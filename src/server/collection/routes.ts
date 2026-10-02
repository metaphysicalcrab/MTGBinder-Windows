import { Hono } from 'hono'
import { z } from 'zod'
import type { CopyCount, Finish } from '../../shared/types.ts'
import { localDate } from '../backup.ts'
import { getCard } from '../cards/repo.ts'
import type { DB } from '../db/index.ts'
import { ApiError, parseWith, readJson } from '../http.ts'
import { csvLine, CsvError } from './csv.ts'
import { MAX_ROW_QUANTITY, previewImport } from './import.ts'
import { addCopies, adjustCopies, collectionStats, exportRows } from './repo.ts'

const CardId = z.string().min(1).max(100)
const FinishSchema = z.enum(['nonfoil', 'foil', 'etched'])
const AdjustBody = z.object({
  cardId: CardId,
  finish: FinishSchema,
  delta: z.number().int().min(-1000).max(1000).refine((n) => n !== 0, 'must not be 0'),
})
const PreviewBody = z.object({ csv: z.string().max(10_000_000) })
const ImportItemSchema = z.object({ cardId: CardId, finish: FinishSchema, quantity: z.number().int().min(1).max(MAX_ROW_QUANTITY) })
const ImportBody = z.object({ items: z.array(ImportItemSchema).min(1).max(100_000) })

/** The Foil column of an export: blank for nonfoil, as Moxfield writes it. */
const FOIL_COLUMN: Record<Finish, string> = { nonfoil: '', foil: 'foil', etched: 'etched' }


/** "Lightning Bolt (M10 #146)" */
function printingLabel(name: string, setCode: string, collectorNumber: string): string {
  return `${name} (${setCode.toUpperCase()} #${collectorNumber})`
}

export function collectionRoutes(deps: { db: DB }): Hono {
  const routes = new Hono()
  const { db } = deps

  routes.get('/stats', (c) => c.json(collectionStats(db)))

  routes.post('/adjust', async (c) => {
    const { cardId, finish, delta } = parseWith(AdjustBody, await readJson(c.req))
    const card = getCard(db, cardId)
    if (!card) throw new ApiError(404, 'not_found', 'Card not found')
    // Removing is always allowed, so a finish Scryfall no longer lists can still be cleared out.
    if (delta > 0 && !card.finishes.includes(finish)) {
      throw new ApiError(400, 'finish_unavailable', `${printingLabel(card.name, card.setCode, card.collectorNumber)} has no ${finish} version`)
    }
    const result: CopyCount = { cardId, finish, quantity: adjustCopies(db, cardId, finish, delta) }
    return c.json(result)
  })

  routes.post('/import/preview', async (c) => {
    const { csv } = parseWith(PreviewBody, await readJson(c.req))
    try {
      return c.json(previewImport(db, csv))
    } catch (err) {
      if (err instanceof CsvError) throw new ApiError(400, 'bad_csv', err.message)
      throw err
    }
  })

  routes.post('/import', async (c) => {
    const { items } = parseWith(ImportBody, await readJson(c.req))
    // Checked up front so the import is all or nothing (the card data may have changed since the preview).
    const lookup = db.prepare('SELECT name, set_code, collector_number, finishes FROM cards WHERE id = ?')
    for (const item of items) {
      const card = lookup.get(item.cardId) as { name: string; set_code: string; collector_number: string; finishes: string } | undefined
      if (!card) throw new ApiError(400, 'bad_import', `Card ${item.cardId} isn't in the card data; preview the file again`)
      if (!(JSON.parse(card.finishes) as Finish[]).includes(item.finish)) {
        throw new ApiError(
          400,
          'bad_import',
          `${printingLabel(card.name, card.set_code, card.collector_number)} has no ${item.finish} version; preview the file again`,
        )
      }
    }
    return c.json(addCopies(db, items))
  })

  // `?excel=1` starts the file with a byte order mark: Excel on Windows then reads it as UTF-8, so names like
  // Lim-Dûl's Vault and Séance come out right, where it would otherwise read it in Windows' own code page. Without it,
  // the file is as other apps' imports expect. Binder's own import takes either.
  routes.get('/export.csv', (c) => {
    const lines = [csvLine(['Count', 'Name', 'Edition', 'Collector Number', 'Foil'])]
    for (const row of exportRows(db)) {
      lines.push(csvLine([row.quantity, row.name, row.setCode, row.collectorNumber, FOIL_COLUMN[row.finish]]))
    }
    const date = localDate(new Date())
    const bom = c.req.query('excel') === '1' ? '\uFEFF' : ''
    return c.body(`${bom}${lines.join('\r\n')}\r\n`, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="binder-collection-${date}.csv"`,
    })
  })

  return routes
}
