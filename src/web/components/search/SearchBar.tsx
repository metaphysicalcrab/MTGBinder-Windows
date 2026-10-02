import { useEffect, useState } from 'react'
import { EMPTY_FORM, type AdvancedForm } from '../../../shared/search/advanced.ts'
import { composeQuery, formSync } from '../../lib/advanced-sync.ts'
import { useCoarsePointer } from '../../lib/platform.ts'
import type { SearchScope } from '../../lib/search-state.ts'
import { AdvancedPanel } from './AdvancedPanel.tsx'

interface QueryError {
  message: string
  span: { start: number; end: number } | undefined
}

interface Props {
  q: string
  scope: SearchScope
  /** Hide the scope switch (the Library page always searches My library). */
  scopeLocked?: boolean
  /** A query mistake reported by the server for `q`. */
  queryError: QueryError | null
  onSearch: (q: string) => void
  onScopeChange: (scope: SearchScope, q: string) => void
  /** The text in the search box as it's typed, for actions outside the bar that search it. */
  onDraftChange?: (draft: string) => void
}

const SCOPE_LABELS: Array<[SearchScope, string]> = [
  ['all', 'All cards'],
  ['library', 'My library'],
]

export function SearchBar({ q, scope, scopeLocked = false, queryError, onSearch, onScopeChange, onDraftChange }: Props) {
  const [draft, setDraft] = useState(q)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [form, setForm] = useState<AdvancedForm>(EMPTY_FORM)
  const [base, setBase] = useState<string | null>(null)
  const formScope = scope === 'library' ? 'library' : 'cards'

  // A new query (a search, or back/forward) replaces the text in the same render, so the form's state never shows,
  // even for a frame, against the old text.
  const [shownQ, setShownQ] = useState(q)
  if (q !== shownQ) {
    setShownQ(q)
    setDraft(q)
  }
  useEffect(() => onDraftChange?.(draft), [draft, onDraftChange])

  // The form's first edit keeps the typed text as its base; it then drives the query (base + form terms) while the
  // text still says exactly that. Typing in the query (or going back/forward) pauses it; Reset form clears it.
  const sync = formSync(base, form, formScope, draft)

  function changeForm(next: AdvancedForm) {
    // Paused, the form's fields are disabled; a half-typed type chip still commits when its field loses focus, which
    // mustn't write over the text that paused the form.
    if (sync === 'paused') return
    const b = base ?? draft.trim()
    setBase(b)
    setForm(next)
    setDraft(composeQuery(b, next, formScope))
  }

  function resetForm() {
    if (sync === 'driving') setDraft(base ?? '')
    setForm(EMPTY_FORM)
    setBase(null)
  }

  function changeScope(next: SearchScope) {
    // Library-only form fields appear or disappear with the scope, so re-compose a form that drives the query.
    const text = sync === 'driving' ? composeQuery(base ?? '', form, next === 'library' ? 'library' : 'cards') : draft
    setDraft(text)
    onScopeChange(next, text.trim())
  }

  const showError = queryError !== null && draft === q
  // A phone's box shows a shorter example: the long one would be cut off.
  const narrow = useCoarsePointer()
  const scopes: Array<[SearchScope, string]> = scope === 'local' ? [...SCOPE_LABELS, ['local', 'Local data']] : SCOPE_LABELS

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSearch(draft.trim())
      }}
      className="space-y-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        {!scopeLocked && (
          <div className="flex rounded-lg border border-stone-800 bg-stone-900/60 p-0.5" role="radiogroup" aria-label="Search in">
            {scopes.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={scope === value}
                onClick={() => changeScope(value)}
                className={`rounded-md px-3 py-1.5 text-sm pointer-coarse:py-2 ${scope === value ? 'bg-amber-500 font-medium text-stone-950' : 'text-stone-400 hover:text-stone-100'}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <input
          type="search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Search query"
          aria-invalid={showError}
          // Scryfall syntax, not words: a phone's keyboard mustn't capitalize t:elf or correct c:g.
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          placeholder={
            scope === 'library'
              ? narrow
                ? 'Search my library, e.g. t:elf'
                : 'Search my library, e.g. t:creature c:g (blank lists everything)'
              : narrow
                ? 'e.g. t:creature c:g mv<=3'
                : 'e.g. t:creature c:g mv<=3 o:"draw a card"'
          }
          className={`h-10 min-w-0 flex-1 basis-full rounded-lg border bg-stone-900/80 px-3 font-mono text-sm text-stone-100 outline-none placeholder:font-sans placeholder:text-stone-500 focus:ring-2 focus:ring-amber-500/20 sm:min-w-64 sm:basis-0 ${showError ? 'border-rose-700' : 'border-stone-700 focus:border-amber-500/70'}`}
        />
        {/* On a phone, the buttons share a line of their own under the box. */}
        <div className="flex w-full gap-2 sm:contents">
          <button type="submit" className="h-10 flex-1 rounded-lg bg-amber-500 px-4 text-sm font-medium text-stone-950 hover:bg-amber-400 sm:flex-initial">
            Search
          </button>
          <button
            type="button"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
            className="h-10 flex-1 rounded-lg border border-stone-700 px-3 text-sm text-stone-300 hover:bg-stone-800 sm:flex-initial"
          >
            Advanced {advancedOpen ? '▴' : '▾'}
          </button>
        </div>
      </div>

      {showError && (
        <div role="alert" className="rounded-lg border border-rose-900 bg-rose-950/40 px-3 py-2 text-sm text-rose-200">
          <div>{queryError.message}</div>
          {queryError.span && queryError.span.end > queryError.span.start && (
            <div className="mt-1 font-mono text-xs break-all text-rose-200/80">
              {q.slice(0, queryError.span.start)}
              <mark className="rounded-sm bg-rose-700/70 px-0.5 text-rose-50">{q.slice(queryError.span.start, queryError.span.end)}</mark>
              {q.slice(queryError.span.end)}
            </div>
          )}
        </div>
      )}

      {advancedOpen && (
        <AdvancedPanel form={form} scope={formScope} paused={sync === 'paused'} onChange={changeForm} onReset={resetForm} />
      )}
    </form>
  )
}
