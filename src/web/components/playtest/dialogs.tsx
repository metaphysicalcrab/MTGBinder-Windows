import { useRef, useState } from 'react'
import { kindOf } from '../../../shared/playtest/placement.ts'
import type { CardData, Dest, GameState, SeatIndex } from '../../../shared/playtest/types.ts'
import { useCoarsePointer } from '../../lib/platform.ts'
import { tokenName } from '../../lib/playtest-board.ts'
import { useTokenSearch } from '../../lib/playtest.ts'
import { useDebounced } from '../../lib/use-debounced.ts'
import { CardView } from './CardView.tsx'
import { Modal } from './Menu.tsx'
import { useMediaQuery } from './use-media-query.ts'

/** The playtest's dialogs (spec §5.9.4, §5.9.5, §5.9.8). A finger's buttons and fields are taller (M13). */

const button = 'rounded-md border border-stone-700 bg-stone-800 px-3 py-1.5 text-sm text-stone-100 hover:bg-stone-700 disabled:opacity-40 pointer-coarse:py-2'
const primary =
  'rounded-md border border-amber-600 bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-40 pointer-coarse:py-2'
const field = 'rounded-md border border-stone-700 bg-stone-900 px-2 py-1 text-stone-100 pointer-coarse:py-2'
/** LookDialog's ↑, ↓ and To top. */
const nudge =
  'rounded border border-stone-700 bg-stone-800 px-2 text-sm text-stone-200 hover:bg-stone-700 disabled:opacity-30 disabled:hover:bg-stone-800 pointer-coarse:min-h-9 pointer-coarse:min-w-9'

/** "How many?" for drawing, milling, or looking at several cards. */
export function CountDialog({
  title,
  label,
  initial,
  max,
  onSubmit,
  onClose,
}: {
  title: string
  label: string
  initial: number
  max: number
  onSubmit: (n: number) => void
  onClose: () => void
}) {
  const [text, setText] = useState(String(initial))
  const n = Number(text)
  const ok = Number.isInteger(n) && n >= 1 && n <= max
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!ok) return
          onClose()
          onSubmit(n)
        }}
        className="flex items-end gap-3"
      >
        <label className="flex flex-col gap-1 text-sm text-stone-300">
          {label}
          <input type="number" min={1} max={max} value={text} onChange={(e) => setText(e.target.value)} className={`w-24 ${field}`} />
        </label>
        <button type="submit" disabled={!ok} className={primary}>
          {title}
        </button>
      </form>
      {max === 0 && <p className="mt-3 text-sm text-stone-400">The library is empty.</p>}
    </Modal>
  )
}

type LookPlace = 'top' | 'bottom' | 'graveyard' | 'hand' | 'exile'
const LOOK_PLACES: Array<[LookPlace, string]> = [
  ['top', 'Top'],
  ['bottom', 'Bottom'],
  ['graveyard', 'Graveyard'],
  ['hand', 'Hand'],
  ['exile', 'Exile'],
]

/**
 * Looking at the top cards of my library (spec §5.9.4): each card goes to the top, the bottom, the graveyard, the
 * hand, or exile. The cards kept on top stay in the order shown, first on top; drag them, or move them with their ↑
 * and ↓ (a finger's drag, which the browser may take for a scroll, needn't be relied on), to change it. Scry and
 * surveil are this.
 */
