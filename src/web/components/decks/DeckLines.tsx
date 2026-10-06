import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { Board, CardDetail, DeckDetail, DeckLine, LineStatus } from '../../../shared/types.ts'
import { apiGet, apiSend } from '../../lib/api.ts'
import { useCardDrawer } from '../../lib/card-drawer.tsx'
import { groupLines, statusLabel } from '../../lib/deck-view.ts'
import { BOARD_LABEL, BOARD_ORDER, useAddToDeck, useDeckChange } from '../../lib/decks.ts'
import { formatUsd } from '../../lib/format.ts'
import { ManaText } from '../ManaText.tsx'

const STATUS_ICON: Record<LineStatus, string> = { owned: '✅', in_other_deck: '⚠️', buy: '🛒' }

const stepButton =
  'size-6 rounded border border-stone-700 text-stone-300 hover:bg-stone-800 disabled:opacity-50 pointer-coarse:size-10 pointer-coarse:text-lg'

/** The most copies a line can hold (the line PATCH caps quantities at 999). */
const MAX_QUANTITY = 999

interface LinePatch {
  quantity?: number
  board?: Board
  category?: string | null
  preferredCardId?: string | null
}

/** The deck's lines by board, then type or category, each with a stepper, status, price, and an edit panel. */
export function DeckLines({ deck }: { deck: DeckDetail }) {
  const [groupBy, setGroupBy] = useState<'type' | 'category'>('type')
  const sections = groupLines(deck.lines, groupBy)
  const toggle = (active: boolean) =>
    `rounded-md px-2.5 py-1 text-xs pointer-coarse:px-3 pointer-coarse:py-2 pointer-coarse:text-sm ${active ? 'bg-stone-700 text-stone-50' : 'text-stone-400 hover:text-stone-100'}`
  return (
    <section aria-label="Deck list" className="min-w-0 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs tracking-[0.2em] text-stone-500 uppercase">Cards</h2>
        <div className="flex rounded-lg border border-stone-800 p-0.5" role="radiogroup" aria-label="Group by">
          <button role="radio" aria-checked={groupBy === 'type'} onClick={() => setGroupBy('type')} className={toggle(groupBy === 'type')}>
            By type
          </button>
          <button role="radio" aria-checked={groupBy === 'category'} onClick={() => setGroupBy('category')} className={toggle(groupBy === 'category')}>
            By category
          </button>
        </div>
      </div>
      {sections.length === 0 ? (
        <p className="py-10 text-center text-stone-500">
          No cards yet. Search <span className="lg:hidden">under Add cards</span>
          <span className="hidden lg:inline">on the left</span>, paste a list under Import / Export, or scan the cards you
          have with Scan cards into this deck.
        </p>
      ) : (
        sections.map((section) => (
          <div key={section.board} className="space-y-2">
            <h3 className="border-b border-stone-800 pb-1 font-serif text-lg text-stone-100">
              {BOARD_LABEL[section.board]} <span className="text-sm text-stone-500 tabular-nums">{section.count}</span>
            </h3>
            {section.groups.map((group) => (
              <div key={group.label}>
                <h4 className="mb-1 text-xs text-stone-500">
                  {group.label} <span className="tabular-nums">({group.count})</span>
                </h4>
                <ul className="divide-y divide-stone-800/60">
                  {group.lines.map((line) => (
                    <LineRow key={line.id} deckId={deck.id} line={line} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ))
      )}
    </section>
  )
}

function LineRow({ deckId, line }: { deckId: number; line: DeckLine }) {
  const [editing, setEditing] = useState(false)
  const drawer = useCardDrawer()
  const update = useDeckChange((patch: LinePatch) => apiSend<void>('PATCH', `/api/decks/${deckId}/lines/${line.id}`, patch), "Couldn't change the card")
  const remove = useDeckChange(() => apiSend<void>('DELETE', `/api/decks/${deckId}/lines/${line.id}`), "Couldn't remove the card")
  // The stepper sends deltas, not quantities: the server applies each one atomically (removing the line at 0), so fast
  // clicks all count and a second "−" on a removed line is harmless. It never changes the line's chosen printing.
  const add = useAddToDeck()
  const step = (delta: 1 | -1) => add.mutate({ deckId, cardId: line.cardId, board: line.board, delta })
  const label = statusLabel(line)
  // While the line is being moved or removed, a step would recreate it (without its category) before the list shows
  // it gone. A line whose card is gone from the card data can't change its quantity or printing (its menu still moves
  // it, sets its category, or removes it).
  const missing = line.cardId === ''
  const settling = update.isPending || remove.isPending
  return (
    <li className="py-1.5">
      {/*
        Below sm (a phone), two lines: the name and its cost, then the stepper, status, price and menu (each order-2),
        so the name has the row's width. From sm up, one line, in the order written here.
      */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm sm:flex-nowrap">
        <span className="order-2 flex shrink-0 items-center gap-1 sm:order-none pointer-coarse:gap-3">
          <button aria-label={`One fewer ${line.name}`} onClick={() => step(-1)} disabled={missing || settling} className={stepButton}>
            −
          </button>
          <span className="w-6 text-center text-stone-100 tabular-nums">{line.quantity}</span>
          <button
            aria-label={`One more ${line.name}`}
            onClick={() => step(1)}
            disabled={missing || settling || line.quantity >= MAX_QUANTITY}
            className={stepButton}
          >
            +
          </button>
        </span>
        <span className="group relative min-w-0 flex-1">
          {missing ? (
            <span className="max-w-full truncate text-stone-400 italic">{line.name}</span>
          ) : (
            <button
              onClick={() => drawer.open(line.cardId)}
              className="max-w-full truncate text-left text-stone-100 hover:text-amber-300 pointer-coarse:py-1.5"
            >
              {line.name}
            </button>
          )}
          {line.imageNormal && (
            <img
              src={line.imageNormal}
              alt=""
              loading="lazy"
              className="pointer-events-none absolute top-6 left-0 z-30 hidden w-56 rounded-xl shadow-2xl shadow-black group-hover:block"
            />
          )}
        </span>
        <ManaText text={line.manaCost} className="shrink-0 text-xs" />
        <span aria-hidden className="order-1 basis-full sm:hidden" />
        <span role="img" aria-label={label} title={label} className="order-2 w-5 shrink-0 text-center sm:order-none">
          {STATUS_ICON[line.status]}
        </span>
        <span className="order-2 ml-auto w-16 shrink-0 text-right text-stone-300 tabular-nums sm:order-none sm:ml-0">
          {formatUsd(line.priceUsd)}
        </span>
        <button
          aria-label={`Edit ${line.name}`}
          aria-expanded={editing}
          onClick={() => setEditing((e) => !e)}
          className="order-2 shrink-0 rounded px-1.5 text-stone-400 hover:bg-stone-800 hover:text-stone-100 sm:order-none pointer-coarse:min-h-10 pointer-coarse:min-w-10"
        >
          ⋯
        </button>
      </div>
      <div className="text-xs text-stone-500 sm:pl-[4.75rem] sm:pointer-coarse:pl-[8.5rem]">
        {/* What the status icon means, which a finger has no tooltip to tell. */}
        <span className="hidden text-stone-300 pointer-coarse:inline">{label} · </span>
        own {line.owned}, {line.inOtherBuiltDecks} in other built decks
        {line.scanned > 0 && (
          <span className="ml-2 text-stone-400">
            {Math.min(line.scanned, line.quantity)} of {line.quantity} scanned
          </span>
        )}
        {line.category && <span className="ml-2 rounded bg-stone-800 px-1 text-stone-400">{line.category}</span>}
        {line.warnings.map((w) => (
          <div key={w} className="text-amber-300/90">
            {w}
          </div>
        ))}
      </div>
      {editing && (
        <LineEditor
          line={line}
          onChange={(patch) => update.mutate(patch)}
          changing={update.isPending}
          onRemove={() => remove.mutate(undefined)}
          removing={remove.isPending}
        />
      )}
    </li>
  )
}

interface LineEditorProps {
  line: DeckLine
  onChange: (patch: LinePatch) => void
  /** A change is being sent: moving again now could name a line the first move merged away. */
  changing: boolean
  onRemove: () => void
  /** The removal is being sent: a second one would find no line. */
  removing: boolean
}

/** Move to another board, set a category, choose a printing, or remove (spec §5.4.2 line menu). */
function LineEditor({ line, onChange, changing, onRemove, removing }: LineEditorProps) {
  const [category, setCategory] = useState(line.category ?? '')
  const missing = line.cardId === ''
  const { data } = useQuery({
    queryKey: ['card', line.cardId],
    queryFn: ({ signal }) => apiGet<CardDetail>(`/api/cards/${encodeURIComponent(line.cardId)}`, signal),
    enabled: !missing,
  })
  const field = 'rounded-md border border-stone-700 bg-stone-900 px-2 py-1 text-xs text-stone-100 pointer-coarse:py-2 pointer-coarse:text-sm'
  const button = 'rounded-md border px-2 py-1 pointer-coarse:px-3 pointer-coarse:py-2'
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-stone-800 bg-stone-900/60 p-2 text-xs text-stone-400 sm:ml-[4.75rem] pointer-coarse:text-sm sm:pointer-coarse:ml-[8.5rem]">
      <span>Move to</span>
      {BOARD_ORDER.filter((b) => b !== line.board).map((b) => (
        <button
          key={b}
          onClick={() => onChange({ board: b })}
          disabled={changing}
          className={`${button} border-stone-700 text-stone-200 hover:bg-stone-800 disabled:opacity-50`}
        >
          {BOARD_LABEL[b]}
        </button>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onChange({ category: category.trim() === '' ? null : category.trim() })
        }}
        className="flex items-center gap-1"
      >
        <input
          aria-label="Category"
          placeholder="Category"
          maxLength={60}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          enterKeyHint="done"
          className={`${field} w-32`}
        />
        <button type="submit" className={`${button} border-stone-700 text-stone-200 hover:bg-stone-800`}>
          Set
        </button>
      </form>
      {!missing && (
        <select
          aria-label="Printing"
          value={line.preferredCardId ?? ''}
          onChange={(e) => onChange({ preferredCardId: e.target.value === '' ? null : e.target.value })}
          className={`${field} max-w-64`}
        >
          <option value="">Default printing</option>
          {/* The chosen printing, until every printing has loaded. */}
          {!data && line.preferredCardId && (
            <option value={line.preferredCardId}>
              {line.setCode.toUpperCase()} #{line.collectorNumber}
            </option>
          )}
          {data?.printings.map((p) => (
            <option key={p.id} value={p.id}>
              {p.setCode.toUpperCase()} · {p.setName} #{p.collectorNumber}
            </option>
          ))}
        </select>
      )}
      <button
        onClick={onRemove}
        disabled={removing}
        className={`${button} ml-auto border-rose-900 text-rose-300 hover:bg-rose-950 disabled:opacity-50`}
      >
        Remove
      </button>
    </div>
  )
}
