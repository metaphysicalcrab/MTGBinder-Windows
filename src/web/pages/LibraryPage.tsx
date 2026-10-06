import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import type { CollectionStats } from '../../shared/types.ts'
import { CardDataNotice } from '../components/library/CardDataNotice.tsx'
import { ImportPanel } from '../components/library/ImportPanel.tsx'
import { apiGet } from '../lib/api.ts'
import { useOnOverlayEntry } from '../lib/back-to-close.ts'
import { formatDate, formatUsd } from '../lib/format.ts'
import { IS_WINDOWS } from '../lib/platform.ts'
import { readSearchState, writeSearchState } from '../lib/search-state.ts'
import { SearchView } from './SearchPage.tsx'

const action = 'rounded-md border border-stone-700 px-3 py-1.5 text-sm text-stone-200 hover:bg-stone-800 pointer-coarse:py-2.5'

const EXPORT_URL = '/api/collection/export.csv'

/**
 * My library, where Binder opens: totals, CSV import and export, and search locked to the collection (spec §5.2, §5.3).
 * Before there's card data it says how to get it, and while nothing is owned its results show Getting started (§5.7).
 */
export function LibraryPage() {
  // Getting started's Import a CSV (on this page) and other pages' links open the page with the import panel showing.
  const { pathname, search, state } = useLocation()
  const navigate = useNavigate()
  const openedImporting = (state as { importing?: boolean } | null)?.importing === true
  const [importing, setImporting] = useState(openedImporting)
  // Once read, the history entry drops that state (keeping the path and the search), so a reload or Back doesn't open
  // the panel again. Opening it here too covers a link from this page, which keeps the page mounted.
  useEffect(() => {
    if (!openedImporting) return
    setImporting(true)
    void navigate({ pathname, search }, { replace: true, state: null })
  }, [openedImporting, pathname, search, navigate])
  const stats = useQuery({
    queryKey: ['collection', 'stats'],
    queryFn: ({ signal }) => apiGet<CollectionStats>('/api/collection/stats', signal),
  })

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <h1 className="font-serif text-3xl font-semibold text-stone-50">Library</h1>
          {stats.data ? (
            <StatsLine stats={stats.data} unpricedSearch={unpricedSearch(search)} />
          ) : stats.error ? (
            <p className="text-sm text-rose-300">Couldn't load library totals: {stats.error.message}</p>
          ) : (
            <p className="text-sm text-stone-500">…</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setImporting(true)} disabled={importing} className={`${action} disabled:opacity-50`}>
            Import CSV
          </button>
          <a href={EXPORT_URL} download className={action}>
            Export CSV
          </a>
          {IS_WINDOWS && (
            // The same CSV, marked as UTF-8 (a byte order mark first): Excel on Windows reads a CSV without one in
            // Windows' own code page, garbling accented names.
            <a
              href={`${EXPORT_URL}?excel=1`}
              download
              title="The same CSV, marked as UTF-8 so Excel shows accented names as they are"
              className={action}
            >
              Export for Excel
            </a>
          )}
        </div>
      </div>
      <CardDataNotice />
      {importing && <ImportPanel onClose={() => setImporting(false)} />}
      <SearchView locked="library" />
    </div>
  )
}

/**
 * The search for the library's copies with no price (what its value leaves out), each printing and finish on its own
 * row, keeping the current layout and sort.
 */
function unpricedSearch(search: string): string {
  const current = readSearchState(new URLSearchParams(search), 'library')
  return `?${writeSearchState({ ...current, q: 'is:unpriced', view: 'printings', page: 1 }, 'library')}`
}

function StatsLine({ stats, unpricedSearch }: { stats: CollectionStats; unpricedSearch: string }) {
  // With the import panel open, the search replaces the panel's history entry (see useOnOverlayEntry).
  const fromOverlay = useOnOverlayEntry()
  const items: Array<[string, string]> = [
    ['Cards', stats.totalCards.toLocaleString()],
    ['Unique', stats.uniqueCards.toLocaleString()],
    ['Value', formatUsd(stats.valueUsd)],
    ['Last added', stats.lastAddedAt ? formatDate(stats.lastAddedAt) : 'never'],
  ]
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="flex gap-1.5">
          <dt className="text-stone-500">{label}</dt>
          <dd className="text-stone-100 tabular-nums">
            {value}
            {label === 'Value' && stats.unpricedCards > 0 && (
              <Link
                to={{ search: unpricedSearch }}
                replace={fromOverlay}
                // For a finger, a taller target without a taller line.
                className="ml-1 text-xs text-stone-500 underline decoration-stone-600 underline-offset-2 hover:text-amber-300 hover:decoration-amber-300 pointer-coarse:inline-block pointer-coarse:-my-3 pointer-coarse:py-3"
              >
                ({stats.unpricedCards.toLocaleString()} without a price)
              </Link>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}
