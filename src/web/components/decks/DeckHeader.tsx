import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { FORMAT_IDS, FORMATS } from '../../../shared/formats.ts'
import type { DeckDetail, DeckStatus, DeckSummary, FormatId } from '../../../shared/types.ts'
import { apiSend } from '../../lib/api.ts'
import { useCreateThread } from '../../lib/brainstorm.ts'
import { completionPercent, costLabel, scannedProgress, shortCards, valueLabel, warningCount } from '../../lib/deck-view.ts'
import { BOARD_LABEL, BOARD_ORDER, useDeckChange } from '../../lib/decks.ts'
import { plural } from '../../lib/format.ts'
import { ColorPips } from './ColorPips.tsx'

/** The header's actions: on a phone, each a third of their line. */
const action =
  'flex-1 rounded-md border border-stone-700 px-3 py-1.5 text-sm text-stone-200 hover:bg-stone-800 sm:flex-initial pointer-coarse:py-2.5'

interface DeckFields {
  name?: string
  format?: FormatId
  status?: DeckStatus
}

/**
 * Name, format, status (with the "Mark as built" check of spec §4.3), board counts, completion, cost to finish, how
 * much of it scanning has covered, and warnings.
 */
export function DeckHeader({ deck, onShowWarnings }: { deck: DeckDetail; onShowWarnings: () => void }) {
  const [name, setName] = useState(deck.name)
  useEffect(() => setName(deck.name), [deck.name])
  // The name as last loaded: a failed save goes back to it, not to one captured when the save started.
  const savedName = useRef(deck.name)
  savedName.current = deck.name
  // Set by Escape: the blur it causes runs saveName with the typed name still in its closure, so it must skip the save.
  const cancelled = useRef(false)
  const [confirmingBuilt, setConfirmingBuilt] = useState(false)
  const save = useDeckChange((fields: DeckFields) => apiSend<DeckSummary>('PATCH', `/api/decks/${deck.id}`, fields), "Couldn't save the deck")
  const brainstorm = useCreateThread()
  const navigate = useNavigate()
  const short = shortCards(deck.lines)
  const warnings = warningCount(deck)
  const scanned = scannedProgress(deck.lines)
  const empty = deck.cardCount === 0
  // The Mark as built check shows only while it has a reason (copies added meanwhile can leave nothing short), and
  // once it has none it's put away, so it doesn't come back unasked when a card is short again.
  const checkingBuilt = confirmingBuilt && deck.status !== 'built' && short.length > 0
  if (confirmingBuilt && !checkingBuilt) setConfirmingBuilt(false)

  function saveName() {
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    const trimmed = name.trim()
    if (trimmed === '') setName(deck.name)
    else if (trimmed !== deck.name) save.mutate({ name: trimmed }, { onError: () => setName(savedName.current) })
  }

  function setStatus(status: DeckStatus) {
    if (status === deck.status) return
    // Marking built claims owned copies; if any card is short, show which and ask first (spec §4.3).
    if (status === 'built' && short.length > 0) setConfirmingBuilt(true)
    else save.mutate({ status })
  }

  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          aria-label="Deck name"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              cancelled.current = true
              setName(deck.name)
              e.currentTarget.blur()
            }
          }}
          autoCapitalize="words"
          enterKeyHint="done"
          className="min-w-0 flex-1 basis-full rounded-md border border-transparent bg-transparent px-1 font-serif text-2xl font-semibold text-stone-50 hover:border-stone-800 focus:border-stone-700 focus:outline-none sm:basis-0 sm:text-3xl"
        />
        {!empty && <ColorPips identity={deck.colorIdentity} className="text-lg" />}
        <select
          aria-label="Format"
          value={deck.format}
          onChange={(e) => save.mutate({ format: e.target.value as FormatId })}
          className="rounded-md border border-stone-700 bg-stone-900 px-2 py-1.5 text-sm text-stone-100 pointer-coarse:py-2.5"
        >
          {FORMAT_IDS.map((f) => (
            <option key={f} value={f}>
              {FORMATS[f].label}
            </option>
          ))}
        </select>
        <div className="flex rounded-lg border border-stone-800 bg-stone-900/60 p-0.5" role="radiogroup" aria-label="Status">
          {(['prospective', 'built'] as const).map((s) => (
            <button
              key={s}
              role="radio"
              aria-checked={deck.status === s}
              onClick={() => setStatus(s)}
              className={`rounded-md px-3 py-1 text-sm capitalize pointer-coarse:py-2 ${deck.status === s ? (s === 'built' ? 'bg-emerald-700 text-emerald-50' : 'bg-stone-700 text-stone-50') : 'text-stone-400 hover:text-stone-100'}`}
            >
              {s}
            </button>
          ))}
        </div>
        {/* On a phone, the three share a line of their own, in fewer words. */}
        <div className="flex w-full gap-2 sm:contents">
          <button
            onClick={() => brainstorm.mutate(deck.id, { onSuccess: (thread) => navigate(`/brainstorm/${thread.id}`) })}
            disabled={brainstorm.isPending}
            className={`${action} disabled:opacity-50`}
          >
            Brainstorm<span className="max-sm:hidden"> with Claude</span>
          </button>
          <button onClick={() => navigate(`/scan?deck=${deck.id}`)} className={action}>
            Scan <span className="max-sm:hidden">cards into this deck</span>
            <span className="sm:hidden">cards</span>
          </button>
          <button onClick={() => navigate(`/playtest?deck=${deck.id}`)} className={action}>
            Playtest
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-stone-400">
        {BOARD_ORDER.filter((b) => deck.boards[b] > 0 || b === 'main').map((b) => (
          <span key={b}>
            {BOARD_LABEL[b]} <span className="text-stone-100 tabular-nums">{deck.boards[b]}</span>
          </span>
        ))}
        {!empty && (
          <span>
            <span className="text-stone-100 tabular-nums">{completionPercent(deck.completion)}%</span> complete
          </span>
        )}
        {!empty && <span>{valueLabel(deck)}</span>}
        {!empty && <span>{costLabel(deck)}</span>}
        {scanned && (
          <span>
            Scanned <span className="text-stone-100 tabular-nums">{scanned.scanned}</span> of{' '}
            <span className="tabular-nums">{scanned.of}</span>
          </span>
        )}
        {warnings > 0 && (
          <button onClick={onShowWarnings} className="text-amber-300 hover:underline pointer-coarse:py-2">
            {plural(warnings, 'warning')}
          </button>
        )}
      </div>
      {checkingBuilt && (
        <div role="alert" className="space-y-2 rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-sm text-amber-100">
          <p>
            {plural(short.length, 'card')} short: marking the deck built claims the copies you have, but these still need
            copies (your collection doesn't change):
          </p>
          <ul className="list-inside list-disc text-amber-200/90">
            {short.map((c) => (
              <li key={c.oracleId}>
                {c.name} <span className="text-amber-300/70">({c.short} short)</span>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button
              onClick={() => save.mutate({ status: 'built' }, { onSuccess: () => setConfirmingBuilt(false) })}
              disabled={save.isPending}
              className="rounded-md bg-amber-500 px-3 py-1 font-medium text-stone-950 hover:bg-amber-400 disabled:opacity-50 pointer-coarse:py-2.5"
            >
              {save.isPending ? 'Marking as built…' : 'Mark as built anyway'}
            </button>
            <button
              onClick={() => setConfirmingBuilt(false)}
              className="rounded-md border border-stone-700 px-3 py-1 text-stone-300 hover:bg-stone-800 pointer-coarse:py-2.5"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </header>
  )
}
