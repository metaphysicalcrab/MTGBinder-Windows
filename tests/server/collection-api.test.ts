import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../../src/server/db/index.ts'
import type { ApiErrorBody, CardDetail, CollectionStats, CopyCount, ImportPreview, ImportResult } from '../../src/shared/types.ts'
import { body, makeApp } from '../helpers/app.ts'
import { createTestDb } from '../helpers/db.ts'
import { fixtureCard } from '../helpers/fixtures.ts'
import { deck, inDeck, own } from '../helpers/library.ts'

let db: DB
let app: ReturnType<typeof makeApp>
beforeEach(() => {
  db = createTestDb()
  app = makeApp({ db })
})

const post = (path: string, json: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) })
const errorCode = async (res: Response) => (await body<ApiErrorBody>(res)).error.code
const bolt = (set: string) => fixtureCard('Lightning Bolt', set)

describe('card detail', () => {
  it('includes every owned copy of the card and its ownership', async () => {
    own(db, 'Lightning Bolt', 'm10', 2)
    own(db, 'Lightning Bolt', 'sta', 1, 'etched')
    const burn = deck(db, 'Burn', 'built', 'modern')
    inDeck(db, burn, 'Lightning Bolt', 4)
    const detail = await body<CardDetail>(await app.request(`/api/cards/${bolt('m11').id}`))
    expect(detail.copies.map((c) => [c.setCode, c.finish, c.quantity])).toEqual([
      ['sta', 'etched', 1],
      ['m10', 'nonfoil', 2],
    ])
    expect(detail.ownership).toEqual({ owned: 3, free: -1, decks: [{ id: burn, name: 'Burn', status: 'built', quantity: 4, maybe: 0 }] })
  })

  it('shows no copies and no decks for a card I do not own', async () => {
    const detail = await body<CardDetail>(await app.request(`/api/cards/${bolt('m11').id}`))
    expect([detail.copies, detail.ownership]).toEqual([[], { owned: 0, free: 0, decks: [] }])
  })
})

describe('POST /api/collection/adjust', () => {
  it('adds and removes copies, reporting what is left', async () => {
    const add = await post('/api/collection/adjust', { cardId: bolt('m10').id, finish: 'foil', delta: 2 })
    expect(add.status).toBe(200)
    expect(await body<CopyCount>(add)).toEqual({ cardId: bolt('m10').id, finish: 'foil', quantity: 2 })
    const remove = await post('/api/collection/adjust', { cardId: bolt('m10').id, finish: 'foil', delta: -3 })
    expect(await body<CopyCount>(remove)).toEqual({ cardId: bolt('m10').id, finish: 'foil', quantity: 0 })
  })

  it('refuses to add a finish the printing lacks, but lets you remove one', async () => {
    const res = await post('/api/collection/adjust', { cardId: bolt('m10').id, finish: 'etched', delta: 1 })
    expect(res.status).toBe(400)
    expect(await body(res)).toEqual({
      error: { code: 'finish_unavailable', message: 'Lightning Bolt (M10 #146) has no etched version' },
    })
    db.prepare("INSERT INTO collection (card_id, finish, quantity, added_at, updated_at) VALUES (?, 'etched', 1, 't', 't')").run(bolt('m10').id)
    const removed = await post('/api/collection/adjust', { cardId: bolt('m10').id, finish: 'etched', delta: -1 })
    expect((await body<CopyCount>(removed)).quantity).toBe(0)
  })

  it('404s an unknown card and 400s a bad body', async () => {
    expect((await post('/api/collection/adjust', { cardId: 'nope', finish: 'foil', delta: 1 })).status).toBe(404)
    for (const bad of [{ cardId: bolt('m10').id, finish: 'foil', delta: 0 }, { cardId: bolt('m10').id, finish: 'shiny', delta: 1 }, { cardId: bolt('m10').id, finish: 'foil', delta: 1.5 }, {}]) {
      const res = await post('/api/collection/adjust', bad)
      expect([res.status, await errorCode(res)]).toEqual([400, 'bad_request'])
    }
    const notJson = await app.request('/api/collection/adjust', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
    expect([notJson.status, await errorCode(notJson)]).toEqual([400, 'bad_request'])
  })

  it('refuses a request from another site', async () => {
    const res = await app.request('/api/collection/adjust', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ cardId: bolt('m10').id, finish: 'nonfoil', delta: 1 }),
    })
    expect(res.status).toBe(403)
  })
})

