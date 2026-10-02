import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { backupIfDue, backupNow, KEEP_BACKUPS, KEEP_EXTRA_BACKUPS, KEEP_UPGRADE_BACKUPS } from '../../src/server/backup.ts'
import { openDb, openFailureLine, openLibrary, type DB } from '../../src/server/db/index.ts'
import { getMeta, setMeta } from '../../src/server/db/meta.ts'
import { migrate, UpgradeBackupError, type MigrateOptions } from '../../src/server/db/migrate.ts'
import { tempDir } from '../helpers/tmp.ts'

let tmp: string
let db: DB
beforeEach(() => {
  // The folder is removed after every database in it is closed, this one and those a test opens (see tempDir).
  tmp = tempDir('binder-backup-')
  db = openDb(path.join(tmp, 'binder.db'))
  onTestFinished(() => {
    if (db.open) db.close()
  })
  db.prepare("INSERT INTO decks (name, format, status, created_at, updated_at) VALUES ('Burn', 'modern', 'built', 't', 't')").run()
})

const dir = () => path.join(tmp, 'backups')
const day = (n: number) => new Date(2026, 8, n, 9, 0, 0) // September n, 2026, 09:00 local

/** Makes removing any `.db` file fail (temporary `.db.tmp` files still go), and quiets and records console.error. */
function oldBackupsStuck() {
  const rmSync = fs.rmSync
  const rm = vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
    if (String(file).endsWith('.db')) throw new Error('EPERM: operation not permitted')
    rmSync(file, options)
  })
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => {
    rm.mockRestore()
    logged.mockRestore()
  })
  return logged
}

