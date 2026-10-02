import { useEffect, useRef, useState } from 'react'
import { KEEP } from '../../../shared/playtest/game.ts'
import type { Action, GameState } from '../../../shared/playtest/types.ts'
import { boardKey, CARD_RATIO } from '../../lib/playtest-board.ts'
import type { SaveStatus } from '../../lib/playtest-save.ts'
import { GO_TO_MS, isTypingTarget } from '../../lib/shortcuts.ts'
import { CardView } from './CardView.tsx'
import { useElementSize } from './Table.tsx'

/**
 * An opening hand, by my playgroup's rule (spec §5.9.2): the seat choosing drew 10 and picks 3 to put on the bottom.
 * Clicking a card marks it (1, 2, 3); clicking it again unmarks it. The first card marked ends up at the very bottom.
 * The parent keys this by the hand, so a new hand starts with nothing marked.
 */
export function MulliganView({
  game,
  play,
  undo,
  canUndo,
  saveStatus,
}: {
  game: GameState
  play: (action: Action) => boolean
  undo: () => void
  canUndo: boolean
  saveStatus: SaveStatus
}) {
  const seat = game.choosing
  const s = game.seats[seat]!
  const [marked, setMarked] = useState<string[]>([])
  const need = Math.max(0, s.hand.length - KEEP)
  const left = need - marked.length
  const second = game.seats.length === 2 && seat !== game.startingSeat
  // A card is 260 px tall, or, three to a row on a phone, as tall as a third of the row (less its gaps) allows.
  const handRef = useRef<HTMLUListElement>(null)
  const handWidth = useElementSize(handRef)?.width ?? Infinity
  const height = Math.min(260, Math.floor(((handWidth - 16) / 3) * CARD_RATIO))

  // The undo key (Cmd+Z on a Mac, Ctrl+Z elsewhere: undoKeyLabel) reaches back through the mulligans too (spec §5.9.7),
  // with the Board's guards: not while a field, a dialog, or a menu has the keys, nor right after `g`. Only undo does
  // anything here. When `g` was last pressed; never, to start.
  const lastG = useRef(-Infinity)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const now = performance.now()
      if (e.key === 'g' && !e.metaKey && !e.ctrlKey && !e.altKey) lastG.current = now
      if (isTypingTarget(e.target as HTMLElement) || document.querySelector('[aria-modal="true"], [role="menu"]')) return
      if (boardKey(e, e.key !== 'g' && now - lastG.current <= GO_TO_MS) !== 'undo' || !canUndo) return
      e.preventDefault()
      undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, canUndo])

  return (
    <div className="relative mx-auto flex max-w-6xl flex-col gap-4 py-4">
      {saveStatus === 'retrying' && (
        <p role="alert" className="absolute top-1 left-1/2 z-50 -translate-x-1/2 rounded-md bg-red-800 px-3 py-1 text-sm text-red-50 shadow-lg">
          Couldn't save — retrying
        </p>
      )}
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:gap-6">
        <div>
          <h1 className="font-serif text-3xl text-amber-400">{s.name}</h1>
          <p className="mt-1 text-stone-300">
            {second ? 'Goes second. ' : game.seats.length === 2 ? 'Goes first. ' : ''}
            Drew {s.hand.length}. Pick {need} to put on the bottom.
          </p>
          <p className="text-sm text-stone-500">Mulligans so far: {game.mulligans}</p>
        </div>
        {s.command.length > 0 && (
          <div className="flex gap-2">
            {s.command.map((id) => (
              <figure key={id} className="flex flex-col items-center gap-1">
                <CardView data={game.data[id]!} height={120} />
                <figcaption className="text-xs text-stone-500">Command zone</figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>

      {/* On a phone, three cards to a row, as large as fit; from sm up, as many 260 px cards as fit. */}
      <ul ref={handRef} aria-label="Opening hand" className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:gap-3">
        {s.hand.map((id) => {
          const at = marked.indexOf(id)
          return (
            <li key={id}>
              <button
                aria-pressed={at >= 0}
                aria-label={at >= 0 ? `${game.data[id]!.name}, to the bottom (${at + 1})` : game.data[id]!.name}
                onClick={() => {
                  if (at >= 0) setMarked(marked.filter((m) => m !== id))
                  else if (left > 0) setMarked([...marked, id])
                }}
                className={`relative rounded-lg transition ${at >= 0 ? 'opacity-45 ring-2 ring-amber-500 ring-offset-2 ring-offset-stone-950' : 'hover:-translate-y-1'}`}
              >
                <CardView data={game.data[id]!} height={height} />
                {at >= 0 && (
                  <span className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full bg-amber-500 text-sm font-bold text-stone-950">
                    {at + 1}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>

      {/* Below lg, where the hand runs past the window's bottom, Keep and Mulligan stay in view under it. */}
      <div className="flex flex-wrap items-center gap-3 max-lg:sticky max-lg:bottom-0 max-lg:z-10 max-lg:-mx-3 max-lg:border-t max-lg:border-stone-800 max-lg:bg-stone-950/95 max-lg:px-3 max-lg:py-2">
        <button
          disabled={left !== 0}
          onClick={() => play({ type: 'keep', seat, bottom: marked })}
          className="rounded-md border border-amber-600 bg-amber-700 px-4 py-2 font-medium text-white hover:bg-amber-600 disabled:opacity-40"
        >
          Keep {s.hand.length - need}
        </button>
        <button onClick={() => play({ type: 'mulligan', seat })} className="rounded-md border border-stone-700 bg-stone-800 px-4 py-2 text-stone-100 hover:bg-stone-700">
          Mulligan
        </button>
        {canUndo && (
          <button onClick={undo} className="rounded-md px-3 py-2 text-sm text-stone-400 hover:bg-stone-800 hover:text-stone-100">
            Undo
          </button>
        )}
        <span className="text-sm text-stone-400" aria-live="polite">
          {left > 0 ? `Pick ${left} more` : ''}
        </span>
      </div>
      <p className="text-xs text-stone-500">
        The first card picked ends up at the very bottom. A mulligan shuffles all {s.hand.length} back and draws {s.hand.length} again, as many
        times as you like.
      </p>
    </div>
  )
}
