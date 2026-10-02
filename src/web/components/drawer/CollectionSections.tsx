import { useId, useState } from 'react'
import type { Card, CardDetail, Finish, Ownership, Printing } from '../../../shared/types.ts'
import { useAdjustCopies } from '../../lib/collection.ts'
import { formatUsd } from '../../lib/format.ts'
import { useToast } from '../../lib/toast.tsx'
import { sectionHeading } from './styles.ts'

const FINISH_LABEL: Record<Finish, string> = { nonfoil: 'Nonfoil', foil: 'Foil', etched: 'Etched' }

const stepButton =
  'size-7 rounded-md border border-stone-700 text-stone-200 hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:size-10 pointer-coarse:text-lg'

/** "Own 3 · 1 free", or "Own 1 · 3 short" when built decks claim more copies than I own (as the search badge says). */
function OwnershipLine({ ownership }: { ownership: Ownership }) {
  const { owned, free } = ownership
  if (owned === 0 && free >= 0) return null
  return (
    <span
      title={free < 0 ? `Built decks use ${owned - free} copies but you own ${owned}` : undefined}
      className={`text-xs normal-case tracking-normal ${free < 0 ? 'text-rose-300' : 'text-stone-400'}`}
    >
      Own {owned} · {free < 0 ? `${-free} short` : `${free} free`}
    </span>
  )
}

/** Every owned copy of this card, per printing and finish, with steppers (spec §5.2.5 "Your copies"). */
export function YourCopies({ detail, onSelectPrinting }: { detail: CardDetail; onSelectPrinting: (id: string) => void }) {
  const adjust = useAdjustCopies()
  const headingId = useId()
  const finishesById = new Map(detail.printings.map((p) => [p.id, p.finishes]))
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className={`${sectionHeading} flex items-baseline justify-between`}>
        Your copies <OwnershipLine ownership={detail.ownership} />
      </h3>
      {detail.copies.length === 0 ? (
        <p className="text-sm text-stone-500">You don't own this card yet.</p>
      ) : (
        <ul className="divide-y divide-stone-800/80 rounded-lg border border-stone-800">
          {detail.copies.map((copy) => {
            const label = `${copy.setCode.toUpperCase()} #${copy.collectorNumber} ${copy.finish}`
            const canAdd = finishesById.get(copy.cardId)?.includes(copy.finish) ?? false
            return (
              // Below sm, two lines: the printing, then its price and the stepper, so the name has the row's width.
              <li key={`${copy.cardId}-${copy.finish}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm sm:flex-nowrap">
                <button
                  onClick={() => onSelectPrinting(copy.cardId)}
                  className="w-12 shrink-0 text-left font-mono text-xs text-stone-400 uppercase hover:text-amber-300 pointer-coarse:py-2"
                >
                  {copy.setCode}
                </button>
                <span className="min-w-0 flex-1 truncate text-stone-300">
                  {copy.setName} <span className="text-stone-500">#{copy.collectorNumber}</span>
                </span>
                {copy.finish !== 'nonfoil' && <span className="shrink-0 text-xs text-amber-300">{FINISH_LABEL[copy.finish]}</span>}
                <span className="flex basis-full items-center justify-end gap-3 sm:contents">
                  <span className="w-16 shrink-0 text-right text-stone-300 tabular-nums">{formatUsd(copy.priceUsd)}</span>
                  <span className="flex shrink-0 items-center gap-1.5 pointer-coarse:gap-3">
                    <button
                      aria-label={`Remove one ${label}`}
                      onClick={() => adjust.mutate({ cardId: copy.cardId, finish: copy.finish, delta: -1 })}
                      className={stepButton}
                    >
                      −
                    </button>
                    <span className="w-6 text-center text-stone-100 tabular-nums">{copy.quantity}</span>
                    <button
                      aria-label={`Add one ${label}`}
                      disabled={!canAdd}
                      title={canAdd ? undefined : `This printing no longer comes in ${copy.finish}`}
                      onClick={() => adjust.mutate({ cardId: copy.cardId, finish: copy.finish, delta: 1 })}
                      className={stepButton}
                    >
                      +
                    </button>
                  </span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function printingLabel(p: Printing): string {
  return `${p.setCode.toUpperCase()} · ${p.setName} #${p.collectorNumber} (${p.releasedAt.slice(0, 4)})`
}

/** Printing picker (starting at the printing on screen) and finish picker (spec §5.2.5 "Add a copy"). */
export function AddCopy({ card, printings }: { card: Card; printings: Printing[] }) {
  const [printingId, setPrintingId] = useState(card.id)
  const printing = printings.find((p) => p.id === printingId) ?? printings[0]
  const finishes = printing?.finishes ?? []
  const [finish, setFinish] = useState<Finish>(finishes[0] ?? 'nonfoil')
  const chosenFinish = finishes.includes(finish) ? finish : (finishes[0] ?? 'nonfoil')
  const adjust = useAdjustCopies()
  const toast = useToast()
  const headingId = useId()
  if (!printing) return null

  function add() {
    if (!printing) return
    const what = `${card.name} (${printing.setCode.toUpperCase()} #${printing.collectorNumber}${chosenFinish === 'nonfoil' ? '' : `, ${chosenFinish}`})`
    // Through the returned promise rather than mutate's onSuccess, which is dropped when the drawer closes first.
    // A failure has its toast from useAdjustCopies.
    adjust
      .mutateAsync({ cardId: printing.id, finish: chosenFinish, delta: 1 })
      .then((result) => toast.success(`Added ${what}. You have ${result.quantity}.`))
      .catch(() => {})
  }

  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className={sectionHeading}>
        Add a copy
      </h3>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Printing"
          value={printing.id}
          onChange={(e) => setPrintingId(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-stone-700 bg-stone-900 px-2 py-1.5 text-sm text-stone-100 pointer-coarse:py-2.5"
        >
          {printings.map((p) => (
            <option key={p.id} value={p.id}>
              {printingLabel(p)}
            </option>
          ))}
        </select>
        <select
          aria-label="Finish"
          value={chosenFinish}
          onChange={(e) => setFinish(e.target.value as Finish)}
          className="rounded-md border border-stone-700 bg-stone-900 px-2 py-1.5 text-sm text-stone-100 pointer-coarse:py-2.5"
        >
          {finishes.map((f) => (
            <option key={f} value={f}>
              {FINISH_LABEL[f]}
            </option>
          ))}
        </select>
        <button
          onClick={add}
          disabled={adjust.isPending}
          className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-stone-950 hover:bg-amber-400 disabled:opacity-50 pointer-coarse:py-2.5"
        >
          Add copy
        </button>
      </div>
    </section>
  )
}