describe('backupIfDue', () => {
  it('writes a dated copy of the database and records when', () => {
    const file = path.join(dir(), 'binder-2026-09-26.db')
    expect(backupIfDue(db, dir(), day(26))).toEqual({ status: 'saved', file })
    const copy = new Database(file, { readonly: true })
    expect(copy.prepare('SELECT name FROM decks').pluck().all()).toEqual(['Burn'])
    copy.close()
    expect(getMeta(db, 'last_backup_at')).toBe(day(26).toISOString())
  })

  it('waits 24 hours between backups', () => {
    backupIfDue(db, dir(), day(26))
    expect(backupIfDue(db, dir(), new Date(day(26).getTime() + 23 * 3600_000))).toBeNull()
    expect(backupIfDue(db, dir(), new Date(day(26).getTime() + 25 * 3600_000))).toEqual({
      status: 'saved',
      file: path.join(dir(), 'binder-2026-09-27.db'),
    })
  })

  it('keeps only the newest 7 backups, leaving other files alone', () => {
    fs.mkdirSync(dir(), { recursive: true })
    fs.writeFileSync(path.join(dir(), 'notes.txt'), 'mine')
    for (let d = 1; d <= 9; d++) backupIfDue(db, dir(), day(d))
    const files = fs.readdirSync(dir()).sort()
    expect(files).toHaveLength(KEEP_BACKUPS + 1)
    expect(files[0]).toBe('binder-2026-09-03.db')
    expect(files).toContain('notes.txt')
  })

  it('never replaces an existing backup, even after an older one is restored', () => {
    backupIfDue(db, dir(), day(25))
    db.prepare("INSERT INTO decks (name, format, status, created_at, updated_at) VALUES ('Tron', 'modern', 'built', 't', 't')").run()
    backupIfDue(db, dir(), day(26))
    // Restore day 25's backup (stop, copy it over binder.db, delete the -wal and -shm files), then start again on day 26.
    db.close()
    fs.copyFileSync(path.join(dir(), 'binder-2026-09-25.db'), path.join(tmp, 'binder.db'))
    for (const suffix of ['-wal', '-shm']) fs.rmSync(path.join(tmp, `binder.db${suffix}`), { force: true })
    db = openDb(path.join(tmp, 'binder.db'))
    const restart = new Date(2026, 8, 26, 18, 0, 0)
    // Reported, so the start can say today's backup is already there.
    expect(backupIfDue(db, dir(), restart)).toEqual({ status: 'exists', file: path.join(dir(), 'binder-2026-09-26.db') })
    const copy = new Database(path.join(dir(), 'binder-2026-09-26.db'), { readonly: true })
    expect(copy.prepare('SELECT name FROM decks ORDER BY name').pluck().all()).toEqual(['Burn', 'Tron'])
    copy.close()
    expect(getMeta(db, 'last_backup_at')).toBe(restart.toISOString()) // not retried at every start today
  })

  it('recovers from an interrupted backup without keeping its partial file', () => {
    for (let d = 1; d <= 7; d++) backupIfDue(db, dir(), day(d))
    const partial = path.join(dir(), 'binder-2026-09-08.db.tmp') // day 8's backup was cut short
    fs.writeFileSync(partial, 'partial')
    expect(backupIfDue(db, dir(), day(8))).toEqual({ status: 'saved', file: path.join(dir(), 'binder-2026-09-08.db') })
    expect(fs.existsSync(partial)).toBe(false)
    expect(fs.readdirSync(dir()).sort()).toEqual([2, 3, 4, 5, 6, 7, 8].map((d) => `binder-2026-09-0${d}.db`))
    const copy = new Database(path.join(dir(), 'binder-2026-09-08.db'), { readonly: true })
    expect(copy.prepare('SELECT name FROM decks').pluck().all()).toEqual(['Burn'])
    copy.close()
  })

  it('counts a last backup dated in the future (the clock was once set ahead) as due', () => {
    setMeta(db, 'last_backup_at', new Date(2027, 0, 1).toISOString())
    expect(backupIfDue(db, dir(), day(26))).toEqual({ status: 'saved', file: path.join(dir(), 'binder-2026-09-26.db') })
    expect(getMeta(db, 'last_backup_at')).toBe(day(26).toISOString())
  })

  it('keeps the backup it saves when backups dated later (the clock was once set ahead) fill the week', () => {
    for (let d = 20; d <= 26; d++) backupIfDue(db, dir(), day(d))
    // The clock is put right: the last backup is dated in the future, so one is due, and it's the oldest by date.
    const file = path.join(dir(), 'binder-2026-09-09.db')
    expect(backupIfDue(db, dir(), day(9))).toEqual({ status: 'saved', file })
    expect(fs.readdirSync(dir()).sort()).toEqual(['binder-2026-09-09.db', ...[21, 22, 23, 24, 25, 26].map((d) => `binder-2026-09-${d}.db`)])
  })

  it('keeps a new backup when an old one cannot be removed, logging it for the next start to retry', () => {
    for (let d = 1; d <= 7; d++) backupIfDue(db, dir(), day(d))
    const logged = oldBackupsStuck()
    expect(backupIfDue(db, dir(), day(8))).toEqual({ status: 'saved', file: path.join(dir(), 'binder-2026-09-08.db') })
    expect(getMeta(db, 'last_backup_at')).toBe(day(8).toISOString())
    expect(fs.readdirSync(dir())).toHaveLength(8)
    expect(logged.mock.calls).toEqual([["[backup] Couldn't remove an old backup: EPERM: operation not permitted"]])
  })

  it('removes partial copies an interrupted backup left on any day, and nothing else', () => {
    backupIfDue(db, dir(), day(20))
    for (const file of ['binder-2026-09-21.db.tmp', 'binder-2026-09-19-before-004.db.tmp', 'notes.db.tmp', 'binder-2026-09-21.db.tmp.keep']) {
      fs.writeFileSync(path.join(dir(), file), 'left behind')
    }
    backupIfDue(db, dir(), day(26))
    expect(fs.readdirSync(dir()).sort()).toEqual(['binder-2026-09-20.db', 'binder-2026-09-21.db.tmp.keep', 'binder-2026-09-26.db', 'notes.db.tmp'])
  })

  it('removes its temporary copy when the backup fails, and reports the failure', () => {
    backupIfDue(db, dir(), day(25))
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device')
    })
    onTestFinished(() => rename.mockRestore())
    expect(() => backupIfDue(db, dir(), day(26))).toThrow('ENOSPC')
    expect(fs.readdirSync(dir())).toEqual(['binder-2026-09-25.db'])
    expect(getMeta(db, 'last_backup_at')).toBe(day(25).toISOString()) // so the next start tries again
  })
})

