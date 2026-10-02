import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { scryfallToRow } from '../../src/server/cards/map.ts'
import { insertCardRows, rebuildCardNames } from '../../src/server/cards/repo.ts'
import type { DB } from '../../src/server/db/index.ts'
import { createCardLookups } from '../../src/server/scanner/lookups.ts'
import type { CardLookups } from '../../src/server/scanner/matcher.ts'
import type { OcrLine, OcrResult } from '../../src/server/scanner/ocr-client.ts'
import { AUTO_ADDED_MS, countSkipped, listAutoAdded, SKIPPED_MS } from '../../src/server/scanner/repo.ts'
import { MAX_SCAN_BYTES } from '../../src/server/scanner/routes.ts'
import { createScanWorker, type ScanWorker } from '../../src/server/scanner/worker.ts'
import { updateSettings } from '../../src/server/settings.ts'
import type { ApiErrorBody, ScanCommitResult, ScanItem, ScanQueue } from '../../src/shared/types.ts'
import { body, makeApp } from '../helpers/app.ts'
import { createTestDb } from '../helpers/db.ts'
import { fixtureCard, syntheticCard } from '../helpers/fixtures.ts'
import { deck, inDeck } from '../helpers/library.ts'
import { tempDir } from '../helpers/tmp.ts'

const line = (text: string, y: number, x = 0.08): OcrLine => ({ text, confidence: 1, box: { x, y, w: 0.5, h: 0.02 } })
const bottom = (...texts: string[]) => texts.map((t, i) => line(t, 0.934 + i * 0.017))

/** What the stub OCR reads from each test "photo" (a JPEG header followed by one of these names). */
const PHOTOS: Record<string, OcrResult | Error> = {
  'bolt-m11': { width: 672, height: 936, lines: [line('Lightning Bolt', 0.06), ...bottom('149/249 C', 'M11 • EN Christopher Moeller')] },
  // On-device OCR reads a foil's ★ as *.
  'bolt-m11-foil': { width: 672, height: 936, lines: [line('Lightning Bolt', 0.06), ...bottom('149/249 C', 'M11 * EN Christopher Moeller')] },
  'bolt-sta': { width: 672, height: 936, lines: [line('Lightning Bolt', 0.06), ...bottom('0042 U', 'STA • EN')] },
  bolt: { width: 672, height: 936, lines: [line('Lightning Bolt', 0.06), line('Instant', 0.575)] },
  // No Lightning Bolt was printed in 1997 or 1998: the year read contradicts the title.
  'bolt-1997': { width: 672, height: 936, lines: [line('Lightning Bolt', 0.06), line('Instant', 0.575), ...bottom('TM & © 1997 Wizards of the Coast')] },
  elfs: { width: 672, height: 936, lines: [line('Llanowar Elfs', 0.06), line('Creature', 0.575)] },
  mystery: { width: 672, height: 936, lines: [line('Xqzv Plorp', 0.06), line('Creature', 0.575)] },
  blank: { width: 672, height: 936, lines: [] },
  broken: new Error('Text recognition failed'),
}
const photo = (name: string) => new Uint8Array([0xff, 0xd8, 0xff, ...Buffer.from(name)])
const photoName = (file: string) => fs.readFileSync(file).subarray(3).toString()

let db: DB
let scansDir: string
let lookups: CardLookups
let worker: ScanWorker
let app: ReturnType<typeof makeApp>
/** Photo names whose OCR fails for now, as when the helper can't be built. */
let failing: Set<string>
/** OCR answers once this settles, so a test can act while a scan is being identified. */
let gate: Promise<void>

beforeEach(() => {
  db = createTestDb()
  scansDir = tempDir('binder-scans-')
  failing = new Set()
  gate = Promise.resolve()
  lookups = createCardLookups(db)
  worker = createScanWorker({
    db,
    scansDir,
    lookups,
    saveRetryMs: 50,
    ocr: {
      recognize: async (file) => {
        const name = photoName(file)
        await gate
        if (failing.has(name)) throw new Error("Couldn't build the OCR helper")
        const result = PHOTOS[name]!
        if (result instanceof Error) throw result
        return result
      },
      close: () => {},
    },
  })
  app = makeApp({ db, scanner: { scansDir, worker } })
})
// The scans folder goes once nothing is being identified (see tempDir).
afterEach(() => worker.idle())

const capture = (name: string, auto = false, query = '') =>
  app.request(`/api/scan?${auto ? 'auto=1&' : ''}${query}`, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: photo(name) })
const send = (method: string, url: string, json?: unknown) =>
  app.request(url, json === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) })
const items = async () => (await body<{ items: ScanItem[] }>(await app.request('/api/scan/items'))).items
/** Captures a photo and waits until it's identified; `query` adds to the capture's query (`deck=3&board=side`). */
async function scan(name: string, auto = false, query = ''): Promise<ScanItem> {
  const res = await capture(name, auto, query)
  expect(res.status).toBe(201)
  const { id } = await body<ScanItem>(res)
  await worker.idle()
  return (await items()).find((i) => i.id === id)!
}
const summary = (i: ScanItem) => [i.status, i.method, i.reason, i.card ? `${i.card.name} ${i.card.setCode} ${i.card.collectorNumber}` : null, i.finish]
const code = async (res: Response) => [res.status, (await body<ApiErrorBody>(res)).error.code]
const owned = () => db.prepare('SELECT card_id, finish, quantity FROM collection ORDER BY card_id').all()

