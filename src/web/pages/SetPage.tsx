import { useLayoutEffect, useMemo } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router'
import type { SetCard } from '../../shared/types.ts'
import { ManaText } from '../components/ManaText.tsx'
import { SetBar } from '../components/sets/SetBar.tsx'
import { useCardDrawer } from '../lib/card-drawer.tsx'
import { isNoSet, releaseDate, setTypeLabel, useSet } from '../lib/sets.ts'

/**
 * One set: its bar, then every card in collector-number order, a missing card dimmed, with All | Missing only in the
 * address (spec §5.8). A row opens the card's details, where copies are added; the page refetches with the collection.
 */
export function SetPage() {
  const { code = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  // The Sets page's address (its sort and filter), passed by its link, so ← Sets returns to the list as it was.
  const state = location.state as { back?: string } | null
  const back = `/sets${state?.back ? `?${state.back}` : ''}`
  const missingOnly = params.get('show') === 'missing'
  const { data: set, error, isPending } = useSet(code)
  // A set opens at its top. The router leaves the window where the last page had it, and a set seen in the last few
  // minutes shows its whole table at once, so it would open partway down its cards. A layout effect scrolls before that
  // paints; keyed on the code alone, so All | Missing only, the card drawer, and a refetch leave the scroll alone. The
  // braces matter: Chromium's scrollTo returns a promise, which React would take for a cleanup and call on leaving.
  useLayoutEffect(() => {
    window.scrollTo(0, 0)
  }, [code])

  const show = (missing: boolean) =>
    // Keeps the history entry's state, so ← Sets still knows the list's address after a switch.
    setParams(missing ? { show: 'missing' } : {}, { replace: true, state: location.state })

  const backLink = (
    <Link to={back} className="text-sm text-stone-400 hover:text-stone-100 pointer-coarse:inline-block pointer-coarse:py-2">
      ← Sets
    </Link>
  )
  if (error) {
    return (
      <div className="space-y-4">
        {backLink}
        <p role="alert" className="text-rose-300">
          {isNoSet(error) ? 'No set with that code.' : `Couldn't load the set: ${error.message}`}
        </p>
      </div>
    )
  }
  if (isPending) {
    return (
      <div className="space-y-4">
        {backLink}
        <p className="text-stone-500">Loading…</p>
      </div>
    )
  }

  const missing = set.cards.filter((card) => card.copies === 0)
  const shown = missingOnly ? missing : set.cards
  const type = setTypeLabel(set.setType)
  const tab = (active: boolean) =>
    `rounded-md px-3 py-1.5 pointer-coarse:py-2.5 ${active ? 'bg-stone-700 text-stone-50' : 'text-stone-400 hover:text-stone-100'}`

  return (
    <div className="space-y-5">
      {backLink}
      <div className="space-y-3">
        <div className="space-y-1">
          <h1 className="font-serif text-3xl font-semibold [overflow-wrap:anywhere] text-stone-50">{set.name}</h1>
          <p className="text-sm text-stone-400">
            <span className="font-mono uppercase">{set.code}</span>
            {type && ` · ${type}`} · Released {releaseDate(set.releasedAt)}
          </p>
        </div>
        <div className="max-w-2xl">
          <SetBar owned={set.owned} total={set.total} label={`${set.name} completion`} />
        </div>
      </div>
      <div className="flex w-fit rounded-lg border border-stone-800 bg-stone-900/60 p-0.5 text-sm" role="tablist" aria-label="Show">
        <button role="tab" aria-selected={!missingOnly} onClick={() => show(false)} className={tab(!missingOnly)}>
          All <span className="text-stone-500">{set.cards.length.toLocaleString('en-US')}</span>
        </button>
        <button role="tab" aria-selected={missingOnly} onClick={() => show(true)} className={tab(missingOnly)}>
          Missing only <span className="text-stone-500">{missing.length.toLocaleString('en-US')}</span>
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="py-12 text-center text-stone-500">You own every card in this set: it's complete.</p>
      ) : (
        <CardList cards={shown} />
      )}
    </div>
  )
}

/** A row's cells: a finger's height on a touch screen. */
const cell = 'px-3 py-2 pointer-coarse:py-3'

/**
 * The set's cards as a table; the whole set at once, without pages (The List's 5,258 cards too). Below sm (a phone)
 * it fits the screen, the rarity a letter by the name instead of a column.
 */
function CardList({ cards }: { cards: readonly SetCard[] }) {
  // The drawer's value changes with the card it shows, so this re-renders on every open and close. The rows depend
  // only on the cards and the stable `open`, so they're kept, rather than re-rendering thousands of them each time.
  const { open } = useCardDrawer()
  const rows = useMemo(
    () =>
      cards.map((card) => {
        const owned = card.copies > 0
        return (
          <tr key={card.cardId} onClick={() => open(card.cardId)} className="cursor-pointer hover:bg-stone-900">
            <td className={`${cell} font-mono text-xs ${owned ? 'text-stone-400' : 'text-stone-600'}`}>{card.collectorNumber}</td>
            <td className={cell}>
              <div className={`flex items-center gap-2 ${owned ? '' : 'opacity-45'}`}>
                <span className="text-stone-100">{card.name}</span>
                <ManaText text={card.manaCost} className="shrink-0 text-xs" />
                {/* Below sm the rarity has no column: its letter goes by the name. */}
                <span className="text-xs text-stone-500 sm:hidden">
                  <span aria-hidden>{card.rarity.charAt(0).toUpperCase()}</span>
                  <span className="sr-only">{card.rarity}</span>
                </span>
              </div>
            </td>
            <td className={`${cell} hidden capitalize sm:table-cell ${owned ? 'text-stone-400' : 'text-stone-600'}`}>{card.rarity}</td>
            <td className={`${cell} text-right tabular-nums`}>
              {owned ? <span className="text-emerald-300">✓ {card.copies}</span> : <span className="text-stone-600">missing</span>}
            </td>
          </tr>
        )
      }),
    [cards, open],
  )
  return (
    <div className="overflow-x-auto rounded-lg border border-stone-800">
      <table className="w-full text-left text-sm sm:min-w-[32rem]">
        <thead className="bg-stone-900/80 text-xs tracking-wide text-stone-400 uppercase">
          <tr>
            <th className="w-14 px-3 py-2 font-medium sm:w-20">#</th>
            <th className="px-3 py-2 font-medium">Card</th>
            <th className="hidden px-3 py-2 font-medium sm:table-cell">Rarity</th>
            <th className="px-3 py-2 text-right font-medium">Copies</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-800/70">{rows}</tbody>
      </table>
    </div>
  )
}
