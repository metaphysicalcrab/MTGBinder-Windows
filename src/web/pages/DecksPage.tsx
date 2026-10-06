import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { FORMAT_IDS, FORMATS } from '../../shared/formats.ts'
import type { DeckStatus, DeckSummary, FormatId } from '../../shared/types.ts'
import { ColorPips } from '../components/decks/ColorPips.tsx'
import { apiSend } from '../lib/api.ts'
import { completionPercent, costLabel, valueLabel } from '../lib/deck-view.ts'
import { useDeckChange, useDecks } from '../lib/decks.ts'
import { plural } from '../lib/format.ts'
import { useToast } from '../lib/toast.tsx'

type Tab = 'built' | 'prospective' | 'all'
const TABS: Array<[Tab, string]> = [
  ['built', 'Built'],
  ['prospective', 'Prospective'],
  ['all', 'All'],
]

const input = 'rounded-md border border-stone-700 bg-stone-900 px-2 py-1.5 text-sm text-stone-100 pointer-coarse:py-2.5'
/** A card's small buttons: a finger's size on a touch screen. */
const small = 'rounded-md px-2 py-1 pointer-coarse:px-3 pointer-coarse:py-2'

/** Decks, filtered by status, with new / duplicate / delete (spec §5.4.1). */
export function DecksPage() {
  const [params, setParams] = useSearchParams()
  const tab = (TABS.find(([t]) => t === params.get('tab'))?.[0] ?? 'all') satisfies Tab
  const { data: decks, error, isPending } = useDecks()
  const [creating, setCreating] = useState(false)
  const shown = decks?.filter((d) => tab === 'all' || d.status === tab) ?? []

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-serif text-3xl font-semibold text-stone-50">Decks</h1>
        <button
          onClick={() => setCreating(true)}
          disabled={creating}
          className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-stone-950 hover:bg-amber-400 disabled:opacity-50 pointer-coarse:py-2.5"
        >
          New deck
        </button>
      </div>
      {creating && <NewDeckForm onDone={() => setCreating(false)} />}
      <div className="flex rounded-lg border border-stone-800 bg-stone-900/60 p-0.5 text-sm" role="tablist" aria-label="Show">
        {TABS.map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            onClick={() => setParams(value === 'all' ? {} : { tab: value })}
            className={`rounded-md px-3 py-1.5 pointer-coarse:py-2.5 ${tab === value ? 'bg-stone-700 text-stone-50' : 'text-stone-400 hover:text-stone-100'}`}
          >
            {label} {decks && <span className="text-stone-500">{decks.filter((d) => value === 'all' || d.status === value).length}</span>}
          </button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-rose-300">
          Couldn't load your decks: {error.message}
        </p>
      ) : isPending ? (
        <p className="text-stone-500">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="py-12 text-center text-stone-500">
          {decks?.length === 0 ? (
            <>
              No decks yet. Plan one with New deck, or{' '}
              <Link to="/scan" className="text-amber-300 hover:underline">
                scan a deck you own
              </Link>{' '}
              (choose New deck… under Scanning into).
            </>
          ) : (
            `No ${tab} decks.`
          )}
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((d) => (
            <DeckCard key={d.id} deck={d} />
          ))}
        </ul>
      )}
    </div>
  )
}

function NewDeckForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [format, setFormat] = useState<FormatId>('commander')
  const [status, setStatus] = useState<DeckStatus>('prospective')
  const navigate = useNavigate()
  const create = useDeckChange(
    (fields: { name: string; format: FormatId; status: DeckStatus }) => apiSend<DeckSummary>('POST', '/api/decks', fields),
    "Couldn't create the deck",
  )
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        create.mutate({ name: name.trim(), format, status }, { onSuccess: (deck) => navigate(`/decks/${deck.id}`) })
      }}
      className="flex flex-wrap items-end gap-3 rounded-xl border border-stone-800 bg-stone-900/40 p-4"
    >
      <label className="flex min-w-56 flex-1 flex-col gap-1 text-sm text-stone-400">
        Name
        <input
          autoFocus
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoCapitalize="words"
          enterKeyHint="done"
          className={input}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-stone-400">
        Format
        <select value={format} onChange={(e) => setFormat(e.target.value as FormatId)} className={input}>
          {FORMAT_IDS.map((f) => (
            <option key={f} value={f}>
              {FORMATS[f].label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm text-stone-400">
        Status
        <select value={status} onChange={(e) => setStatus(e.target.value as DeckStatus)} className={input}>
          <option value="prospective">Prospective</option>
          <option value="built">Built</option>
        </select>
      </label>
      <button
        type="submit"
        disabled={name.trim() === '' || create.isPending}
        className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-stone-950 hover:bg-amber-400 disabled:opacity-50 pointer-coarse:py-2.5"
      >
        Create
      </button>
      <button
        type="button"
        onClick={onDone}
        className="rounded-md border border-stone-700 px-3 py-1.5 text-sm text-stone-300 hover:bg-stone-800 pointer-coarse:py-2.5"
      >
        Cancel
      </button>
    </form>
  )
}

function DeckCard({ deck }: { deck: DeckSummary }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const toast = useToast()
  const duplicate = useDeckChange(() => apiSend<DeckSummary>('POST', `/api/decks/${deck.id}/duplicate`), "Couldn't duplicate the deck")
  const remove = useDeckChange(() => apiSend<void>('DELETE', `/api/decks/${deck.id}`), "Couldn't delete the deck")
  const percent = completionPercent(deck.completion)
  return (
    // The whole card opens the deck (the name's link stretched over it); its buttons sit above that.
    <li className="relative flex flex-col gap-3 rounded-xl border border-stone-800 bg-stone-900/40 p-4">
      <div className="flex items-start justify-between gap-2">
        <Link
          to={`/decks/${deck.id}`}
          className="min-w-0 font-serif text-lg font-semibold [overflow-wrap:anywhere] text-stone-50 after:absolute after:inset-0 after:rounded-xl hover:text-amber-300"
        >
          {deck.name}
        </Link>
        {deck.cardCount > 0 && <ColorPips identity={deck.colorIdentity} className="shrink-0 pt-1" />}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-stone-400">
        <span>{FORMATS[deck.format].label}</span>
        <span className={`rounded px-1.5 py-0.5 ${deck.status === 'built' ? 'bg-emerald-900/60 text-emerald-200' : 'bg-stone-800 text-stone-300'}`}>
          {deck.status}
        </span>
        <span>{plural(deck.cardCount, 'card')}</span>
        {deck.cardCount > 0 && <span>{valueLabel(deck)}</span>}
      </div>
      {deck.cardCount === 0 ? (
        <p className="text-xs text-stone-500">No cards yet.</p>
      ) : (
        <div>
          <div className="flex justify-between gap-2 text-xs text-stone-400">
            <span>{percent}% complete</span>
            <span className="text-right">{costLabel(deck)}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded bg-stone-800" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Completion">
            <div className="h-full rounded bg-emerald-600" style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}
      {confirmingDelete ? (
        <div role="alert" className="relative flex flex-wrap items-center gap-2 text-sm text-rose-200">
          Delete {deck.name}? This can't be undone.
          <button
            aria-label={`Delete ${deck.name}`}
            onClick={(e) => {
              if (e.detail > 1) return // the second click of a double click
              remove.mutate(undefined, { onSuccess: () => toast.success(`Deleted ${deck.name}.`) })
            }}
            disabled={remove.isPending || remove.isSuccess}
            className={`${small} bg-rose-700 text-rose-50 hover:bg-rose-600 disabled:opacity-50`}
          >
            Delete
          </button>
          <button onClick={() => setConfirmingDelete(false)} className={`${small} border border-stone-700 text-stone-300 hover:bg-stone-800`}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="relative flex gap-2 self-start text-sm">
          <button
            aria-label={`Duplicate ${deck.name}`}
            onClick={(e) => {
              // The server answers in milliseconds, so isPending alone re-enables the button before a double click's
              // second click lands; that second click (detail 2) is ignored instead of making a second copy.
              if (e.detail > 1) return
              duplicate.mutate(undefined, { onSuccess: (copy) => toast.success(`Created ${copy.name}.`) })
            }}
            disabled={duplicate.isPending}
            className={`${small} border border-stone-700 text-stone-300 hover:bg-stone-800 disabled:opacity-50`}
          >
            Duplicate
          </button>
          <button
            aria-label={`Delete ${deck.name}`}
            onClick={() => setConfirmingDelete(true)}
            className={`${small} border border-stone-700 text-stone-300 hover:bg-stone-800`}
          >
            Delete
          </button>
        </div>
      )}
    </li>
  )
}
