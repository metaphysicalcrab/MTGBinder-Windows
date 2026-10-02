import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { openDb } from '../../src/server/db/index.ts'
import { migrate } from '../../src/server/db/migrate.ts'
import { getMeta, setMeta } from '../../src/server/db/meta.ts'
import { compileFilter } from '../../src/server/search/compile.ts'
import { parseSearch } from '../../src/shared/search/parse.ts'
import { createTestDb } from '../helpers/db.ts'
import { tempDir } from '../helpers/tmp.ts'

describe('database', () => {
  it('creates every table from the spec', () => {
    const db = openDb(':memory:')
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as string[]
    for (const table of [
      'cards', 'card_names', 'card_names_fts', 'collection', 'decks', 'deck_cards',
      'scan_items', 'ai_threads', 'ai_messages', 'meta', 'schema_migrations', 'playtest_game', 'playtest_actions', 'tokens',
      'card_tokens',
    ]) {
      expect(names).toContain(table)
    }
  })

  it('applies each migration only once', () => {
    const db = openDb(':memory:')
    const before = db.prepare('SELECT count(*) FROM schema_migrations').pluck().get()
    migrate(db)
    expect(db.prepare('SELECT count(*) FROM schema_migrations').pluck().get()).toBe(before)
  })

  it('enforces foreign keys', () => {
    const db = openDb(':memory:')
    expect(() =>
      db.prepare(
        "INSERT INTO collection (card_id, finish, quantity, added_at, updated_at) VALUES ('missing', 'nonfoil', 1, 't', 't')",
      ).run(),
    ).toThrow(/FOREIGN KEY/)
  })

  it('creates parent directories and sets the pragmas for file databases', () => {
    const dir = tempDir('binder-db-')
    const db = openDb(path.join(dir, 'nested', 'test.db'))
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
      expect(db.pragma('synchronous', { simple: true })).toBe(1) // NORMAL
      expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
      expect(db.pragma('mmap_size', { simple: true })).toBe(1073741824)
      expect(db.pragma('journal_size_limit', { simple: true })).toBe(67108864)
    } finally {
      db.close()
    }
  })

  it("closes a file it can't open as a library, so it can be replaced or deleted (Windows won't while it's open)", () => {
    const dir = tempDir('binder-db-')
    const file = path.join(dir, 'binder.db')
    fs.writeFileSync(file, 'this is not a database')
    const close = vi.spyOn(Database.prototype, 'close')
    onTestFinished(() => close.mockRestore())
    expect(() => openDb(file)).toThrow('file is not a database')
    expect(close).toHaveBeenCalledOnce()
    fs.rmSync(file)
  })

  // Over 100 MB written and folded back in: slow where antivirus checks each write (Windows), so it gets 30 s.
  it('keeps at most 64 MB of the write-ahead log on disk once a large write is checkpointed', () => {
    const dir = tempDir('binder-db-')
    const file = path.join(dir, 'test.db')
    const db = openDb(file)
    onTestFinished(() => {
      db.close()
    })
    const MB = 1024 * 1024
    // As a card-data refresh does: one transaction far larger than the limit fills the log.
    db.exec('CREATE TABLE big (b BLOB)')
    db.prepare(
      'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100) INSERT INTO big SELECT zeroblob(?) FROM n',
    ).run(MB)
    expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(100 * MB)
    db.pragma('wal_checkpoint(PASSIVE)')
    // The next write starts the log over, and gives back what's past the limit.
    db.exec('DELETE FROM big')
    expect(fs.statSync(`${file}-wal`).size).toBeLessThanOrEqual(64 * MB)
  }, 30_000)

  it("registers the search compiler's SQL functions, so a compiled filter runs on any freshly opened database", () => {
    const db = createTestDb() // through openDb, never through the search routes
    const parsed = parseSearch('!"insectile aberration"')
    if (!parsed.ok) throw new Error(parsed.error.message)
    const filter = compileFilter(parsed.ast, 'cards')
    expect(filter.sql).toContain('faces_include')
    expect(db.prepare(`SELECT c.name FROM cards c WHERE ${filter.sql}`).pluck().all(filter.params)).toEqual([
      'Delver of Secrets // Insectile Aberration',
    ])
    db.close()
  })

  it('reads, overwrites, and deletes meta values', () => {
    const db = openDb(':memory:')
    expect(getMeta(db, 'k')).toBeNull()
    setMeta(db, 'k', 'v1')
    setMeta(db, 'k', 'v2')
    expect(getMeta(db, 'k')).toBe('v2')
    setMeta(db, 'k', null)
    expect(getMeta(db, 'k')).toBeNull()
  })
})
