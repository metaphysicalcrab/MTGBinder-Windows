import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { autocomplete, insertCardRows, rebuildCardNames } from '../../src/server/cards/repo.ts'
import { CompactUnfinishedError, compactLibrary, librarySize } from '../../src/server/compact.ts'
import { openDb, type DB } from '../../src/server/db/index.ts'
import { compactFailure } from '../../src/server/settings-routes.ts'
import type { ApiErrorBody, LibrarySize } from '../../src/shared/types.ts'
import { body, makeApp } from '../helpers/app.ts'
import { fixtureRows } from '../helpers/db.ts'
import { tempDir } from '../helpers/tmp.ts'

let tmp: string
let db: DB
beforeEach(() => {
  tmp = tempDir('binder-compact-')
  db = openDb(path.join(tmp, 'binder.db'))
  insertCardRows(db, 'cards', fixtureRows())
  rebuildCardNames(db)
  // About 8 MB of free space, as an old card data import left.
  db.exec('CREATE TABLE junk (b BLOB)')
  const insert = db.prepare('INSERT INTO junk VALUES (zeroblob(4096))')
  db.transaction(() => {
    for (let i = 0; i < 2000; i++) insert.run()
  })()
  db.exec('DROP TABLE junk')
})
// Closed before its folder is removed (see tempDir).
afterEach(() => db.close())

const backups = () => path.join(tmp, 'backups')
const ftsIntact = () => {
  // FTS5's own check that the index matches the card names it is built from; it throws when they differ.
  db.prepare(`INSERT INTO card_names_fts (card_names_fts, rank) VALUES ('integrity-check', 1)`).run()
  return true
}

describe('compacting the library', () => {
  it('says how much of the file is free space', () => {
    const size = librarySize(db)
    expect(size.freeBytes).toBeGreaterThan(7_000_000)
    expect(size.bytes).toBeGreaterThan(size.freeBytes)
  })

  it('backs up first, gives back the free space, and keeps card-name search working', () => {
    const { before, after, backup } = compactLibrary(db, backups(), new Date(2026, 8, 28, 9))
    expect(backup).toBe(path.join(backups(), 'binder-2026-09-28.db'))
    expect(fs.existsSync(backup)).toBe(true)
    expect(after.freeBytes).toBeLessThan(64 * 1024) // rebuilding the index can leave a page or two
    expect(after.bytes).toBeLessThan(before.bytes - 7_000_000)
    expect(after.logBytes).toBe(0)
    expect(ftsIntact()).toBe(true)
    expect(autocomplete(db, 'lightning b').map((c) => c.name)).toContain('Lightning Bolt')
  })
})

describe('the library routes', () => {
  it('report the size, compact after a backup, and say why compacting failed', async () => {
    const app = makeApp({ db, backupDir: backups() })
    const size = await body<LibrarySize>(await app.request('/api/settings/library'))
    expect(size.freeBytes).toBeGreaterThan(7_000_000)
    const res = await app.request('/api/settings/library/compact', { method: 'POST' })
    expect(res.status).toBe(200)
    const done = await body<{ before: LibrarySize; after: LibrarySize; backup: string }>(res)
    expect(done.after.freeBytes).toBeLessThan(64 * 1024)
    expect(done.backup).toMatch(/^binder-\d{4}-\d{2}-\d{2}\.db$/)
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device')
    })
    onTestFinished(() => rename.mockRestore())
    const failed = await app.request('/api/settings/library/compact', { method: 'POST' })
    expect(failed.status).toBe(500)
    // The reason as it is, then what to do next.
    expect((await body<ApiErrorBody>(failed)).error).toEqual({
      code: 'compact_failed',
      message: "Couldn't compact the library: ENOSPC: no space left on device. Free up disk space and try again; the library is unchanged.",
    })
    expect((await makeApp({ db }).request('/api/settings/library/compact', { method: 'POST' })).status).toBe(404)
  })

  it('says what to do by the cause: a file another program holds, or a full disk where temporary files go', () => {
    const failure = (code: string, message: string) => compactFailure(Object.assign(new Error(message), { code }))
    const inUse = 'A file in the library folder is in use by another program (antivirus, OneDrive, or another Binder); try again in a moment'
    for (const code of ['EPERM', 'EBUSY', 'EACCES', 'SQLITE_BUSY']) {
      expect(failure(code, `${code}: the file is held.`)).toBe(`Couldn't compact the library: ${code}: the file is held. ${inUse}; the library is unchanged.`)
    }
    expect(failure('SQLITE_FULL', 'database or disk is full')).toBe(
      "Couldn't compact the library: database or disk is full. Free up disk space, on the library's drive and on the one that holds temporary files, and try again; the library is unchanged.",
    )
    expect(failure('ENOSPC', 'ENOSPC: no space left on device')).toBe(
      "Couldn't compact the library: ENOSPC: no space left on device. Free up disk space and try again; the library is unchanged.",
    )
  })

  it("says when the library was compacted but what follows didn't finish, so compacting again finishes it", async () => {
    const pragma = db.pragma.bind(db)
    const failing = vi.spyOn(db, 'pragma').mockImplementation(((source: string, options?: Database.PragmaOptions) => {
      if (source === 'wal_checkpoint(TRUNCATE)') throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR_TRUNCATE' })
      return pragma(source, options)
    }) as typeof db.pragma)
    onTestFinished(() => failing.mockRestore())
    expect(() => compactLibrary(db, backups())).toThrow(CompactUnfinishedError)
    expect(librarySize(db).freeBytes).toBeLessThan(64 * 1024) // VACUUM did its part
    const failed = await makeApp({ db, backupDir: backups() }).request('/api/settings/library/compact', { method: 'POST' })
    expect((await body<ApiErrorBody>(failed)).error).toEqual({
      code: 'compact_failed',
      message: "Couldn't finish compacting the library: disk I/O error. It was compacted; compact it again to finish.",
    })
  })
})
