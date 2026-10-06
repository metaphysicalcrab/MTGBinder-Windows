import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { apply, PlaytestError, replay } from '../../shared/playtest/game.ts'
import type { Action, CardData, GameState, SavedGame, SeatIndex, Setup } from '../../shared/playtest/types.ts'
import { ApiRequestError, apiGet, apiPost, apiSend } from './api.ts'
import { createSaver, type SaveStatus } from './playtest-save.ts'
import { useToast } from './toast.tsx'

/** The playtest page's data (spec §5.9): the game in progress, played at once in the page and saved behind it. */

export const PLAYTEST_KEY = ['playtest'] as const

/**
 * Scryfall's tokens and emblems whose name holds the query (spec §5.9.8), as game cards; none for a blank query. Its
 * key is apart from the game's, so a reload of the game leaves it be. The last answer stays up while the next loads.
 */
export function useTokenSearch(query: string) {
  const q = query.trim()
  return useQuery({
    queryKey: ['playtest-tokens', q],
    queryFn: ({ signal }) => apiGet<CardData[]>(`/api/playtest/tokens?q=${encodeURIComponent(q)}`, signal),
    enabled: q !== '',
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  })
}

/** The game in progress, or null when there's none. */
export function usePlaytestGame() {
  return useQuery({
    queryKey: PLAYTEST_KEY,
    queryFn: async ({ signal }) => {
      try {
        return await apiGet<SavedGame>('/api/playtest', signal)
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) return null
        throw err
      }
    },
    // The page holds the live game: it's fetched again only when a save is refused. That game may hold actions not
    // yet saved, so it's kept when the page is left (by default it would go after 5 minutes) and comes back as played.
    staleTime: Infinity,
    gcTime: Infinity,
  })
}

/** What a refused save tells the owner, as the page reloads the saved game. */
export function refusedMessage(err: ApiRequestError): string {
  if (err.status === 404) return 'This game was ended in another window or on another device.'
  if (err.status === 409) return 'This game changed in another window or on another device, so Binder reloaded the saved game.'
  return `Binder couldn't save that move (${err.message}), so it reloaded the saved game.`
}

/** What the saver tells when a save is refused: the page's query client and toasts, from the last page shown. */
let bound: { queryClient: QueryClient; toastError: (message: string) => void } | null = null

// One saver for the whole app, so actions keep saving in order after the page is left.
const saver = createSaver({
  send: (op) =>
    op.kind === 'append'
      ? apiPost<void>('/api/playtest/actions', { startedAt: op.startedAt, seq: op.seq, action: op.action })
      : apiSend<void>('DELETE', `/api/playtest/actions/last?${new URLSearchParams({ startedAt: op.startedAt, seq: String(op.seq) })}`),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onRefused: (err) => {
    if (!bound) return
    bound.toastError(refusedMessage(err))
    void bound.queryClient.invalidateQueries({ queryKey: PLAYTEST_KEY })
  },
})

// Each list of actions played, the setup it was played from, and the game they make: so playing an action applies
// just that one. The query keeps an old list in place of an equal new one (a new game's empty list takes the old
// game's), so a list answers only for the setup it was made from.
const games = new WeakMap<readonly Action[], { setup: Setup; game: GameState }>()

/** The game a saved game's actions make. */
export function gameOf(saved: SavedGame): GameState {
  const known = games.get(saved.actions)
  if (known && known.setup === saved.setup) return known.game
  const game = replay(saved.setup, saved.actions)
  games.set(saved.actions, { setup: saved.setup, game })
  return game
}

/**
 * Plays an action on the saved game and stores the longer list in the query, or throws a PlaytestError when it doesn't
 * apply. The query stores a copy of the list, so the game is kept for the copy.
 */
export function playAction(queryClient: QueryClient, current: SavedGame, action: Action): GameState {
  const next = apply(gameOf(current), action)
  const stored = queryClient.setQueryData<SavedGame>(PLAYTEST_KEY, { ...current, actions: [...current.actions, action] })
  if (stored) games.set(stored.actions, { setup: stored.setup, game: next })
  return next
}

export interface GameSession {
  /** Null when the saved game can't be replayed (saved by another version of Binder): `broken` says why. */
  game: GameState | null
  broken: string | null
  /** Plays an action, or says why it doesn't apply (a toast) and answers false. */
  play: (action: Action) => boolean
  /** Takes back the last action. */
  undo: () => void
  canUndo: boolean
  saveStatus: SaveStatus
}

/** Plays the saved game: each action applies at once, and the saver sends it on. */
export function useGameSession(saved: SavedGame): GameSession {
  const queryClient = useQueryClient()
  const toast = useToast()
  useEffect(() => {
    bound = { queryClient, toastError: toast.error }
  }, [queryClient, toast])
  const saveStatus = useSyncExternalStore(saver.subscribe, saver.status)

  // Each reads the game from the query's data, not the render's, so actions played in one event build on each other.
  const play = useCallback(
    (action: Action) => {
      const current = queryClient.getQueryData<SavedGame | null>(PLAYTEST_KEY)
      if (!current) return false
      try {
        playAction(queryClient, current, action)
      } catch (err) {
        if (err instanceof PlaytestError) {
          toast.error(err.message)
          return false
        }
        throw err
      }
      saver.append(current.startedAt, current.actions.length, action)
      return true
    },
    [queryClient, toast],
  )

  const undo = useCallback(() => {
    const current = queryClient.getQueryData<SavedGame | null>(PLAYTEST_KEY)
    if (!current || current.actions.length === 0) return
    queryClient.setQueryData<SavedGame>(PLAYTEST_KEY, { ...current, actions: current.actions.slice(0, -1) })
    saver.undo(current.startedAt, current.actions.length - 1)
  }, [queryClient])

  let game: GameState | null = null
  let broken: string | null = null
  try {
    game = gameOf(saved)
  } catch (err) {
    if (!(err instanceof PlaytestError)) throw err
    broken = err.message
  }
  return { game, broken, play, undo, canUndo: saved.actions.length > 0, saveStatus }
}

export interface StartInput {
  decks: [number, number | null]
  first: 'random' | SeatIndex
  life: number
  startingDraws: boolean
}

/** Starts a game, replacing the one in progress. */
export function useStartGame() {
  const queryClient = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: (input: StartInput) => apiPost<SavedGame>('/api/playtest', input),
    onSuccess: (game) => {
      saver.reset()
      queryClient.setQueryData(PLAYTEST_KEY, game)
      const leftOut = game.setup.seats.filter((s) => s.leftOut > 0)
      for (const seat of leftOut) {
        toast.error(`${seat.leftOut} ${seat.leftOut === 1 ? 'card' : 'cards'} of ${seat.name} no longer in the card data ${seat.leftOut === 1 ? 'was' : 'were'} left out`)
      }
    },
    onError: (err) => toast.error(`Couldn't start the game: ${err.message}`),
  })
}

/** Ends the game in progress. */
export function useEndGame() {
  const queryClient = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: () => apiSend<void>('DELETE', '/api/playtest'),
    onMutate: () => saver.reset(),
    onSuccess: () => queryClient.setQueryData(PLAYTEST_KEY, null),
    onError: (err) => toast.error(`Couldn't end the game: ${err.message}`),
  })
}
