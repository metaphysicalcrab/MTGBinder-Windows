import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { createBulkImporter, importCardsFile } from '../../src/server/bulk/import.ts'
import { CARD_DATA_VERSION } from '../../src/server/cards/map.ts'
import { autocomplete, getCard, insertCardRows, rebuildCardNames } from '../../src/server/cards/repo.ts'
import { openDb } from '../../src/server/db/index.ts'
import { deckDetail } from '../../src/server/decks/analysis.ts'
import { getMeta, setMeta } from '../../src/server/db/meta.ts'
import { ScryfallError, type ScryfallClient } from '../../src/server/scryfall/client.ts'
import type { ScryfallCard } from '../../src/server/scryfall/types.ts'
import { count, createTestDb, fixtureRows, tableExists } from '../helpers/db.ts'
import { fixtureCard, loadFixtureCards, loadTokenFixtures, syntheticCard } from '../helpers/fixtures.ts'
import { closeAtEnd, tempDir } from '../helpers/tmp.ts'

const SOURCE_UPDATED_AT = '2026-09-26T09:05:51.554+00:00'

let tmp: string
beforeEach(() => {
  // Removed after the databases a test opens in it are closed, even when the test fails first (see tempDir).
  tmp = tempDir('binder-bulk-')
})

const gzLines = (lines: string[]) => zlib.gzipSync(`${lines.join('\n')}\n`)
const gzCards = (cards: ScryfallCard[]) => gzLines(cards.map((c) => JSON.stringify(c)))

function writeFile(data: Buffer, name = 'cards.jsonl.gz'): string {
  const file = path.join(tmp, name)
  fs.writeFileSync(file, data)
  return file
}

function fakeClient(opts: { meta?: Record<string, unknown>; file?: Buffer; metaError?: Error }): ScryfallClient {
  return {
    async getJson<T>() {
      if (opts.metaError) throw opts.metaError
      return (opts.meta ?? {
        type: 'default_cards',
        updated_at: SOURCE_UPDATED_AT,
        jsonl_download_uri: 'https://data.scryfall.io/default-cards/default-cards.jsonl.gz',
      }) as T
    },
    async postJson<T>(): Promise<T> {
      throw new Error('not used')
    },
    async download() {
      return new Response(new Uint8Array(opts.file ?? Buffer.alloc(0)))
    },
  }
}

