import fs from 'node:fs'
import path from 'node:path'
import type { BackupStatus } from '../shared/types.ts'
import type { DB } from './db/index.ts'
import { getMeta, setMeta } from './db/meta.ts'
import { removeWithRetry, renameWithRetry } from './fs-retry.ts'

const DAY_MS = 24 * 60 * 60 * 1000
/** Daily backups kept (spec §6): a week of them. */
export const KEEP_BACKUPS = 7
/** `binder-YYYY-MM-DD.db`: a day's backup, saved at a start or by that day's first Back up now. */
const BACKUP_FILE = /^binder-\d{4}-\d{2}-\d{2}\.db$/
/** Extra copies kept (Back up now's, on a day that already had its backup), apart from the daily backups. */
export const KEEP_EXTRA_BACKUPS = 3
/** `binder-YYYY-MM-DD-N.db` (N from 2): another backup that day, saved by Back up now. */
const EXTRA_BACKUP_FILE = /^binder-(\d{4}-\d{2}-\d{2})-(\d+)\.db$/
/** Copies saved before upgrading the database kept, apart from the daily backups. */
export const KEEP_UPGRADE_BACKUPS = 3
/** `binder-YYYY-MM-DD-before-NNN.db`, or `…-before-NNN-2.db` and on for another copy that day. */
const UPGRADE_BACKUP_FILE = /^binder-(\d{4}-\d{2}-\d{2})-before-(\d{3})(?:-(\d+))?\.db$/
/** A partial copy left by an interrupted backup of either kind, from any day. */
const PARTIAL_COPY = /^binder-.*\.db\.tmp$/

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** YYYY-MM-DD in local time. */
export function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Removes the partial copies that interrupted backups left in `dir`: a start killed mid-copy leaves one that can be
 * hundreds of MB, under a name no later backup reuses once the day has changed. Best effort: a failure is logged.
 */
function removePartialCopies(dir: string): void {
  try {
    for (const file of fs.readdirSync(dir).filter((f) => PARTIAL_COPY.test(f))) {
      fs.rmSync(path.join(dir, file), { force: true })
    }
  } catch (err) {
    console.error(`[backup] Couldn't remove a partial backup: ${messageOf(err)}`)
  }
}

/**
 * Prunes the backups named by `pattern`, the pool `written` (the backup just saved) belongs to, down to `keep`:
 * `written` and the newest `keep - 1` others (`order` sorts them oldest first; by name without it). The backup just
 * saved is never removed, even when the order puts it among the oldest: a daily backup when a clock once set ahead
 * gave others later dates, or a copy before an earlier migration on a day with copies before a later one.
 * Best effort: the new backup is already safe, so a failure is logged and the next backup tries again.
 */
function removeOldBackups(
  dir: string,
  written: string,
  pattern: RegExp,
  keep: number,
  order?: (a: string, b: string) => number,
): void {
  try {
    const name = path.basename(written)
    const others = fs.readdirSync(dir).filter((file) => file !== name && pattern.test(file))
    const newestFirst = others.sort(order).reverse()
    for (const old of newestFirst.slice(keep - 1)) fs.rmSync(path.join(dir, old), { force: true })
  } catch (err) {
    console.error(`[backup] Couldn't remove an old backup: ${messageOf(err)}`)
  }
}

/**
 * `<dir>/<name>.db`, or when copies by that name exist, `<name>-N.db` numbered after the last of them: an earlier
 * backup is never replaced, and a new copy is never numbered below one kept, which pruning would take for older.
 */
function unusedFile(dir: string, name: string): string {
  const copyOf = new RegExp(`^${name}(?:-(\\d+))?\\.db$`)
  let last = 0
  for (const file of fs.readdirSync(dir)) {
    const match = copyOf.exec(file)
    if (match) last = Math.max(last, Number(match[1] ?? 1))
  }
  return path.join(dir, last === 0 ? `${name}.db` : `${name}-${last + 1}.db`)
}

/**
 * Orders backup files named by `pattern` oldest first. The pattern's groups are the date, any others (the migration of
 * a pre-upgrade copy), and last which copy of that day it is: by date, the others, then the copy (the first has none).
 */
const byDateThenCopy =
  (pattern: RegExp) =>
  (a: string, b: string): number => {
    const key = (file: string) => {
      const [, date, ...rest] = pattern.exec(file) ?? []
      const copy = rest.at(-1) ?? '1'
      return `${date} ${rest.slice(0, -1).join(' ')} ${copy.padStart(6, '0')}`
    }
    return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0
  }

/**
 * Writes a compact copy of the database (VACUUM INTO, about half the live file's size) to `file`, under a temporary
 * name first so an interrupted copy never passes for a backup. A failed copy leaves no temporary file behind (or, when
 * even that can't be removed, the next backup's cleanup does). On Windows, renaming the copy waits out antivirus
 * scanning the file just written (see fs-retry).
 */
