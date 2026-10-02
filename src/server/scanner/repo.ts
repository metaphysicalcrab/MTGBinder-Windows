import fs from 'node:fs'
import path from 'node:path'
import type {
  AutoAddedScan,
  Finish,
  ScanBoard,
  ScanCandidate,
  ScanCard,
  ScanCommitResult,
  ScanItem,
  ScanStatus,
  ScanTarget,
} from '../../shared/types.ts'
import { parsePrices } from '../cards/repo.ts'
import { adjustCopies } from '../collection/repo.ts'
import type { DB } from '../db/index.ts'
import { addToDeck } from '../decks/repo.ts'
import { removeWithRetry } from '../fs-retry.ts'

export interface ScanRow {
  id: number
  image_path: string | null
  status: ScanStatus
  /** The schema also allows 'claude', which scanning never writes (it's on-device only); items show it as null. */
  method: ScanItem['method'] | 'claude'
  reason: ScanItem['reason']
  auto: number
  ocr_json: string | null
  candidates: string
  card_id: string | null
  finish: Finish
  quantity: number
  confidence: number | null
  error: string | null
  created_at: string
  updated_at: string
  deck_id: number | null
  board: ScanBoard | null
  auto_committed: number
  lifted: number
}

interface CardRow {
  id: string
  oracle_id: string
  name: string
  set_code: string
  set_name: string
  collector_number: string
  image_small: string | null
  finishes: string
  prices: string
}

/** Scans still in the queue (spec §5.1.3); committed and discarded ones are done with. */
const ACTIVE = "('queued', 'identifying', 'confident', 'review')"

/** How close together two auto-mode captures must be for the second to look like the first caught again. */
const DOUBLE_CAPTURE_MS = 60_000

/**
 * A capture of the bare scanning area that the worker dropped: discarded before it was identified, with the OCR
 * result that found no text kept as the mark. A scan the owner discarded has no such result.
 */
const BARE_MAT = "status = 'discarded' AND method IS NULL AND ocr_json IS NOT NULL"

/**
 * Whether an auto-mode capture looks like auto mode caught the card before it again (spec §5.1.3): the scan before it
 * is an auto-mode capture of the same printing, taken within a minute, whether it's still in the queue or already
 * added. Scans the owner discarded are skipped, but a capture auto mode took after seeing the empty scanning area
 * (`lifted`), or a bare-mat capture the worker dropped in between, means the card was lifted, so this copy is a new card.
 */
function isSameCardAsBefore(db: DB, row: ScanRow): boolean {
  if (row.auto !== 1 || row.lifted === 1 || !row.card_id) return false
  const before = db
    .prepare(
      `SELECT auto, card_id, status, created_at FROM scan_items
       WHERE id < ? AND (status <> 'discarded' OR (${BARE_MAT})) ORDER BY id DESC LIMIT 1`,
    )
    .get(row.id) as Pick<ScanRow, 'auto' | 'card_id' | 'status' | 'created_at'> | undefined
  return (
    before !== undefined &&
    before.status !== 'discarded' &&
    before.auto === 1 &&
    before.card_id === row.card_id &&
    Date.parse(row.created_at) - Date.parse(before.created_at) <= DOUBLE_CAPTURE_MS
  )
}

function toItem(db: DB, row: ScanRow): ScanItem {
  const cardById = db.prepare(
    'SELECT id, oracle_id, name, set_code, set_name, collector_number, image_small, finishes, prices FROM cards WHERE id = ?',
  )
  const c = row.card_id ? (cardById.get(row.card_id) as CardRow | undefined) : undefined
  const card: ScanCard | null = c
    ? {
        id: c.id,
        oracleId: c.oracle_id,
        name: c.name,
        setCode: c.set_code,
        setName: c.set_name,
        collectorNumber: c.collector_number,
        imageSmall: c.image_small,
        finishes: JSON.parse(c.finishes) as Finish[],
        prices: parsePrices(c.prices),
      }
    : null
  const stored = JSON.parse(row.candidates) as Array<{ card_id: string; score: number }>
  const candidates = stored.flatMap(({ card_id, score }): ScanCandidate[] => {
    const r = cardById.get(card_id) as CardRow | undefined
    return r ? [{ cardId: r.id, name: r.name, setCode: r.set_code, collectorNumber: r.collector_number, score }] : []
  })
  return {
    id: row.id,
    status: row.status,
    method: row.method === 'ocr' || row.method === 'manual' ? row.method : null,
    reason: row.reason,
    auto: row.auto === 1,
    card,
    finish: row.finish,
    quantity: row.quantity,
    confidence: row.confidence,
    candidates,
    error: row.error,
    createdAt: row.created_at,
    target: targetOf(db, row),
    sameCardAsBefore: isSameCardAsBefore(db, row),
  }
}

