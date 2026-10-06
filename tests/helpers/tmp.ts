import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { onTestFinished } from 'vitest'

/**
 * A temporary folder, removed when the test ends. Call it first (in the test, or in beforeEach), before opening
 * anything in it: cleanups run last-registered first, so a database opened later is closed (closeAtEnd) before its
 * folder goes, which Windows requires (it won't delete a file SQLite has open). The removal tries again for a moment
 * while antivirus or the search indexer has a file in it open.
 */
export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return dir
}

/** Closes `db` when the test ends, before the folder it's in is removed, unless the test closed it already. */
export function closeAtEnd<T extends { readonly open: boolean; close(): unknown }>(db: T): T {
  onTestFinished(() => {
    if (db.open) db.close()
  })
  return db
}
