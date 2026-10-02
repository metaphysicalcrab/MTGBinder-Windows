import fs from 'node:fs'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { DB } from '../db/index.ts'
import { ApiError, parseWith, PathId, pathId, readJson } from '../http.ts'
import {
  addScan,
  commitScans,
  countSkipped,
  discardScan,
  getScanItem,
  listAutoAdded,
  listScanItems,
  retryScan,
  scanImageFile,
  targetAllScans,
  updateScan,
} from './repo.ts'
import type { ScanWorker } from './worker.ts'

/** The scan queue's worker and where captures are kept. */
export interface ScanService {
  scansDir: string
  worker: ScanWorker
}

/** The largest capture accepted: a phone camera's full frame as JPEG is well under this. */
export const MAX_SCAN_BYTES = 15 * 1024 * 1024

const ScanBoard = z.enum(['commander', 'main', 'side'])
/**
 * A capture's query: `auto=1` from auto mode (`lifted=1` when it saw the empty scanning area since its last capture), and
 * the deck (and board, main by default) it goes to.
 */
const CaptureQuery = z.object({
  auto: z.enum(['0', '1']).optional(),
  lifted: z.enum(['0', '1']).optional(),
  deck: PathId.optional(),
  board: ScanBoard.optional(),
})
const Target = z.object({ deckId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), board: ScanBoard }).strict()
const Patch = z
  .object({
    cardId: z.string().min(1).max(64).optional(),
    finish: z.enum(['nonfoil', 'foil', 'etched']).optional(),
    quantity: z.number().int().min(1).max(999).optional(),
    confirm: z.literal(true).optional(),
    target: Target.nullable().optional(),
  })
  .strict()
/** Where every scan in the queue goes: a deck and board, or null for the collection only. */
const AllTarget = z.object({ target: Target.nullable() }).strict()

/** The most scans one commit can name. */
export const MAX_COMMIT_IDS = 1000
/** Which scans to commit: the ready rows the Add button counted. */
const Commit = z
  .object({ ids: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(MAX_COMMIT_IDS) })
  .strict()

const scanId = (value: string) => pathId(value, 'Scan not found')

/** A JPEG starts with FF D8 FF. */
const isJpeg = (bytes: Uint8Array) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff

/** /api/scan (spec §5.1): capture, the queue, edits, and commit. */
export function scanRoutes(deps: { db: DB; scanner: ScanService }): Hono {
  const { db, scanner } = deps
  const routes = new Hono()

  routes.post(
    '/',
    bodyLimit({
      maxSize: MAX_SCAN_BYTES,
      onError: () => {
        throw new ApiError(
          413,
          'too_large',
          `A capture can be at most ${MAX_SCAN_BYTES / 1024 / 1024} MB; from a phone, take the photo again (Binder shrinks each photo before sending it)`,
        )
      },
    }),
    async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      if (!isJpeg(bytes)) throw new ApiError(400, 'bad_request', 'A capture must be a JPEG image')
      const query = parseWith(CaptureQuery, c.req.query())
      const target = query.deck === undefined ? null : { deckId: query.deck, board: query.board ?? 'main' }
      const item = addScan(db, scanner.scansDir, bytes, { auto: query.auto === '1', lifted: query.lifted === '1', target })
      scanner.worker.kick()
      return c.json(item, 201)
    },
  )

  routes.get('/items', (c) => c.json({ items: listScanItems(db), added: listAutoAdded(db), skipped: countSkipped(db) }))

  routes.put('/target', async (c) => {
    const scans = targetAllScans(db, parseWith(AllTarget, await readJson(c.req)).target)
    if (scans === 'no_deck') throw new ApiError(400, 'no_deck', 'That deck no longer exists')
    return c.json({ scans })
  })

  routes.get('/items/:id/image', (c) => {
    const row = db.prepare('SELECT image_path FROM scan_items WHERE id = ?').get(scanId(c.req.param('id'))) as
      | { image_path: string | null }
      | undefined
    const file = row && scanImageFile(scanner.scansDir, row)
    if (!file || !fs.existsSync(file)) throw new ApiError(404, 'not_found', 'Scan image not found')
    const headers = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' }
    return c.body(fs.readFileSync(file), 200, headers)
  })

  routes.patch('/items/:id', async (c) => {
    const id = scanId(c.req.param('id'))
    const result = updateScan(db, id, parseWith(Patch, await readJson(c.req)))
    if (result === 'no_scan') throw new ApiError(404, 'not_found', 'Scan not found')
    if (result === 'busy') throw new ApiError(409, 'busy', "This scan is still being identified")
    if (result === 'no_card') throw new ApiError(400, 'no_card', 'Choose a card first')
    if (result === 'bad_finish') throw new ApiError(400, 'bad_finish', "That printing doesn't come in that finish")
    if (result === 'no_deck') throw new ApiError(400, 'no_deck', 'That deck no longer exists')
    return c.json(result)
  })

  routes.delete('/items/:id', (c) => {
    const discarded = discardScan(db, scanner.scansDir, scanId(c.req.param('id')))
    if (!discarded) throw new ApiError(404, 'not_found', 'Scan not found')
    return c.body(null, 204)
  })

  routes.post('/items/:id/retry', (c) => {
    const id = scanId(c.req.param('id'))
    const item = retryScan(db, id)
    if (!item) {
      if (!getScanItem(db, id)) throw new ApiError(404, 'not_found', 'Scan not found')
      throw new ApiError(409, 'busy', 'Only scans in review can be identified again')
    }
    scanner.worker.kick()
    return c.json(item)
  })

  // With `{ ids }`, only those scans (the ones the Add button counted); with no body, every confident scan.
  routes.post('/commit', async (c) => {
    const text = await c.req.text()
    const body = text.trim() === '' ? null : parseWith(Commit, await readJson({ json: async () => JSON.parse(text) }))
    return c.json(commitScans(db, scanner.scansDir, body?.ids))
  })

  return routes
}