describe('capturing', () => {
  it('queues a JPEG, saves it under the scans folder, and serves it back', async () => {
    const res = await capture('bolt-m11')
    expect(res.status).toBe(201)
    const item = await body<ScanItem>(res)
    expect(item).toMatchObject({ status: 'queued', card: null, quantity: 1 })
    expect(fs.existsSync(path.join(scansDir, `${item.id}.jpg`))).toBe(true)
    const image = await app.request(`/api/scan/items/${item.id}/image`)
    expect([image.status, image.headers.get('content-type')]).toEqual([200, 'image/jpeg'])
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(photo('bolt-m11'))
    await worker.idle()
  })

  it('refuses anything but a JPEG, and captures over the size limit', async () => {
    const png = await app.request('/api/scan', { method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) })
    expect(await code(png)).toEqual([400, 'bad_request'])
    const huge = new Uint8Array(MAX_SCAN_BYTES + 1)
    huge.set([0xff, 0xd8, 0xff])
    expect(await code(await app.request('/api/scan', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: huge }))).toEqual([413, 'too_large'])
    expect(await code(await capture('bolt-m11', false, 'auto=yes'))).toEqual([400, 'bad_request'])
    expect(await items()).toEqual([])
  })
})

describe('identifying', () => {
  it('is confident when OCR reads the set code and number, and starts in the default finish', async () => {
    expect(summary(await scan('bolt-m11'))).toEqual(['confident', 'ocr', null, 'Lightning Bolt m11 149', 'nonfoil'])
    updateSettings(db, { scanDefaultFinish: 'foil' })
    expect(summary(await scan('bolt-m11'))[4]).toBe('foil')
  })

  it('starts a scan as foil when its collector line has a ★ (read as *), if the printing comes in foil', async () => {
    expect(summary(await scan('bolt-m11-foil'))[4]).toBe('foil')
  })

  it('puts a card whose printing is uncertain in review, or accepts it when the setting says so', async () => {
    expect(summary(await scan('bolt'))).toEqual(['review', 'ocr', 'printing', 'Lightning Bolt m11 149', 'nonfoil'])
    updateSettings(db, { scanAcceptUncertainPrinting: true })
    expect(summary(await scan('bolt'))).toEqual(['confident', 'ocr', null, 'Lightning Bolt m11 149', 'nonfoil'])
  })

  it('puts a card it cannot settle in review with its candidates, and a failed OCR with its error', async () => {
    const unsure = await scan('mystery')
    expect([...summary(unsure), unsure.error]).toEqual(['review', 'ocr', 'unsure', null, 'nonfoil', null])
    const broken = await scan('broken')
    expect([broken.status, broken.reason, broken.error]).toEqual(['review', 'unsure', 'OCR failed: Text recognition failed'])
  })

  it('drops an auto capture with no text (the bare scanning area), counting it for a minute, but keeps a manual one for review', async () => {
    await capture('blank', true)
    await worker.idle()
    const queue = await body<ScanQueue>(await app.request('/api/scan/items'))
    expect([queue.items, queue.skipped]).toEqual([[], 1])
    const manual = await scan('blank')
    expect([manual.status, manual.error]).toEqual(['review', 'No text found in the capture'])
    expect(countSkipped(db)).toBe(1)
    expect(countSkipped(db, new Date(Date.now() + SKIPPED_MS + 1000))).toBe(0)
  })

  it('adds confident scans to the collection right away when auto-commit is on', async () => {
    updateSettings(db, { scanAutoCommit: true })
    await scan('bolt-m11')
    await scan('bolt')
    expect((await items()).map((i) => i.reason)).toEqual(['printing'])
    expect(owned()).toEqual([{ card_id: fixtureCard('Lightning Bolt', 'm11').id, finish: 'nonfoil', quantity: 1 }])
  })

  it('picks up scans a restart interrupted', async () => {
    const { id } = await body<ScanItem>(await capture('bolt-m11'))
    await worker.idle()
    db.prepare("UPDATE scan_items SET status = 'identifying', card_id = NULL WHERE id = ?").run(id)
    worker.recover()
    await worker.idle()
    expect(summary((await items())[0]!)).toEqual(['confident', 'ocr', null, 'Lightning Bolt m11 149', 'nonfoil'])
  })

  it("leaves auto mode's captures in the queue when auto-commit is on, and commits manual ones", async () => {
    updateSettings(db, { scanAutoCommit: true })
    const auto = await scan('bolt-m11', true)
    expect([...summary(auto), auto.auto]).toEqual(['confident', 'ocr', null, 'Lightning Bolt m11 149', 'nonfoil', true])
    expect(owned()).toEqual([])
    await scan('bolt-sta')
    expect(owned()).toEqual([{ card_id: fixtureCard('Lightning Bolt', 'sta').id, finish: 'nonfoil', quantity: 1 }])
    expect((await items()).map((i) => [i.id, i.status, i.auto])).toEqual([[auto.id, 'confident', true]])
  })

  it('never accepts an uncertain printing that contradicted what was read, even with auto-commit on', async () => {
    updateSettings(db, { scanAcceptUncertainPrinting: true, scanAutoCommit: true })
    const contradicted = await scan('bolt-1997')
    expect(summary(contradicted)).toEqual(['review', 'ocr', 'printing', 'Lightning Bolt m11 149', 'nonfoil'])
    // A title alone, with several printings and nothing contradicting, is accepted (and, here, committed).
    await scan('bolt')
    expect(owned()).toEqual([{ card_id: fixtureCard('Lightning Bolt', 'm11').id, finish: 'nonfoil', quantity: 1 }])
    expect((await items()).map((i) => [i.id, i.status, i.reason])).toEqual([[contradicted.id, 'review', 'printing']])
  })

  it("keeps a scan discarded while it's being identified discarded: the late result doesn't bring it back", async () => {
    updateSettings(db, { scanAutoCommit: true })
    let release!: () => void
    gate = new Promise((resolve) => (release = resolve))
    const { id } = await body<ScanItem>(await capture('bolt-m11'))
    const status = () => db.prepare('SELECT status FROM scan_items WHERE id = ?').pluck().get(id)
    expect(status()).toBe('identifying')
    expect((await send('DELETE', `/api/scan/items/${id}`)).status).toBe(204)
    release()
    await worker.idle()
    expect(status()).toBe('discarded')
    expect(await items()).toEqual([])
    expect(owned()).toEqual([])
  })

  it("lists an unsure scan's candidates with their names, set codes, and numbers", async () => {
    insertCardRows(db, 'cards', [scryfallToRow(syntheticCard({ name: 'Llanowar Elf', set: 'syn', collector_number: '1' }))!])
    rebuildCardNames(db)
    const unsure = await scan('elfs')
    expect([unsure.status, unsure.reason]).toEqual(['review', 'unsure'])
    const elves = fixtureCard('Llanowar Elves')
    expect(unsure.candidates.map((c) => [c.name, c.setCode, c.collectorNumber]).sort()).toEqual([
      ['Llanowar Elf', 'syn', '1'],
      ['Llanowar Elves', elves.set, elves.collector_number],
    ])
    expect(unsure.candidates.every((c) => c.cardId !== '' && c.score >= 0.75)).toBe(true)
  })

  it('puts a scan in review with the error when the card data fails, rather than losing it', async () => {
    // The matcher's own lookup fails.
    const printings = vi.spyOn(lookups, 'printings').mockImplementation(() => {
      throw new Error('The card data is being replaced')
    })
    const failed = await scan('bolt')
    expect([failed.status, failed.reason, failed.card]).toEqual(['review', 'unsure', null])
    expect(failed.error).toBe("Couldn't match the card: The card data is being replaced")
    printings.mockRestore()
    // A printing the lookup found is gone from the card data by the time the result is saved, so saving it fails:
    // the fallback still saves the scan for review, with the error.
    const bolt = lookups.bySetAndNumber('m11', '149')[0]!
    const bySetAndNumber = vi.spyOn(lookups, 'bySetAndNumber').mockReturnValue([{ ...bolt, id: 'no-longer-in-the-card-data' }])
    onTestFinished(() => bySetAndNumber.mockRestore())
    const unsaved = await scan('bolt-m11')
    expect([unsaved.status, unsaved.reason, unsaved.card, unsaved.error]).toEqual(['review', 'unsure', null, 'FOREIGN KEY constraint failed'])
  })

  it('logs an auto-commit that fails and leaves the scan ready, so it can be added by hand', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => logged.mockRestore())
    updateSettings(db, { scanAutoCommit: true })
    db.exec("CREATE TRIGGER refuse_copies BEFORE INSERT ON collection BEGIN SELECT RAISE(ABORT, 'disk full'); END")
    const ready = await scan('bolt-m11')
    expect(summary(ready)).toEqual(['confident', 'ocr', null, 'Lightning Bolt m11 149', 'nonfoil'])
    expect(owned()).toEqual([])
    expect(logged).toHaveBeenCalledWith('[scan] auto-commit failed', expect.objectContaining({ message: 'disk full' }))
  })

  it('logs a failure it cannot even save for review, and tries the scan again until it is saved', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => logged.mockRestore())
    // Every write of a result fails, the fallback's too; putting the scan back in line doesn't.
    db.exec(
      `CREATE TRIGGER refuse_results BEFORE UPDATE OF status ON scan_items
       WHEN OLD.status = 'identifying' AND NEW.status <> 'queued' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`,
    )
    await capture('bolt-m11')
    // Tried again after 50 ms, then after 100 ms more, and so on (a further try can land between checks).
    await vi.waitFor(() => expect(logged.mock.calls.length).toBeGreaterThanOrEqual(3))
    expect(logged).toHaveBeenCalledWith('[scan] identifying failed', expect.objectContaining({ message: 'disk I/O error' }))
    expect((await items()).map((i) => i.status)).toEqual(['identifying'])
    // The database recovers before the next try.
    db.exec('DROP TRIGGER refuse_results')
    await vi.waitFor(async () => expect((await items()).map((i) => i.status)).toEqual(['confident']))
  })
})

