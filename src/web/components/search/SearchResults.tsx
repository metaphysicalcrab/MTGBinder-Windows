import { Link } from 'react-router'
import { isCardSort } from '../../../shared/search/sorts.ts'
import type { SearchPage, SearchSort } from '../../../shared/types.ts'
import { useCardDrawer } from '../../lib/card-drawer.tsx'
import { formatUsd } from '../../lib/format.ts'
import type { SearchState } from '../../lib/search-state.ts'
import { ManaText } from '../ManaText.tsx'
import { GettingStarted } from '../library/GettingStarted.tsx'
import { OwnershipBadge } from './OwnershipBadge.tsx'

const SORT_LABELS: Record<SearchSort, string> = {
  name: 'Name',
  mv: 'Mana value',
  price: 'Price',
  color: 'Color',
  rarity: 'Rarity',
  added: 'Date added',
  quantity: 'Quantity',
}

interface Props {
  page: SearchPage
  state: SearchState
  fetching: boolean
  onChange: (patch: Partial<SearchState>) => void
  /** Shown on the Library page (search locked to the library), whose Import CSV button sits above. */
  libraryPage?: boolean
}

export function SearchResults({ page, state, fetching, onChange, libraryPage = false }: Props) {
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize))
  const library = state.scope === 'library'
  // An empty page after the first: past the last one, or (with more after it) a page of only digital cards.
  const emptyLaterPage = page.cards.length === 0 && state.page > 1
  const sorts = (Object.keys(SORT_LABELS) as SearchSort[]).filter((s) => library || isCardSort(s))
  const button = (active: boolean) =>
    `rounded-md px-2.5 py-1 text-xs pointer-coarse:px-3 pointer-coarse:py-2 pointer-coarse:text-sm ${active ? 'bg-stone-700 text-stone-50' : 'text-stone-400 hover:text-stone-100'}`

  return (
    <section aria-busy={fetching} className={fetching ? 'opacity-70 transition-opacity' : undefined}>
      <div className="mb-4 flex flex-wrap items-center gap-3 border-b border-stone-800 pb-3 text-sm">
        {!emptyLaterPage && (
          <span className="text-stone-300">
            {page.estimated && 'About '}
            {page.total.toLocaleString()} {library && state.view === 'printings' ? 'printings' : 'cards'}
          </span>
        )}
        <label className="ml-auto flex items-center gap-2 text-stone-400">
          Sort
          <select
            value={state.sort}
            onChange={(e) => onChange({ sort: e.target.value as SearchSort })}
            className="rounded-md border border-stone-700 bg-stone-900 px-2 py-1 text-stone-100 pointer-coarse:py-2"
          >
            {sorts.map((s) => (
              <option key={s} value={s}>
                {SORT_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() => onChange({ dir: state.dir === 'asc' ? 'desc' : 'asc' })}
          aria-label={state.dir === 'asc' ? 'Ascending; switch to descending' : 'Descending; switch to ascending'}
          className="rounded-md border border-stone-700 px-2 py-1 text-stone-300 hover:bg-stone-800 pointer-coarse:min-h-10 pointer-coarse:min-w-10"
        >
          {state.dir === 'asc' ? '↑' : '↓'}
        </button>
        {library && (
          <div className="flex rounded-lg border border-stone-800 p-0.5">
            <button className={button(state.view === 'cards')} onClick={() => onChange({ view: 'cards' })}>
              Cards
            </button>
            <button className={button(state.view === 'printings')} onClick={() => onChange({ view: 'printings' })}>
              Printings
            </button>
          </div>
        )}
        <div className="flex rounded-lg border border-stone-800 p-0.5">
          <button className={button(state.layout === 'grid')} onClick={() => onChange({ layout: 'grid', page: state.page })}>
            Grid
          </button>
          <button className={button(state.layout === 'list')} onClick={() => onChange({ layout: 'list', page: state.page })}>
            List
          </button>
        </div>
      </div>

      {emptyLaterPage && !page.hasMore ? (
        <p className="py-16 text-center text-stone-400">
          This search has no page {state.page}.{' '}
          <button onClick={() => onChange({ page: 1 })} className="text-amber-300 hover:underline">
            Back to the first page
          </button>
        </p>
      ) : page.cards.length === 0 && library && libraryPage && state.q.trim() === '' ? (
        <GettingStarted />
      ) : page.cards.length === 0 ? (
        <p className="py-16 text-center text-stone-400">
          {library && state.q.trim() === '' ? (
            <>
              Your library is empty. Scan your cards on the Scan page,{' '}
              <Link to="/library" state={{ importing: true }} className="text-amber-300 hover:underline">
                import a CSV on the Library page
              </Link>
              , or open any card and use Add copy.
            </>
          ) : (
            'No cards match.'
          )}
        </p>
      ) : state.layout === 'grid' ? (
        <ResultGrid page={page} showFinish={library && state.view === 'printings'} />
      ) : (
        <ResultList page={page} library={library} />
      )}

      {pages > 1 && (
        <nav className="mt-6 flex items-center justify-center gap-3 text-sm" aria-label="Pages">
          <button
            disabled={state.page <= 1}
            onClick={() => onChange({ page: state.page - 1 })}
            className="rounded-md border border-stone-700 px-3 py-1.5 text-stone-200 hover:bg-stone-800 disabled:opacity-40 pointer-coarse:py-2.5"
          >
            ← Previous
          </button>
          <span className="text-stone-400">
            Page {state.page} of {pages}
          </span>
          <button
            disabled={!page.hasMore}
            onClick={() => onChange({ page: state.page + 1 })}
            className="rounded-md border border-stone-700 px-3 py-1.5 text-stone-200 hover:bg-stone-800 disabled:opacity-40 pointer-coarse:py-2.5"
          >
            Next →
          </button>
        </nav>
      )}
    </section>
  )
}

function ResultGrid({ page, showFinish }: { page: SearchPage; showFinish: boolean }) {
  const drawer = useCardDrawer()
  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {page.cards.map((card) => (
        <li key={`${card.cardId}-${card.finish ?? ''}`} className="min-w-0">
          <button onClick={() => drawer.open(card.cardId)} className="group block w-full text-left">
            {card.imageNormal ? (
              <img
                src={card.imageNormal}
                alt={card.name}
                loading="lazy"
                className="aspect-[63/88] w-full rounded-[4.5%] bg-stone-900 object-cover shadow-lg shadow-black/40 transition group-hover:-translate-y-0.5 group-hover:shadow-black/70"
              />
            ) : (
              <div className="flex aspect-[63/88] items-center justify-center rounded-[4.5%] bg-stone-900 p-3 text-center text-sm text-stone-300">
                {card.name}
              </div>
            )}
          </button>
          <div className="mt-1.5 space-y-1">
            <div className="flex items-baseline gap-1 text-xs text-stone-300">
              <span className="truncate">{card.name}</span>
              {card.quantity !== null && <span className="shrink-0 text-stone-500">×{card.quantity}</span>}
              {showFinish && card.finish !== 'nonfoil' && <span className="shrink-0 text-amber-300">{card.finish}</span>}
            </div>
            <OwnershipBadge ownership={card.ownership} />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** The List layout: a table from md up, and below it (a phone) a list of two-line rows, each the table's row folded. */
function ResultList({ page, library }: { page: SearchPage; library: boolean }) {
  const drawer = useCardDrawer()
  return (
    <>
      <ul className="divide-y divide-stone-800/70 rounded-lg border border-stone-800 md:hidden">
        {page.cards.map((card) => {
          const stats = card.loyalty ?? (card.power !== null && card.toughness !== null ? `${card.power}/${card.toughness}` : null)
          return (
            <li key={`${card.cardId}-${card.finish ?? ''}`}>
              <button onClick={() => drawer.open(card.cardId)} className="block w-full space-y-1 px-3 py-2.5 text-left text-sm">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-stone-100">{card.name}</span>
                  <ManaText text={card.manaCost} className="shrink-0 text-xs" />
                </span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-400">
                  <span className="font-mono uppercase">{card.setCode}</span>
                  {card.finish && card.finish !== 'nonfoil' && <span className="text-amber-300">{card.finish}</span>}
                  {stats && <span>{stats}</span>}
                  <span className="text-stone-300 tabular-nums">{formatUsd(card.priceUsd)}</span>
                  {library && <span className="text-stone-300 tabular-nums">×{card.quantity}</span>}
                  <OwnershipBadge ownership={card.ownership} />
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <div className="hidden overflow-x-auto rounded-lg border border-stone-800 md:block">
        <table className="w-full min-w-[48rem] text-left text-sm">
          <thead className="bg-stone-900/80 text-xs tracking-wide text-stone-400 uppercase">
            <tr>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Set</th>
              <th className="px-3 py-2 font-medium">P/T</th>
              <th className="px-3 py-2 text-right font-medium">Price</th>
              {library && <th className="px-3 py-2 text-right font-medium">Copies</th>}
              <th className="px-3 py-2 font-medium">Mine</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-800/70">
            {page.cards.map((card) => (
              <tr
                key={`${card.cardId}-${card.finish ?? ''}`}
                onClick={() => drawer.open(card.cardId)}
                className="cursor-pointer hover:bg-stone-900"
              >
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-stone-100">{card.name}</span>
                    <ManaText text={card.manaCost} className="shrink-0 text-xs" />
                  </div>
                </td>
                <td className="max-w-56 truncate px-3 py-2 text-stone-400">{card.typeLine}</td>
                <td className="px-3 py-2 font-mono text-xs text-stone-400 uppercase">
                  {card.setCode}
                  {card.finish && card.finish !== 'nonfoil' && <span className="ml-1 text-amber-300 normal-case">{card.finish}</span>}
                </td>
                <td className="px-3 py-2 text-stone-400">
                  {card.loyalty ?? (card.power !== null && card.toughness !== null ? `${card.power}/${card.toughness}` : '')}
                </td>
                <td className="px-3 py-2 text-right text-stone-300 tabular-nums">{formatUsd(card.priceUsd)}</td>
                {library && <td className="px-3 py-2 text-right text-stone-300 tabular-nums">{card.quantity}</td>}
                <td className="px-3 py-2">
                  <OwnershipBadge ownership={card.ownership} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
