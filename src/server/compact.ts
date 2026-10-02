import fs from 'node:fs'
import type { LibrarySize } from '../shared/types.ts'
import { backupNow } from './backup.ts'
import type { DB } from './db/index.ts'

const fileBytes = (file: string) => {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** How big the library is, how much of it is free space compacting would give back, and its write-ahead log. */
export function librarySize(db: DB): LibrarySize {
  const pageSize = db.pragma('page_size', { simple: true }) as number
  const pages = db.pragma('page_count', { simple: true }) as number
  const free = db.pragma('freelist_count', { simple: true }) as number
  return { bytes: pages * pageSize, freeBytes: free * pageSize, logBytes: db.memory ? 0 : fileBytes(`${db.name}-wal`) }
}

/** What compacting did: the sizes before and after, and the backup made first. */
export interface CompactResult {
  before: LibrarySize
  after: LibrarySize
  backup: string
}

/**
 * A failure after VACUUM rewrote the library: it was compacted, but the steps after it (the card-name index, emptying
 * the log) didn't all finish. Compacting again finishes them. Its cause is the error itself.
 */
export class CompactUnfinishedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'CompactUnfinishedError'
  }
}

/**
 * Compacts the library (Settings → Compact the library). It first backs it up (as Back up now does). Then it
 * rewrites the file without its free space (VACUUM), rebuilds the card-name index, and empties the write-ahead log
 * into the file. The index is keyed by `card_names`' rowids, which SQLite doesn't promise VACUUM keeps for a table
 * without an INTEGER PRIMARY KEY, so it's rebuilt from the names rather than trusted. A failure in the backup or in
 * VACUUM leaves the library as it was; one after VACUUM is a CompactUnfinishedError.
 */
export function compactLibrary(db: DB, backupDir: string, now = new Date()): CompactResult {
  const before = librarySize(db)
  const backup = backupNow(db, backupDir, now)
  db.exec('VACUUM')
  try {
    db.exec(`INSERT INTO card_names_fts (card_names_fts) VALUES ('rebuild')`)
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch (err) {
    throw new CompactUnfinishedError(err)
  }
  return { before, after: librarySize(db), backup }
}