describe('the queue', () => {
  it('confirms a review scan, or corrects its card, printing, finish, and quantity', async () => {
    const printing = await scan('bolt')
    // The owner said it's right: "Ready · confirmed".
    const confirmed = await body<ScanItem>(await send('PATCH', `/api/scan/items/${printing.id}`, { confirm: true }))
    expect(summary(confirmed)).toEqual(['confident', 'manual', null, 'Lightning Bolt m11 149', 'nonfoil'])
    const unsure = await scan('mystery')
    const picked = await body<ScanItem>(await send('PATCH', `/api/scan/items/${unsure.id}`, { cardId: fixtureCard('Lightning Bolt', 'sta').id }))
    expect(summary(picked)).toEqual(['confident', 'manual', null, 'Lightning Bolt sta 42', 'nonfoil'])
    const edited = await body<ScanItem>(await send('PATCH', `/api/scan/items/${unsure.id}`, { finish: 'etched', quantity: 4 }))
    expect([edited.finish, edited.quantity]).toEqual(['etched', 4])
    // A printing that doesn't come in the finish falls back to one it has.
    const moved = await body<ScanItem>(await send('PATCH', `/api/scan/items/${unsure.id}`, { cardId: fixtureCard('Lightning Bolt', 'm10').id }))
    expect(moved.finish).toBe('nonfoil')
  })

  it("carries the scanned printing's prices, which follow a corrected printing", async () => {
    const item = await scan('bolt-m11')
    expect(item.card?.prices).toEqual({ usd: 1.04, usdFoil: 6.68, usdEtched: null })
    const moved = await body<ScanItem>(await send('PATCH', `/api/scan/items/${item.id}`, { cardId: fixtureCard('Lightning Bolt', 'm10').id }))
    expect(moved.card?.prices).toEqual({ usd: 1.89, usdFoil: 12.69, usdEtched: null })
  })

  it('refuses edits it cannot make', async () => {
    const unsure = await scan('mystery')
    expect(await code(await send('PATCH', `/api/scan/items/${unsure.id}`, { confirm: true }))).toEqual([400, 'no_card'])
    expect(await code(await send('PATCH', `/api/scan/items/${unsure.id}`, { cardId: 'no-such-card' }))).toEqual([400, 'no_card'])
    const ready = await scan('bolt-m11')
    expect(await code(await send('PATCH', `/api/scan/items/${ready.id}`, { finish: 'etched' }))).toEqual([400, 'bad_finish'])
    expect(await code(await send('PATCH', `/api/scan/items/${ready.id}`, { quantity: 0 }))).toEqual([400, 'bad_request'])
    expect(await code(await send('PATCH', `/api/scan/items/${ready.id}`, { status: 'committed' }))).toEqual([400, 'bad_request'])
    expect(await code(await send('PATCH', '/api/scan/items/999', { quantity: 2 }))).toEqual([404, 'not_found'])
    expect(await code(await send('PATCH', '/api/scan/items/abc', { quantity: 2 }))).toEqual([404, 'not_found'])
    for (const alias of [`0x${ready.id}`, `${ready.id}e0`, `0${ready.id}`]) {
      expect([alias, ...(await code(await send('PATCH', `/api/scan/items/${alias}`, { quantity: 2 })))]).toEqual([alias, 404, 'not_found'])
    }
    // Not identified yet (the worker isn't told about this row).
    const queued = db.prepare("INSERT INTO scan_items (status, created_at, updated_at) VALUES ('queued', '', '')").run()
    expect(await code(await send('PATCH', `/api/scan/items/${queued.lastInsertRowid}`, { quantity: 2 }))).toEqual([409, 'busy'])
  })

  it('discards a scan and deletes its image', async () => {
    const item = await scan('mystery')
    expect((await send('DELETE', `/api/scan/items/${item.id}`)).status).toBe(204)
    expect(fs.existsSync(path.join(scansDir, `${item.id}.jpg`))).toBe(false)
    expect(await items()).toEqual([])
    expect(await code(await send('DELETE', `/api/scan/items/${item.id}`))).toEqual([404, 'not_found'])
  })

  it('identifies a review scan again, for example once the OCR helper works', async () => {
    failing.add('bolt-m11')
    const item = await scan('bolt-m11')
    expect([item.status, item.error]).toEqual(['review', "OCR failed: Couldn't build the OCR helper"])
    failing.clear()
    expect((await send('POST', `/api/scan/items/${item.id}/retry`)).status).toBe(200)
    await worker.idle()
    expect(summary((await items())[0]!)).toEqual(['confident', 'ocr', null, 'Lightning Bolt m11 149', 'nonfoil'])
    expect(await code(await send('POST', `/api/scan/items/${item.id}/retry`))).toEqual([409, 'busy'])
  })

  it('clears the error of a scan the owner settles, by picking a card or confirming it', async () => {
    const bolt = fixtureCard('Lightning Bolt', 'm11').id
    failing.add('bolt-m11')
    const failed = await scan('bolt-m11')
    expect([failed.status, failed.error]).toEqual(['review', "OCR failed: Couldn't build the OCR helper"])
    const picked = await body<ScanItem>(await send('PATCH', `/api/scan/items/${failed.id}`, { cardId: bolt }))
    expect([picked.status, picked.error]).toEqual(['confident', null])
    // A review scan with both a card and an error, set up directly.
    const review = await scan('bolt-m11')
    db.prepare('UPDATE scan_items SET card_id = ? WHERE id = ?').run(bolt, review.id)
    const confirmed = await body<ScanItem>(await send('PATCH', `/api/scan/items/${review.id}`, { confirm: true }))
    expect([confirmed.status, confirmed.error]).toEqual(['confident', null])
    expect((await items()).map((i) => [i.status, i.error])).toEqual([['confident', null], ['confident', null]])
  })

  it('commits confident scans to the collection, leaving the rest, and deletes their images', async () => {
    const a = await scan('bolt-m11')
    const b = await scan('bolt-m11')
    await send('PATCH', `/api/scan/items/${b.id}`, { quantity: 3 })
    await scan('bolt-sta')
    await scan('mystery')
    expect(await body(await send('POST', '/api/scan/commit'))).toEqual({ items: 3, copies: 5, decks: [] })
    expect(owned()).toEqual(
      [
        { card_id: fixtureCard('Lightning Bolt', 'm11').id, finish: 'nonfoil', quantity: 4 },
        { card_id: fixtureCard('Lightning Bolt', 'sta').id, finish: 'nonfoil', quantity: 1 },
      ].sort((x, y) => x.card_id.localeCompare(y.card_id)),
    )
    expect((await items()).map((i) => i.reason)).toEqual(['unsure'])
    expect(fs.existsSync(path.join(scansDir, `${a.id}.jpg`))).toBe(false)
    expect(await body(await send('POST', '/api/scan/commit'))).toEqual({ items: 0, copies: 0, decks: [] })
  })

  it("reports what it added even when it can't delete the images, logging those", async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => logged.mockRestore())
    const ready = await scan('bolt-m11')
    const image = path.join(scansDir, `${ready.id}.jpg`)
    // The image can't be deleted (a folder made read-only won't do it: root, and Windows, delete from it anyway).
    const remove = vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, unlink '${image}'`), { code: 'EISDIR' })
    })
    onTestFinished(() => remove.mockRestore())
    expect(await body(await send('POST', '/api/scan/commit'))).toEqual({ items: 1, copies: 1, decks: [] })
    expect(remove).toHaveBeenCalledWith(image, { force: true })
    expect(owned()).toEqual([{ card_id: fixtureCard('Lightning Bolt', 'm11').id, finish: 'nonfoil', quantity: 1 }])
    expect(logged).toHaveBeenCalledWith(`[scan] couldn't delete ${image}`, expect.anything())
    // The image the commit left is deleted at the next start, its scan being finished; a scan still in the queue keeps its.
    const review = await scan('mystery')
    worker.recover()
    expect(fs.existsSync(image)).toBe(false)
    expect(fs.existsSync(path.join(scansDir, `${review.id}.jpg`))).toBe(true)
  })

  it('commits only the scans it is given, when given their ids', async () => {
    const counted = await scan('bolt-m11')
    // Confirmed after the Add button counted what was ready.
    const later = await scan('bolt')
    await send('PATCH', `/api/scan/items/${later.id}`, { confirm: true })
    expect(await body(await send('POST', '/api/scan/commit', { ids: [counted.id] }))).toEqual({ items: 1, copies: 1, decks: [] })
    expect(owned()).toEqual([{ card_id: fixtureCard('Lightning Bolt', 'm11').id, finish: 'nonfoil', quantity: 1 }])
    expect((await items()).map((i) => [i.id, i.status])).toEqual([[later.id, 'confident']])
    const text = (raw: string) => app.request('/api/scan/commit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw })
    expect(await code(await text('not json'))).toEqual([400, 'bad_request'])
    expect(await code(await send('POST', '/api/scan/commit', { ids: [later.id], all: true }))).toEqual([400, 'bad_request'])
    expect(await code(await send('POST', '/api/scan/commit', {}))).toEqual([400, 'bad_request'])
    expect(await code(await send('POST', '/api/scan/commit', { ids: [0] }))).toEqual([400, 'bad_request'])
    expect(await code(await send('POST', '/api/scan/commit', { ids: [1.5] }))).toEqual([400, 'bad_request'])
    const tooMany = Array.from({ length: 1001 }, (_, i) => i + 1)
    expect(await code(await send('POST', '/api/scan/commit', { ids: tooMany }))).toEqual([400, 'bad_request'])
    expect((await items()).map((i) => [i.id, i.status])).toEqual([[later.id, 'confident']])
  })
})

