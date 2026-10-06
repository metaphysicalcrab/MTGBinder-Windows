import { useEffect, useMemo, useRef } from 'react'
import { gameLog } from '../../../shared/playtest/log.ts'
import { commanderTax, faceOf, visibleTo } from '../../../shared/playtest/status.ts'
import type { Action, SeatIndex } from '../../../shared/playtest/types.ts'
import { CARD_RATIO, previewHeight } from '../../lib/playtest-board.ts'
import { hoverOn, useBoard } from './board-context.ts'
import { CardView } from './CardView.tsx'

/** The playtest's panels: a graveyard or exile to drag from, the log, and the large preview of a card. */

/** A panel over the table: at its right, and the width of a narrow screen, less a margin. */
const PANEL = 'fixed inset-x-2 top-24 z-40 flex flex-col rounded-xl border border-stone-700 bg-stone-950/95 shadow-2xl sm:inset-x-auto sm:right-4 sm:w-96'
const CLOSE = 'rounded px-2 text-sm text-stone-400 hover:bg-stone-800 hover:text-stone-100 pointer-coarse:min-h-10 pointer-coarse:px-3'

/** A seat's graveyard or exile (spec §5.9.4), top card first; its cards drag out like any other. */
export function PilePanel({ seat, zone, onClose }: { seat: SeatIndex; zone: 'graveyard' | 'exile'; onClose: () => void }) {
  const board = useBoard()
  const ids = [...board.game.seats[seat]![zone]].reverse()
  const name = board.game.seats[seat]!.name
  return (
    <section aria-label={`${name}'s ${zone}`} data-drop="none" className={`${PANEL} max-h-[70dvh]`}>
      <header className="flex items-center justify-between border-b border-stone-800 px-3 py-2">
        <h2 className="truncate text-sm text-stone-200">
          {name}'s {zone} ({ids.length})
        </h2>
        <button onClick={onClose} className={CLOSE}>
          Close ✕
        </button>
      </header>
      {ids.length === 0 ? (
        <p className="p-4 text-sm text-stone-500">Nothing here yet.</p>
      ) : (
        <ul className="grid grid-cols-3 gap-2 overflow-y-auto overscroll-contain p-3">
          {ids.map((id) => (
            // A finger swiping up or down scrolls the list; one moving sideways drags the card out.
            <li
              key={id}
              data-card={id}
              onPointerDown={(e) => board.beginCardDrag(e, id, 'pile')}
              onContextMenu={(e) => board.openCardMenu(e, id)}
              {...hoverOn(board, id)}
              className="cursor-grab touch-pan-y"
            >
              <CardView data={board.game.data[id]!} height={150} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** The log (spec §5.9.6): each action in words, as the seat viewed would know it, grouped by turn, newest at the bottom. */
export function LogPanel({ actions, onClose }: { actions: readonly Action[]; onClose: () => void }) {
  const board = useBoard()
  const entries = useMemo(() => gameLog(board.setup, actions), [board.setup, actions])
  const end = useRef<HTMLLIElement>(null)
  // A block, not an arrow's value: scrollIntoView returns a promise in newer browsers, which React would call on unmount.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [entries.length])
  const turns: Array<{ turn: number; lines: string[] }> = []
  for (const entry of entries) {
    if (entry.text === null) continue
    const line = entry.text[board.viewer]
    if (turns.at(-1)?.turn === entry.turn) turns.at(-1)!.lines.push(line)
    else turns.push({ turn: entry.turn, lines: [line] })
  }
  return (
    <section aria-label="Log" data-drop="none" className={`${PANEL} bottom-4`}>
      <header className="flex items-center justify-between border-b border-stone-800 px-3 py-2">
        <h2 className="text-sm text-stone-200">Log, as {board.game.seats[board.viewer]!.name} sees it</h2>
        <button onClick={onClose} className={CLOSE}>
          Close ✕
        </button>
      </header>
      <ol className="flex-1 overflow-y-auto overscroll-contain px-3 py-2 text-sm">
        {turns.map((group, i) => (
          <li key={i} className="mb-2">
            <h3 className="text-xs font-semibold tracking-wide text-amber-500/80 uppercase">{group.turn === 0 ? 'Mulligans' : `Turn ${group.turn}`}</h3>
            <ul className="text-stone-300">
              {group.lines.map((line, j) => (
                <li key={j}>{line}</li>
              ))}
            </ul>
          </li>
        ))}
        {turns.length === 0 && <li className="text-stone-500">Nothing yet.</li>}
        <li ref={end} />
      </ol>
    </section>
  )
}

/**
 * A large view of the card under the pointer (spec §5.9.3), on the side of the window away from it: the face showing,
 * its counters, and a commander's tax. Only for a card the seat viewed can see.
 */
export function Preview({ id, pointerX }: { id: string; pointerX: number }) {
  const left = pointerX > window.innerWidth / 2
  return <PreviewBox id={id} className={`fixed top-20 z-40 ${left ? 'left-4' : 'right-4'}`} />
}

/**
 * The large view of a card from its menu's View card (M13), for a finger, which has no hover: the preview, in the middle
 * of the window, until a tap anywhere, Escape, or Back.
 */
export function CardViewer({ id, onClose }: { id: string; onClose: () => void }) {
  const board = useBoard()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div role="dialog" aria-modal="true" aria-label={board.game.data[id]!.name} className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/70" />
      <PreviewBox id={id} className="relative" />
    </div>
  )
}

/** The large view's box: the card, then its name, its counters, and a commander's tax. */
function PreviewBox({ id, className }: { id: string; className: string }) {
  const board = useBoard()
  const card = board.game.cards[id]
  if (!card || !visibleTo(card, board.viewer)) return null
  const face = faceOf(board.game, card)
  const counters = Object.entries(card.counters)
  const height = previewHeight(window.innerHeight)
  return (
    <div
      aria-hidden
      // The card's width, and the padding (p-2) on each side.
      style={{ width: Math.ceil(height / CARD_RATIO) + 16 }}
      className={`pointer-events-none flex flex-col gap-2 rounded-xl bg-stone-950/90 p-2 shadow-2xl ${className}`}
    >
      <CardView data={board.game.data[id]!} card={{ ...card, counters: {}, tapped: false }} height={height} large />
      <div className="px-1 text-sm text-stone-300">
        <div className="font-semibold text-stone-100">{face.name}</div>
        {card.faceDown && <div className="text-stone-400">Face down</div>}
        {counters.length > 0 && <div>Counters: {counters.map(([k, v]) => `${v} ${k}`).join(', ')}</div>}
        {card.commander && <div>Commander tax: +{commanderTax(board.game, id)}</div>}
      </div>
    </div>
  )
}
