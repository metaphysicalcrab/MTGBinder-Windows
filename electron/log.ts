import fs from 'node:fs'
import { renameWithRetry } from '../src/server/fs-retry.ts'

/** How long the rename may be tried again on Windows: a moment, since Binder's window waits on it. */
const ROTATE_BUDGET_MS = 500

/**
 * Starts a new log for this run, keeping the one before as `previous`. On Windows a program reading the log (an
 * editor, `Get-Content -Wait`, antivirus) can keep it from being renamed: that's tried again for a moment, then the
 * log is copied and emptied instead, and if even that fails this run's log follows the last one's. It never throws:
 * a log that can't be rotated mustn't keep Binder from starting.
 */
export function rotateLog(file: string, previous: string, platform: NodeJS.Platform = process.platform): void {
  if (!fs.existsSync(file)) return
  try {
    renameWithRetry(file, previous, { platform, budgetMs: ROTATE_BUDGET_MS })
    return
  } catch {
    // Copied and emptied instead, below.
  }
  try {
    fs.copyFileSync(file, previous)
    fs.truncateSync(file, 0)
  } catch {
    // Neither: this run's log is added to the last one's.
  }
}