describe('GET /api/collection/stats', () => {
  it('reports the library totals', async () => {
    own(db, 'Lightning Bolt', 'm10', 2)
    const stats = await body<CollectionStats>(await app.request('/api/collection/stats'))
    expect(stats).toMatchObject({ totalCards: 2, uniqueCards: 1, valueUsd: 3.78, unpricedCards: 0 })
  })
})

describe('CSV import', () => {
  it('previews a file, then imports the chosen rows in one go', async () => {
    const preview = await body<ImportPreview>(await post('/api/collection/import/preview', { csv: 'Count,Name,Edition\n2,Lightning Bolt,m10\n1,Nope,\n1,Sol Ring,' }))
    expect(preview.counts).toEqual({ resolved: 1, ambiguous: 1, unresolved: 1 })
    const items = preview.rows.flatMap((r) => (r.card ? [{ cardId: r.card.id, finish: r.finish, quantity: r.quantity }] : []))
    const res = await post('/api/collection/import', { items })
    expect(res.status).toBe(200)
    expect(await body<ImportResult>(res)).toEqual({ rows: 2, copies: 3 })
    expect((await body<CollectionStats>(await app.request('/api/collection/stats'))).totalCards).toBe(3)
  })

  it('reports a file it cannot read as bad_csv', async () => {
    const res = await post('/api/collection/import/preview', { csv: 'Count,Condition\n1,NM' })
    expect([res.status, await errorCode(res)]).toEqual([400, 'bad_csv'])
  })

  it('refuses the whole import when any item names an unknown card or a missing finish', async () => {
    for (const bad of [
      { cardId: 'nope', finish: 'nonfoil', quantity: 1 },
      { cardId: bolt('m10').id, finish: 'etched', quantity: 1 },
    ]) {
      const res = await post('/api/collection/import', { items: [{ cardId: bolt('m11').id, finish: 'nonfoil', quantity: 1 }, bad] })
      expect([res.status, await errorCode(res)]).toEqual([400, 'bad_import'])
    }
    expect((await body<CollectionStats>(await app.request('/api/collection/stats'))).totalCards).toBe(0)
  })
})

describe('GET /api/collection/export.csv', () => {
  it('exports Count,Name,Edition,Collector Number,Foil as a download', async () => {
    own(db, "Atraxa, Praetors' Voice", undefined, 1, 'foil')
    own(db, 'Lightning Bolt', 'm10', 2)
    const res = await app.request('/api/collection/export.csv')
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="binder-collection-\d{4}-\d{2}-\d{2}\.csv"$/)
    expect(await res.text()).toBe('Count,Name,Edition,Collector Number,Foil\r\n1,"Atraxa, Praetors\' Voice",2xm,190,foil\r\n2,Lightning Bolt,m10,146,\r\n')
  })

  it('starts the file with a byte order mark for Excel, asked with ?excel=1, and only then', async () => {
    own(db, 'Lightning Bolt', 'm10', 2)
    const bytes = async (url: string) => Buffer.from(await (await app.request(url)).arrayBuffer())
    const plain = await bytes('/api/collection/export.csv')
    const excel = await bytes('/api/collection/export.csv?excel=1')
    expect([...excel.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(excel.subarray(3)).toEqual(plain)
    expect(plain.subarray(0, 5).toString()).toBe('Count')
    // Binder's own import reads it back.
    const preview = await body<ImportPreview>(await post('/api/collection/import/preview', { csv: excel.toString('utf8') }))
    expect(preview.counts).toEqual({ resolved: 1, ambiguous: 0, unresolved: 0 })
  })

  it('round-trips: importing an export resolves every row to the same printing and finish', async () => {
    own(db, 'Lightning Bolt', 'sta', 1, 'etched')
    own(db, 'Fire // Ice', undefined, 3)
    own(db, 'Thrasios, Triton Hero', undefined, 1, 'foil')
    const csv = await (await app.request('/api/collection/export.csv')).text()
    const preview = await body<ImportPreview>(await post('/api/collection/import/preview', { csv }))
    expect(preview.counts).toEqual({ resolved: 3, ambiguous: 0, unresolved: 0 })
    const before = db.prepare('SELECT card_id, finish, quantity FROM collection ORDER BY card_id, finish').all()
    expect(preview.rows.map((r) => ({ card_id: r.card?.id, finish: r.finish, quantity: r.quantity })).sort((a, b) => (a.card_id! < b.card_id! ? -1 : 1))).toEqual(before)
  })
})