export function LookDialog({
  game,
  seat,
  count,
  onSubmit,
  onClose,
}: {
  game: GameState
  seat: SeatIndex
  count: number
  onSubmit: (placed: Record<LookPlace, string[]>) => void
  onClose: () => void
}) {
  const [order, setOrder] = useState(() => game.seats[seat]!.library.slice(0, count))
  const [places, setPlaces] = useState<Record<string, LookPlace>>(() => Object.fromEntries(order.map((id) => [id, 'top'])))
  const [dragging, setDragging] = useState<string | null>(null)
  const coarse = useCoarsePointer()
  // Smaller cards on a phone, or a window too short for two rows of the large ones.
  const small = useMediaQuery('(width < 40rem), (height < 40rem)')
  const submit = () => {
    const placed: Record<LookPlace, string[]> = { top: [], bottom: [], graveyard: [], hand: [], exile: [] }
    for (const id of order) placed[places[id]!].push(id)
    onClose()
    onSubmit(placed)
  }
  const moveTo = (id: string, at: number) =>
    setOrder((list) => {
      const next = list.filter((x) => x !== id)
      next.splice(at, 0, id)
      return next
    })
  return (
    <Modal title={`The top ${order.length === 1 ? 'card' : `${order.length} cards`} of your library`} onClose={onClose} wide>
      <p className="mb-3 text-sm text-stone-400">
        The first card is the top of your library. {coarse ? 'Move the cards with ↑ and ↓' : 'Drag the cards (or use ↑ and ↓)'} to change their
        order, then choose where each goes.
      </p>
      <ol className="flex flex-wrap gap-3">
        {order.map((id, i) => (
          <li
            key={id}
            draggable
            onDragStart={() => setDragging(id)}
            onDragOver={(e) => {
              e.preventDefault()
              if (dragging === null || dragging === id) return
              setOrder((list) => {
                const next = list.filter((x) => x !== dragging)
                next.splice(next.indexOf(id) + (list.indexOf(dragging) < list.indexOf(id) ? 1 : 0), 0, dragging)
                return next
              })
            }}
            onDragEnd={() => setDragging(null)}
            className={`flex cursor-grab flex-col items-center gap-1 ${dragging === id ? 'opacity-50' : ''}`}
          >
            <span className="text-xs text-stone-500">{i + 1}</span>
            <CardView data={game.data[id]!} height={small ? 160 : 220} large />
            <div className="flex gap-1">
              <button aria-label={`${game.data[id]!.name} up one`} title="Up one, nearer the top" disabled={i === 0} onClick={() => moveTo(id, i - 1)} className={nudge}>
                ↑
              </button>
              <button
                aria-label={`${game.data[id]!.name} down one`}
                title="Down one, nearer the bottom"
                disabled={i === order.length - 1}
                onClick={() => moveTo(id, i + 1)}
                className={nudge}
              >
                ↓
              </button>
              <button aria-label={`${game.data[id]!.name} to the top`} disabled={i === 0} onClick={() => moveTo(id, 0)} className={nudge}>
                To top
              </button>
            </div>
            <select
              aria-label={`Where ${game.data[id]!.name} goes`}
              value={places[id]}
              onChange={(e) => setPlaces({ ...places, [id]: e.target.value as LookPlace })}
              className={`text-sm ${field}`}
            >
              {LOOK_PLACES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className={button}>
          Cancel
        </button>
        <button data-autofocus onClick={submit} className={primary}>
          Done
        </button>
      </div>
    </Modal>
  )
}

const SEARCH_PLACES: Array<[string, string]> = [
  ['hand', 'into my hand'],
  ['battlefield', 'onto the battlefield'],
  ['top', 'on top of my library'],
  ['graveyard', 'into my graveyard'],
  ['exile', 'into exile'],
]

/** Searching my library (spec §5.9.4): its cards by name, not in order; chosen cards go somewhere, then shuffle. */
export function SearchDialog({
  game,
  seat,
  onSubmit,
  onClose,
}: {
  game: GameState
  seat: SeatIndex
  onSubmit: (ids: string[], to: Dest, shuffle: boolean) => void
  onClose: () => void
}) {
  const [filter, setFilter] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const [place, setPlace] = useState('hand')
  const [shuffle, setShuffle] = useState(true)
  const cards = [...game.seats[seat]!.library].sort((a, b) => game.data[a]!.name.localeCompare(game.data[b]!.name))
  const shown = cards.filter((id) => game.data[id]!.name.toLowerCase().includes(filter.trim().toLowerCase()))
  const to: Dest =
    place === 'battlefield'
      ? { zone: 'battlefield', seat }
      : place === 'top'
        ? { zone: 'library', at: 'top' }
        : { zone: place as 'hand' | 'graveyard' | 'exile' }
  return (
    <Modal title="Search your library" onClose={onClose} wide>
      <input
        type="search"
        placeholder="Find a card by name"
        aria-label="Find a card by name"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className={`mb-3 w-full ${field}`}
      />
      <ul className="grid max-h-[50dvh] grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3 overflow-y-auto">
        {shown.map((id) => {
          const on = chosen.includes(id)
          return (
            <li key={id}>
              <button
                aria-pressed={on}
                aria-label={game.data[id]!.name}
                onClick={() => setChosen(on ? chosen.filter((x) => x !== id) : [...chosen, id])}
                className={`rounded-md p-1 ${on ? 'bg-amber-700/40 ring-2 ring-amber-500' : 'hover:bg-stone-800'}`}
              >
                <CardView data={game.data[id]!} height={200} />
              </button>
            </li>
          )
        })}
        {shown.length === 0 && <li className="text-sm text-stone-500">No card in your library matches.</li>}
      </ul>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-3 text-sm text-stone-300">
        <label className="flex items-center gap-2">
          Put {chosen.length === 1 ? 'it' : 'them'}
          <select value={place} onChange={(e) => setPlace(e.target.value)} className={field}>
            {SEARCH_PLACES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={shuffle} onChange={(e) => setShuffle(e.target.checked)} />
          Shuffle?
        </label>
        <button onClick={onClose} className={button}>
          Cancel
        </button>
        <button
          disabled={chosen.length === 0}
          onClick={() => {
            onClose()
            onSubmit(chosen, to, shuffle)
          }}
          className={primary}
        >
          {chosen.length === 0 ? 'Choose cards' : chosen.length === 1 ? 'Take 1 card' : `Take ${chosen.length} cards`}
        </button>
      </div>
    </Modal>
  )
}

/**
 * Counters on cards (spec §5.9.4): one more or one fewer of each counter on the first card, or a counter of any name
 * (one of the usual ones, one already on the table, or typed) added, removed, or set to a number.
 */
export function CounterDialog({
  names,
  current,
  choices,
  onAdd,
  onSet,
  onClose,
}: {
  names: string
  /** The counters already on the first card. */
  current: Record<string, number>
  /** The names to offer: the usual counters, then the others on the table. */
  choices: string[]
  onAdd: (name: string, delta: number) => void
  onSet: (name: string, value: number) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [text, setText] = useState('1')
  const n = Number(text)
  const ok = name.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 999
  const act = (fn: () => void) => {
    if (!ok) return
    onClose()
    fn()
  }
  const nameRef = useRef<HTMLInputElement>(null)
  // The counters on the card when the dialog opened. One taken down to 0 keeps its row, so the rows under it don't move
  // up under the pointer.
  const [kinds] = useState(() => Object.keys(current))
  return (
    <Modal title={`Counters on ${names}`} onClose={onClose}>
      {kinds.length > 0 && (
        <ul aria-label="Counters on it now" className="mb-4 flex flex-col gap-1">
          {kinds.map((k) => {
            const v = Object.hasOwn(current, k) ? current[k]! : 0
            return (
              <li key={k} className="flex items-center gap-2 text-sm text-stone-200">
                <span className="min-w-0 flex-1 truncate">{k}</span>
                <span className="w-8 text-right font-semibold tabular-nums">{v}</span>
                {/* These stay open, so a counter can go up or down a few at a time. At 0, − turns off: focus moves to +. */}
                <button
                  aria-label={`Remove 1 ${k} counter`}
                  disabled={v === 0}
                  onClick={(e) => {
                    if (v === 1) (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus()
                    onAdd(k, -1)
                  }}
                  className={button}
                >
                  −
                </button>
                <button aria-label={`Add 1 ${k} counter`} onClick={() => onAdd(k, 1)} className={button}>
                  +
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (n !== 0) act(() => onAdd(name.trim(), n))
        }}
      >
        <div role="group" aria-label="Counter names" className="mb-3 flex flex-wrap gap-1.5">
          {choices.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={name.trim() === c}
              onClick={() => {
                setName(c)
                // So Enter adds it, rather than pressing this button again.
                nameRef.current?.focus()
              }}
              className={`rounded-full border px-2.5 py-0.5 text-xs pointer-coarse:py-1.5 ${name.trim() === c ? 'border-amber-500 bg-amber-700/40 text-amber-100' : 'border-stone-700 bg-stone-900 text-stone-300 hover:bg-stone-800'}`}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm text-stone-300">
            Counter
            <input
              ref={nameRef}
              data-autofocus
              maxLength={40}
              placeholder="Any name, e.g. hour"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={`w-44 ${field}`}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-stone-300">
            How many
            <input type="number" min={0} value={text} onChange={(e) => setText(e.target.value)} className={`w-20 ${field}`} />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" disabled={!ok || n === 0} onClick={() => act(() => onAdd(name.trim(), -n))} className={button}>
            Remove
          </button>
          <button type="button" disabled={!ok} onClick={() => act(() => onSet(name.trim(), n))} className={button}>
            Set to {ok ? n : '…'}
          </button>
          <button type="submit" disabled={!ok || n === 0} className={primary}>
            Add
          </button>
        </div>
      </form>
    </Modal>
  )
}

const COLORS: Array<[string, string]> = [
  ['W', 'White'],
  ['U', 'Blue'],
  ['B', 'Black'],
  ['R', 'Red'],
  ['G', 'Green'],
]

/**
 * Making tokens (spec §5.9.8): a search over Scryfall's tokens and emblems, one picked and made as many times as
 * asked; or, for anything missing, a form for a name, power/toughness, colors, a type line, and how many.
 */
export function TokenDialog({ onSubmit, onClose }: { onSubmit: (token: CardData, count: number) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const found = useTokenSearch(useDebounced(query, 150))
  const results = query.trim() === '' ? [] : (found.data ?? [])
  const [picked, setPicked] = useState<CardData | null>(null)
  const [pickedText, setPickedText] = useState('1')
  const pickedCount = Number(pickedText)
  const pickedOk = picked !== null && Number.isInteger(pickedCount) && pickedCount >= 1 && pickedCount <= 100

  const [name, setName] = useState('')
  const [power, setPower] = useState('1')
  const [toughness, setToughness] = useState('1')
  const [colors, setColors] = useState('')
  const [typeLine, setTypeLine] = useState('Creature')
  const [text, setText] = useState('1')
  const count = Number(text)
  const ok = name.trim() !== '' && typeLine.trim() !== '' && Number.isInteger(count) && count >= 1 && count <= 100
  const submit = () => {
    if (!ok) return
    const type = typeLine.trim()
    const creature = kindOf(type) === 'creature'
    onClose()
    onSubmit(
      {
        name: name.trim(),
        faces: [
          {
            name: name.trim(),
            manaCost: '',
            typeLine: type,
            oracleText: '',
            power: creature && power.trim() !== '' ? power.trim() : null,
            toughness: creature && toughness.trim() !== '' ? toughness.trim() : null,
            loyalty: null,
            image: null,
          },
        ],
        imageSmall: null,
        colors: 'WUBRG'.split('').filter((c) => colors.includes(c)).join(''),
        kind: kindOf(type),
      },
      count,
    )
  }
  return (
    <Modal title="Create tokens" onClose={onClose} wide>
      <section aria-label="Scryfall's tokens" className="flex flex-col gap-3 text-sm text-stone-300">
        <label className="flex flex-col gap-1">
          Search Scryfall's tokens and emblems
          <input
            data-autofocus
            value={query}
            maxLength={100}
            placeholder="Treasure, Spirit, Elspeth…"
            onChange={(e) => setQuery(e.target.value)}
            className={field}
          />
        </label>
        {results.length > 0 && (
          <ul aria-label="Tokens found" className="grid max-h-[34dvh] grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2 overflow-y-auto">
            {results.map((token, i) => (
              <li key={`${token.name}-${i}`}>
                <button
                  type="button"
                  aria-pressed={picked === token}
                  aria-label={tokenName(token)}
                  title={tokenName(token)}
                  onClick={() => setPicked(token)}
                  className={`rounded-md p-1 ${picked === token ? 'bg-amber-700/40 ring-2 ring-amber-500' : 'hover:bg-stone-800'}`}
                >
                  <CardView data={token} height={150} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {query.trim() !== '' && found.isSuccess && !found.isPlaceholderData && results.length === 0 && (
          <p className="text-stone-500">No token or emblem by that name. Make it below.</p>
        )}
        {query.trim() !== '' && found.isError && (
          <p role="alert" className="text-red-300">
            Couldn't search the tokens: {found.error.message}. Make it below.
          </p>
        )}
        {picked && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!pickedOk) return
              onClose()
              onSubmit(picked, pickedCount)
            }}
            className="flex items-end gap-3"
          >
            <p className="min-w-0 flex-1 truncate self-center text-stone-100">{tokenName(picked)}</p>
            <label className="flex flex-col gap-1">
              How many
              <input
                type="number"
                min={1}
                max={100}
                value={pickedText}
                onChange={(e) => setPickedText(e.target.value)}
                className={`w-20 ${field}`}
              />
            </label>
            <button type="submit" disabled={!pickedOk} className={primary}>
              {picked.kind === 'emblem' ? 'Get' : 'Create'} {pickedOk && pickedCount > 1 ? pickedCount : ''}
            </button>
          </form>
        )}
      </section>
      <h3 className="mt-5 mb-3 border-t border-stone-800 pt-4 text-sm font-medium text-stone-200">Or make one by hand</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        className="flex flex-col gap-3 text-sm text-stone-300"
      >
        <label className="flex flex-col gap-1">
          Name
          <input value={name} placeholder="Goblin" onChange={(e) => setName(e.target.value)} className={field} />
        </label>
        <label className="flex flex-col gap-1">
          Type line
          <input value={typeLine} onChange={(e) => setTypeLine(e.target.value)} className={field} />
        </label>
        <div className="flex gap-3">
          <label className="flex flex-col gap-1">
            Power
            <input value={power} onChange={(e) => setPower(e.target.value)} className={`w-16 ${field}`} />
          </label>
          <label className="flex flex-col gap-1">
            Toughness
            <input value={toughness} onChange={(e) => setToughness(e.target.value)} className={`w-16 ${field}`} />
          </label>
          <label className="flex flex-col gap-1">
            How many
            <input type="number" min={1} max={100} value={text} onChange={(e) => setText(e.target.value)} className={`w-20 ${field}`} />
          </label>
        </div>
        <fieldset className="flex gap-3">
          <legend className="mb-1">Colors</legend>
          {COLORS.map(([c, label]) => (
            <label key={c} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={colors.includes(c)}
                onChange={(e) => setColors(e.target.checked ? colors + c : colors.replace(c, ''))}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={button}>
            Cancel
          </button>
          <button type="submit" disabled={!ok} className={primary}>
            Create {ok && count > 1 ? count : ''}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** "Command zone instead?" (spec §5.9.5), with the command zone first and focused. */
export function CommandZoneDialog({
  names,
  placeLabel,
  onCommandZone,
  onPlace,
  onClose,
}: {
  names: string
  placeLabel: string
  onCommandZone: () => void
  onPlace: () => void
  onClose: () => void
}) {
  return (
    <Modal title="Command zone instead?" onClose={onClose}>
      <p className="mb-4 text-sm text-stone-300">{names} can go to the command zone instead.</p>
      <div className="flex justify-end gap-2">
        <button
          onClick={() => {
            onClose()
            onPlace()
          }}
          className={button}
        >
          {placeLabel}
        </button>
        <button
          data-autofocus
          onClick={() => {
            onClose()
            onCommandZone()
          }}
          className={primary}
        >
          Command zone
        </button>
      </div>
    </Modal>
  )
}

/** End game (spec §5.9.5): a rematch with the same decks, a new game, or back to this one. */
export function EndGameDialog({
  canRematch,
  onRematch,
  onNewGame,
  onClose,
}: {
  canRematch: boolean
  onRematch: () => void
  onNewGame: () => void
  onClose: () => void
}) {
  return (
    <Modal title="End this game?" onClose={onClose}>
      <p className="mb-4 text-sm text-stone-300">
        Either one ends the game in progress.{!canRematch && " A deck in this game has been deleted, so there's no rematch."}
      </p>
      <div className="flex justify-end gap-2">
        <button data-autofocus onClick={onClose} className={button}>
          Cancel
        </button>
        <button
          onClick={() => {
            onClose()
            onNewGame()
          }}
          className={button}
        >
          New game
        </button>
        <button
          disabled={!canRematch}
          onClick={() => {
            onClose()
            onRematch()
          }}
          className={primary}
        >
          Rematch
        </button>
      </div>
    </Modal>
  )
}
