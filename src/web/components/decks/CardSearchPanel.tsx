import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { Board, CardSummary, SearchPage } from '../../../shared/types.ts'
import { apiGet } from '../../lib/api.ts'
import { BOARD_LABEL, BOARD_ORDER, useAddToDeck } from '../../lib/decks.ts'
import { useDebounced } from '../../lib/use-debounced.ts'
import { useToast } from '../../lib/toast.tsx'
import { ManaText } from '../ManaText.tsx'
import { OwnershipBadge } from '../search/OwnershipBadge.tsx'

type Scope = 'all' | 'library'

/**
 * The editor's search pane (spec §5.4.2): name suggestions from the local card data while typing, and on Search a
 * result list from All cards (Scryfall) or My library, each with owned/free badges and a "+" that adds one copy to
 * the chosen board.
 */
export function CardSearchPanel({ deckId }: { deckId: number }) {
  const [scope, setScope] = useState<Scope>('all')
  const [board, setBoard] = useState<Board>('main')
  const [text, setText] = useState('')
  const [submitted, setSubmitted] = useState('')
  /** Whether the suggestions may show: Escape and leaving the search box close them; typing opens them again. */
  const [open, setOpen] = useState(true)
  const typed = useDebounced(text.trim(), 150)
  const add = useAddToDeck()
  const toast = useToast()

  const suggestions = useQuery({
    queryKey: ['autocomplete', typed],
    queryFn: ({ signal }) => apiGet<CardSummary[]>(`/api/cards/autocomplete?q=${encodeURIComponent(typed)}&limit=8`, signal),
    enabled: typed.length >= 2 && typed !== submitted,
  })
  const url = `/api/search/${scope === 'all' ? 'scryfall' : 'library'}?q=${encodeURIComponent(submitted)}`
  const results = useQuery({
    queryKey: ['search', url],
    queryFn: ({ signal }) => apiGet<SearchPage>(url, signal),
    enabled: submitted !== '' || scope === 'library',
  })

  function addCard(cardId: string, name: string) {
    add.mutate({ deckId, cardId, board, delta: 1 }, { onSuccess: ({ quantity }) => toast.success(`${name}: ${quantity} in ${BOARD_LABEL[board]}.`) })
  }

  const toggle = (active: boolean) =>
    `flex-1 rounded-md px-2 py-1 text-xs pointer-coarse:py-2 pointer-coarse:text-sm ${active ? 'bg-amber-500 font-medium text-stone-950' : 'text-stone-400 hover:text-stone-100'}`
  const showSuggestions = open && typed.length >= 2 && typed !== submitted && (suggestions.data?.length ?? 0) > 0

  return (
    <section aria-label="Find cards to add" className="space-y-3">
      <div className="flex rounded-lg border border-stone-800 bg-stone-900/60 p-0.5" role="radiogroup" aria-label="Search in">
        <button role="radio" aria-checked={scope === 'all'} onClick={() => setScope('all')} className={toggle(scope === 'all')}>
          All cards
        </button>
        <button role="radio" aria-checked={scope === 'library'} onClick={() => setScope('library')} className={toggle(scope === 'library')}>
          My library
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setSubmitted(text.trim())
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false)
        }}
        className="relative"
      >
        <input
          aria-label="Card search"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && showSuggestions) {
              e.preventDefault()
              setOpen(false)
            }
          }}
          placeholder={scope === 'all' ? 'Name or Scryfall query…' : 'Search my library…'}
          // Card names and Scryfall syntax: no capitals, corrections or suggestions from a phone's keyboard.
          inputMode="search"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          className="h-9 w-full rounded-lg border border-stone-700 bg-stone-900/80 px-3 text-sm text-stone-100 placeholder:text-stone-500 focus:border-amber-500/70 focus:outline-none pointer-coarse:h-11"
        />
        {showSuggestions && (
          <ul className="absolute z-30 mt-1 w-full overflow-hidden rounded-lg border border-stone-700 bg-stone-900 shadow-2xl shadow-black/50">
            {suggestions.data?.map((card) => (
              <li key={card.oracleId}>
                <button
                  type="button"
                  // Keeps focus in the search box, so the list doesn't close before the click lands.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => addCard(card.cardId, card.name)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-stone-200 hover:bg-stone-800 pointer-coarse:py-3"
                >
                  <span className="min-w-0 flex-1 truncate">{card.name}</span>
                  <ManaText text={card.manaCost} className="shrink-0 text-xs" />
                  <span className="shrink-0 text-amber-300">+</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </form>
      <label className="flex items-center gap-2 text-xs text-stone-400 pointer-coarse:text-sm">
        Add to
        <select
          value={board}
          onChange={(e) => setBoard(e.target.value as Board)}
          className="rounded-md border border-stone-700 bg-stone-900 px-2 py-1 text-xs text-stone-100 pointer-coarse:py-2 pointer-coarse:text-sm"
        >
          {BOARD_ORDER.map((b) => (
            <option key={b} value={b}>
              {BOARD_LABEL[b]}
            </option>
          ))}
        </select>
      </label>
      {results.error ? (
        <p role="alert" className="text-xs text-rose-300">
          {results.error.message}
        </p>
      ) : results.data ? (
        // Its own scroller beside the deck from lg up; below it, the pane is the page, which scrolls on its own.
        <ul className="divide-y divide-stone-800/60 rounded-lg border border-stone-800 lg:max-h-[60vh] lg:overflow-y-auto lg:overscroll-contain">
          {results.data.cards.length === 0 && <li className="px-3 py-2 text-xs text-stone-500">No cards match.</li>}
          {results.data.cards.map((card) => (
            <li key={`${card.cardId}-${card.finish ?? ''}`} className="flex items-start gap-2 px-3 py-2">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2 text-sm text-stone-100">
                  <span className="truncate">{card.name}</span>
                  <ManaText text={card.manaCost} className="shrink-0 text-xs" />
                </div>
                <OwnershipBadge ownership={card.ownership} />
              </div>
              <button
                aria-label={`Add ${card.name}`}
                onClick={() => addCard(card.cardId, card.name)}
                className="shrink-0 rounded-md border border-stone-700 px-2 text-amber-300 hover:bg-stone-800 pointer-coarse:size-10 pointer-coarse:px-0 pointer-coarse:text-lg"
              >
                +
              </button>
            </li>
          ))}
        </ul>
      ) : results.isFetching ? (
        <p className="text-xs text-stone-500">Searching…</p>
      ) : null}
    </section>
  )
}
