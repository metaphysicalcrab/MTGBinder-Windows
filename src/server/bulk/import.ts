import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import zlib from 'node:zlib'
import type { BulkState, BulkStatus } from '../../shared/types.ts'
import { localDate } from '../backup.ts'
import { CARD_COLUMNS, CARD_DATA_VERSION, scryfallToRow, shouldImport, shouldImportToken, tokenParts, type CardRow } from '../cards/map.ts'
import { insertCardRows, rebuildCardNames } from '../cards/repo.ts'
import { createTokenStaging, dropTokenStaging, insertTokenLinks, replaceTokens } from '../cards/tokens.ts'
import type { DB } from '../db/index.ts'
import { getMeta, setMeta } from '../db/meta.ts'
import { removeWithRetry, renameWithRetryAsync } from '../fs-retry.ts'
import { ScryfallError, type ScryfallClient } from '../scryfall/client.ts'
import type { ScryfallBulkData, ScryfallCard } from '../scryfall/types.ts'

const BATCH_SIZE = 2000
const DAY_MS = 24 * 60 * 60 * 1000
const STALE_AFTER_MS = 7 * DAY_MS

/** Whether a failure is Scryfall being out of reach (offline, or not answering), however deep it's wrapped. */
function isOffline(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    if (e instanceof ScryfallError) return e.code === 'offline'
  }
  return false
}

/** Whether a failure came from the database (busy, full, read-only), not from the downloaded file. */
const isDatabaseError = (err: unknown) =>
  typeof (err as { code?: unknown } | null)?.code === 'string' && (err as { code: string }).code.startsWith('SQLITE_')

/**
 * Streams a gzipped JSONL file of Scryfall cards into a staging table, then merges it into `cards` in one
 * transaction. Tokens and emblems, and the cards' links to them, are staged apart and replace `tokens` and
 * `card_tokens` in that transaction. Any failure (truncated gzip, malformed line, nothing importable) leaves `cards`
 * and the tokens untouched.
 * `meta` entries (null deletes the key) are written in that same transaction, so they change only if the merge commits.
 * The staging tables (cards, tokens, and the cards' links to tokens) are TEMP tables, private to this connection, so
 * imports on other connections can't disturb them.
 */
export async function importCardsFile(
  db: DB,
  file: string,
  onProgress?: (processed: number) => void,
  meta: Record<string, string | null> = {},
): Promise<{ imported: number; skipped: number }> {
  // Unqualified `cards_staging` below resolves to this temp table (SQLite searches temp before main).
  db.exec('DROP TABLE IF EXISTS temp.cards_staging; CREATE TEMP TABLE cards_staging AS SELECT * FROM main.cards WHERE 0')
  createTokenStaging(db)
  const input = fs.createReadStream(file)
  const gunzip = zlib.createGunzip()
  input.on('error', (err) => gunzip.destroy(err))
  try {
    const lines = readline.createInterface({ input: input.pipe(gunzip), crlfDelay: Infinity })
    let batch: CardRow[] = []
    let tokens: CardRow[] = []
    let links: Array<[string, string]> = []
    let imported = 0
    let skipped = 0
    let lineNo = 0
    const flush = () => {
      insertCardRows(db, 'cards_staging', batch)
      insertCardRows(db, 'tokens_staging', tokens)
      insertTokenLinks(db, links)
      imported += batch.length
      batch = []
      tokens = []
      links = []
      onProgress?.(imported)
    }
    for await (const line of readLines(lines)) {
      lineNo++
      if (line.trim() === '') continue
      let card: ScryfallCard
      try {
        card = JSON.parse(line) as ScryfallCard
      } catch {
        throw new Error(`Malformed card data on line ${lineNo}`)
      }
      // A token counts as skipped: it isn't one of the printings imported into `cards`.
      const row = shouldImport(card) ? scryfallToRow(card) : null
      if (row) {
        batch.push(row)
        for (const token of tokenParts(card)) links.push([row.oracle_id, token])
      } else {
        skipped++
        const token = shouldImportToken(card) ? scryfallToRow(card) : null
        if (token) tokens.push(token)
      }
      if (batch.length >= BATCH_SIZE) flush()
    }
    if (batch.length > 0 || tokens.length > 0 || links.length > 0) flush()
    if (imported === 0) throw new Error('Card data file contained no importable cards')
    mergeStaging(db, meta)
    return { imported, skipped }
  } finally {
    input.destroy()
    gunzip.destroy()
    db.exec('DROP TABLE IF EXISTS temp.cards_staging')
    dropTokenStaging(db)
  }
}

