import { randomInt } from 'node:crypto'
import { Hono } from 'hono'
import { PlaytestError, replay } from '../../shared/playtest/game.ts'
import { MODEL_VERSION, type CardData, type SavedGame, type SeatIndex, type Setup } from '../../shared/playtest/types.ts'
import { searchTokens } from '../cards/tokens.ts'
import type { DB } from '../db/index.ts'
import { ApiError, parseWith, readJson } from '../http.ts'
import { deleteAction, deleteGame, gameProgress, getSavedGame, saveAction, saveNewGame } from './repo.ts'
import { AppendBody, StartBody, TokenQuery, UndoQuery } from './schema.ts'
import { snapshotDeck, tokenDataOf } from './snapshot.ts'

const NO_GAME = 'No game in progress'
const CHANGED = 'The game changed in another window or on another device'

/**
 * The playtest's game (spec §5.9.1): start one, read it, save each action in order, take the last one back, end it.
 * And the token search (spec §5.9.8). `random` picks the seed and a random starting seat (tests pass their own).
 */
export function playtestRoutes(deps: { db: DB; random?: (max: number) => number }): Hono {
  const { db } = deps
  const random = deps.random ?? ((max: number) => randomInt(max))
  const routes = new Hono()

  routes.post('/', async (c) => {
    const body = parseWith(StartBody, await readJson(c.req))
    const [first, second] = body.decks
    const seats = [snapshotDeck(db, first, 1), ...(second === null ? [] : [snapshotDeck(db, second, 2)])]
    if (body.first === 1 && seats.length === 1) throw new ApiError(400, 'bad_request', "Seat 2 has no deck, so it can't go first")
    const setup: Setup = {
      version: MODEL_VERSION,
      seed: random(2 ** 32),
      seats,
      startingSeat: body.first === 'random' ? (random(seats.length) as SeatIndex) : body.first,
      life: body.life,
      startingDraws: body.startingDraws,
    }
    const startedAt = saveNewGame(db, setup)
    return c.json({ startedAt, setup, actions: [] } satisfies SavedGame, 201)
  })

  routes.get('/', (c) => {
    const game = getSavedGame(db)
    if (!game) throw new ApiError(404, 'not_found', NO_GAME)
    return c.json(game)
  })

  // The action must be for this game, be the next one, and apply to the game as saved: so a saved game always replays.
  routes.post('/actions', async (c) => {
    const { startedAt, seq, action } = parseWith(AppendBody, await readJson(c.req))
    const game = getSavedGame(db)
    if (!game) throw new ApiError(404, 'not_found', NO_GAME)
    if (startedAt !== game.startedAt || seq !== game.actions.length) throw new ApiError(409, 'conflict', CHANGED)
    try {
      replay(game.setup, [...game.actions, action])
    } catch (err) {
      if (err instanceof PlaytestError) throw new ApiError(400, 'bad_action', err.message)
      throw err
    }
    saveAction(db, seq, action)
    return c.body(null, 204)
  })

  routes.delete('/actions/last', (c) => {
    const { startedAt, seq } = parseWith(UndoQuery, c.req.query())
    const game = gameProgress(db)
    if (game === null) throw new ApiError(404, 'not_found', NO_GAME)
    if (startedAt !== game.startedAt || seq !== game.count - 1) throw new ApiError(409, 'conflict', CHANGED)
    deleteAction(db, seq)
    return c.body(null, 204)
  })

  routes.delete('/', (c) => {
    deleteGame(db)
    return c.body(null, 204)
  })

  // Every token and emblem whose name holds the query, as game cards: empty until card data has been imported with
  // tokens (spec §4.2).
  routes.get('/tokens', (c) => {
    const { q } = parseWith(TokenQuery, c.req.query())
    return c.json(searchTokens(db, q).map(tokenDataOf) satisfies CardData[])
  })

  return routes
}