describe('scanning into a deck', () => {
  /** The deck's lines as [name, board, quantity, the printing it shows when not the default]. */
  const lines = (deckId: number) =>
    db
      .prepare(
        `SELECT c.name, dc.board, dc.quantity, dc.preferred_card_id AS preferred FROM deck_cards dc
         JOIN card_names c ON c.oracle_id = dc.oracle_id WHERE dc.deck_id = ? ORDER BY c.name, dc.board`,
      )
      .all(deckId)
  const commit = async () => body<ScanCommitResult>(await send('POST', '/api/scan/commit'))

  it('captures for a deck and board, and lists where each scan goes', async () => {
    const elves = deck(db, 'Elf Ball', 'built')
    expect((await scan('bolt-m11', false, `deck=${elves}&board=side`)).target).toEqual({ deckId: elves, board: 'side', deckName: 'Elf Ball' })
    expect((await scan('bolt-m11', false, `deck=${elves}`)).target).toEqual({ deckId: elves, board: 'main', deckName: 'Elf Ball' })
    expect((await scan('bolt-m11')).target).toBeNull()
    // A deck deleted in another window: the capture is kept, for the collection only.
    expect((await scan('bolt-m11', false, 'deck=999')).target).toBeNull()
    expect(await code(await capture('bolt-m11', false, `deck=${elves}&board=maybe`))).toEqual([400, 'bad_request'])
    expect(await code(await capture('bolt-m11', false, 'deck=abc'))).toEqual([400, 'bad_request'])
    // A deck is named only by its plain id: `01` and `0x1` don't alias deck 1.
    expect(await code(await capture('bolt-m11', false, 'deck=01'))).toEqual([400, 'bad_request'])
    expect(await code(await capture('bolt-m11', false, 'deck=0x1'))).toEqual([400, 'bad_request'])
    expect((await items()).length).toBe(4)
  })

  it("adds a scan to its deck as well as the collection, filling the copies the deck lists before adding more", async () => {
    const elves = deck(db, 'Elf Ball', 'built', 'modern')
    inDeck(db, elves, 'Lightning Bolt', 4)
    const m11 = fixtureCard('Lightning Bolt', 'm11').id
    const two = await scan('bolt-m11', false, `deck=${elves}`)
    await send('PATCH', `/api/scan/items/${two.id}`, { quantity: 2 })
    expect(await commit()).toEqual({ items: 1, copies: 2, decks: [{ id: elves, name: 'Elf Ball', copies: 2 }] })
    expect(owned()).toEqual([{ card_id: m11, finish: 'nonfoil', quantity: 2 }])
    expect(lines(elves)).toEqual([{ name: 'Lightning Bolt', board: 'main', quantity: 4, preferred: null }])
    // Two more fill the list; a fifth goes beyond it.
    await scan('bolt-m11', false, `deck=${elves}`)
    await scan('bolt-m11', false, `deck=${elves}`)
    await commit()
    expect(lines(elves)).toEqual([{ name: 'Lightning Bolt', board: 'main', quantity: 4, preferred: null }])
    await scan('bolt-m11', false, `deck=${elves}`)
    expect(await commit()).toEqual({ items: 1, copies: 1, decks: [{ id: elves, name: 'Elf Ball', copies: 1 }] })
    expect(lines(elves)).toEqual([{ name: 'Lightning Bolt', board: 'main', quantity: 5, preferred: null }])
    expect(owned()).toEqual([{ card_id: m11, finish: 'nonfoil', quantity: 5 }])
  })

  it('fills each board on its own, and gives a new line the printing scanned', async () => {
    const elves = deck(db, 'Elf Ball', 'built', 'modern')
    inDeck(db, elves, 'Lightning Bolt', 1, 'side')
    await scan('bolt-sta', false, `deck=${elves}`)
    await scan('bolt-sta', false, `deck=${elves}&board=side`)
    await scan('bolt-sta', false, `deck=${elves}&board=side`)
    // The first two of one commit fill in id order: one fills the sideboard's copy, the next goes beyond it.
    expect(await commit()).toEqual({ items: 3, copies: 3, decks: [{ id: elves, name: 'Elf Ball', copies: 3 }] })
    expect(lines(elves)).toEqual([
      { name: 'Lightning Bolt', board: 'main', quantity: 1, preferred: fixtureCard('Lightning Bolt', 'sta').id },
      { name: 'Lightning Bolt', board: 'side', quantity: 2, preferred: null },
    ])
  })

  it('counts the copies for each deck of one commit', async () => {
    const elves = deck(db, 'Elf Ball', 'built')
    const burn = deck(db, 'Burn', 'prospective', 'modern')
    await scan('bolt-m11', false, `deck=${elves}`)
    await scan('bolt-sta', false, `deck=${burn}`)
    await scan('bolt-sta', false, `deck=${burn}`)
    await scan('bolt-m11')
    expect(await commit()).toEqual({
      items: 4,
      copies: 4,
      decks: [
        { id: elves, name: 'Elf Ball', copies: 1 },
        { id: burn, name: 'Burn', copies: 2 },
      ],
    })
    expect(lines(burn)).toEqual([{ name: 'Lightning Bolt', board: 'main', quantity: 2, preferred: fixtureCard('Lightning Bolt', 'sta').id }])
  })

  it('adds nothing when a deck write fails: the collection and the decks change together', async () => {
    const elves = deck(db, 'Elf Ball', 'built', 'modern')
    await scan('bolt-m11', false, `deck=${elves}`)
    await scan('bolt-sta', false, `deck=${elves}&board=side`)
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON deck_cards WHEN NEW.board = 'side' BEGIN SELECT RAISE(ABORT, 'boom'); END")
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => logged.mockRestore())
    expect((await send('POST', '/api/scan/commit')).status).toBe(500)
    expect(owned()).toEqual([])
    expect(lines(elves)).toEqual([])
    expect((await items()).map((i) => i.status)).toEqual(['confident', 'confident'])
  })

  it('changes where a scan goes, even while it is being identified, and refuses a deck that no longer exists', async () => {
    const elves = deck(db, 'Elf Ball', 'built')
    const ready = await scan('bolt-m11')
    const moved = await body<ScanItem>(await send('PATCH', `/api/scan/items/${ready.id}`, { target: { deckId: elves, board: 'commander' } }))
    expect(moved.target).toEqual({ deckId: elves, board: 'commander', deckName: 'Elf Ball' })
    expect((await body<ScanItem>(await send('PATCH', `/api/scan/items/${ready.id}`, { target: null }))).target).toBeNull()
    expect(await code(await send('PATCH', `/api/scan/items/${ready.id}`, { target: { deckId: 999, board: 'main' } }))).toEqual([400, 'no_deck'])
    expect(await code(await send('PATCH', `/api/scan/items/${ready.id}`, { target: { deckId: elves, board: 'maybe' } }))).toEqual([400, 'bad_request'])
    expect(await code(await send('PATCH', `/api/scan/items/${ready.id}`, { target: { deckId: elves } }))).toEqual([400, 'bad_request'])
    let release!: () => void
    gate = new Promise((resolve) => (release = resolve))
    const { id } = await body<ScanItem>(await capture('bolt-m11'))
    expect((await body<ScanItem>(await send('PATCH', `/api/scan/items/${id}`, { target: { deckId: elves, board: 'main' } }))).target?.deckId).toBe(elves)
    // Only where it goes: the rest waits until it's identified.
    expect(await code(await send('PATCH', `/api/scan/items/${id}`, { target: null, quantity: 2 }))).toEqual([409, 'busy'])
    release()
    await worker.idle()
    expect((await items()).find((i) => i.id === id)?.target?.deckId).toBe(elves)
  })

  it('sends every scan in the queue to one deck and board, or back to the collection only', async () => {
    const elves = deck(db, 'Elf Ball', 'built')
    const added = await scan('bolt-m11')
    await commit()
    await scan('bolt-m11')
    await scan('mystery')
    let release!: () => void
    gate = new Promise((resolve) => (release = resolve))
    try {
      await capture('bolt-sta')
      expect(await body(await send('PUT', '/api/scan/target', { target: { deckId: elves, board: 'side' } }))).toEqual({ scans: 3 })
    } finally {
      release() // even when the expectation fails, or the worker (and afterEach) waits for ever
    }
    await worker.idle()
    expect((await items()).map((i) => i.target)).toEqual(Array(3).fill({ deckId: elves, board: 'side', deckName: 'Elf Ball' }))
    // A scan already added stays where it went.
    expect(db.prepare('SELECT deck_id FROM scan_items WHERE id = ?').pluck().get(added.id)).toBeNull()
    expect(await body(await send('PUT', '/api/scan/target', { target: null }))).toEqual({ scans: 3 })
    expect((await items()).map((i) => i.target)).toEqual([null, null, null])
    expect(await code(await send('PUT', '/api/scan/target', { target: { deckId: 999, board: 'main' } }))).toEqual([400, 'no_deck'])
    expect(await code(await send('PUT', '/api/scan/target', { target: { deckId: elves, board: 'maybe' } }))).toEqual([400, 'bad_request'])
    expect(await code(await send('PUT', '/api/scan/target', {}))).toEqual([400, 'bad_request'])
  })

  it('leaves the scans of a deleted deck to the collection only', async () => {
    const elves = deck(db, 'Elf Ball', 'built')
    await scan('bolt-m11', false, `deck=${elves}`)
    db.prepare('DELETE FROM decks WHERE id = ?').run(elves)
    expect((await items())[0]!.target).toBeNull()
    expect(await commit()).toEqual({ items: 1, copies: 1, decks: [] })
    expect(owned()).toEqual([{ card_id: fixtureCard('Lightning Bolt', 'm11').id, finish: 'nonfoil', quantity: 1 }])
  })

  it('adds to the deck when auto-commit adds a scan, and lists what it added for a minute', async () => {
    updateSettings(db, { scanAutoCommit: true })
    const elves = deck(db, 'Elf Ball', 'built')
    // Added as soon as they're identified, so they're gone from the queue by then.
    const added = await body<ScanItem>(await capture('bolt-m11', false, `deck=${elves}`))
    await capture('bolt-sta')
    await worker.idle()
    const queue = await body<ScanQueue>(await app.request('/api/scan/items'))
    expect(queue.items).toEqual([])
    expect(queue.added).toEqual([
      { id: added.id, name: 'Lightning Bolt', copies: 1, deckName: 'Elf Ball' },
      { id: added.id + 1, name: 'Lightning Bolt', copies: 1, deckName: null },
    ])
    expect(lines(elves)).toEqual([{ name: 'Lightning Bolt', board: 'main', quantity: 1, preferred: null }])
    expect(listAutoAdded(db, new Date(Date.now() + AUTO_ADDED_MS + 1000))).toEqual([])
    // Scans the owner added aren't listed: the page that added them has said so.
    updateSettings(db, { scanAutoCommit: false })
    await scan('bolt-m11')
    await commit()
    expect((await body<ScanQueue>(await app.request('/api/scan/items'))).added.map((a) => a.id)).toEqual([added.id, added.id + 1])
  })
})

