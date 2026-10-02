import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../../src/server/db/index.ts'
import { replay } from '../../src/shared/playtest/game.ts'
import type { Action, CardData, SavedGame } from '../../src/shared/playtest/types.ts'
import type { ApiErrorBody, DeckSummary } from '../../src/shared/types.ts'
import { body, makeApp } from '../helpers/app.ts'
import { addTokens, count, createTestDb } from '../helpers/db.ts'
import { fixtureCard, loadTokenFixtures } from '../helpers/fixtures.ts'

let db: DB
let app: ReturnType<typeof makeApp>
/** What the routes' `random` answers next: the seed, then the starting seat when it's random. */
let rolls: number[]

beforeEach(() => {
  db = createTestDb()
  rolls = []
  app = makeApp({ db, playtestRandom: (max) => (rolls.shift() ?? 0) % max })
})

const send = (method: string, path: string, json?: unknown) =>
  app.request(path, json === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) })
async function error(res: Response): Promise<[number, string, string]> {
  const { code, message } = (await body<ApiErrorBody>(res)).error
  return [res.status, code, message]
}

async function newDeck(name: string, format = 'commander'): Promise<number> {
  return (await body<DeckSummary>(await send('POST', '/api/decks', { name, format }))).id
}

async function add(deckId: number, name: string, board = 'main', delta = 1, set?: string): Promise<void> {
  const res = await send('POST', `/api/decks/${deckId}/cards`, { cardId: fixtureCard(name, set).id, board, delta })
  expect(res.status).toBe(200)
}

/**
 * "Atraxa Superfriends": Atraxa as commander; on the main board 5 Forests and one each of Llanowar Elves, Delver of
 * Secrets (double-faced), Brazen Borrower (an adventure), Fire // Ice (split), Lightning Bolt (its M10 printing chosen),
 * Dryad Arbor, and Sol Ring: 12 cards. Counterspell on the sideboard and Wrath of God on the maybe board.
 */
async function atraxa(): Promise<number> {
  const id = await newDeck('Atraxa Superfriends')
  await add(id, "Atraxa, Praetors' Voice", 'commander')
  await add(id, 'Forest', 'main', 5)
  for (const name of ['Llanowar Elves', 'Delver of Secrets // Insectile Aberration', 'Brazen Borrower // Petty Theft', 'Fire // Ice', 'Dryad Arbor', 'Sol Ring']) {
    await add(id, name)
  }
  await add(id, 'Lightning Bolt', 'main', 1, 'm10')
  await add(id, 'Counterspell', 'side')
  await add(id, 'Wrath of God', 'maybe')
  return id
}

const start = (decks: [number, number | null], extra: Record<string, unknown> = {}) =>
  send('POST', '/api/playtest', { decks, first: 0, life: 40, startingDraws: false, ...extra })

async function started(decks: [number, number | null]): Promise<SavedGame> {
  const res = await start(decks)
  expect(res.status).toBe(201)
  return body<SavedGame>(res)
}

/** The keep that ends seat 1's mulligan: its hand's last 3 cards to the bottom. */
function keep(game: SavedGame): Action {
  const g = replay(game.setup, game.actions)
  return { type: 'keep', seat: 0, bottom: g.seats[0]!.hand.slice(7) }
}

describe('the token search', () => {
  const search = async (q: string) => body<CardData[]>(await app.request(`/api/playtest/tokens?q=${encodeURIComponent(q)}`))

  it('finds tokens and emblems by name, ignoring case: the whole name first, then names starting with it', async () => {
    addTokens(db)
    expect((await search('t')).map((t) => t.name)).toEqual([
      'Treasure',
      'Beast',
      'Elspeth, Knight-Errant Emblem',
      'Incubator // Phyrexian',
      'Insect',
    ])
    expect((await search('BEAST')).map((t) => t.name)).toEqual(['Beast'])
    expect((await search('elspeth'))[0]).toMatchObject({ name: 'Elspeth, Knight-Errant Emblem', kind: 'emblem', colors: '' })
    const [incubator] = await search('incubator')
    expect(incubator!.faces.map((f) => [f.name, f.image !== null])).toEqual([
      ['Incubator', true],
      ['Phyrexian', true],
    ])
    expect(await search('  ')).toEqual([])
    expect(await search('%')).toEqual([])
  })

  it('finds nothing until card data has been imported with tokens, and refuses a query past 100 characters', async () => {
    expect(await search('treasure')).toEqual([])
    const [status, code] = await error(await app.request(`/api/playtest/tokens?q=${'a'.repeat(101)}`))
    expect([status, code]).toEqual([400, 'bad_request'])
  })

  it('finds nothing for a request without a query', async () => {
    addTokens(db)
    const res = await app.request('/api/playtest/tokens')
    expect(res.status).toBe(200)
    expect(await body<CardData[]>(res)).toEqual([])
  })
})

