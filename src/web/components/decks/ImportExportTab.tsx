import { useMutation, useQuery } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import type { DeckImportItem, DeckImportPreview, DeckImportRow } from '../../../shared/types.ts'
import { apiGetText, apiSend } from '../../lib/api.ts'
import { copyText } from '../../lib/clipboard.ts'
import { BOARD_LABEL, useDeckChange } from '../../lib/decks.ts'
import { plural } from '../../lib/format.ts'
import { useToast } from '../../lib/toast.tsx'

/** Paste a decklist (Arena, MTGO, or Moxfield), preview how it resolves, then add or replace; and export (spec §5.4.2). */
export function ImportExportTab({ deckId }: { deckId: number }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <ImportPanel deckId={deckId} />
      <ExportPanel deckId={deckId} />
    </div>
  )
}

const box = 'space-y-3 rounded-xl border border-stone-800 bg-stone-900/40 p-4'
const radio = 'pointer-coarse:size-5'

function ImportPanel({ deckId }: { deckId: number }) {
  const [text, setText] = useState('')
  const [replace, setReplace] = useState(false)
  const toast = useToast()
  const preview = useMutation({
    mutationFn: (list: string) => apiSend<DeckImportPreview>('POST', `/api/decks/${deckId}/import/preview`, { text: list }),
  })
  const apply = useDeckChange(
    (body: { items: DeckImportItem[]; replace: boolean }) => apiSend<{ lines: number; copies: number }>('POST', `/api/decks/${deckId}/import`, body),
    'Import failed; the deck is unchanged',
  )
  const result = preview.data
  const items: DeckImportItem[] =
    result?.rows.flatMap((r) => (r.card ? [{ oracleId: r.card.oracleId, cardId: r.card.cardId, quantity: r.quantity, board: r.board }] : [])) ?? []
  const copies = items.reduce((sum, i) => sum + i.quantity, 0)
  const problems = result?.rows.filter((r) => r.match === 'fuzzy' || r.match === 'unresolved') ?? []

  return (
    <section aria-labelledby="deck-import-heading" className={box}>
      <h2 id="deck-import-heading" className="text-lg font-semibold text-stone-100">
        Import a list
      </h2>
      <textarea
        aria-label="Decklist"
        rows={10}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          preview.reset()
        }}
        placeholder={'Commander\n1 Atraxa, Praetors\' Voice\n\nDeck\n1 Sol Ring (CMR) 472\n4 Forest'}
        className="w-full rounded-md border border-stone-700 bg-stone-950 px-3 py-2 font-mono text-xs text-stone-100 placeholder:text-stone-600"
      />
      <button
        onClick={() => preview.mutate(text)}
        disabled={text.trim() === '' || preview.isPending}
        className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-stone-950 hover:bg-amber-400 disabled:opacity-50 pointer-coarse:py-2.5"
      >
        {preview.isPending ? 'Reading…' : 'Preview'}
      </button>
      {preview.error && (
        <p role="alert" className="text-sm text-rose-300">
          {preview.error.message}
        </p>
      )}
      {result && (
        <div className="space-y-3 text-sm">
          <p className="text-stone-300" aria-live="polite">
            {plural(result.rows.length, 'line')}: {result.counts.exact + result.counts.face} matched, {result.counts.fuzzy} close
            matches, {result.counts.unresolved} not found
            {result.skipped.length > 0 && `, ${plural(result.skipped.length, 'line')} skipped`}.
          </p>
          {problems.length > 0 && (
            <ul className="space-y-1 rounded-lg border border-stone-800 p-2 text-xs">
              {problems.map((row) => (
                <ProblemRow key={row.line} row={row} />
              ))}
            </ul>
          )}
          {result.skipped.length > 0 && (
            <p className="text-xs text-stone-500">Skipped: {result.skipped.map((s) => `line ${s.line} "${s.text}"`).join(', ')}</p>
          )}
          <fieldset className="flex flex-wrap gap-4 text-stone-300">
            <legend className="sr-only">How to import</legend>
            <label className="flex items-center gap-2 pointer-coarse:min-h-10">
              <input type="radio" name="import-mode" checked={!replace} onChange={() => setReplace(false)} className={radio} /> Add to this deck
            </label>
            <label className="flex items-center gap-2 pointer-coarse:min-h-10">
              <input type="radio" name="import-mode" checked={replace} onChange={() => setReplace(true)} className={radio} /> Replace this deck's cards
            </label>
          </fieldset>
          <button
            onClick={() =>
              apply.mutate(
                { items, replace },
                {
                  onSuccess: (r) => {
                    toast.success(`${replace ? 'Replaced the deck with' : 'Added'} ${plural(r.copies, 'card')}.`)
                    preview.reset()
                    setText('')
                  },
                },
              )
            }
            disabled={items.length === 0 || apply.isPending}
            className="rounded-md bg-amber-500 px-3 py-1.5 font-medium text-stone-950 hover:bg-amber-400 disabled:opacity-50 pointer-coarse:py-2.5"
          >
            {apply.isPending ? 'Importing…' : `${replace ? 'Replace with' : 'Add'} ${plural(copies, 'card')}`}
          </button>
        </div>
      )}
    </section>
  )
}

