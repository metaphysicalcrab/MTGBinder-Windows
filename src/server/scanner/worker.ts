import type { DB } from '../db/index.ts'
import { getSettings } from '../settings.ts'
import { decide, hasText, readCard, type CardLookups, type MatchDecision, type ScoredCard } from './matcher.ts'
import type { OcrClient, OcrResult } from './ocr-client.ts'
import {
  claimNextScan,
  commitScans,
  dropBareMat,
  finishFor,
  removeFinishedImages,
  requeueInterrupted,
  requeueScan,
  saveScanResult,
  scanImageFile,
  type ScanResult,
  type ScanRow,
} from './repo.ts'

/** How many scans are read by OCR at once (spec §5.1.2). The one helper process takes them in turn. */
export const OCR_CONCURRENCY = 2

/**
 * How long the worker first waits to try again a scan whose result it couldn't save at all. Each wait after that is
 * twice as long, up to SAVE_RETRY_MAX_MS.
 */
export const SAVE_RETRY_MS = 5_000
export const SAVE_RETRY_MAX_MS = 5 * 60_000

export interface ScanWorkerDeps {
  db: DB
  scansDir: string
  ocr: OcrClient
  lookups: CardLookups
  now?: () => Date
  /** The first wait before trying again a scan it couldn't save (tests shorten it). */
  saveRetryMs?: number
}

export interface ScanWorker {
  /** Starts identifying queued scans; call it after queueing one. */
  kick(): void
  /** Resolves once nothing is being identified. Scans queued without a kick() stay queued. */
  idle(): Promise<void>
  /** Queues again the scans a restart interrupted, deletes finished scans' images left behind, then starts. */
  recover(): void
}

const candidateIds = (candidates: readonly ScoredCard[]) =>
  candidates.map((c) => ({ cardId: c.card.id, score: c.score }))

/**
 * Identifies queued scans on this computer (spec §5.1.2): OCR, then the matcher. A confident scan is ready (and, when
 * it was captured by hand, committed straight away if auto-commit is on); a certain card with an uncertain printing,
 * and anything the matcher can't settle, go to review. Scanning never calls a cloud service.
 */
export function createScanWorker(deps: ScanWorkerDeps): ScanWorker {
  const { db, lookups } = deps
  const now = deps.now ?? (() => new Date())
  const saveRetryMs = deps.saveRetryMs ?? SAVE_RETRY_MS
  let running = 0
  let waiting: Array<() => void> = []
  /** The scans whose result couldn't be saved at all, with how many times in a row. */
  const unsaved = new Map<number, number>()

  /**
   * A backstop for a scan whose result couldn't be saved, not even for review (the database is failing): it's logged
   * and tried again after a wait that doubles each time, up to SAVE_RETRY_MAX_MS, until it's saved, so it never stays
   * identifying for good.
   */
  function unsavable(id: number, err: unknown) {
    console.error('[scan] identifying failed', err)
    const tries = (unsaved.get(id) ?? 0) + 1
    unsaved.set(id, tries)
    setTimeout(
      () => {
        try {
          if (requeueScan(db, id)) pump()
          else unsaved.delete(id) // discarded meanwhile
        } catch (retryErr) {
          unsavable(id, retryErr)
        }
      },
      Math.min(saveRetryMs * 2 ** (tries - 1), SAVE_RETRY_MAX_MS),
    ).unref()
  }

  function save(row: ScanRow, result: Omit<ScanResult, 'finish'> & { foil: boolean }) {
    const settings = getSettings(db)
    const preferred = result.foil ? 'foil' : settings.scanDefaultFinish
    const finish = result.cardId ? finishFor(db, result.cardId, preferred) : settings.scanDefaultFinish
    const saved = saveScanResult(db, row.id, { ...result, finish }, now())
    // Auto mode can capture one card twice (a hand reaching in, or a nudge, re-arms it), so its captures always wait
    // in the queue, where a second capture is marked; auto-commit is for manual captures only.
    if (saved && result.status === 'confident' && settings.scanAutoCommit && row.auto !== 1) {
      try {
        commitScans(db, deps.scansDir, [row.id], now(), { auto: true })
      } catch (err) {
        // The scan stays ready in the queue, so it can still be added by hand.
        console.error('[scan] auto-commit failed', err)
      }
    }
  }

  async function readScan(row: ScanRow) {
    const file = scanImageFile(deps.scansDir, row)
    let ocr: OcrResult | null = null
    let decision: MatchDecision | null = null
    let error: string | null = null
    const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))
    try {
      if (!file) throw new Error('The scan has no image')
      ocr = await deps.ocr.recognize(file)
    } catch (err) {
      error = `OCR failed: ${reason(err)}`
    }
    const ocrJson = ocr && JSON.stringify(ocr)
    if (ocr && !hasText(ocr)) {
      if (row.auto === 1) {
        // Auto mode also captures the bare scanning area once a card is lifted: nothing to keep.
        dropBareMat(db, deps.scansDir, row.id, ocrJson!, now())
        return
      }
      error = 'No text found in the capture'
    } else if (ocr) {
      try {
        decision = decide(readCard(ocr), lookups)
      } catch (err) {
        error = `Couldn't match the card: ${reason(err)}`
      }
    }
    // An uncertain printing is accepted only when nothing read contradicted the title, the one sign it may be misread.
    const accept =
      decision?.outcome === 'printing' && !decision.contradicted && getSettings(db).scanAcceptUncertainPrinting
    const confident = decision?.outcome === 'confident' || accept
    save(row, {
      status: confident ? 'confident' : 'review',
      method: 'ocr',
      reason: confident ? null : decision?.outcome === 'printing' ? 'printing' : 'unsure',
      cardId: decision?.card?.id ?? null,
      confidence: decision?.confidence ?? null,
      candidates: decision ? candidateIds(decision.candidates) : [],
      error,
      foil: decision?.reading.foil ?? false,
      ocrJson,
    })
  }

  /** Reads a scan, turning an unexpected failure into a review scan so no capture is ever lost. */
  async function guarded(row: ScanRow) {
    try {
      await readScan(row)
    } catch (err) {
      saveScanResult(
        db,
        row.id,
        {
          status: 'review', method: 'ocr', reason: 'unsure', cardId: null, finish: getSettings(db).scanDefaultFinish,
          confidence: null, candidates: [], error: err instanceof Error ? err.message : String(err), ocrJson: null,
        },
        now(),
      )
    }
  }

  function pump() {
    while (running < OCR_CONCURRENCY) {
      const row = claimNextScan(db, now())
      if (!row) break
      running++
      void guarded(row)
        .then(() => unsaved.delete(row.id))
        .finally(() => {
          running--
          pump()
        })
        .catch((err) => unsavable(row.id, err))
    }
    if (running === 0) {
      for (const resolve of waiting) resolve()
      waiting = []
    }
  }

  return {
    kick: pump,
    idle: () => (running === 0 ? Promise.resolve() : new Promise((resolve) => waiting.push(resolve))),
    recover() {
      requeueInterrupted(db)
      removeFinishedImages(db, deps.scansDir)
      pump()
    },
  }
}