/** Yields the file's lines, reporting a damaged gzip stream (truncated download, not gzip) in plain words. */
async function* readLines(lines: AsyncIterable<string>): AsyncGenerator<string> {
  try {
    yield* lines
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string' && code.startsWith('Z_')) {
      throw new Error(`Card data file is corrupt or incomplete (${(err as Error).message})`, { cause: err })
    }
    throw err
  }
}

/**
 * In one transaction: upserts staging into `cards`, deletes printings Scryfall dropped unless something references
 * them, rebuilds names, replaces the tokens, drops the staging tables, and writes the meta entries plus the card data
 * version. When a card a deck line uses is missing from the new data, all its printings are kept, since a line on the
 * default printing names only the card; the name rebuild then picks a default printing from those. When the card is
 * still there, its dropped printings go like any other, so a frozen price can't win the buy list.
 */
function mergeStaging(db: DB, meta: Record<string, string | null>): void {
  const columns = CARD_COLUMNS.join(', ')
  const updates = CARD_COLUMNS.filter((c) => c !== 'id')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ')
  db.transaction(() => {
    // `WHERE true` is required: SQLite can't otherwise parse an upsert after INSERT ... SELECT.
    db.exec(`INSERT INTO cards (${columns}) SELECT ${columns} FROM cards_staging WHERE true
             ON CONFLICT (id) DO UPDATE SET ${updates}`)
    db.exec(`DELETE FROM cards
             WHERE id NOT IN (SELECT id FROM cards_staging)
               AND id NOT IN (SELECT card_id FROM collection)
               AND id NOT IN (SELECT preferred_card_id FROM deck_cards WHERE preferred_card_id IS NOT NULL)
               AND NOT (oracle_id IN (SELECT oracle_id FROM deck_cards)
                        AND oracle_id NOT IN (SELECT oracle_id FROM cards_staging))
               AND id NOT IN (SELECT card_id FROM scan_items WHERE card_id IS NOT NULL)`)
    rebuildCardNames(db)
    replaceTokens(db)
    db.exec('DROP TABLE temp.cards_staging')
    dropTokenStaging(db)
    setMeta(db, 'card_data_version', String(CARD_DATA_VERSION))
    for (const [key, value] of Object.entries(meta)) setMeta(db, key, value)
  })()
}

export interface BulkImporter {
  status(): BulkStatus
  /** True when card data was never imported, is older than 7 days, or was imported by an older CARD_DATA_VERSION. */
  isStale(): boolean
  /** Why the card data is stale ("Card data is 9 days old"), or null when it isn't. */
  staleReason(): string | null
  /** Starts a refresh in the background. Returns its promise (which never rejects), or null if one is already running. */
  start(): Promise<void> | null
}

export interface BulkImporterDeps {
  db: DB
  client: ScryfallClient
  dataDir: string
  now?: () => Date
  log?: (message: string) => void
}

