import fs from 'node:fs'

/**
 * Renaming and removing files on Windows, where a file another program has open can't be renamed, replaced or deleted
 * for a moment: antivirus scanning a file just written (a backup, the 80 MB card data download), the search indexer,
 * OneDrive, a backup agent. Those fail with EPERM, EACCES or EBUSY and pass on their own, so on Windows each call is
 * tried again, waiting a little longer each time, for up to RETRY_BUDGET_MS. Elsewhere it's one attempt, as before.
 */

/** The errors a file someone else has open gives on Windows. */
const LOCKED = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** How long a call keeps trying on Windows before it fails with the last error. */
export const RETRY_BUDGET_MS = 10_000

export interface RetryOptions {
  /** Whose rules apply: Windows tries again; any other platform tries once. Default: this one. */
  platform?: NodeJS.Platform
  /** How long to keep trying (default RETRY_BUDGET_MS). */
  budgetMs?: number
  /** Waits that many milliseconds (tests pass their own). Blocks for the sync calls, as the calls themselves do. */
  sleep?: (ms: number) => void | Promise<void>
}

/** Whether a failure is a file another program has open, which a moment's wait may get past. */
export function isLockedError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && LOCKED.has(code)
}

/** The waits between attempts: 50 ms, doubling up to a second each, until they add up to `budgetMs`. */
export function retryDelays(budgetMs: number): number[] {
  const delays: number[] = []
  let total = 0
  for (let delay = 50; total < budgetMs; delay = Math.min(delay * 2, 1000)) {
    const wait = Math.min(delay, budgetMs - total)
    delays.push(wait)
    total += wait
  }
  return delays
}

const blockFor = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Runs `attempt`; on Windows, while it fails with a locked file, waits and runs it again, within the budget. */
export function retrySync<T>(attempt: () => T, options: RetryOptions = {}): T {
  const { platform = process.platform, budgetMs = RETRY_BUDGET_MS, sleep = blockFor } = options
  const delays = platform === 'win32' ? retryDelays(budgetMs) : []
  for (let tried = 0; ; tried++) {
    try {
      return attempt()
    } catch (err) {
      if (tried >= delays.length || !isLockedError(err)) throw err
      void sleep(delays[tried]!)
    }
  }
}

/** retrySync for an asynchronous attempt, waiting without blocking. */
export async function retryAsync<T>(attempt: () => T | Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { platform = process.platform, budgetMs = RETRY_BUDGET_MS } = options
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const delays = platform === 'win32' ? retryDelays(budgetMs) : []
  for (let tried = 0; ; tried++) {
    try {
      return await attempt()
    } catch (err) {
      if (tried >= delays.length || !isLockedError(err)) throw err
      await sleep(delays[tried]!)
    }
  }
}

/** Renames `from` to `to`, replacing `to`; on Windows, tries again while either file is held open. */
export function renameWithRetry(from: string, to: string, options?: RetryOptions): void {
  retrySync(() => fs.renameSync(from, to), options)
}

/** renameWithRetry without blocking while it waits. */
export function renameWithRetryAsync(from: string, to: string, options?: RetryOptions): Promise<void> {
  return retryAsync(() => fs.promises.rename(from, to), options)
}

/**
 * Removes a file, if it's there; on Windows, tries again while it's held open. Its own loop rather than rmSync's
 * `maxRetries`, which applies only to `recursive` removes (and would take a folder in the file's place with it).
 */
export function removeWithRetry(file: string, options?: RetryOptions): void {
  retrySync(() => fs.rmSync(file, { force: true }), options)
}
