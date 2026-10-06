import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { FORMAT_IDS, FORMATS } from '../../../shared/formats.ts'
import type { DeckSummary, FormatId, ScanBoard, ScanTarget } from '../../../shared/types.ts'
import { apiSend } from '../../lib/api.ts'
import { BOARD_LABEL, useDeckChange, useDecks } from '../../lib/decks.ts'
import { boardOnDeck, hasCommanderBoard } from '../../lib/scan.ts'

const control = 'rounded-md border border-stone-700 bg-stone-900 px-2 py-1 text-sm text-stone-100 disabled:opacity-50 pointer-coarse:py-2'

/**
 * Chooses where scans go: the collection only, or a deck and one of its boards. Commander is offered for decks whose
 * format has a commander board (or when already chosen); moving to a deck without one goes to Main. With `onNewDeck`,
 * the list ends with "New deck…".
 */
export function TargetPicker({
  label,
  target,
  onChange,
  onNewDeck,
  disabled = false,
}: {
  label: string
  target: ScanTarget | null
  onChange: (target: ScanTarget | null) => void
  onNewDeck?: () => void
  disabled?: boolean
}) {
  const { data: decks = [] } = useDecks()
  const deck = target ? decks.find((d) => d.id === target.deckId) : undefined
  const group = (status: DeckSummary['status']) => decks.filter((d) => d.status === status)
  return (
    <>
      <select
        aria-label={label}
        value={target ? String(target.deckId) : 'collection'}
        disabled={disabled}
        onChange={(e) => {
          const value = e.target.value
          if (value === 'new') onNewDeck?.()
          else if (value === 'collection') onChange(null)
          else {
            const deckId = Number(value)
            onChange({ deckId, board: boardOnDeck(target?.board ?? 'main', decks.find((d) => d.id === deckId)?.format) })
          }
        }}
        className={`max-w-full ${control}`}
      >
        <option value="collection">Your collection only</option>
        {(['built', 'prospective'] as const).map(
          (status) =>
            group(status).length > 0 && (
              <optgroup key={status} label={status === 'built' ? 'Built decks' : 'Prospective decks'}>
                {group(status).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </optgroup>
            ),
        )}
        {onNewDeck && <option value="new">New deck…</option>}
      </select>
      {target && (
        <select
          aria-label={`${label}: board`}
          value={target.board}
          disabled={disabled}
          onChange={(e) => onChange({ deckId: target.deckId, board: e.target.value as ScanBoard })}
          className={control}
        >
          {(['main', 'side', 'commander'] as const)
            .filter((b) => b !== 'commander' || (deck !== undefined && hasCommanderBoard(deck.format)) || target.board === 'commander')
            .map((b) => (
              <option key={b} value={b}>
                {BOARD_LABEL[b]}
              </option>
            ))}
        </select>
      )}
    </>
  )
}

/** A deck made for scanning a physical one into: built, since its cards are in hand. */
function NewDeckForm({ onCreated, onCancel }: { onCreated: (deck: DeckSummary) => void; onCancel: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [format, setFormat] = useState<FormatId>('commander')
  const create = useDeckChange(
    (fields: { name: string; format: FormatId }) => apiSend<DeckSummary>('POST', '/api/decks', { ...fields, status: 'built' }),
    "Couldn't create the deck",
  )
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        create.mutate(
          { name: name.trim(), format },
          {
            onSuccess: (deck) => {
              // In the decks list at once (the list refetches too), so choosing it never reads as the collection only.
              queryClient.setQueryData<DeckSummary[]>(['decks'], (list = []) => (list.some((d) => d.id === deck.id) ? list : [...list, deck]))
              onCreated(deck)
            },
          },
        )
      }}
      className="flex w-full flex-wrap items-center gap-2"
    >
      <input
        aria-label="New deck's name"
        placeholder="Deck name"
        autoFocus
        required
        maxLength={100}
        autoCapitalize="words"
        autoComplete="off"
        enterKeyHint="done"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className={`min-w-48 flex-1 ${control}`}
      />
      <select aria-label="New deck's format" value={format} onChange={(e) => setFormat(e.target.value as FormatId)} className={control}>
        {FORMAT_IDS.map((f) => (
          <option key={f} value={f}>
            {FORMATS[f].label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={name.trim() === '' || create.isPending}
        className="rounded-md bg-amber-500 px-3 py-1 text-sm font-medium text-stone-950 hover:bg-amber-400 disabled:opacity-50 pointer-coarse:py-2.5"
      >
        Create built deck
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md border border-stone-700 px-3 py-1 text-sm text-stone-300 hover:bg-stone-800 pointer-coarse:py-2.5"
      >
        Cancel
      </button>
    </form>
  )
}

/**
 * "Scanning into" (spec §5.1.3): where the next captures go besides the collection. Each scan remembers the deck it
 * was captured for, so changing this doesn't move scans already taken.
 */
export function ScanTargetBar({ target, onChange }: { target: ScanTarget | null; onChange: (target: ScanTarget | null) => void }) {
  const [creating, setCreating] = useState(false)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-stone-800 bg-stone-900/40 px-4 py-3 text-sm">
      <span className="text-stone-400">Scanning into</span>
      <TargetPicker label="Scanning into" target={target} onChange={onChange} onNewDeck={() => setCreating(true)} />
      {target && (
        <Link to={`/decks/${target.deckId}`} className="text-amber-300 hover:underline pointer-coarse:py-2">
          Open deck
        </Link>
      )}
      {target && <span className="text-stone-500">Cards go to your collection and fill the deck's list first.</span>}
      {creating && (
        <NewDeckForm
          onCreated={(deck) => {
            onChange({ deckId: deck.id, board: 'main' })
            setCreating(false)
          }}
          onCancel={() => setCreating(false)}
        />
      )}
    </div>
  )
}
