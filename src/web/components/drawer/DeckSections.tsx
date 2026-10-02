import { useId, useState } from 'react'
import { Link, useMatch } from 'react-router'
import type { Board, Card, Ownership } from '../../../shared/types.ts'
import { useOnOverlayEntry } from '../../lib/back-to-close.ts'
import { useCardDrawer } from '../../lib/card-drawer.tsx'
import { BOARD_LABEL, BOARD_ORDER, useAddToDeck, useDecks } from '../../lib/decks.ts'
import { useToast } from '../../lib/toast.tsx'
import { sectionHeading } from './styles.ts'

const statusBadge = (status: 'built' | 'prospective') =>
  `rounded px-1.5 py-0.5 text-[11px] ${status === 'built' ? 'bg-emerald-900/60 text-emerald-200' : 'bg-stone-800 text-stone-300'}`

/**
 * Decks that include this card, with status and copies (and those on the maybe board), each linking to its editor
 * (spec §5.2.5 "Decks").
 */
export function DeckList({ ownership }: { ownership: Ownership }) {
  const { close } = useCardDrawer()
  const headingId = useId()
  // The deck opens in place of the drawer's history entry, so Back from it comes to the page the drawer was open on.
  const replace = useOnOverlayEntry()
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className={sectionHeading}>
        Decks
      </h3>
      {ownership.decks.length === 0 ? (
        <p className="text-sm text-stone-500">Not in any deck.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {ownership.decks.map((d) => (
            <li key={d.id} className="flex items-center gap-2">
              <Link
                to={`/decks/${d.id}`}
                replace={replace}
                onClick={close}
                className="text-stone-200 hover:text-amber-300 hover:underline pointer-coarse:py-2"
              >
                {d.name}
              </Link>
              <span className={statusBadge(d.status)}>{d.status}</span>
              {d.quantity > 0 && <span className="text-stone-500 tabular-nums">×{d.quantity}</span>}
              {d.maybe > 0 && <span className="text-stone-500 tabular-nums">{d.maybe} on maybe</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** The deck last chosen in Add to deck during this page session, the default when the page isn't a deck's editor. */
let lastChosenDeckId: number | null = null

/**
 * Deck and board pickers that add one copy of the printing on screen (spec §5.2.5 "Add to deck"). The deck is the one
 * chosen here, else the deck whose editor is open, else the deck last chosen in the drawer, else the first deck; a
 * deck that no longer exists is passed over.
 */
export function AddToDeck({ card }: { card: Card }) {
  const { data: decks, error } = useDecks()
  const [chosen, setChosen] = useState<number | null>(null)
  const [board, setBoard] = useState<Board>('main')
  const add = useAddToDeck()
  const toast = useToast()
  const { close } = useCardDrawer()
  const headingId = useId()
  const replace = useOnOverlayEntry()
  const routeDeckId = Number(useMatch('/decks/:id')?.params.id)
  const deck = [chosen, routeDeckId, lastChosenDeckId].map((id) => decks?.find((d) => d.id === id)).find((d) => d !== undefined) ?? decks?.[0]
  const deckId = deck?.id ?? null

  function addCard() {
    if (deckId === null || !deck) return
    add.mutate(
      { deckId, cardId: card.id, board, delta: 1 },
      { onSuccess: ({ quantity }) => toast.success(`Added ${card.name} to ${deck.name} (${BOARD_LABEL[board]}). It has ${quantity}.`) },
    )
  }

  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className={sectionHeading}>
        Add to deck
      </h3>
      {error ? (
        <p className="text-sm text-rose-300">Couldn't load your decks: {error.message}</p>
      ) : decks && decks.length === 0 ? (
        <p className="text-sm text-stone-500">
          No decks yet.{' '}
          <Link to="/decks" replace={replace} onClick={close} className="text-amber-300 hover:underline">
            Create one on the Decks page
          </Link>
          .
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Deck"
            value={deckId ?? ''}
            onChange={(e) => {
              lastChosenDeckId = Number(e.target.value)
              setChosen(lastChosenDeckId)
            }}
            className="min-w-0 flex-1 rounded-md border border-stone-700 bg-stone-900 px-2 py-1.5 text-sm text-stone-100 pointer-coarse:py-2.5"
          >
            {decks?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.status})
              </option>
            ))}
          </select>
          <select
            aria-label="Board"
            value={board}
            onChange={(e) => setBoard(e.target.value as Board)}
            className="rounded-md border border-stone-700 bg-stone-900 px-2 py-1.5 text-sm text-stone-100 pointer-coarse:py-2.5"
          >
            {BOARD_ORDER.map((b) => (
              <option key={b} value={b}>
                {BOARD_LABEL[b]}
              </option>
            ))}
          </select>
          <button
            onClick={addCard}
            disabled={deckId === null || add.isPending}
            className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-stone-950 hover:bg-amber-400 disabled:opacity-50 pointer-coarse:py-2.5"
          >
            Add to deck
          </button>
        </div>
      )}
    </section>
  )
}