describe('backupNow (Settings → Back up now)', () => {
  it("writes today's backup, or another copy of it, never replacing one, and records the time", () => {
    backupIfDue(db, dir(), day(26))
    db.prepare("INSERT INTO decks (name, format, status, created_at, updated_at) VALUES ('Tron', 'modern', 'built', 't', 't')").run()
    const later = new Date(2026, 8, 26, 15, 0, 0)
    expect(backupNow(db, dir(), later)).toBe(path.join(dir(), 'binder-2026-09-26-2.db'))
    expect(backupNow(db, dir(), later)).toBe(path.join(dir(), 'binder-2026-09-26-3.db'))
    const copy = new Database(path.join(dir(), 'binder-2026-09-26-2.db'), { readonly: true })
    expect(copy.prepare('SELECT name FROM decks ORDER BY name').pluck().all()).toEqual(['Burn', 'Tron'])
    copy.close()
    expect(getMeta(db, 'last_backup_at')).toBe(later.toISOString())
    // The daily backup waits a day from it.
    expect(backupIfDue(db, dir(), new Date(later.getTime() + 23 * 3600_000))).toBeNull()
    expect(backupNow(db, dir(), day(27))).toBe(path.join(dir(), 'binder-2026-09-27.db'))
  })

  it("keeps its extra copies apart from the week of daily backups, the newest 3 by date and then copy, and leaves others' files", () => {
    fs.mkdirSync(dir(), { recursive: true })
    fs.writeFileSync(path.join(dir(), 'binder-2026-09-01-before-004.db'), 'an upgrade copy')
    for (let d = 1; d <= 5; d++) backupIfDue(db, dir(), day(d))
    // The first is day 6's daily backup; the other 10 are its extra copies, -2 to -11.
    for (let n = 1; n <= 11; n++) backupNow(db, dir(), day(6))
    const dailies = [1, 2, 3, 4, 5, 6].map((d) => `binder-2026-09-0${d}.db`)
    const extras = ['binder-2026-09-06-10.db', 'binder-2026-09-06-11.db', 'binder-2026-09-06-9.db']
    expect(KEEP_EXTRA_BACKUPS).toBe(3)
    expect(fs.readdirSync(dir()).sort()).toEqual([...dailies, ...extras, 'binder-2026-09-01-before-004.db'].sort())
    // And the daily backups' pruning keeps its 7 without counting the extra copies.
    backupIfDue(db, dir(), day(8))
    backupIfDue(db, dir(), day(9))
    expect(fs.readdirSync(dir()).sort()).toEqual(
      [...dailies.slice(1), 'binder-2026-09-08.db', 'binder-2026-09-09.db', ...extras, 'binder-2026-09-01-before-004.db'].sort(),
    )
  })

  it('keeps the backup it saves when the clock was once set ahead and later-dated backups fill the week', () => {
    for (let d = 20; d <= 26; d++) backupIfDue(db, dir(), day(d))
    const file = backupNow(db, dir(), day(9)) // the real date
    expect(file).toBe(path.join(dir(), 'binder-2026-09-09.db'))
    expect(fs.existsSync(file)).toBe(true) // so "Saved binder-2026-09-09.db." is true
    // It counts among the 7, in place of the oldest of the others.
    expect(fs.readdirSync(dir()).sort()).toEqual(['binder-2026-09-09.db', ...[21, 22, 23, 24, 25, 26].map((d) => `binder-2026-09-${d}.db`)])
  })
})