/** The deck and board a scan goes to, with the deck's name; null for the collection only. */
function targetOf(db: DB, row: ScanRow): ScanItem['target'] {
  if (row.deck_id === null) return null
  const name = db.prepare('SELECT name FROM decks WHERE id = ?').pluck().get(row.deck_id) as string | undefined
  return name === undefined ? null : { deckId: row.deck_id, board: row.board ?? 'main', deckName: name }
}

const deckExists = (db: DB, id: number) => db.prepare('SELECT 1 FROM decks WHERE id = ?').get(id) !== undefined

const getRow = (db: DB, id: number) =>
  db.prepare('SELECT * FROM scan_items WHERE id = ?').get(id) as ScanRow | undefined

export function getScanItem(db: DB, id: number): ScanItem | null {
  const row = getRow(db, id)
  return row ? toItem(db, row) : null
}

/** The scans in the queue, oldest first. */
export function listScanItems(db: DB): ScanItem[] {
  const rows = db.prepare(`SELECT * FROM scan_items WHERE status IN ${ACTIVE} ORDER BY id`).all() as ScanRow[]
  return rows.map((row) => toItem(db, row))
}

/** The image file of a scan, under `scansDir`. */
export const scanImageFile = (scansDir: string, row: Pick<ScanRow, 'image_path'>) =>
  row.image_path ? path.join(scansDir, row.image_path) : null

export interface CaptureOptions {
  /** Taken by auto mode. */
  auto?: boolean
  /** Taken by auto mode after it saw the empty scanning area: the card before it was lifted. */
  lifted?: boolean
  /** The deck and board it goes to besides the collection. A deck that no longer exists leaves it for the collection. */
  target?: ScanTarget | null
}

/** Saves a captured JPEG as `<scansDir>/<id>.jpg` and queues it (spec §5.1.2). */
export function addScan(db: DB, scansDir: string, jpeg: Uint8Array, options: CaptureOptions = {}, now = new Date()): ScanItem {
  fs.mkdirSync(scansDir, { recursive: true })
  const at = now.toISOString()
  const target = options.target && deckExists(db, options.target.deckId) ? options.target : null
  const id = db.transaction(() => {
    const newId = Number(
      db
        .prepare(
          "INSERT INTO scan_items (status, auto, lifted, deck_id, board, created_at, updated_at) VALUES ('queued', ?, ?, ?, ?, ?, ?)",
        )
        .run(options.auto ? 1 : 0, options.lifted ? 1 : 0, target?.deckId ?? null, target?.board ?? null, at, at).lastInsertRowid,
    )
    const file = `${newId}.jpg`
    fs.writeFileSync(path.join(scansDir, file), jpeg)
    db.prepare('UPDATE scan_items SET image_path = ? WHERE id = ?').run(file, newId)
    return newId
  })()
  return getScanItem(db, id)!
}

/** Takes the oldest queued scan for identifying, or returns null when none is waiting. */
export function claimNextScan(db: DB, now = new Date()): ScanRow | null {
  const row = db
    .prepare(
      `UPDATE scan_items SET status = 'identifying', updated_at = ?
       WHERE id = (SELECT id FROM scan_items WHERE status = 'queued' ORDER BY id LIMIT 1) RETURNING *`,
    )
    .get(now.toISOString()) as ScanRow | undefined
  return row ?? null
}

/** Puts scans a restart left mid-identification back in the queue. */
export function requeueInterrupted(db: DB): number {
  return db.prepare("UPDATE scan_items SET status = 'queued' WHERE status = 'identifying'").run().changes
}

/** The finish a scan starts with: the preferred one when the printing comes in it, else the printing's first. */
export function finishFor(db: DB, cardId: string, preferred: Finish): Finish {
  const json = db.prepare('SELECT finishes FROM cards WHERE id = ?').pluck().get(cardId) as string | undefined
  const finishes = json ? (JSON.parse(json) as Finish[]) : []
  return finishes.includes(preferred) ? preferred : (finishes[0] ?? 'nonfoil')
}

