import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { libraryPaths } from '../../src/server/config.ts'
import { removeWithRetry, renameWithRetry, retrySync } from '../../src/server/fs-retry.ts'

/** What a library holds: owned copies and the cards they are, decks, scans waiting in the queue, and conversations. */
export interface LibrarySummary {
  copies: number
  cards: number
  decks: number
  scans: number
  conversations: number
}

/** Why the library wasn't copied, in one line; nothing was changed. */
export class MoveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MoveError'
  }
}

/** The folders that go with the database. Anything else beside it (the key file, the window's files, logs) stays. */
const FOLDERS = ['backups', 'bulk', 'scans'] as const

/** What the library at `dbPath` holds. Opened for writing, so it closes cleanly: not for a library that must stay as it is. */
export function librarySummary(dbPath: string): LibrarySummary {
  const db = new Database(dbPath, { fileMustExist: true })
  try {
    const get = (sql: string) => db.prepare(sql).pluck().get() as number
    return {
      copies: get('SELECT coalesce(sum(quantity), 0) FROM collection'),
      cards: get('SELECT count(DISTINCT c.oracle_id) FROM collection co JOIN cards c ON c.id = co.card_id'),
      decks: get('SELECT count(*) FROM decks'),
      scans: get("SELECT count(*) FROM scan_items WHERE status NOT IN ('committed', 'discarded')"),
      conversations: get('SELECT count(*) FROM ai_threads'),
    }
  } finally {
    db.close()
  }
}

/** Whether nothing was ever added to a library: no copies, decks, scans (even finished ones), or conversations. */
function untouched(dbPath: string): boolean {
  const db = new Database(dbPath, { fileMustExist: true })
  try {
    const used = ['collection', 'decks', 'scan_items', 'ai_threads'].some(
      (table) => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined,
    )
    return !used
  } finally {
    db.close()
  }
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** "7 copies of 2 cards, 1 deck", with scans and conversations when there are any. */
export function describeLibrary(s: LibrarySummary): string {
  return [
    `${count(s.copies, 'copy', 'copies')} of ${count(s.cards, 'card')}`,
    count(s.decks, 'deck'),
    ...(s.scans > 0 ? [`${count(s.scans, 'scan')} in the queue`] : []),
    ...(s.conversations > 0 ? [count(s.conversations, 'conversation')] : []),
  ].join(', ')
}

/** How the desktop app is named, quit, and opened on each platform, for pnpm move-library's lines. */
export function desktopWords(platform: NodeJS.Platform = process.platform): { app: string; quit: string; open: string } {
  if (platform === 'darwin') return { app: 'Binder.app', quit: 'Cmd+Q in Binder.app', open: 'Open Binder.app' }
  if (platform === 'win32') {
    return {
      app: 'the Binder app',
      quit: 'right-click its icon in the notification area → Quit Binder',
      open: 'Open Binder from the Start menu',
    }
  }
  return { app: 'the Binder app', quit: "Quit Binder in its icon's menu", open: 'Open the Binder app' }
}

/**
 * On Windows, the line saying an earlier pnpm move-library copied the library to the Mac's folder under the user's
 * (%USERPROFILE%\Library\Application Support\Binder), which nothing on Windows opens; null when it didn't.
 */
export function strayLibraryNote(platform: NodeJS.Platform, home: string, exists = fs.existsSync): string | null {
  if (platform !== 'win32') return null
  const stray = path.win32.join(home, 'Library', 'Application Support', 'Binder')
  if (!exists(path.win32.join(stray, 'binder.db'))) return null
  return `An earlier pnpm move-library copied your library to ${stray}, which Binder on Windows doesn't use: delete that folder once you've checked Binder.`
}

/** Removes a folder and what's in it; on Windows, tries again while a file in it is held open. */
const removeFolder = (dir: string) => retrySync(() => fs.rmSync(dir, { recursive: true, force: true }))

/**
 * Copies the library in `from` (the project's data/) to `to` (the desktop app's folder, spec §3.4). The copy is staged
 * in `to/.moving` and checked there first: the database through SQLite's backup, so it's whole even while its log
 * holds changes, then backups/, bulk/, and scans/. Nothing in `to` changes until all of it has checked out; then it's
 * put in place by renames, the database last, so a move stopped partway leaves no library and the next run starts
 * again. A library already in `to` is left alone, unless nothing was ever added to it (the app opened before the
 * move), which is replaced. `from` is only read, though SQLite may leave empty `binder.db-shm` and `binder.db-wal`
 * beside a closed source (the database file itself isn't changed). `platform` words the refusal. Returns what the copy
 * holds.
 */
export async function moveLibrary(
  from: string,
  to: string,
  { platform = process.platform }: { platform?: NodeJS.Platform } = {},
): Promise<LibrarySummary> {
  const source = libraryPaths(from).dbPath
  const target = libraryPaths(to).dbPath
  if (!fs.existsSync(source)) throw new MoveError(`No library in ${from}: nothing was copied.`)
  const replacing = fs.existsSync(target)
  if (replacing && !untouched(target)) {
    const { app } = desktopWords(platform)
    throw new MoveError(
      `${to} already has a library (${describeLibrary(librarySummary(target))}): nothing was copied. ` +
        `${app[0]!.toUpperCase()}${app.slice(1)}'s library is kept; to use this one instead, quit Binder, move that ` +
        'folder aside, and run pnpm move-library again.',
    )
  }
  // A killed run's staging is cleared; a failed one clears its own, so an untouched library in `to` stays whole.
  const staging = path.join(to, '.moving')
  const staged = libraryPaths(staging).dbPath
  fs.rmSync(staging, { recursive: true, force: true })
  try {
    fs.mkdirSync(staging, { recursive: true })
    const db = new Database(source, { readonly: true, fileMustExist: true })
    try {
      await db.backup(staged)
    } finally {
      db.close()
    }
    const copy = new Database(staged, { fileMustExist: true })
    const check = copy.pragma('integrity_check', { simple: true })
    copy.close()
    if (check !== 'ok') throw new MoveError(`The copy of the library didn't check out (${String(check)}): nothing was changed.`)
    for (const folder of FOLDERS) {
      const dir = path.join(from, folder)
      if (fs.existsSync(dir)) fs.cpSync(dir, path.join(staging, folder), { recursive: true, preserveTimestamps: true })
    }
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true })
    if (err instanceof MoveError) throw err
    throw new MoveError(`Couldn't copy the library (${err instanceof Error ? err.message : String(err)}): nothing was changed.`)
  }
  // On Windows, antivirus or the search indexer can hold a file just written for a moment: each removal and rename is
  // tried again while it does (fs-retry). One that still fails leaves the move unfinished, and a rerun finishes it.
  try {
    if (replacing) {
      for (const leftover of [target, `${target}-wal`, `${target}-shm`]) removeWithRetry(leftover)
      for (const folder of FOLDERS) removeFolder(path.join(to, folder))
    }
    for (const folder of FOLDERS) {
      const dir = path.join(staging, folder)
      if (!fs.existsSync(dir)) continue
      removeFolder(path.join(to, folder))
      renameWithRetry(dir, path.join(to, folder))
    }
    // The database goes in last: until it's there, a move stopped partway leaves no library, so the next run starts
    // again.
    renameWithRetry(staged, target)
  } catch (err) {
    throw new MoveError(
      `Couldn't put the copy in place (${err instanceof Error ? err.message : String(err)}): run pnpm move-library again.`,
    )
  }
  try {
    removeFolder(staging)
  } catch {
    // The library is in place; the empty staging folder left behind harms nothing.
  }
  return librarySummary(target)
}
