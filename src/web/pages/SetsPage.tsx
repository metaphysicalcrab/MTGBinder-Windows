import { useState } from 'react'
import { Link, useNavigationType, useSearchParams } from 'react-router'
import type { SetProgress } from '../../shared/types.ts'
import { SetBar } from '../components/sets/SetBar.tsx'
import { plural } from '../lib/format.ts'
import { filterSets, readSetSort, releaseMonth, SET_SORTS, setTypeLabel, sortSets, useSets, type SetSort } from '../lib/sets.ts'

const input = 'rounded-md border border-stone-700 bg-stone-900 px-2 py-1.5 text-sm text-stone-100 pointer-coarse:py-2.5'

/** Every set with a copy owned, and how complete each is (spec §5.8). The sort and filter live in the address. */
export function SetsPage() {
  const [params, setParams] = useSearchParams()
  const navigationType = useNavigationType()
  const sort = readSetSort(params.get('sort'))
  const filter = params.get('q') ?? ''
  // The box keeps its own text, as SearchBar does: the router updates the address in a transition, a moment after the
  // keystroke, so a box bound to the address would jump its caret to the end and could drop a letter typed meanwhile.
  const [draft, setDraft] = useState(filter)
  // A new address from elsewhere (Back/Forward, a link to Sets) replaces the text in the same render. The box's own
  // writes replace the history entry and only catch the address up to the text; re-syncing on those could undo letters
  // typed since.
  const [shownFilter, setShownFilter] = useState(filter)
  if (filter !== shownFilter) {
    setShownFilter(filter)
    if (navigationType !== 'REPLACE') setDraft(filter)
  }
  const { data: sets, error, isPending } = useSets()
  const shown = sets ? sortSets(filterSets(sets, draft), sort) : []

  // Replaces the history entry, so Back leaves the page rather than stepping through each letter typed.
  const change = (patch: { sort?: SetSort; q?: string }) => {
    const next = new URLSearchParams(params)
    const nextSort = patch.sort ?? sort
    const nextFilter = patch.q ?? draft
    if (nextSort === 'completion') next.delete('sort')
    else next.set('sort', nextSort)
    if (nextFilter === '') next.delete('q')
    else next.set('q', nextFilter)
    setParams(next, { replace: true })
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="font-serif text-3xl font-semibold text-stone-50">Sets</h1>
        {sets && sets.length > 0 && <p className="text-sm text-stone-400">{plural(sets.length, 'set')} with cards you own</p>}
      </div>
      {error ? (
        <p role="alert" className="text-rose-300">
          Couldn't load your sets: {error.message}
        </p>
      ) : isPending ? (
        <p className="text-stone-500">Loading…</p>
      ) : sets.length === 0 ? (
        <p className="py-12 text-center text-stone-500">
          Sets appear here once you own cards from them.{' '}
          <Link to="/scan" className="text-amber-300 hover:underline">
            Scan your cards
          </Link>{' '}
          or{' '}
          <Link to="/library" state={{ importing: true }} className="text-amber-300 hover:underline">
            import a CSV
          </Link>
          .
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="search"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                change({ q: e.target.value })
              }}
              placeholder="Filter by name or code"
              aria-label="Filter sets by name or code"
              // Set names and codes: no capitals or corrections from a phone's keyboard. It filters as it's typed, so
              // Enter only puts the keyboard away.
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="search"
              className={`${input} w-full max-w-xs`}
            />
            <label className="ml-auto flex items-center gap-2 text-sm text-stone-400">
              Sort
              <select value={sort} onChange={(e) => change({ sort: readSetSort(e.target.value) })} className={input}>
                {SET_SORTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {shown.length === 0 ? (
            <p className="py-12 text-center text-stone-500">No sets match “{draft.trim()}”.</p>
          ) : (
            <ul className="space-y-3">
              {shown.map((set) => (
                <SetRow key={set.code} set={set} back={params.toString()} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

/** One set: its name, code, type, and release month, then its bar. `back` is this page's address, for ← Sets. */
function SetRow({ set, back }: { set: SetProgress; back: string }) {
  const type = setTypeLabel(set.setType)
  return (
    <li>
      <Link
        to={`/sets/${set.code}`}
        state={{ back }}
        className="block rounded-xl border border-stone-800 bg-stone-900/40 px-4 py-3 hover:border-stone-600 hover:bg-stone-900/70"
      >
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="font-serif text-lg font-semibold [overflow-wrap:anywhere] text-stone-50">{set.name}</span>
          <span className="text-xs text-stone-400">
            <span className="font-mono uppercase">{set.code}</span>
            {type && ` · ${type}`} · {releaseMonth(set.releasedAt)}
          </span>
        </div>
        <SetBar owned={set.owned} total={set.total} label={`${set.name} completion`} />
      </Link>
    </li>
  )
}
