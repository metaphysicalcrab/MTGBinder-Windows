import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { insertCardRows, rebuildCardNames } from '../../src/server/cards/repo.ts'
import { openDb } from '../../src/server/db/index.ts'
import { librarySummary, moveLibrary, MoveError } from '../../scripts/lib/move.ts'
import { fixtureRows } from '../helpers/db.ts'
import { deck, own } from '../helpers/library.ts'
import { tempDir } from '../helpers/tmp.ts'

const scratch = () => tempDir('binder-move-')

/** A library in `dir` with card data, 7 copies of 2 cards, and a deck, plus the files a library keeps beside it. */
function library(dir: string) {
  const db = openDb(path.join(dir, 'binder.db'))
  insertCardRows(db, 'cards', fixtureRows())
  rebuildCardNames(db)
  own(db, 'Lightning Bolt', 'm10', 4)
  own(db, 'Llanowar Elves', undefined, 3)
  deck(db, 'Elves', 'built')
  for (const [file, text] of [['backups/binder-2026-09-27.db', 'backup'], ['bulk/default-cards.json', '[]'], ['scans/1.jpg', 'jpeg']]) {
    fs.mkdirSync(path.dirname(path.join(dir, file!)), { recursive: true })
    fs.writeFileSync(path.join(dir, file!), text!)
  }
  // Not the library's: the key file, the window's own files, and logs stay where they are.
  fs.writeFileSync(path.join(dir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-test-0000\n')
  fs.mkdirSync(path.join(dir, 'Electron'))
  fs.mkdirSync(path.join(dir, 'Logs'))
  return db
}

describe('moveLibrary (spec §3.4)', () => {
  it('copies the database whole, even with changes still in its log, with its backups, card data, and scans', async () => {
    const dir = scratch()
    const from = path.join(dir, 'data')
    const to = path.join(dir, 'Application Support', 'Binder')
    fs.mkdirSync(from)
    // Left open: its latest changes are still in the write-ahead log, not the database file.
    const open = library(from)
    onTestFinished(() => {
      open.close()
    })
    expect(await moveLibrary(from, to)).toEqual({ copies: 7, cards: 2, decks: 1, scans: 0, conversations: 0 })
    expect(librarySummary(path.join(to, 'binder.db'))).toMatchObject({ copies: 7, decks: 1 })
    for (const file of ['backups/binder-2026-09-27.db', 'bulk/default-cards.json', 'scans/1.jpg']) {
      expect(fs.readFileSync(path.join(to, file), 'utf8')).toBe(fs.readFileSync(path.join(from, file), 'utf8'))
    }
    expect(fs.readdirSync(to).sort()).toEqual(['backups', 'binder.db', 'bulk', 'scans'])
    // The original is left as it was.
    expect(librarySummary(path.join(from, 'binder.db'))).toMatchObject({ copies: 7, decks: 1 })
    expect(fs.existsSync(path.join(from, '.env'))).toBe(true)
  })

  it('leaves a library that has anything in it alone, but replaces one nothing was ever added to', async () => {
    const dir = scratch()
    const from = path.join(dir, 'data')
    const to = path.join(dir, 'Binder')
    fs.mkdirSync(from)
    library(from).close()
    // Binder.app opened before the move: a new library with card data and its first backup, and nothing else.
    fs.mkdirSync(path.join(to, 'backups'), { recursive: true })
    const fresh = openDb(path.join(to, 'binder.db'))
    insertCardRows(fresh, 'cards', fixtureRows())
    fresh.close()
    fs.writeFileSync(path.join(to, 'backups', 'binder-2026-09-28.db'), 'empty library backup')
    expect(await moveLibrary(from, to)).toMatchObject({ copies: 7, decks: 1 })
    expect(fs.existsSync(path.join(to, 'backups', 'binder-2026-09-28.db'))).toBe(false)
    // Now it holds a collection: a second move refuses, and changes nothing.
    await expect(moveLibrary(from, to)).rejects.toThrow(
      new MoveError(
        `${to} already has a library (7 copies of 2 cards, 1 deck): nothing was copied. Binder.app's library is kept; ` +
          'to use this one instead, quit Binder, move that folder aside, and run pnpm move-library again.',
      ),
    )
  })

  it('says so when there is no library to move', async () => {
    const dir = scratch()
    await expect(moveLibrary(path.join(dir, 'data'), path.join(dir, 'Binder'))).rejects.toThrow(
      new MoveError(`No library in ${path.join(dir, 'data')}: nothing was copied.`),
    )
  })

  it('changes nothing when the copy fails partway, and a rerun then works', async () => {
    const dir = scratch()
    const from = path.join(dir, 'data')
    const to = path.join(dir, 'Binder')
    fs.mkdirSync(from)
    library(from).close()
    // Binder.app opened before the move: an untouched library, with its own backup.
    fs.mkdirSync(path.join(to, 'backups'), { recursive: true })
    const fresh = openDb(path.join(to, 'binder.db'))
    insertCardRows(fresh, 'cards', fixtureRows())
    fresh.close()
    fs.writeFileSync(path.join(to, 'backups', 'binder-2026-09-28.db'), 'empty library backup')
    // The folders' copy fails after the database is copied, as a full disk or Ctrl+C would. (Not by taking a file's
    // permissions away: root, and Windows, read it anyway.)
    const copy = vi.spyOn(fs, 'cpSync').mockImplementationOnce(() => {
      throw new Error("ENOSPC: no space left on device, copyfile 'scans/1.jpg'")
    })
    onTestFinished(() => copy.mockRestore())
    const failure = await moveLibrary(from, to).catch((err: unknown) => err)
    expect(copy).toHaveBeenCalledOnce()
    expect(failure).toBeInstanceOf(MoveError)
    expect((failure as MoveError).message).toMatch(/^Couldn't copy the library \(.+\): nothing was changed\.$/)
    expect(librarySummary(path.join(to, 'binder.db'))).toMatchObject({ copies: 0 })
    expect(fs.existsSync(path.join(to, 'backups', 'binder-2026-09-28.db'))).toBe(true)
    expect(fs.existsSync(path.join(to, '.moving'))).toBe(false)
    // Once the copy can be made, the move goes through.
    expect(await moveLibrary(from, to)).toEqual({ copies: 7, cards: 2, decks: 1, scans: 0, conversations: 0 })
  })

  it('clears what a killed move left behind', async () => {
    const dir = scratch()
    const from = path.join(dir, 'data')
    const to = path.join(dir, 'Binder')
    fs.mkdirSync(from)
    library(from).close()
    fs.mkdirSync(path.join(to, '.moving'), { recursive: true })
    fs.writeFileSync(path.join(to, '.moving', 'junk'), 'left by a killed run')
    expect(await moveLibrary(from, to)).toMatchObject({ copies: 7, decks: 1 })
    expect(fs.existsSync(path.join(to, '.moving'))).toBe(false)
    expect(fs.readdirSync(to).sort()).toEqual(['backups', 'binder.db', 'bulk', 'scans'])
  })
})