function ProblemRow({ row }: { row: DeckImportRow }) {
  return (
    <li className="flex flex-wrap gap-x-2">
      <span className="text-stone-500 tabular-nums">line {row.line}</span>
      <span className="text-stone-200">
        {row.quantity} {row.name}
      </span>
      <span className="text-stone-500">({BOARD_LABEL[row.board]})</span>
      {row.match === 'fuzzy' && row.card ? (
        <span className="text-amber-300">
          → {row.card.name} ({Math.round((row.score ?? 0) * 100)}% alike)
        </span>
      ) : (
        <span className="text-rose-300">not found; left out</span>
      )}
    </li>
  )
}

function ExportPanel({ deckId }: { deckId: number }) {
  const [format, setFormat] = useState<'arena' | 'mtgo'>('arena')
  const toast = useToast()
  const listRef = useRef<HTMLTextAreaElement>(null)
  const { data, error } = useQuery({
    queryKey: ['deck', deckId, 'export', format],
    queryFn: ({ signal }) => apiGetText(`/api/decks/${deckId}/export?format=${format}`, signal),
  })
  async function copy() {
    try {
      await copyText(data ?? '')
      toast.success('Copied the list to the clipboard.')
    } catch {
      // The list is selected, for the browser's own Copy (a long press on a phone).
      listRef.current?.select()
      toast.error("Couldn't copy to the clipboard. The list is selected: copy it from there.")
    }
  }
  return (
    <section aria-labelledby="deck-export-heading" className={box}>
      <div className="flex items-center justify-between gap-3">
        <h2 id="deck-export-heading" className="text-lg font-semibold text-stone-100">
          Export
        </h2>
        <select
          aria-label="Export format"
          value={format}
          onChange={(e) => setFormat(e.target.value as 'arena' | 'mtgo')}
          className="rounded-md border border-stone-700 bg-stone-900 px-2 py-1 text-sm text-stone-100 pointer-coarse:py-2"
        >
          <option value="arena">Arena</option>
          <option value="mtgo">MTGO</option>
        </select>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-rose-300">
          {error.message}
        </p>
      ) : (
        <textarea
          ref={listRef}
          aria-label="Exported list"
          readOnly
          rows={10}
          value={data ?? ''}
          className="w-full rounded-md border border-stone-700 bg-stone-950 px-3 py-2 font-mono text-xs text-stone-100"
        />
      )}
      <button
        onClick={() => void copy()}
        disabled={!data}
        className="rounded-md border border-stone-700 px-3 py-1.5 text-sm text-stone-200 hover:bg-stone-800 disabled:opacity-50 pointer-coarse:py-2.5"
      >
        Copy
      </button>
    </section>
  )
}
