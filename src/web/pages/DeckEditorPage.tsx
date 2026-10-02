import { Link, useParams, useSearchParams } from 'react-router'
import { BuyListTab } from '../components/decks/BuyListTab.tsx'
import { CardSearchPanel } from '../components/decks/CardSearchPanel.tsx'
import { DeckHeader } from '../components/decks/DeckHeader.tsx'
import { DeckLines } from '../components/decks/DeckLines.tsx'
import { DeckPanels } from '../components/decks/DeckPanels.tsx'
import { ImportExportTab } from '../components/decks/ImportExportTab.tsx'
import { isDeckGone, useDeck } from '../lib/decks.ts'

type Tab = 'deck' | 'buy' | 'io'
const TABS: readonly Tab[] = ['deck', 'buy', 'io']

/** The Deck tab's panes, one at a time below lg: the list, the search that adds to it, and its panels. */
type View = 'cards' | 'add' | 'stats'
const VIEWS: ReadonlyArray<[View, string]> = [
  ['cards', 'Cards'],
  ['add', 'Add cards'],
  ['stats', 'Stats'],
]

/**
 * One deck: search on the left, the list in the middle, panels on the right; plus buy list and import/export tabs.
 * Below lg (a phone, a portrait tablet) the three show one at a time, chosen above them. The tab (`?tab=`) and the pane
 * (`?view=`) are in the address, so a reload, or coming back from a card or another page, keeps them.
 */
export function DeckEditorPage() {
  const id = Number(useParams().id)
  const { data: deck, error, isPending } = useDeck(id)
  const [params, setParams] = useSearchParams()
  const tab = TABS.find((t) => t === params.get('tab')) ?? 'deck'
  const view = VIEWS.find(([v]) => v === params.get('view'))?.[0] ?? 'cards'
  // Replaces the history entry, so Back leaves the deck rather than stepping back through its tabs.
  const show = (next: { tab?: Tab; view?: View }) => {
    const nextTab = next.tab ?? tab
    const nextView = next.view ?? view
    setParams(
      {
        ...(nextTab === 'deck' ? {} : { tab: nextTab }),
        ...(nextView === 'cards' ? {} : { view: nextView }),
      },
      { replace: true },
    )
  }

  // A failed background refetch keeps the loaded editor (and what's typed in it), unless the deck is gone: deleted in
  // another window, say, when every edit would fail.
  if (error && (!deck || isDeckGone(error))) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-rose-300">
          {isDeckGone(error) ? (deck ? `${deck.name} was deleted.` : 'There is no such deck.') : error.message}
        </p>
        <Link to="/decks" className="text-amber-300 hover:underline">
          ← All decks
        </Link>
      </div>
    )
  }
  if (isPending || !deck) return <p className="text-stone-500">Loading…</p>

  const tabs: Array<[Tab, string]> = [
    ['deck', 'Deck'],
    ['buy', `Buy list (${deck.buyList.items.length})`],
    ['io', 'Import / Export'],
  ]
  // Every pane shows from lg up; below it, only the chosen one.
  const pane = (v: View) => `min-w-0 ${view === v ? '' : 'hidden lg:block'}`
  return (
    <div className="space-y-5">
      <Link to="/decks" className="text-sm text-stone-500 hover:text-stone-200 pointer-coarse:inline-block pointer-coarse:py-2">
        ← All decks
      </Link>
      <DeckHeader
        key={deck.id}
        deck={deck}
        onShowWarnings={() => {
          // Below lg the warnings are in the Stats pane.
          show(window.matchMedia('(width < 64rem)').matches ? { tab: 'deck', view: 'stats' } : { tab: 'deck' })
          requestAnimationFrame(() => document.getElementById('deck-health')?.scrollIntoView({ behavior: 'smooth' }))
        }}
      />
      <div className="flex border-b border-stone-800" role="tablist">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            onClick={() => show({ tab: value })}
            className={`-mb-px border-b-2 px-4 py-2 text-sm pointer-coarse:py-3 ${tab === value ? 'border-amber-500 text-stone-50' : 'border-transparent text-stone-400 hover:text-stone-100'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'deck' && (
        <>
          <div className="flex rounded-lg border border-stone-800 bg-stone-900/60 p-0.5 text-sm lg:hidden" role="tablist" aria-label="Show">
            {VIEWS.map(([value, label]) => (
              <button
                key={value}
                role="tab"
                aria-selected={view === value}
                onClick={() => show({ view: value })}
                className={`flex-1 rounded-md px-3 py-2 ${view === value ? 'bg-stone-700 text-stone-50' : 'text-stone-400 hover:text-stone-100'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[18rem_minmax(0,1fr)_17rem]">
            <div className={pane('add')}>
              <CardSearchPanel deckId={deck.id} />
            </div>
            <div className={pane('cards')}>
              <DeckLines deck={deck} />
            </div>
            <div className={`${pane('stats')} lg:col-span-2 xl:col-span-1`}>
              <DeckPanels deck={deck} />
            </div>
          </div>
        </>
      )}
      {tab === 'buy' && <BuyListTab deck={deck} />}
      {/* Keyed per deck so a paste doesn't follow to another deck; distinct from DeckHeader's key (a sibling). */}
      {tab === 'io' && <ImportExportTab key={`import-${deck.id}`} deckId={deck.id} />}
    </div>
  )
}