describe('backup before upgrading the database', () => {
  // Migrations of its own, so these tests don't depend on Binder's.
  let migrations: string
  let library: DB
  beforeEach(() => {
    migrations = path.join(tmp, 'migrations')
    fs.mkdirSync(migrations)
    addMigration('001_first.sql', 'CREATE TABLE first (x INTEGER);')
    library = new Database(path.join(tmp, 'library.db'))
  })
  afterEach(() => library.close())

  function addMigration(file: string, sql: string) {
    fs.writeFileSync(path.join(migrations, file), sql)
  }
  const upgrade = (options: MigrateOptions = {}) => migrate(library, { migrationsDir: migrations, backupDir: dir(), now: day(27), ...options })
  const tables = (db: DB) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all()
  const versions = (db: DB) => db.prepare('SELECT version FROM schema_migrations ORDER BY version').pluck().all()
  const backups = () => (fs.existsSync(dir()) ? fs.readdirSync(dir()).sort() : [])

  it('copies an existing database before applying a pending migration, holding the schema before it', () => {
    upgrade()
    library.prepare('INSERT INTO first VALUES (1)').run()
    addMigration('002_second.sql', 'CREATE TABLE second (y INTEGER);')
    const saved: string[] = []
    upgrade({ onBackup: (file) => saved.push(file) })
    const file = path.join(dir(), 'binder-2026-09-27-before-002.db')
    expect(saved).toEqual([file])
    expect(backups()).toEqual(['binder-2026-09-27-before-002.db'])
    const copy = new Database(file, { readonly: true })
    expect(tables(copy)).toEqual(['first', 'schema_migrations'])
    expect(versions(copy)).toEqual([1])
    expect(copy.prepare('SELECT x FROM first').pluck().all()).toEqual([1])
    copy.close()
    expect(tables(library)).toEqual(['first', 'schema_migrations', 'second'])
    expect(versions(library)).toEqual([1, 2])
  })

  it('names the copy after the first of several pending migrations, and makes one copy for them all', () => {
    upgrade()
    addMigration('002_second.sql', 'CREATE TABLE second (y INTEGER);')
    addMigration('003_third.sql', 'CREATE TABLE third (z INTEGER);')
    upgrade()
    expect(backups()).toEqual(['binder-2026-09-27-before-002.db'])
    expect(versions(library)).toEqual([1, 2, 3])
  })

  it('migrates a new, empty database without a copy, and copies nothing when nothing is pending', () => {
    const saved: string[] = []
    upgrade({ onBackup: (file) => saved.push(file) })
    upgrade({ onBackup: (file) => saved.push(file) })
    expect(saved).toEqual([])
    expect(backups()).toEqual([])
    expect(versions(library)).toEqual([1])
  })

  it('makes no copy without a backups folder (tests, in-memory databases)', () => {
    upgrade()
    addMigration('002_second.sql', 'CREATE TABLE second (y INTEGER);')
    upgrade({ backupDir: undefined })
    expect(backups()).toEqual([])
    expect(versions(library)).toEqual([1, 2])
  })

  it("refuses to upgrade when the copy fails, leaving the database as it was and no partial copy", () => {
    upgrade()
    addMigration('002_second.sql', 'CREATE TABLE second (y INTEGER);')
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device')
    })
    onTestFinished(() => rename.mockRestore())
    expect(() => upgrade()).toThrow(
      "Couldn't back up the database before upgrading it, so it was not changed: ENOSPC: no space left on device",
    )
    expect(backups()).toEqual([])
    expect(tables(library)).toEqual(['first', 'schema_migrations'])
    expect(versions(library)).toEqual([1])
  })

  it('refuses to upgrade when the backups folder cannot be made', () => {
    upgrade()
    addMigration('002_second.sql', 'CREATE TABLE second (y INTEGER);')
    fs.writeFileSync(dir(), 'a file where the folder should be')
    expect(() => upgrade()).toThrow(/^Couldn't back up the database before upgrading it, so it was not changed: /)
    expect(versions(library)).toEqual([1])
  })

  it('says when the copy starts, before making it, and where it went once made', () => {
    const events: string[] = []
    const options: MigrateOptions = {
      onBackupStart: () => events.push(`start, with ${backups().filter((f) => f.endsWith('.db')).length} copies`),
      onBackup: (file) => events.push(`saved ${path.basename(file)}`),
    }
    upgrade(options) // a new database: no copy, nothing to say
    addMigration('002_second.sql', 'CREATE TABLE second (y INTEGER);')
    upgrade(options)
    expect(events).toEqual(['start, with 0 copies', 'saved binder-2026-09-27-before-002.db'])
  })

  it('still upgrades when an old copy cannot be removed, keeping the new one and logging it', () => {
    upgrade()
    fs.mkdirSync(dir())
    for (const file of ['binder-2026-09-01-before-005.db', 'binder-2026-09-02-before-006.db', 'binder-2026-09-03-before-007.db']) {
      fs.writeFileSync(path.join(dir(), file), 'older')
    }
    addMigration('002_second.sql', 'CREATE TABLE second (y INTEGER);')
    const logged = oldBackupsStuck()
    const saved: string[] = []
    upgrade({ onBackup: (file) => saved.push(file) })
    expect(saved).toEqual([path.join(dir(), 'binder-2026-09-27-before-002.db')])
    expect(backups()).toHaveLength(4)
    expect(versions(library)).toEqual([1, 2])
    expect(logged.mock.calls).toEqual([["[backup] Couldn't remove an old backup: EPERM: operation not permitted"]])
  })

  it('removes partial copies an interrupted backup left on any day before copying', () => {
    upgrade()
    fs.mkdirSync(dir())
    for (const file of ['binder-2026-09-20-before-002.db.tmp', 'binder-2026-09-20.db.tmp', 'notes.db.tmp']) {
      fs.writeFileSync(path.join(dir(), file), 'left behind')
    }
    addMigration('002_second.sql', 'CREATE TABLE second (y INTEGER);')
    upgrade()
    expect(backups()).toEqual(['binder-2026-09-27-before-002.db', 'notes.db.tmp'])
  })

  it('never replaces an earlier copy for the same migration that day', () => {
    upgrade()
    addMigration('002_second.sql', 'CREATE TABLE second (y INTEGER);')
    fs.mkdirSync(dir())
    fs.writeFileSync(path.join(dir(), 'binder-2026-09-27-before-002.db'), 'an earlier copy, maybe of newer data')
    const saved: string[] = []
    upgrade({ onBackup: (file) => saved.push(file) })
    expect(saved).toEqual([path.join(dir(), 'binder-2026-09-27-before-002-2.db')])
    expect(fs.readFileSync(path.join(dir(), 'binder-2026-09-27-before-002.db'), 'utf8')).toBe('an earlier copy, maybe of newer data')
  })

  it('counts later copies of one day as newer when pruning', () => {
    upgrade()
    addMigration('002_second.sql', 'CREATE TABLE second (y INTEGER);')
    fs.mkdirSync(dir())
    for (const suffix of ['', '-2', '-3']) fs.writeFileSync(path.join(dir(), `binder-2026-09-27-before-002${suffix}.db`), 'earlier')
    upgrade()
    expect(backups()).toEqual(['binder-2026-09-27-before-002-2.db', 'binder-2026-09-27-before-002-3.db', 'binder-2026-09-27-before-002-4.db'])
  })

  it('numbers a new copy after the last one kept, even once the first of the day was pruned', () => {
    upgrade()
    addMigration('002_second.sql', 'CREATE TABLE second (y INTEGER);')
    fs.mkdirSync(dir())
    for (const suffix of ['-2', '-3', '-4']) fs.writeFileSync(path.join(dir(), `binder-2026-09-27-before-002${suffix}.db`), 'earlier')
    const saved: string[] = []
    upgrade({ onBackup: (file) => saved.push(file) })
    // Not the free first name, which pruning would take for the oldest and remove at once.
    expect(saved).toEqual([path.join(dir(), 'binder-2026-09-27-before-002-5.db')])
    expect(backups()).toEqual(['binder-2026-09-27-before-002-3.db', 'binder-2026-09-27-before-002-4.db', 'binder-2026-09-27-before-002-5.db'])
  })

  it('keeps a copy before an earlier migration saved on a day with three copies before a later one', () => {
    // Three copies before 003 were saved today; then a library from before 002 is restored and upgraded again.
    upgrade()
    addMigration('002_second.sql', 'CREATE TABLE second (y INTEGER);')
    fs.mkdirSync(dir())
    for (const suffix of ['', '-2', '-3']) fs.writeFileSync(path.join(dir(), `binder-2026-09-27-before-003${suffix}.db`), 'earlier')
    const saved: string[] = []
    upgrade({ onBackup: (file) => saved.push(file) })
    expect(saved).toEqual([path.join(dir(), 'binder-2026-09-27-before-002.db')])
    // It counts among the 3, in place of the oldest of the others.
    expect(backups()).toEqual(['binder-2026-09-27-before-002.db', 'binder-2026-09-27-before-003-2.db', 'binder-2026-09-27-before-003-3.db'])
  })

  it('keeps the newest 3 copies, apart from the daily backups', () => {
    upgrade({ now: day(1) })
    fs.mkdirSync(dir())
    const daily = [1, 2, 3, 4, 5, 6, 7, 8].map((d) => `binder-2026-09-0${d}.db`)
    for (const file of daily) fs.writeFileSync(path.join(dir(), file), 'daily')
    fs.writeFileSync(path.join(dir(), 'binder-2026-09-02-before-002-2.db'), 'a second copy that day')
    for (let v = 2; v <= 6; v++) {
      addMigration(`00${v}_m${v}.sql`, `CREATE TABLE m${v} (x INTEGER);`)
      upgrade({ now: day(v) })
    }
    expect(KEEP_UPGRADE_BACKUPS).toBe(3)
    expect(backups()).toEqual(
      [...daily, 'binder-2026-09-04-before-004.db', 'binder-2026-09-05-before-005.db', 'binder-2026-09-06-before-006.db'].sort(),
    )
    // A daily backup keeps its own 7 and leaves these alone.
    setMeta(db, 'last_backup_at', day(8).toISOString())
    backupIfDue(db, dir(), day(9))
    expect(backups().filter((f) => f.includes('before'))).toEqual([
      'binder-2026-09-04-before-004.db',
      'binder-2026-09-05-before-005.db',
      'binder-2026-09-06-before-006.db',
    ])
    expect(backups().filter((f) => !f.includes('before'))).toHaveLength(KEEP_BACKUPS)
  })
})

