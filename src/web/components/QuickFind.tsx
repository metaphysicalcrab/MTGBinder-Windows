import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { CardSummary } from '../../shared/types.ts'
import { apiGet } from '../lib/api.ts'
import { useCardDrawer } from '../lib/card-drawer.tsx'
import { finderList } from '../lib/finder-list.ts'
import { useCoarsePointer } from '../lib/platform.ts'
import { shortcutAllowed } from '../lib/shortcuts.ts'
import { useDebounced } from '../lib/use-debounced.ts'
import { ManaText } from './ManaText.tsx'

/**
 * Card-name lookup in the header, as an ARIA combobox. Arrow keys move, Enter opens the card drawer, Escape closes the
 * list. It focuses when "/" is pressed, by the same rule as the other shortcuts: not while typing in a field, with
 * Ctrl, Cmd or Alt, or while a dialog (the card drawer, the shortcuts list) is open.
 */
export function QuickFind() {
  const [text, setText] = useState('')
  const [listOpen, setListOpen] = useState(false)
  const [active, setActive] = useState(0)
  const query = useDebounced(text.trim(), 120)
  const drawer = useCardDrawer()
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  // "/" is a key: a finger has none to press.
  const coarse = useCoarsePointer()

  const { data, error, isFetching, isPlaceholderData } = useQuery({
    queryKey: ['autocomplete', query],
    queryFn: ({ signal }) => apiGet<CardSummary[]>(`/api/cards/autocomplete?q=${encodeURIComponent(query)}&limit=12`, signal),
    enabled: query.length > 0,
    placeholderData: (previous) => previous,
  })
  // Keyboard selection only acts on results for exactly what's typed: not while the debounce or a fetch is pending
  // (the list still shows the previous query's results), and not when the list shows an error instead.
  const list = finderList({ typed: text.trim(), query, data, isFetching, isPlaceholderData, error })
  const { results, selectable } = list
  const drawerOpen = drawer.cardId !== null

  useEffect(() => setActive(0), [query])

  useEffect(() => {
    if (drawerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && shortcutAllowed(e, document.querySelector('[aria-modal="true"]') !== null)) {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen])

  function choose(card: CardSummary) {
    drawer.open(card.cardId)
    setListOpen(false)
    inputRef.current?.blur()
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setListOpen(true)
      if (selectable && results.length > 0) setActive((i) => Math.max(0, Math.min(i + 1, results.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (selectable && results.length > 0) setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      const card = selectable ? results[active] : undefined
      if (card) {
        e.preventDefault()
        choose(card)
      }
    } else if (e.key === 'Escape') {
      setListOpen(false)
      inputRef.current?.blur()
    }
  }

  const showList = listOpen && list.show
  const optionId = (i: number) => `${listId}-option-${i}`
  const activeId = showList && !error && results[active] ? optionId(active) : undefined

  return (
    // Below sm the list is as wide as the header rather than the box: the box's wrapper is static there, so the list is
    // placed in the header (sticky, so positioned).
    <div className="relative w-full max-sm:static">
      <div className="relative">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setListOpen(true)
          }}
          onFocus={() => setListOpen(true)}
          onBlur={() => setListOpen(false)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-label="Find a card"
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          // Card names, not words: no capitals, corrections or suggestions from a phone's keyboard, whose Enter says Go.
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          placeholder={coarse ? 'Find a card' : 'Find a card   /'}
          className="h-9 w-full rounded-lg border border-stone-700 bg-stone-900/80 px-3 text-sm text-stone-100 outline-none placeholder:text-stone-500 focus:border-amber-500/70 focus:ring-2 focus:ring-amber-500/20"
        />
        {isFetching && (
          <span aria-hidden className="absolute top-1/2 right-3 size-2 -translate-y-1/2 animate-pulse rounded-full bg-amber-500/70" />
        )}
      </div>
      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-[60dvh] w-full overflow-auto overscroll-contain rounded-lg border border-stone-700 bg-stone-900 shadow-2xl shadow-black/50 max-sm:inset-x-3 max-sm:w-auto"
        >
          {error ? (
            <li role="presentation" className="px-3 py-2 text-sm text-rose-300">
              {error.message}
            </li>
          ) : results.length === 0 ? (
            <li role="presentation" className={`px-3 py-2 text-sm ${list.dimmed ? 'text-stone-600' : 'text-stone-500'}`}>
              No matches
            </li>
          ) : (
            results.map((card, i) => (
              <li
                key={card.oracleId}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(card)
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex cursor-pointer items-center gap-3 px-3 py-2 ${i === active ? 'bg-stone-800' : ''}`}
              >
                {card.imageSmall ? (
                  <img src={card.imageSmall} alt="" loading="lazy" className="h-10 w-7 shrink-0 rounded-sm object-cover" />
                ) : (
                  <div className="h-10 w-7 shrink-0 rounded-sm bg-stone-800" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-stone-100">{card.name}</div>
                  <div className="truncate text-xs text-stone-400">{card.typeLine}</div>
                </div>
                <ManaText text={card.manaCost} className="shrink-0 text-sm" />
              </li>
            ))
          )}
        </ul>
      )}
      <span aria-live="polite" className="sr-only">
        {listOpen ? list.announcement : ''}
      </span>
    </div>
  )
}