describe('starting a game', () => {
  it("copies each deck's commander and main boards into the game, one card per copy, commanders first", async () => {
    const deck = await atraxa()
    rolls = [123456]
    const { setup, actions } = await started([deck, null])
    expect(actions).toEqual([])
    expect(setup).toMatchObject({ version: 1, seed: 123456, startingSeat: 0, life: 40, startingDraws: false })
    const [seat] = setup.seats
    expect(seat).toMatchObject({ deckId: deck, name: 'Atraxa Superfriends', format: 'commander', leftOut: 0 })
    expect(seat!.cards).toHaveLength(13)
    expect(seat!.cards[0]).toMatchObject({ id: '1-1', commander: true, data: { name: "Atraxa, Praetors' Voice", kind: 'creature', colors: 'WUBG' } })
    expect(seat!.cards.map((c) => c.id)).toEqual(Array.from({ length: 13 }, (_, i) => `1-${i + 1}`))
    const named = (name: string) => seat!.cards.find((c) => c.data.name === name)!.data
    expect(seat!.cards.filter((c) => c.data.name === 'Forest')).toHaveLength(5)
    expect(named('Dryad Arbor').kind).toBe('land')
    expect(named('Fire // Ice').kind).toBe('spell')
    expect(named('Sol Ring')).toMatchObject({ kind: 'other', faces: [{ name: 'Sol Ring', typeLine: 'Artifact' }] })
    expect(named('Lightning Bolt').faces[0]!.image).toBe(fixtureCard('Lightning Bolt', 'm10').image_uris!.normal)
    const delver = named('Delver of Secrets // Insectile Aberration')
    expect(delver.faces.map((f) => [f.name, f.image !== null])).toEqual([
      ['Delver of Secrets', true],
      ['Insectile Aberration', true],
    ])
    // An adventure's two halves share the card's one image.
    const borrower = named('Brazen Borrower // Petty Theft')
    expect(borrower.faces.map((f) => [f.name, f.image])).toEqual([
      ['Brazen Borrower', fixtureCard('Brazen Borrower // Petty Theft').image_uris!.normal],
      ['Petty Theft', null],
    ])
    expect(seat!.cards.some((c) => c.data.name === 'Counterspell' || c.data.name === 'Wrath of God')).toBe(false)
  })

  it('gives each card the tokens it makes, from the card data', async () => {
    addTokens(db)
    const id = await newDeck('Tokens')
    for (const name of ['Smothering Tithe', 'Garruk Wildspeaker', 'Beast Within', 'Sol Ring']) await add(id, name)
    await add(id, 'Forest', 'main', 6)
    const { setup } = await started([id, null])
    const named = (name: string) => setup.seats[0]!.cards.find((c) => c.data.name === name)!.data
    const treasure = loadTokenFixtures().find((c) => c.name === 'Treasure')!
    expect(named('Smothering Tithe').tokens).toEqual([
      {
        name: 'Treasure',
        faces: [
          {
            name: 'Treasure',
            manaCost: '',
            typeLine: 'Token Artifact — Treasure',
            oracleText: treasure.oracle_text,
            power: null,
            toughness: null,
            loyalty: null,
            image: treasure.image_uris!.normal,
          },
        ],
        imageSmall: treasure.image_uris!.small,
        colors: '',
        kind: 'other',
      },
    ])
    // Garruk and Beast Within make the same Beast.
    const beasts = named('Garruk Wildspeaker').tokens!
    expect(beasts.map((t) => [t.name, t.kind, t.faces[0]!.power, t.colors])).toEqual([['Beast', 'creature', '3', 'G']])
    expect(named('Beast Within').tokens).toEqual(named('Garruk Wildspeaker').tokens)
    expect(named('Sol Ring')).not.toHaveProperty('tokens')
  })

  it("leaves Scryfall's Copy stand-in out of a card's tokens", async () => {
    addTokens(db)
    const tithe = fixtureCard('Smothering Tithe').oracle_id!
    db.prepare(`INSERT INTO tokens (oracle_id, name, layout, type_line, oracle_text, colors) VALUES ('copy', 'Copy', 'token', 'Token', '', '')`).run()
    db.prepare(`INSERT INTO card_tokens (oracle_id, token_oracle_id) VALUES (?, 'copy')`).run(tithe)
    const id = await newDeck('Tithes')
    await add(id, 'Smothering Tithe')
    await add(id, 'Forest', 'main', 9)
    const { setup } = await started([id, null])
    expect(setup.seats[0]!.cards.find((c) => c.data.name === 'Smothering Tithe')!.data.tokens!.map((t) => t.name)).toEqual(['Treasure'])
  })

  it('numbers seat 2 apart, and picks a random starting seat when asked', async () => {
    const a = await atraxa()
    rolls = [9, 1]
    const { setup } = await body<SavedGame>(await start([a, a], { first: 'random' }))
    expect(setup.seats[1]!.cards[0]!.id).toBe('2-1')
    expect(setup.startingSeat).toBe(1)
  })

  it('counts the copies whose card is gone from the card data, and leaves them out', async () => {
    const deck = await atraxa()
    db.prepare("INSERT INTO deck_cards (deck_id, oracle_id, quantity, board) VALUES (?, 'gone', 2, 'main')").run(deck)
    const { setup } = await started([deck, null])
    expect(setup.seats[0]).toMatchObject({ leftOut: 2 })
    expect(setup.seats[0]!.cards).toHaveLength(13)
  })

  it('refuses a deck too small to play, a deck that is gone, and seat 2 going first with no deck', async () => {
    const small = await newDeck('Tiny', 'modern')
    await add(small, 'Forest', 'main', 9)
    expect(await error(await start([small, null]))).toEqual([
      400,
      'deck_too_small',
      'Tiny has 9 main-board cards; a deck needs at least 10 to play',
    ])
    expect(await error(await start([999, null]))).toEqual([404, 'not_found', 'That deck no longer exists'])
    expect(await error(await start([await atraxa(), null], { first: 1 }))).toEqual([
      400,
      'bad_request',
      "Seat 2 has no deck, so it can't go first",
    ])
    expect((await start([small, null], { life: 0 })).status).toBe(400)
  })

  it('replaces the game in progress, with its actions', async () => {
    const deck = await atraxa()
    const first = await started([deck, null])
    expect((await save(first, 0, keep(first))).status).toBe(204)
    await started([deck, deck])
    const now = await body<SavedGame>(await app.request('/api/playtest'))
    expect(now.setup.seats).toHaveLength(2)
    expect(now.actions).toEqual([])
    expect(count(db, 'playtest_game')).toBe(1)
    expect(count(db, 'playtest_actions')).toBe(0)
  })
})