describe('importCardsFile', () => {
  it('imports importable cards and builds the name index', async () => {
    const db = openDb(':memory:')
    const result = await importCardsFile(db, writeFile(gzCards([...loadFixtureCards(), syntheticCard({ digital: true })])))
    expect(result).toEqual({ imported: 61, skipped: 1 })
    expect(count(db, 'cards')).toBe(61)
    expect(count(db, 'card_names')).toBe(58)
    expect(autocomplete(db, 'bolt')[0]?.name).toBe('Lightning Bolt')
    expect(tableExists(db, 'cards_staging')).toBe(false)
  })

  it('reports progress', async () => {
    const db = openDb(':memory:')
    const seen: number[] = []
    await importCardsFile(db, writeFile(gzCards(loadFixtureCards())), (n) => seen.push(n))
    expect(seen.at(-1)).toBe(61)
  })

  it('updates changed printings in place and removes printings Scryfall dropped', async () => {
    const db = createTestDb()
    const bolt = fixtureCard('Lightning Bolt', 'm10')
    const helix = fixtureCard('Lightning Helix')
    const next = loadFixtureCards()
      .filter((c) => c.id !== helix.id)
      .map((c) => (c.id === bolt.id ? { ...c, prices: { ...c.prices, usd: '99.99' } } : c))
    await importCardsFile(db, writeFile(gzCards(next)))
    expect(getCard(db, bolt.id)?.prices.usd).toBe(99.99)
    expect(getCard(db, helix.id)).toBeNull()
    expect(autocomplete(db, 'helix')).toEqual([])
  })

  it('keeps dropped printings that the collection, a deck, or the scan queue reference', async () => {
    const db = createTestDb()
    const helix = fixtureCard('Lightning Helix')
    const goyf = fixtureCard('Tarmogoyf')
    const jace = fixtureCard('Jace, the Mind Sculptor')
    db.prepare(
      "INSERT INTO collection (card_id, finish, quantity, added_at, updated_at) VALUES (?, 'nonfoil', 2, 't', 't')",
    ).run(helix.id)
    const deckId = db
      .prepare("INSERT INTO decks (name, format, status, created_at, updated_at) VALUES ('d', 'modern', 'built', 't', 't')")
      .run().lastInsertRowid
    db.prepare(
      "INSERT INTO deck_cards (deck_id, oracle_id, preferred_card_id, quantity, board) VALUES (?, ?, ?, 1, 'main')",
    ).run(deckId, goyf.oracle_id, goyf.id)
    db.prepare("INSERT INTO scan_items (status, card_id, created_at, updated_at) VALUES ('review', ?, 't', 't')").run(jace.id)

    const dropped = new Set([helix.id, goyf.id, jace.id])
    await importCardsFile(db, writeFile(gzCards(loadFixtureCards().filter((c) => !dropped.has(c.id)))))
    for (const id of dropped) expect(getCard(db, id)).not.toBeNull()
  })

  it("drops a deck card's printing that Scryfall dropped when the card itself is still in the new data", async () => {
    const db = createTestDb()
    const sta = fixtureCard('Lightning Bolt', 'sta')
    const deckId = Number(
      db.prepare("INSERT INTO decks (name, format, status, created_at, updated_at) VALUES ('d', 'modern', 'built', 't', 't')").run()
        .lastInsertRowid,
    )
    db.prepare("INSERT INTO deck_cards (deck_id, oracle_id, quantity, board) VALUES (?, ?, 4, 'main')").run(deckId, sta.oracle_id)

    // A frozen price on a printing Scryfall no longer lists could otherwise win the buy list.
    await importCardsFile(db, writeFile(gzCards(loadFixtureCards().filter((c) => c.id !== sta.id))))
    expect(getCard(db, sta.id)).toBeNull()
    for (const set of ['m10', 'm11']) expect(getCard(db, fixtureCard('Lightning Bolt', set).id)).not.toBeNull()
    expect(deckDetail(db, deckId)?.lines).toMatchObject([{ name: 'Lightning Bolt', quantity: 4, cardId: fixtureCard('Lightning Bolt', 'm11').id }])
  })

  it('keeps every printing of a card a deck line uses when the card is missing from the new data, so its line stays in its deck', async () => {
    const db = createTestDb()
    const bolt = fixtureCard('Lightning Bolt', 'm11')
    const deckId = Number(
      db.prepare("INSERT INTO decks (name, format, status, created_at, updated_at) VALUES ('d', 'modern', 'built', 't', 't')").run()
        .lastInsertRowid,
    )
    // A line on the card's default printing stores no printing of its own (preferred_card_id is null).
    db.prepare("INSERT INTO deck_cards (deck_id, oracle_id, quantity, board) VALUES (?, ?, 4, 'main')").run(deckId, bolt.oracle_id)

    await importCardsFile(db, writeFile(gzCards(loadFixtureCards().filter((c) => c.oracle_id !== bolt.oracle_id))))
    for (const set of ['m10', 'm11', 'sta']) expect(getCard(db, fixtureCard('Lightning Bolt', set).id)).not.toBeNull()
    expect(deckDetail(db, deckId)?.lines).toMatchObject([{ name: 'Lightning Bolt', quantity: 4, cardId: bolt.id }])
  })

  it('rejects a malformed line and leaves the previous data untouched', async () => {
    const db = createTestDb()
    const lines = loadFixtureCards().map((c) => JSON.stringify(c))
    lines.splice(2, 0, '{"object":"card", truncated')
    await expect(importCardsFile(db, writeFile(gzLines(lines)))).rejects.toThrow(/line 3/)
    expect(count(db, 'cards')).toBe(61)
    expect(autocomplete(db, 'bolt')[0]?.name).toBe('Lightning Bolt')
    expect(tableExists(db, 'cards_staging')).toBe(false)
  })

  it('rejects a truncated download and leaves the previous data untouched', async () => {
    const db = createTestDb()
    const full = gzCards(loadFixtureCards())
    await expect(importCardsFile(db, writeFile(full.subarray(0, Math.floor(full.length / 2))))).rejects.toThrow(/^Card data file is corrupt or incomplete \(unexpected end of file\)$/)
    expect(count(db, 'cards')).toBe(61)
    expect(tableExists(db, 'cards_staging')).toBe(false)
  })

  it('rejects a file with no importable cards and leaves the previous data untouched', async () => {
    const db = createTestDb()
    await expect(importCardsFile(db, writeFile(gzCards([syntheticCard({ digital: true })])))).rejects.toThrow(/no importable cards/)
    expect(count(db, 'cards')).toBe(61)
  })

  it('writes the given meta entries along with the merge', async () => {
    const db = createTestDb()
    setMeta(db, 'bulk_error', 'old')
    await importCardsFile(db, writeFile(gzCards(loadFixtureCards())), undefined, { bulk_updated_at: 'x', bulk_error: null })
    expect(getMeta(db, 'bulk_updated_at')).toBe('x')
    expect(getMeta(db, 'bulk_error')).toBeNull()
    expect(getMeta(db, 'card_data_version')).toBe(String(CARD_DATA_VERSION))
  })

  it('lets two connections to the same database import at the same time', async () => {
    const file = path.join(tmp, 'binder.db')
    const a = closeAtEnd(openDb(file))
    const b = closeAtEnd(openDb(file))
    const cards = writeFile(gzCards(loadFixtureCards()))
    let importB: Promise<unknown> = Promise.resolve('B never started')
    const importA = importCardsFile(a, cards, () => {
      // Deterministic overlap: onProgress runs synchronously after A's rows are in its staging table and before A
      // merges them, so B sets up its own staging while A's is full; B's read, merge, and cleanup then follow.
      importB = importCardsFile(b, cards)
    })
    await expect(importA).resolves.toEqual({ imported: 61, skipped: 0 })
    await expect(importB).resolves.toEqual({ imported: 61, skipped: 0 })
    expect(count(a, 'cards')).toBe(61)
    expect(count(b, 'cards')).toBe(61)
    expect(a.prepare("SELECT 1 FROM main.sqlite_master WHERE name = 'cards_staging'").get()).toBeUndefined()
    expect(tableExists(a, 'cards_staging')).toBe(false)
    expect(tableExists(b, 'cards_staging')).toBe(false)
    a.close()
    b.close()
  })

  it('does not write the meta entries when the import fails', async () => {
    const db = createTestDb()
    const lines = loadFixtureCards().map((c) => JSON.stringify(c))
    lines.splice(2, 0, '{"object":"card", truncated')
    await expect(importCardsFile(db, writeFile(gzLines(lines)), undefined, { bulk_updated_at: 'x' })).rejects.toThrow(/line 3/)
    expect(getMeta(db, 'bulk_updated_at')).toBeNull()
  })
})