describe('the same card caught twice', () => {
  /** Whether each scan in the queue is marked, by id. */
  const marks = async () => Object.fromEntries((await items()).map((i) => [i.id, i.sameCardAsBefore]))

  it('marks an auto capture of the same printing as the auto capture before it, even one already added', async () => {
    const a = await scan('bolt-m11', true)
    const b = await scan('bolt-m11', true)
    expect(await marks()).toEqual({ [a.id]: false, [b.id]: true })
    await send('POST', '/api/scan/commit', { ids: [a.id] })
    expect(await marks()).toEqual({ [b.id]: true })
  })

  it("doesn't mark a card after a bare-mat capture: the card was lifted, so this is another copy", async () => {
    await scan('bolt-m11', true)
    await capture('blank', true)
    await worker.idle()
    const next = await scan('bolt-m11', true)
    expect((await marks())[next.id]).toBe(false)
  })

  it("doesn't mark a capture that says the card was lifted before it (auto mode saw the empty mat)", async () => {
    await scan('bolt-m11', true)
    const lifted = await scan('bolt-m11', true, 'lifted=1')
    const nudged = await scan('bolt-m11', true, 'lifted=0')
    expect(await marks()).toMatchObject({ [lifted.id]: false, [nudged.id]: true })
    expect(await code(await capture('bolt-m11', true, 'lifted=yes'))).toEqual([400, 'bad_request'])
  })

  it('skips scans the owner discarded, and marks nothing across a manual capture, another printing, or a minute', async () => {
    const a = await scan('bolt-m11', true)
    const b = await scan('bolt-m11', true)
    await send('DELETE', `/api/scan/items/${b.id}`)
    const c = await scan('bolt-m11', true)
    expect((await marks())[c.id]).toBe(true)
    const manual = await scan('bolt-m11')
    const d = await scan('bolt-m11', true)
    const sta = await scan('bolt-sta', true)
    expect(await marks()).toEqual({ [a.id]: false, [c.id]: true, [manual.id]: false, [d.id]: false, [sta.id]: false })
    const later = await scan('bolt-sta', true)
    db.prepare('UPDATE scan_items SET created_at = ? WHERE id = ?').run(new Date(Date.now() + 61_000).toISOString(), later.id)
    expect((await marks())[later.id]).toBe(false)
  })

  it("doesn't take a scan the owner discarded before it was identified for a bare-mat capture", async () => {
    const a = await scan('bolt-m11', true)
    let release!: () => void
    gate = new Promise((resolve) => (release = resolve))
    const b = await body<ScanItem>(await capture('bolt-m11', true))
    expect((await send('DELETE', `/api/scan/items/${b.id}`)).status).toBe(204)
    release()
    await worker.idle()
    const c = await scan('bolt-m11', true)
    expect(await marks()).toEqual({ [a.id]: false, [c.id]: true })
    expect(countSkipped(db)).toBe(0)
  })

  it('takes a bare-mat capture identified again (Try again) for one, so the card after it is another copy', async () => {
    // OCR fails for now, as when the helper can't be built: the card, the bare mat, and the card again go to review.
    failing.add('bolt-m11').add('blank')
    const first = await scan('bolt-m11', true)
    const mat = await scan('blank', true)
    const second = await scan('bolt-m11', true)
    expect([first, mat, second].map((i) => i.status)).toEqual(['review', 'review', 'review'])
    // Once OCR works, the owner tries all three again: the mat is dropped, and it counts as one.
    failing.clear()
    for (const { id } of [first, mat, second]) expect((await send('POST', `/api/scan/items/${id}/retry`)).status).toBe(200)
    await worker.idle()
    expect(await marks()).toEqual({ [first.id]: false, [second.id]: false })
    expect(countSkipped(db)).toBe(1)
  })

  it('marks nothing when a scan before it has no card yet', async () => {
    const unknown = await scan('mystery', true)
    const next = await scan('bolt-m11', true)
    expect(await marks()).toEqual({ [unknown.id]: false, [next.id]: false })
  })
})