/** Saves an action for `game` at position `seq`. */
const save = (game: SavedGame, seq: number, action: unknown) =>
  send('POST', '/api/playtest/actions', { startedAt: game.startedAt, seq, action })
/** Takes back the action at position `seq` (as written in the address) of `game`. */
const undo = (game: SavedGame, seq: string) =>
  send('DELETE', `/api/playtest/actions/last?startedAt=${encodeURIComponent(game.startedAt)}&seq=${seq}`)

describe('saving actions', () => {
  it('saves each action at the next position, and gives the game back with them', async () => {
    const game = await started([await atraxa(), null])
    expect(game.startedAt).toMatch(/^\d{4}-\d\d-\d\dT/)
    const action = keep(game)
    expect((await save(game, 0, action)).status).toBe(204)
    expect((await save(game, 1, { type: 'nextTurn' })).status).toBe(204)
    const saved = await body<SavedGame>(await app.request('/api/playtest'))
    expect(saved.startedAt).toBe(game.startedAt)
    expect(saved.actions).toEqual([action, { type: 'nextTurn' }])
    expect(replay(saved.setup, saved.actions).turn).toBe(2)
  })

  it("saves an emblem, which goes to the seat's command zone", async () => {
    const game = await started([await atraxa(), null])
    await save(game, 0, keep(game))
    const face = {
      name: 'Elspeth, Knight-Errant Emblem',
      manaCost: '',
      typeLine: 'Emblem — Elspeth',
      oracleText: 'Artifacts, creatures, enchantments, and lands you control have indestructible.',
      power: null,
      toughness: null,
      loyalty: null,
      image: null,
    }
    const emblem = { name: face.name, faces: [face], imageSmall: null, colors: '', kind: 'emblem' as const }
    expect((await save(game, 1, { type: 'token', seat: 0, token: emblem, count: 1 })).status).toBe(204)
    const saved = await body<SavedGame>(await app.request('/api/playtest'))
    expect(replay(saved.setup, saved.actions).seats[0]!.command).toEqual(['1-1', 't1'])
  })

  it('refuses another game or a position other than the next (409), an action that does not apply (400), and one malformed', async () => {
    const game = await started([await atraxa(), null])
    const changed = [409, 'conflict', 'The game changed in another window or on another device']
    expect(await error(await save(game, 1, keep(game)))).toEqual(changed)
    expect(await error(await save({ ...game, startedAt: '2020-01-01T00:00:00.000Z' }, 0, keep(game)))).toEqual(changed)
    expect(await error(await save(game, 0, { type: 'draw', seat: 0, count: 1 }))).toEqual([400, 'bad_action', 'Finish the mulligans first'])
    expect((await save(game, 0, { type: 'draw', seat: 3, count: 1 })).status).toBe(400)
    expect((await save(game, 0, { type: 'teleport' })).status).toBe(400)
    expect(count(db, 'playtest_actions')).toBe(0)
  })

  it("refuses a card id that's the name of something every object has (400), so a saved game's log still reads", async () => {
    const game = await started([await atraxa(), null])
    await save(game, 0, keep(game))
    expect(await error(await save(game, 1, { type: 'reveal', ids: ['constructor'] }))).toEqual([400, 'bad_action', 'That card is no longer in the game'])
    expect(count(db, 'playtest_actions')).toBe(1)
  })

  it('takes back only the last action of the game named', async () => {
    const game = await started([await atraxa(), null])
    await save(game, 0, keep(game))
    await save(game, 1, { type: 'nextTurn' })
    expect(await error(await undo(game, '0'))).toEqual([409, 'conflict', 'The game changed in another window or on another device'])
    expect((await undo({ ...game, startedAt: '2020-01-01T00:00:00.000Z' }, '1')).status).toBe(409)
    expect((await undo(game, '01')).status).toBe(400)
    expect((await undo(game, '1')).status).toBe(204)
    expect((await undo(game, '0')).status).toBe(204)
    expect((await undo(game, '0')).status).toBe(409)
    expect((await body<SavedGame>(await app.request('/api/playtest'))).actions).toEqual([])
  })
})

describe('the game in progress', () => {
  it('is 404 when there is none, and ends', async () => {
    expect(await error(await app.request('/api/playtest'))).toEqual([404, 'not_found', 'No game in progress'])
    const none = { startedAt: '2020-01-01T00:00:00.000Z', setup: null, actions: [] } as unknown as SavedGame
    expect((await save(none, 0, { type: 'nextTurn' })).status).toBe(404)
    expect((await undo(none, '0')).status).toBe(404)
    await started([await atraxa(), null])
    expect((await send('DELETE', '/api/playtest')).status).toBe(204)
    expect((await app.request('/api/playtest')).status).toBe(404)
    expect((await send('DELETE', '/api/playtest')).status).toBe(204)
  })
})