describe('importing tokens', () => {
  const all = (db: ReturnType<typeof openDb>, sql: string) => db.prepare(sql).pluck().all() as string[]
  const TOKENS = [
    'Beast (token)',
    'Elspeth, Knight-Errant Emblem (emblem)',
    'Human Cleric (token)',
    'Incubator // Phyrexian (double_faced_token)',
    'Insect (token)',
    'Treasure (token)',
    'Wicked // Cursed (flip)',
  ]

  it('puts tokens and emblems in tokens, never in cards or search, and links each card to the tokens it makes', async () => {
    const db = openDb(':memory:')
    const result = await importCardsFile(db, writeFile(gzCards([...loadFixtureCards(), ...loadTokenFixtures()])))
    expect(result).toEqual({ imported: 63, skipped: 8 })
    expect(all(db, "SELECT name || ' (' || layout || ')' FROM tokens ORDER BY name")).toEqual(TOKENS)
    const names = loadTokenFixtures().filter((c) => c.layout !== 'normal').map((c) => c.name)
    expect(db.prepare(`SELECT count(*) FROM cards WHERE name IN (${names.map(() => '?').join(', ')})`).pluck().get(...names)).toBe(0)
    expect(autocomplete(db, 'Wicked')).toEqual([])
    expect(autocomplete(db, 'Elspeth').map((c) => c.name)).toEqual(['Elspeth, Knight-Errant'])
    // Elspeth also makes Soldiers, whose printing isn't in the data: that link is dropped.
    expect(
      all(db, `SELECT n.name || ' → ' || t.name FROM card_tokens ct
               JOIN card_names n ON n.oracle_id = ct.oracle_id JOIN tokens t ON t.oracle_id = ct.token_oracle_id ORDER BY 1`),
    ).toEqual([
      'Beast Within → Beast',
      'Elspeth, Knight-Errant → Elspeth, Knight-Errant Emblem',
      'Garruk Wildspeaker → Beast',
      'Grist, the Hunger Tide → Insect',
      'Smothering Tithe → Treasure',
      'Westvale Abbey // Ormendahl, Profane Prince → Human Cleric',
      "Witch's Mark → Wicked // Cursed",
    ])
    expect(getMeta(db, 'card_data_version')).toBe(String(CARD_DATA_VERSION))
  })

  it("keeps each token's newest English printing, passing over one dated in the future", async () => {
    const db = openDb(':memory:')
    const lines = loadTokenFixtures()
    const beast = lines.find((c) => c.name === 'Beast' && c.set === 'tmic')!
    const treasure = lines.find((c) => c.name === 'Treasure')!
    const fake = (name: string) => ({ small: `https://example.test/${name}-small.jpg`, normal: `https://example.test/${name}.jpg` })
    const future = { ...beast, id: '00000000-0000-4000-8000-00000000f001', released_at: '2999-01-01', image_uris: fake('future') }
    const japanese = { ...treasure, id: '00000000-0000-4000-8000-00000000f002', lang: 'ja', released_at: '2026-01-01', image_uris: fake('ja') }
    await importCardsFile(db, writeFile(gzCards([...loadFixtureCards(), ...lines, future, japanese])))
    const image = (name: string) => db.prepare('SELECT image_small FROM tokens WHERE name = ?').pluck().get(name) as string
    // The newest Beast in the fixture (tmsc, 2026-06-26), not the one "from" 2999.
    expect(image('Beast')).toBe(lines.find((c) => c.name === 'Beast' && c.set === 'tmsc')!.image_uris!.small)
    expect(image('Treasure')).toBe(treasure.image_uris!.small)
    // A double-faced token's image is its front's, and its faces are kept.
    const incubator = db.prepare("SELECT image_small, card_faces FROM tokens WHERE name = 'Incubator // Phyrexian'").get() as { image_small: string; card_faces: string }
    expect(incubator.image_small).toContain('/front/')
    expect((JSON.parse(incubator.card_faces) as Array<{ name: string }>).map((f) => f.name)).toEqual(['Incubator', 'Phyrexian'])
  })

  it('replaces the tokens with each import, and leaves them alone when an import fails', async () => {
    const db = openDb(':memory:')
    await importCardsFile(db, writeFile(gzCards([...loadFixtureCards(), ...loadTokenFixtures()])))
    await expect(importCardsFile(db, writeFile(gzLines([JSON.stringify(fixtureCard('Sol Ring')), '{not json'])))).rejects.toThrow(
      'Malformed card data on line 2',
    )
    expect([count(db, 'tokens'), count(db, 'card_tokens')]).toEqual([7, 7])
    expect(tableExists(db, 'tokens_staging') || tableExists(db, 'card_tokens_staging')).toBe(false)
    await importCardsFile(db, writeFile(gzCards(loadFixtureCards())))
    expect([count(db, 'tokens'), count(db, 'card_tokens')]).toEqual([0, 0])
  })
})