export interface ScanResult {
  status: 'confident' | 'review'
  method: 'ocr'
  reason: ScanItem['reason']
  cardId: string | null
  finish: Finish
  confidence: number | null
  candidates: Array<{ cardId: string; score: number }>
  error: string | null
  ocrJson: string | null
}

/** Records what identifying a scan found. A scan discarded in the meantime stays discarded. */
export function saveScanResult(db: DB, id: number, result: ScanResult, now = new Date()): boolean {
  return (
    db
      .prepare(
        `UPDATE scan_items SET status = @status, method = @method, reason = @reason, card_id = @cardId,
           finish = @finish, confidence = @confidence, candidates = @candidates, error = @error, ocr_json = @ocrJson,
           updated_at = @at
         WHERE id = @id AND status = 'identifying'`,
      )
      .run({
        ...result,
        id,
        candidates: JSON.stringify(result.candidates.map((c) => ({ card_id: c.cardId, score: c.score }))),
        at: now.toISOString(),
      }).changes === 1
  )
}

export interface ScanPatch {
  /** Another card or printing: the owner's choice, so the scan becomes confident. */
  cardId?: string
  finish?: Finish
  quantity?: number
  /** Accepts a review scan as it is. */
  confirm?: true
  /** Another deck and board for it, or null for the collection only. */
  target?: ScanTarget | null
}

export type ScanUpdate = ScanItem | 'no_scan' | 'busy' | 'no_card' | 'bad_finish' | 'no_deck'

/**
 * Edits a scan in the queue (spec §5.1.3). Choosing a card makes it confident and marks it as picked by hand; a
 * finish the printing doesn't come in is refused, and a new printing keeps the finish only if it comes in it. A scan
 * the owner settles (by choosing a card or confirming it) drops its old error, which no longer applies. Where it goes
 * (its deck and board) can change while it's still being identified; nothing else can.
 */
export function updateScan(db: DB, id: number, patch: ScanPatch, now = new Date()): ScanUpdate {
  return db.transaction((): ScanUpdate => {
    const row = getRow(db, id)
    if (!row || row.status === 'committed' || row.status === 'discarded') return 'no_scan'
    const { target, ...rest } = patch
    const busy = row.status === 'queued' || row.status === 'identifying'
    if (busy && Object.values(rest).some((value) => value !== undefined)) return 'busy'
    const next = { ...row }
    if (target !== undefined) {
      if (target !== null && !deckExists(db, target.deckId)) return 'no_deck'
      next.deck_id = target?.deckId ?? null
      next.board = target?.board ?? null
    }
    if (patch.cardId !== undefined) {
      if (!db.prepare('SELECT 1 FROM cards WHERE id = ?').get(patch.cardId)) return 'no_card'
      next.card_id = patch.cardId
      next.finish = finishFor(db, patch.cardId, row.finish)
      next.method = 'manual'
      next.status = 'confident'
      next.reason = null
      next.error = null
    }
    if (patch.finish !== undefined) {
      if (!next.card_id || finishFor(db, next.card_id, patch.finish) !== patch.finish) return 'bad_finish'
      next.finish = patch.finish
    }
    if (patch.quantity !== undefined) next.quantity = patch.quantity
    if (patch.confirm) {
      if (!next.card_id) return 'no_card'
      // The owner looked and said it's right, so it's theirs now, as when they pick the card.
      next.method = 'manual'
      next.status = 'confident'
      next.reason = null
      next.error = null
    }
    db.prepare(
      `UPDATE scan_items SET card_id = @card_id, finish = @finish, method = @method, status = @status, reason = @reason,
         quantity = @quantity, error = @error, deck_id = @deck_id, board = @board, updated_at = @at WHERE id = @id`,
    ).run({ ...next, at: now.toISOString() })
    return toItem(db, getRow(db, id)!)
  })()
}

/**
 * How long deleting a scan's image waits on Windows for a program that still has it open (antivirus, the OCR helper):
 * briefly, as the request adding the scan waits too. One left behind is deleted at the next start.
 */
const IMAGE_RETRY_MS = 2_000

/**
 * Deletes a scan's image. Failing to (a folder that became read-only, or on Windows a file another program holds) is
 * logged: the scan is done with anyway, and removeFinishedImages deletes the image at the next start.
 */