export function createBulkImporter(deps: BulkImporterDeps): BulkImporter {
  const { db, client, dataDir } = deps
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  let state: BulkState = 'idle'
  let processed = 0
  let running: Promise<void> | null = null
  /** The last refresh's error, kept here too in case the database couldn't record it. */
  let lastError: string | null = null
  const keptFile = path.join(dataDir, 'bulk', 'default-cards.jsonl.gz')

  async function refresh(): Promise<void> {
    state = 'downloading'
    processed = 0
    let reusedFile = false
    try {
      const meta = await client.getJson<ScryfallBulkData>('/bulk-data/default-cards')
      const uri = meta.jsonl_download_uri
      if (typeof uri !== 'string') {
        throw new Error(`Scryfall bulk metadata has no jsonl_download_uri (fields present: ${Object.keys(meta).join(', ')})`)
      }
      if (typeof meta.updated_at !== 'string') {
        throw new Error(`Scryfall bulk metadata has no updated_at (fields present: ${Object.keys(meta).join(', ')})`)
      }
      fs.mkdirSync(path.dirname(keptFile), { recursive: true })
      const file = keptFile
      // The file from the last successful import is still current when Scryfall hasn't published a newer one
      // (for example when an app update re-imports): import it again instead of downloading 80 MB.
      reusedFile = meta.updated_at === getMeta(db, 'bulk_source_updated_at') && fs.existsSync(file)
      if (reusedFile) {
        log('Scryfall has no newer card data; re-importing the downloaded file')
      } else {
        const partial = `${file}.part`
        try {
          const res = await client.download(uri)
          if (!res.body) throw new Error('the response was empty')
          await pipeline(Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>), fs.createWriteStream(partial))
        } catch (err) {
          throw new Error(`Card data download failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
        }
        // On Windows, antivirus scans the download as it closes: the rename waits that out (see fs-retry).
        await renameWithRetryAsync(partial, file)
      }

      state = 'importing'
      const { imported } = await importCardsFile(
        db,
        file,
        (n) => {
          processed = n
        },
        { bulk_updated_at: now().toISOString(), bulk_source_updated_at: meta.updated_at, bulk_error: null },
      )
      state = 'idle'
      lastError = null
      log(`Imported ${imported.toLocaleString()} printings`)
    } catch (err) {
      state = 'error'
      // Offline with card data already here is the usual case on a laptop: say what happened and that nothing is lost,
      // in one line, rather than as a failure.
      const reason = err instanceof Error ? err.message : String(err)
      let offlineWithData = false
      let message = reason
      try {
        if (isOffline(err) && (db.prepare('SELECT count(*) FROM cards').pluck().get() as number) > 0) {
          const since = new Date(getMeta(db, 'bulk_updated_at') ?? Number.NaN)
          const from = Number.isNaN(since.getTime()) ? 'already here' : `from ${localDate(since)}`
          offlineWithData = true
          message = `${reason}. The card data ${from} stays in use`
        }
      } catch {
        // The database can't be read either (busy, I/O): the reason alone is still worth saying.
      }
      lastError = message
      // A kept file that fails to import may be damaged; delete it so the next refresh downloads a fresh copy. A
      // database error says nothing about the file, which is kept.
      if (reusedFile && !isDatabaseError(err)) {
        try {
          removeWithRetry(keptFile)
        } catch (rmErr) {
          // Still held open (on Windows, by antivirus or the indexer): the next refresh imports it again, and fails the
          // same way or works. The refresh's own error is still recorded below, and refresh() never rejects.
          log(`Could not delete the card data file: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`)
        }
      }
      try {
        setMeta(db, 'bulk_error', message)
      } catch (metaErr) {
        // The database itself may be the problem (busy, read-only, I/O); refresh() must still never reject.
        log(`Could not record the refresh error: ${metaErr instanceof Error ? metaErr.message : String(metaErr)}`)
      }
      log(offlineWithData ? message : `Card data refresh failed: ${message}`)
    }
  }

  function staleReason(): string | null {
    const updated = getMeta(db, 'bulk_updated_at')
    if (updated === null) return "Card data isn't downloaded yet"
    if (getMeta(db, 'card_data_version') !== String(CARD_DATA_VERSION)) return 'Card data is from an older Binder version'
    const age = now().getTime() - Date.parse(updated)
    if (Number.isNaN(age) || age > STALE_AFTER_MS) {
      const days = Math.floor(age / DAY_MS)
      return Number.isNaN(days) ? 'Card data has no readable date' : `Card data is ${days} days old`
    }
    return null
  }

  return {
    status() {
      return {
        state,
        processed,
        // This process's own last error is the latest; the recorded one is a previous run's, or the same.
        error: lastError ?? getMeta(db, 'bulk_error'),
        updatedAt: getMeta(db, 'bulk_updated_at'),
        sourceUpdatedAt: getMeta(db, 'bulk_source_updated_at'),
        cardCount: db.prepare('SELECT count(*) FROM cards').pluck().get() as number,
      }
    },
    isStale: () => staleReason() !== null,
    staleReason,
    start() {
      if (running) return null
      running = refresh().finally(() => {
        running = null
      })
      return running
    },
  }
}