describe('bulk importer', () => {
  it('downloads, imports, records metadata, and clears an old error', async () => {
    const db = openDb(':memory:')
    setMeta(db, 'bulk_error', 'old failure')
    const bulk = createBulkImporter({
      db,
      client: fakeClient({ file: gzCards(loadFixtureCards()) }),
      dataDir: tmp,
      now: () => new Date('2026-09-26T12:00:00Z'),
    })
    await bulk.start()
    expect(bulk.status()).toEqual({
      state: 'idle',
      processed: 61,
      error: null,
      updatedAt: '2026-09-26T12:00:00.000Z',
      sourceUpdatedAt: SOURCE_UPDATED_AT,
      cardCount: 61,
    })
    expect(fs.existsSync(path.join(tmp, 'bulk', 'default-cards.jsonl.gz'))).toBe(true)
  })

  it('refuses to start a second import while one is running', async () => {
    const db = openDb(':memory:')
    const bulk = createBulkImporter({ db, client: fakeClient({ file: gzCards(loadFixtureCards()) }), dataDir: tmp })
    const first = bulk.start()
    expect(first).not.toBeNull()
    expect(bulk.start()).toBeNull()
    await first
    const again = bulk.start()
    expect(again).not.toBeNull()
    await again
  })

  it('records an error naming the fields when the metadata has no JSONL download', async () => {
    const db = createTestDb()
    const bulk = createBulkImporter({
      db,
      client: fakeClient({ meta: { type: 'default_cards', updated_at: 'x', download_uri: 'https://example.com/x.json' } }),
      dataDir: tmp,
    })
    await bulk.start()
    const status = bulk.status()
    expect(status.state).toBe('error')
    expect(status.error).toMatch(/jsonl_download_uri.*download_uri/)
    expect(getMeta(db, 'bulk_error')).toBe(status.error)
    expect(status.cardCount).toBe(61)
  })

  it('records an error and leaves the card data alone when the metadata has no updated_at', async () => {
    const db = createTestDb()
    const bulk = createBulkImporter({
      db,
      client: fakeClient({
        meta: { type: 'default_cards', jsonl_download_uri: 'https://data.scryfall.io/x.jsonl.gz' },
        file: gzCards(loadFixtureCards().slice(0, 10)),
      }),
      dataDir: tmp,
    })
    await bulk.start()
    const status = bulk.status()
    expect(status).toMatchObject({ state: 'error', updatedAt: null, cardCount: 61 })
    expect(status.error).toMatch(/updated_at/)
    expect(fs.existsSync(path.join(tmp, 'bulk', 'default-cards.jsonl.gz'))).toBe(false)
  })

  it('says which step failed when the download breaks', async () => {
    const db = createTestDb()
    const client = { ...fakeClient({}), download: () => Promise.reject(new ScryfallError('offline', null, 'Scryfall is unreachable: terminated')) }
    const bulk = createBulkImporter({ db, client, dataDir: tmp })
    await bulk.start()
    expect(bulk.status()).toMatchObject({
      state: 'error',
      error: 'Card data download failed: Scryfall is unreachable: terminated. The card data already here stays in use',
      cardCount: 61,
    })
  })

  it('says plainly that the card data stays in use when Scryfall is offline, instead of throwing', async () => {
    const db = createTestDb()
    setMeta(db, 'bulk_updated_at', '2026-09-20T08:00:00.000Z')
    const logged: string[] = []
    const offline = new ScryfallError('offline', null, 'Scryfall is unreachable: ECONNREFUSED')
    const bulk = createBulkImporter({ db, client: fakeClient({ metaError: offline }), dataDir: tmp, log: (m) => logged.push(m) })
    await expect(bulk.start()).resolves.toBeUndefined()
    const message = 'Scryfall is unreachable: ECONNREFUSED. The card data from 2026-09-20 stays in use'
    expect(bulk.status()).toMatchObject({ state: 'error', error: message, cardCount: 61 })
    expect(logged).toEqual([message])
  })

  it('says the download failed, not that it is offline, when there is no card data yet', async () => {
    const db = openDb(':memory:')
    const offline = new ScryfallError('offline', null, 'Scryfall is unreachable: ECONNREFUSED')
    const bulk = createBulkImporter({ db, client: fakeClient({ metaError: offline }), dataDir: tmp })
    await bulk.start()
    expect(bulk.status()).toMatchObject({ state: 'error', error: 'Scryfall is unreachable: ECONNREFUSED', cardCount: 0 })
  })

  it('counts a download that stalls partway as offline too', async () => {
    const db = createTestDb()
    const client = fakeClient({ file: gzCards(loadFixtureCards()) })
    client.download = () => Promise.reject(new ScryfallError('offline', null, 'The download stalled: Scryfall stopped sending data'))
    const bulk = createBulkImporter({ db, client, dataDir: tmp })
    await bulk.start()
    expect(bulk.status().error).toBe(
      'Card data download failed: The download stalled: Scryfall stopped sending data. The card data already here stays in use',
    )
  })

  it('records an error and leaves the card data alone when the download is truncated', async () => {
    const db = createTestDb()
    const full = gzCards(loadFixtureCards())
    const bulk = createBulkImporter({
      db,
      client: fakeClient({ file: full.subarray(0, Math.floor(full.length / 2)) }),
      dataDir: tmp,
    })
    await expect(bulk.start()).resolves.toBeUndefined()
    const status = bulk.status()
    expect(status).toMatchObject({ state: 'error', updatedAt: null, cardCount: 61 })
    expect(status.error).not.toBeNull()
  })

  it('still settles in the error state when the error itself cannot be recorded', async () => {
    const file = path.join(tmp, 'binder.db')
    const seed = openDb(file)
    insertCardRows(seed, 'cards', fixtureRows())
    rebuildCardNames(seed)
    seed.close()
    // Every write fails on this connection, including recording bulk_error.
    const db = closeAtEnd(new Database(file, { readonly: true }))
    const logged: string[] = []
    const bulk = createBulkImporter({
      db,
      client: fakeClient({ metaError: new ScryfallError('offline', null, 'Scryfall is unreachable: ECONNREFUSED') }),
      dataDir: tmp,
      log: (message) => logged.push(message),
    })
    await expect(bulk.start()).resolves.toBeUndefined()
    // The error is still reported, from memory, though the database couldn't record it.
    const message = 'Scryfall is unreachable: ECONNREFUSED. The card data already here stays in use'
    expect(bulk.status()).toMatchObject({ state: 'error', cardCount: 61, error: message })
    expect(logged).toEqual([expect.stringMatching(/readonly database/), message])
    db.close()
  })

  it('still resolves and reports the failure when the database cannot even be read', async () => {
    const file = path.join(tmp, 'binder.db')
    const seed = openDb(file)
    insertCardRows(seed, 'cards', fixtureRows())
    seed.pragma('journal_mode = DELETE')
    seed.close()
    const db = closeAtEnd(new Database(file, { timeout: 0 }))
    // Another connection holds the file: every read on this one fails ("database is locked").
    const locker = closeAtEnd(new Database(file))
    locker.exec('BEGIN EXCLUSIVE')
    const logged: string[] = []
    const bulk = createBulkImporter({
      db,
      client: fakeClient({ metaError: new ScryfallError('offline', null, 'Scryfall is unreachable: ECONNREFUSED') }),
      dataDir: tmp,
      log: (message) => logged.push(message),
    })
    try {
      await expect(bulk.start()).resolves.toBeUndefined()
    } finally {
      locker.exec('ROLLBACK')
      locker.close()
    }
    // Whether card data is here couldn't be read, so the reason is said as it is.
    expect(bulk.status()).toMatchObject({ state: 'error', error: 'Scryfall is unreachable: ECONNREFUSED', cardCount: 61 })
    expect(logged).toEqual([
      expect.stringMatching(/Could not record the refresh error: database is locked/),
      'Card data refresh failed: Scryfall is unreachable: ECONNREFUSED',
    ])
    db.close()
  })

  it('reports the latest failure over an older one the database recorded, when it could not record the latest', async () => {
    const file = path.join(tmp, 'binder.db')
    const seed = openDb(file)
    insertCardRows(seed, 'cards', fixtureRows())
    setMeta(seed, 'bulk_error', 'Card data download failed: an older failure')
    seed.close()
    const db = closeAtEnd(new Database(file, { readonly: true }))
    const bulk = createBulkImporter({
      db,
      client: fakeClient({ metaError: new ScryfallError('offline', null, 'Scryfall is unreachable: ECONNREFUSED') }),
      dataDir: tmp,
      log: () => {},
    })
    await bulk.start()
    expect(bulk.status().error).toBe('Scryfall is unreachable: ECONNREFUSED. The card data already here stays in use')
    db.close()
  })

  it('names the day the card data is from in local time', async () => {
    const zone = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    onTestFinished(() => {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    })
    const db = createTestDb()
    // 8 pm on September 20 in Los Angeles, already September 21 in UTC.
    setMeta(db, 'bulk_updated_at', '2026-09-21T03:00:00.000Z')
    const offline = new ScryfallError('offline', null, 'Scryfall is unreachable: ECONNREFUSED')
    const bulk = createBulkImporter({ db, client: fakeClient({ metaError: offline }), dataDir: tmp })
    await bulk.start()
    expect(bulk.status().error).toBe('Scryfall is unreachable: ECONNREFUSED. The card data from 2026-09-20 stays in use')
  })

  it('is stale when never imported, older than 7 days, or imported by an older card data version, and says which', () => {
    const db = openDb(':memory:')
    let now = new Date('2026-09-26T00:00:00Z')
    const bulk = createBulkImporter({ db, client: fakeClient({}), dataDir: tmp, now: () => now })
    expect([bulk.isStale(), bulk.staleReason()]).toEqual([true, "Card data isn't downloaded yet"])
    setMeta(db, 'bulk_updated_at', '2026-09-25T00:00:00.000Z')
    setMeta(db, 'card_data_version', String(CARD_DATA_VERSION))
    expect([bulk.isStale(), bulk.staleReason()]).toEqual([false, null])
    setMeta(db, 'card_data_version', null)
    expect([bulk.isStale(), bulk.staleReason()]).toEqual([true, 'Card data is from an older Binder version'])
    setMeta(db, 'card_data_version', String(CARD_DATA_VERSION - 1))
    expect(bulk.isStale()).toBe(true)
    setMeta(db, 'card_data_version', String(CARD_DATA_VERSION))
    now = new Date('2026-10-04T00:00:01Z')
    expect([bulk.isStale(), bulk.staleReason()]).toEqual([true, 'Card data is 9 days old'])
    setMeta(db, 'bulk_updated_at', 'garbled')
    expect([bulk.isStale(), bulk.staleReason()]).toEqual([true, 'Card data has no readable date'])
  })

  function keptFile(data: Buffer): string {
    const file = path.join(tmp, 'bulk', 'default-cards.jsonl.gz')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, data)
    return file
  }

  it('re-imports the kept file instead of downloading when Scryfall has nothing newer', async () => {
    const db = openDb(':memory:')
    keptFile(gzCards(loadFixtureCards()))
    setMeta(db, 'bulk_source_updated_at', SOURCE_UPDATED_AT)
    const client = fakeClient({})
    client.download = () => Promise.reject(new Error('should not download'))
    const logs: string[] = []
    const bulk = createBulkImporter({ db, client, dataDir: tmp, log: (m) => logs.push(m) })
    await bulk.start()
    expect(bulk.status()).toMatchObject({ state: 'idle', error: null, cardCount: 61 })
    expect(logs[0]).toMatch(/re-importing the downloaded file/)
    expect(getMeta(db, 'card_data_version')).toBe(String(CARD_DATA_VERSION))
  })

  it('downloads when Scryfall has newer data than the kept file', async () => {
    const db = openDb(':memory:')
    keptFile(gzLines(['not json']))
    setMeta(db, 'bulk_source_updated_at', '2026-09-01T00:00:00.000+00:00')
    const bulk = createBulkImporter({ db, client: fakeClient({ file: gzCards(loadFixtureCards()) }), dataDir: tmp })
    await bulk.start()
    expect(bulk.status()).toMatchObject({ state: 'idle', error: null, sourceUpdatedAt: SOURCE_UPDATED_AT, cardCount: 61 })
  })

  it('keeps the kept file when the database, not the file, is what failed', async () => {
    const file = keptFile(gzCards(loadFixtureCards()))
    const dbFile = path.join(tmp, 'binder.db')
    openDb(dbFile).close()
    const seed = new Database(dbFile)
    seed.prepare("INSERT INTO meta (key, value) VALUES ('bulk_source_updated_at', ?)").run(SOURCE_UPDATED_AT)
    seed.close()
    const db = closeAtEnd(new Database(dbFile, { readonly: true }))
    const bulk = createBulkImporter({ db, client: fakeClient({}), dataDir: tmp, log: () => {} })
    await bulk.start()
    expect(bulk.status().error).toMatch(/readonly/)
    expect(fs.existsSync(file)).toBe(true)
    db.close()
  })

  it('deletes a kept file that fails to import, so the next refresh downloads a fresh copy', async () => {
    const db = openDb(':memory:')
    const file = keptFile(gzLines(['not json']))
    setMeta(db, 'bulk_source_updated_at', SOURCE_UPDATED_AT)
    const bulk = createBulkImporter({ db, client: fakeClient({ file: gzCards(loadFixtureCards()) }), dataDir: tmp })
    await bulk.start()
    expect(bulk.status()).toMatchObject({ state: 'error', error: 'Malformed card data on line 1', cardCount: 0 })
    expect(fs.existsSync(file)).toBe(false)
    await bulk.start()
    expect(bulk.status()).toMatchObject({ state: 'idle', error: null, cardCount: 61 })
  })
})