describe('opening an existing library (openDb)', () => {
  const REAL_MIGRATIONS = new URL('../../src/server/db/migrations/', import.meta.url)
  const realVersions = () =>
    fs
      .readdirSync(REAL_MIGRATIONS)
      .filter((f) => /^\d{3}_.+\.sql$/.test(f))
      .map((f) => Number(f.slice(0, 3)))
      .sort((a, b) => a - b)

  /** A library file that an older Binder left at migration 001 (Binder's own 001_init.sql). */
  function libraryAt001(): string {
    const only001 = path.join(tmp, 'only-001')
    fs.mkdirSync(only001)
    fs.copyFileSync(new URL('001_init.sql', REAL_MIGRATIONS), path.join(only001, '001_init.sql'))
    const file = path.join(tmp, 'at-001.db')
    const raw = new Database(file)
    migrate(raw, { migrationsDir: only001 })
    raw.prepare("INSERT INTO decks (name, format, status, created_at, updated_at) VALUES ('Old', 'modern', 'built', 't', 't')").run()
    raw.close()
    return file
  }
  const versions = (db: DB) => db.prepare('SELECT version FROM schema_migrations ORDER BY version').pluck().all()

  it('copies it to the backups folder before upgrading it', () => {
    const file = libraryAt001()
    const saved: string[] = []
    const library = openDb(file, { backupDir: dir(), onBackup: (copy) => saved.push(copy) })
    onTestFinished(() => {
      library.close()
    })
    const copies = fs.readdirSync(dir())
    expect(copies).toHaveLength(1)
    expect(copies[0]).toMatch(/^binder-\d{4}-\d{2}-\d{2}-before-002\.db$/)
    expect(saved).toEqual([path.join(dir(), copies[0]!)])
    const copy = new Database(path.join(dir(), copies[0]!), { readonly: true })
    expect(versions(copy)).toEqual([1])
    expect(copy.prepare('SELECT name FROM decks').pluck().all()).toEqual(['Old'])
    copy.close()
    expect(versions(library)).toEqual(realVersions())
  })

  it('opens the library for the server and scripts, saying when it backs it up', () => {
    const file = libraryAt001()
    const said = vi.spyOn(console, 'log').mockImplementation(() => {})
    onTestFinished(() => said.mockRestore())
    const library = openLibrary(file, dir())
    onTestFinished(() => {
      library.close()
    })
    const [copy] = fs.readdirSync(dir())
    expect(said.mock.calls).toEqual([
      ['[backup] Backing up the database before upgrading it…'],
      [`[backup] Saved ${path.join(dir(), copy!)} before upgrading the database`],
    ])
    expect(versions(library)).toEqual(realVersions())
  })

  it('exits with one line, and the library unchanged, when the copy fails', () => {
    const file = libraryAt001()
    fs.writeFileSync(dir(), 'a file where the folder should be')
    const said = vi.spyOn(console, 'log').mockImplementation(() => {})
    const failed = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${code}`)
    })
    onTestFinished(() => {
      said.mockRestore()
      failed.mockRestore()
      exit.mockRestore()
    })
    expect(() => openLibrary(file, dir())).toThrow('exit 1')
    expect(failed.mock.calls).toHaveLength(1)
    const [line] = failed.mock.calls[0]!
    expect(line).toMatch(/^\[backup\] Couldn't back up the database before upgrading it, so it was not changed: E[A-Z]+: /)
    expect(line).not.toContain('\n')
    const raw = new Database(file, { readonly: true })
    expect(versions(raw)).toEqual([1])
    raw.close()
  })

  it('makes no copy when opened without a backups folder', () => {
    const file = libraryAt001()
    const library = openDb(file)
    onTestFinished(() => {
      library.close()
    })
    expect(fs.existsSync(dir())).toBe(false)
    expect(versions(library)).toEqual(realVersions())
  })
})

describe('openFailureLine', () => {
  it("prints a failed pre-upgrade copy as a backup problem, without repeating its cause", () => {
    const cause = new Error('ENOSPC: no space left on device')
    expect(openFailureLine(new UpgradeBackupError(cause))).toBe(
      "[backup] Couldn't back up the database before upgrading it, so it was not changed: ENOSPC: no space left on device",
    )
  })

  it("prints any other failure as a database problem, adding a cause it doesn't mention", () => {
    expect(openFailureLine(new Error('file is not a database'))).toBe('[database] file is not a database')
    expect(openFailureLine(new Error('Migration 004 failed', { cause: new Error('duplicate column name: auto') }))).toBe(
      '[database] Migration 004 failed: duplicate column name: auto',
    )
    expect(openFailureLine('odd')).toBe('[database] odd')
  })
})
