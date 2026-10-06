import { useQuery } from '@tanstack/react-query'
import { useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router'
import type { SearchPage as ResultPage } from '../../shared/types.ts'
import { SearchBar } from '../components/search/SearchBar.tsx'
import { SearchResults } from '../components/search/SearchResults.tsx'
import { ApiRequestError, apiGet } from '../lib/api.ts'
import { onOverlayEntry } from '../lib/back-to-close.ts'
import {
  canSearch,
  libraryOnlyTerms,
  readSearchState,
  SEARCH_EXAMPLES,
  searchApiUrl,
  writeSearchState,
  type SearchScope,
  type SearchState,
} from '../lib/search-state.ts'

/** Search all cards (Scryfall), my library, or — when Scryfall is unreachable — the local card data (spec §5.2). */
export function SearchPage() {
  return (
    <div className="space-y-5">
      <h1 className="font-serif text-3xl font-semibold text-stone-50">Search</h1>
      <SearchView />
    </div>
  )
}

/** The search bar and results, with state in the page URL. `locked` pins the scope and hides the scope switch. */
export function SearchView({ locked }: { locked?: SearchScope }) {
  const [params, setParams] = useSearchParams()
  const state = readSearchState(params, locked)
  const url = searchApiUrl(state)
  const enabled = canSearch(state)
  const { data, error, isFetching } = useQuery({
    queryKey: ['search', url],
    queryFn: ({ signal }) => apiGet<ResultPage>(url, signal),
    enabled,
    placeholderData: (previous) => previous,
    staleTime: 60_000,
    // Retry once only when our own server couldn't be reached; an ApiRequestError is a deliberate answer
    // (a query mistake, Scryfall offline or busy) that retrying can't change.
    retry: (count, err) => !(err instanceof ApiRequestError) && count < 1,
  })

  /**
   * Changes the search; any change except paging (or an explicit page) goes back to page 1. Made with Library's import
   * panel open, it replaces the panel's history entry (see useOnOverlayEntry), and the panel adds another.
   */
  const update = (patch: Partial<SearchState>) =>
    setParams(writeSearchState({ ...state, page: 1, ...patch }, locked), { replace: onOverlayEntry() })
  const apiError = error instanceof ApiRequestError ? error : null
  const queryError = apiError?.code === 'bad_query' || apiError?.code === 'empty_query' ? apiError : null
  const offline = apiError?.code === 'scryfall_offline'
  // What's typed in the search box: searching the local card data instead searches that, as the scope buttons do.
  const typed = useRef(state.q)
  const onDraftChange = useCallback((draft: string) => {
    typed.current = draft
  }, [])
  const libraryOnly = enabled && state.scope === 'all' ? libraryOnlyTerms(state.q) : []

  return (
    <div className="space-y-5">
      <SearchBar
        q={state.q}
        scope={state.scope}
        scopeLocked={locked !== undefined}
        queryError={queryError}
        onSearch={(q) => update({ q })}
        onScopeChange={(scope, q) => update({ scope, q })}
        onDraftChange={onDraftChange}
      />

      {libraryOnly.length > 0 && (
        <p className="text-xs text-stone-400">
          {libraryOnly.map((term, i) => (
            <span key={term}>
              {i > 0 && ', '}
              <code className="text-stone-200">{term}</code>
            </span>
          ))}{' '}
          {libraryOnly.length === 1 ? 'works' : 'work'} in My library only; Scryfall reads {libraryOnly.length === 1 ? 'it' : 'them'} its
          own way.{' '}
          <button onClick={() => update({ scope: 'library' })} className="text-amber-300 hover:underline">
            Search My library
          </button>
        </p>
      )}

      {offline && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-900/60 bg-amber-950/30 px-4 py-3 text-sm text-amber-100">
          <span className="flex-1">{apiError.message}</span>
          <button
            onClick={() => update({ scope: 'local', q: typed.current.trim() })}
            className="rounded-md bg-amber-500 px-3 py-1.5 font-medium text-stone-950 hover:bg-amber-400"
          >
            Search local card data instead
          </button>
        </div>
      )}
      {error && !queryError && !offline && (
        <div role="alert" className="rounded-lg border border-rose-900 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
          {error.message}
        </div>
      )}
      {enabled && data && data.warnings.length > 0 && (
        <ul className="rounded-lg border border-stone-800 bg-stone-900/50 px-4 py-2 text-xs text-stone-400">
          {data.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {!enabled ? (
        <div className="space-y-3 py-12 text-center text-stone-500">
          <p>Search every card with Scryfall syntax, or switch to My library to search what you own. For example:</p>
          <ul className="flex flex-wrap justify-center gap-2">
            {SEARCH_EXAMPLES.map((example) => (
              <li key={example.q}>
                <button
                  onClick={() => update({ q: example.q })}
                  className="rounded-full border border-stone-700 px-3 py-1 text-sm text-stone-300 hover:bg-stone-800"
                >
                  <code className="text-amber-300">{example.q}</code> <span className="text-stone-500">{example.means}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : data && !queryError ? (
        <SearchResults page={data} state={state} fetching={isFetching} onChange={update} libraryPage={locked === 'library'} />
      ) : isFetching ? (
        <p className="py-16 text-center text-stone-500">Searching…</p>
      ) : null}
    </div>
  )
}