function copyDatabase(db: DB, file: string): void {
  const temp = `${file}.tmp`
  removeWithRetry(temp) // left by an interrupted backup; VACUUM INTO refuses to overwrite
  try {
    db.prepare('VACUUM INTO ?').run(temp)
    renameWithRetry(temp, file)
  } catch (err) {
    try {
      removeWithRetry(temp) // a partial copy can be hundreds of MB
    } catch {
      // removePartialCopies takes it at the next backup; the copy's own failure is the one to report.
    }
    throw err
  }
}

/** What backupIfDue did: saved today's backup, or found it already there. */
export interface DailyBackup {
  status: 'saved' | 'exists'
  file: string
}

/**
 * Backs up the database when the last backup is more than 24 hours old, or dated in the future (the clock was once
 * set ahead) (spec §6): a compact copy at `<dir>/binder-YYYY-MM-DD.db`, keeping a week of these daily backups (the
 * newest 7 by date, always counting the one just saved). Back up now's extra copies and the copies saved before an
 * upgrade are kept apart, and this pruning doesn't count them. It first removes partial copies interrupted backups left.
 * An existing backup for today is never replaced: after a restore it may hold newer data than the database.
 * Restore by stopping Binder and copying a backup over the library folder's binder.db (the project's data/, or the
 * desktop app's: ~/Library/Application Support/Binder on the Mac, %LOCALAPPDATA%\Binder on Windows), deleting
 * binder.db-wal and -shm.
 * Returns the backup it saved or found for today, or null when none was due.
 */
export function backupIfDue(db: DB, dir: string, now = new Date()): DailyBackup | null {
  const last = getMeta(db, 'last_backup_at')
  // Not due only while the last backup is under a day old: none, an unreadable date, or a future one is due.
  const since = last === null ? NaN : now.getTime() - Date.parse(last)
  if (since >= 0 && since < DAY_MS) return null
  fs.mkdirSync(dir, { recursive: true })
  removePartialCopies(dir)
  const file = path.join(dir, `binder-${localDate(now)}.db`)
  if (fs.existsSync(file)) {
    setMeta(db, 'last_backup_at', now.toISOString()) // so later starts today don't retry
    return { status: 'exists', file }
  }
  copyDatabase(db, file)
  setMeta(db, 'last_backup_at', now.toISOString())
  removeOldBackups(dir, file, BACKUP_FILE, KEEP_BACKUPS)
  return { status: 'saved', file }
}

/**
 * Backs up the database now (Settings → Back up now, spec §5.6). With no backup for today yet, it saves today's daily
 * backup, `<dir>/binder-YYYY-MM-DD.db`, kept with the daily backups (a week of them). Otherwise, since a backup is
 * never replaced, it saves an extra copy, `…-N.db` numbered after the day's last copy. Extra copies are kept apart:
 * the newest 3 by date and then copy, so pressing it often never costs an earlier day's backup. Only the pool of the
 * backup just saved is pruned, and never that backup. It records the time, so the next start's daily backup waits a
 * day from it, and it first removes partial copies interrupted backups left. Returns the backup's path.
 */
export function backupNow(db: DB, dir: string, now = new Date()): string {
  fs.mkdirSync(dir, { recursive: true })
  removePartialCopies(dir)
  const file = unusedFile(dir, `binder-${localDate(now)}`)
  copyDatabase(db, file)
  setMeta(db, 'last_backup_at', now.toISOString())
  if (BACKUP_FILE.test(path.basename(file))) removeOldBackups(dir, file, BACKUP_FILE, KEEP_BACKUPS)
  else removeOldBackups(dir, file, EXTRA_BACKUP_FILE, KEEP_EXTRA_BACKUPS, byDateThenCopy(EXTRA_BACKUP_FILE))
  return file
}

/** When the last backup was made, and where they are kept (Settings → Backups). */
export function backupStatus(db: DB, dir: string): BackupStatus {
  return { lastBackupAt: getMeta(db, 'last_backup_at'), folder: dir }
}

/**
 * Saves a compact copy of the database before a migration upgrades it: `<dir>/binder-YYYY-MM-DD-before-NNN.db`, NNN
 * being the first pending migration's number. An earlier copy by that name is never replaced (after a restore it may
 * hold newer data); the new copy is `…-before-NNN-2.db`, and so on. Keeps the newest 3 of these copies, always
 * counting this one; the other backups' pruning doesn't count them, and theirs doesn't count the others. It first
 * removes partial copies interrupted backups left. Returns the copy's path.
 */
export function backupBeforeUpgrade(db: DB, dir: string, version: string, now = new Date()): string {
  fs.mkdirSync(dir, { recursive: true })
  removePartialCopies(dir)
  const file = unusedFile(dir, `binder-${localDate(now)}-before-${version}`)
  copyDatabase(db, file)
  removeOldBackups(dir, file, UPGRADE_BACKUP_FILE, KEEP_UPGRADE_BACKUPS, byDateThenCopy(UPGRADE_BACKUP_FILE))
  return file
}
