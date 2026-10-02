import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { OPENING_DRAW } from '../../../shared/playtest/game.ts'
import type { SeatIndex } from '../../../shared/playtest/types.ts'
import type { DeckSummary } from '../../../shared/types.ts'
import { useDecks } from '../../lib/decks.ts'
import { useStartGame } from '../../lib/playtest.ts'
import { startingLife } from '../../lib/playtest-board.ts'

/** A deck needs as many main-board cards as a mulligan draws (the server says so too). */
const MIN_PLAY_CARDS = OPENING_DRAW

const field = 'w-full rounded-md border border-stone-700 bg-stone-900 px-2 py-1.5 text-stone-100'

/** A choice of a few buttons, one pressed. */
function Choice<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string, boolean?]>; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex self-start overflow-hidden rounded-md border border-stone-700">
      {options.map(([v, text, disabled]) => (
        <button
          key={String(v)}
          role="radio"
          aria-checked={v === value}
          disabled={disabled}
          onClick={() => onChange(v)}
          className={`border-r border-stone-700 px-3 py-1 text-sm last:border-r-0 disabled:opacity-40 pointer-coarse:py-2 ${v === value ? 'bg-amber-900/60 text-amber-100' : 'text-stone-300 hover:bg-stone-800'}`}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

/**
 * A new game (spec §5.9.2): a deck for each seat (seat 2 may be Nobody, to goldfish), who goes first, starting life,
 * and whether the starting player draws on turn 1. Starting replaces a game in progress, after a confirm.
 */
export function SetupView({ presetDeck, inProgress }: { presetDeck: number | null; inProgress: boolean }) {
  const decks = useDecks()
  const start = useStartGame()
  const navigate = useNavigate()
  const [seat1, setSeat1] = useState<number | null>(presetDeck)
  const [seat2, setSeat2] = useState<number | null>(null)
  const [first, setFirst] = useState<'random' | SeatIndex>('random')
  const [lifeChoice, setLifeChoice] = useState<'auto' | 'other' | number>('auto')
  const [lifeText, setLifeText] = useState('30')
  const [startingDraws, setStartingDraws] = useState(false)
  const [confirming, setConfirming] = useState(false)

  if (decks.isPending) return <p className="p-8 text-stone-400">Loading your decks…</p>
  if (decks.isError) return <p role="alert" className="p-8 text-red-300">Couldn't load your decks: {decks.error.message}</p>
  const playable = decks.data.filter((d) => d.boards.main >= MIN_PLAY_CARDS)
  if (playable.length === 0) {
    return (
      <div className="mx-auto max-w-xl py-16 text-center text-stone-300">
        <h1 className="mb-3 font-serif text-3xl text-stone-50">Playtest</h1>
        <p>
          {decks.data.length === 0 ? 'Playtest needs a deck. ' : `A deck needs at least ${MIN_PLAY_CARDS} main-board cards to play. `}
          <Link to="/decks" className="text-amber-400 underline-offset-2 hover:underline">
            {decks.data.length === 0 ? 'Build or import one on the Decks page.' : 'Add cards on the Decks page.'}
          </Link>
        </p>
      </div>
    )
  }

  const byId = (id: number | null): DeckSummary | undefined => decks.data.find((d) => d.id === id)
  const first1 = byId(seat1) && byId(seat1)!.boards.main >= MIN_PLAY_CARDS ? seat1! : playable[0]!.id
  const deck1 = byId(first1)!
  const deck2 = byId(seat2)
  const auto = startingLife([deck1.format, ...(deck2 ? [deck2.format] : [])])
  const life = lifeChoice === 'auto' ? auto : lifeChoice === 'other' ? Number(lifeText) : lifeChoice
  const lifeOk = Number.isInteger(life) && life >= 1 && life <= 999
  const goFirst = !deck2 && first === 1 ? 'random' : first

  const begin = () => {
    if (!lifeOk) return
    start.mutate(
      { decks: [first1, deck2?.id ?? null], first: goFirst, life, startingDraws },
      { onSuccess: () => navigate('/playtest', { replace: true }) },
    )
  }

  const option = (d: DeckSummary) => (
    <option key={d.id} value={d.id} disabled={d.boards.main < MIN_PLAY_CARDS}>
      {d.name} · {d.format[0]!.toUpperCase() + d.format.slice(1)}
      {d.boards.main < MIN_PLAY_CARDS ? ` (needs ${MIN_PLAY_CARDS} main-board cards)` : ''}
    </option>
  )

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-5 py-8">
      <div className="flex items-baseline justify-between">
        <h1 className="font-serif text-3xl text-stone-50">New game</h1>
        {inProgress && (
          <Link to="/playtest" className="text-sm text-amber-400 hover:underline">
            Back to the game in progress
          </Link>
        )}
      </div>
      <label className="flex flex-col gap-1 text-sm text-stone-300">
        Seat 1
        <select value={first1} onChange={(e) => setSeat1(Number(e.target.value))} className={field}>
          {decks.data.map(option)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm text-stone-300">
        Seat 2
        <select value={deck2?.id ?? ''} onChange={(e) => setSeat2(e.target.value === '' ? null : Number(e.target.value))} className={field}>
          <option value="">Nobody (goldfish Seat 1)</option>
          {decks.data.map(option)}
        </select>
      </label>
      <div className="flex flex-col gap-1 text-sm text-stone-300">
        Who goes first
        <Choice
          label="Who goes first"
          value={goFirst}
          onChange={setFirst}
          options={[
            ['random', 'Random'],
            [0, 'Seat 1'],
            [1, 'Seat 2', !deck2],
          ]}
        />
      </div>
      <div className="flex flex-col gap-1 text-sm text-stone-300">
        Starting life
        <div className="flex items-center gap-3">
          <Choice
            label="Starting life"
            value={lifeChoice === 'auto' ? auto : lifeChoice}
            onChange={setLifeChoice}
            options={[
              [40, '40'],
              [20, '20'],
              ['other', 'Other…'],
            ]}
          />
          {lifeChoice === 'other' && (
            <input
              aria-label="Starting life"
              type="number"
              min={1}
              max={999}
              value={lifeText}
              onChange={(e) => setLifeText(e.target.value)}
              className="w-20 rounded-md border border-stone-700 bg-stone-900 px-2 py-1 text-stone-100"
            />
          )}
        </div>
        <span className="text-xs text-stone-500">40 when either deck is a Commander deck, else 20, unless you choose.</span>
      </div>
      <label className="flex items-center gap-2 text-sm text-stone-300">
        <input type="checkbox" checked={startingDraws} onChange={(e) => setStartingDraws(e.target.checked)} />
        Starting player draws on turn 1
      </label>
      {confirming ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-100">
          A game is in progress. Starting a new one ends it.
          <button onClick={begin} disabled={start.isPending} className="rounded-md border border-amber-600 bg-amber-700 px-3 py-1 text-white hover:bg-amber-600">
            Start anyway
          </button>
          <button onClick={() => setConfirming(false)} className="rounded-md px-3 py-1 text-stone-300 hover:bg-stone-800">
            Cancel
          </button>
        </div>
      ) : (
        <div>
          <button
            onClick={() => (inProgress ? setConfirming(true) : begin())}
            disabled={!lifeOk || start.isPending}
            className="rounded-md border border-amber-600 bg-amber-700 px-4 py-2 font-medium text-white hover:bg-amber-600 disabled:opacity-40"
          >
            Start game
          </button>
        </div>
      )}
    </div>
  )
}