function deleteImage(scansDir: string, row: ScanRow) {
  const file = scanImageFile(scansDir, row)
  try {
    if (file) removeWithRetry(file, { budgetMs: IMAGE_RETRY_MS })
  } catch (err) {
    console.error(`[scan] couldn't delete ${file}`, err)
  }
}

/**
 * Deletes the images that adding or discarding their scans couldn't (see deleteImage). Only the image of a finished
 * scan (added, or discarded) goes: an image whose scan is still in the queue, or that no scan names, is left alone.
 * Best effort; returns how many it deleted.
 */
export function removeFinishedImages(db: DB, scansDir: string): number {
  let names: string[]
  try {
    names = fs.readdirSync(scansDir)
  } catch {
    return 0 // no scans yet
  }
  const finished = db.prepare(
    "SELECT 1 FROM scan_items WHERE id = ? AND image_path = ? AND status IN ('committed', 'discarded')",
  )
  let removed = 0
  for (const name of names) {
    const id = /^([1-9]\d*)\.jpg$/.exec(name)?.[1]
    if (id === undefined || finished.get(Number(id), name) === undefined) continue
    try {
      fs.rmSync(path.join(scansDir, name), { force: true })
      removed++
    } catch (err) {
      console.error(`[scan] couldn't delete ${path.join(scansDir, name)}`, err)
    }
  }
  return removed
}

/** Discards a scan and deletes its image. Returns false if it isn't in the queue. */
export function discardScan(db: DB, scansDir: string, id: number, now = new Date()): boolean {
  const row = getRow(db, id)
  if (!row || row.status === 'committed' || row.status === 'discarded') return false
  db.prepare("UPDATE scan_items SET status = 'discarded', updated_at = ? WHERE id = ?").run(now.toISOString(), id)
  deleteImage(scansDir, row)
  return true
}

/**
 * Drops an auto-mode capture of the bare scanning area (spec §5.1.3), keeping the OCR result that found no text as the
 * mark that it was one. Its method is cleared, as it was never identified: a capture tried again after OCR failed has
 * 'ocr' from that failure. A scan the owner discarded meanwhile stays as they left it.
 */
export function dropBareMat(db: DB, scansDir: string, id: number, ocrJson: string, now = new Date()): void {
  const row = getRow(db, id)
  const dropped = db
    .prepare(
      `UPDATE scan_items SET status = 'discarded', method = NULL, ocr_json = ?, updated_at = ?
       WHERE id = ? AND status = 'identifying'`,
    )
    .run(ocrJson, now.toISOString(), id).changes
  if (row && dropped === 1) deleteImage(scansDir, row)
}

/** How long a dropped bare-mat capture counts in the queue's `skipped`, for the Scan page's note. */
export const SKIPPED_MS = 60_000

/** How many bare-mat captures the worker dropped in the last minute. */
export function countSkipped(db: DB, now = new Date()): number {
  const since = new Date(now.getTime() - SKIPPED_MS).toISOString()
  return db.prepare(`SELECT count(*) FROM scan_items WHERE ${BARE_MAT} AND updated_at >= ?`).pluck().get(since) as number
}

/** Puts a scan the worker couldn't save back in line, to be identified again. */
export function requeueScan(db: DB, id: number): boolean {
  return db.prepare("UPDATE scan_items SET status = 'queued' WHERE id = ? AND status = 'identifying'").run(id).changes === 1
}

/**
 * Sends every scan still in the queue to one deck and board, or to the collection only (null). Returns how many it
 * changed, or 'no_deck' when the deck no longer exists.
 */
export function targetAllScans(db: DB, target: ScanTarget | null, now = new Date()): number | 'no_deck' {
  return db.transaction((): number | 'no_deck' => {
    if (target !== null && !deckExists(db, target.deckId)) return 'no_deck'
    return db
      .prepare(`UPDATE scan_items SET deck_id = ?, board = ?, updated_at = ? WHERE status IN ${ACTIVE}`)
      .run(target?.deckId ?? null, target?.board ?? null, now.toISOString()).changes
  })()
}

/** Sends a review scan through identification again: it's read again by OCR, for example once the OCR helper works. */
export function retryScan(db: DB, id: number, now = new Date()): ScanItem | null {
  const changed = db
    .prepare("UPDATE scan_items SET status = 'queued', error = NULL, updated_at = ? WHERE id = ? AND status = 'review'")
    .run(now.toISOString(), id).changes
  return changed === 1 ? getScanItem(db, id) : null
}

