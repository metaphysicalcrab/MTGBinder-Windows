import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { registerSearchFunctions } from '../search/compile.ts'
import { migrate, UpgradeBackupError, type MigrateOptions } from './migrate.ts'

export type DB = Database.Database

/**
 * Opens (creating if needed) the SQLite database, applies pragmas, registers the search compiler's SQL functions, and
 * runs pending migrations. Pass `backupDir` when opening the owner's library, so an existing database is copied there
 * before a migration upgrades it (see migrate). When any of that fails, the connection is closed before the error is
 * thrown: on Windows an open database's files can't be moved, replaced or deleted until it is.
 */
export function openDb(
  file: string,
  options: Pick<MigrateOptions, 'backupDir' | 'onBackupStart' | 'onBackup'> = {},
): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
    // A card-data refresh leaves the write-ahead log at full size: keep at most 64 MB of it on disk after a checkpoint.
    db.pragma('journal_size_limit = 67108864')
    // Read the ~450 MB card table through memory mapping: searches that scan it run 30–60% faster.
    db.pragma('mmap_size = 1073741824')
    registerSearchFunctions(db)
    migrate(db, options)
  } catch (err) {
    db.close()
    throw err
  }
  return db
}

/**
 * Opens the owner's library for the scripts (`pnpm setup`, `pnpm ocr:bench`; the server opens it in startBinder): an
 * existing library is copied to `backupDir` before a migration upgrades it, saying so. When the library can't be
 * opened, or that copy fails, prints one line (no stack) and exits with status 1; the library is left as it was.
 */
export function openLibrary(file: string, backupDir: string): DB {
  try {
    return openDb(file, {
      backupDir,
      onBackupStart: () => console.log('[backup] Backing up the database before upgrading it…'),
      onBackup: (copy) => console.log(`[backup] Saved ${copy} before upgrading the database`),
    })
  } catch (err) {
    console.error(openFailureLine(err))
    process.exit(1)
  }
}

/**
 * The line printed when the library can't be opened: `[backup]` for a failed copy before an upgrade, `[database]` for
 * anything else, then the error's message and its cause's when the message doesn't already include it.
 */
export function openFailureLine(err: unknown): string {
  const label = err instanceof UpgradeBackupError ? '[backup]' : '[database]'
  const message = err instanceof Error ? err.message : String(err)
  const reason = err instanceof Error ? err.cause : undefined
  const cause = reason === undefined ? '' : reason instanceof Error ? reason.message : String(reason)
  return `${label} ${cause !== '' && !message.includes(cause) ? `${message}: ${cause}` : message}`
}