/**
 * The copies scans have added to a deck (spec §5.1.3), by "<board>/<oracle id>": every committed scan into it counts,
 * whether its copies filled the deck's list or were added beyond it.
 */
export function scannedIntoDeck(db: DB, deckId: number): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT COALESCE(s.board, 'main') AS board, c.oracle_id, SUM(s.quantity) AS copies
       FROM scan_items s JOIN cards c ON c.id = s.card_id
       WHERE s.status = 'committed' AND s.deck_id = ? GROUP BY 1, 2`,
    )
    .all(deckId) as Array<{ board: string; oracle_id: string; copies: number }>
  return new Map(rows.map((r) => [`${r.board}/${r.oracle_id}`, r.copies]))
}

/**
 * Adds a committing scan's copies to its deck (spec §5.1.3). They first fill the copies the deck lists on that board
 * that earlier scans into it haven't: scanning a deck that was planned first doesn't list its cards twice. Only the
 * copies beyond those are added to the line; a new line shows the printing scanned.
 */
function addToTargetDeck(db: DB, row: ScanRow, now: Date): void {
  const deckId = row.deck_id!
  const board = row.board ?? 'main'
  const oracleId = db.prepare('SELECT oracle_id FROM cards WHERE id = ?').pluck().get(row.card_id) as string
  const listed =
    (db
      .prepare('SELECT quantity FROM deck_cards WHERE deck_id = ? AND oracle_id = ? AND board = ?')
      .pluck()
      .get(deckId, oracleId, board) as number | undefined) ?? 0
  const scanned = scannedIntoDeck(db, deckId).get(`${board}/${oracleId}`) ?? 0
  const beyond = row.quantity - Math.min(row.quantity, Math.max(0, listed - scanned))
  if (beyond > 0) addToDeck(db, deckId, row.card_id!, board, beyond, now)
}

/**
 * Adds confident scans to the collection (spec §5.1.3), all of them or just those with the given ids: each adds its
 * quantity of its printing in its finish, and a scan with a deck adds to that deck too, in the same transaction. They
 * become committed and their images are deleted. `auto`: the worker is adding a scan by itself (auto-commit).
 */
export function commitScans(
  db: DB,
  scansDir: string,
  ids?: readonly number[],
  now = new Date(),
  { auto = false }: { auto?: boolean } = {},
): ScanCommitResult {
  const rows = db.transaction(() => {
    const all = db
      .prepare("SELECT * FROM scan_items WHERE status = 'confident' AND card_id IS NOT NULL ORDER BY id")
      .all() as ScanRow[]
    const confident = all.filter((row) => !ids || ids.includes(row.id))
    const done = db.prepare("UPDATE scan_items SET status = 'committed', auto_committed = ?, updated_at = ? WHERE id = ?")
    for (const row of confident) {
      adjustCopies(db, row.card_id!, row.finish, row.quantity, now)
      if (row.deck_id !== null) addToTargetDeck(db, row, now)
      done.run(auto ? 1 : 0, now.toISOString(), row.id)
    }
    return confident
  })()
  for (const row of rows) deleteImage(scansDir, row)
  const decks = new Map<number, ScanCommitResult['decks'][number]>()
  for (const row of rows) {
    if (row.deck_id === null) continue
    const name = db.prepare('SELECT name FROM decks WHERE id = ?').pluck().get(row.deck_id) as string
    const deck = decks.get(row.deck_id) ?? { id: row.deck_id, name, copies: 0 }
    deck.copies += row.quantity
    decks.set(row.deck_id, deck)
  }
  return { items: rows.length, copies: rows.reduce((sum, row) => sum + row.quantity, 0), decks: [...decks.values()] }
}

/** How long a scan auto-commit added stays in the queue's `added` list, for the Scan page to announce. */
export const AUTO_ADDED_MS = 60_000

/** The scans auto-commit added in the last minute, oldest first. */
export function listAutoAdded(db: DB, now = new Date()): AutoAddedScan[] {
  const since = new Date(now.getTime() - AUTO_ADDED_MS).toISOString()
  return db
    .prepare(
      `SELECT s.id, c.name, s.quantity AS copies, d.name AS deckName FROM scan_items s
       JOIN cards c ON c.id = s.card_id LEFT JOIN decks d ON d.id = s.deck_id
       WHERE s.status = 'committed' AND s.auto_committed = 1 AND s.updated_at >= ? ORDER BY s.id`,
    )
    .all(since) as AutoAddedScan[]
}
