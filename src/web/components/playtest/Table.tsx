import { useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react'
import { attachmentsOf, commanderTax, looseCards, losingReasons, visibleTo } from '../../../shared/playtest/status.ts'
import type { CardState, SeatIndex } from '../../../shared/playtest/types.ts'
import { undoKeyLabel } from '../../lib/platform.ts'
import { CARD_RATIO, commandStep, handHeight, toScreen, type Box } from '../../lib/playtest-board.ts'
import type { SaveStatus } from '../../lib/playtest-save.ts'
import { hoverOn, useBoard } from './board-context.ts'
import { CardBack, CardView } from './CardView.tsx'

/** The table's parts (spec §5.9.3): each half's battlefield and side block, the hands, and the turn bar. */

/** An element's size, kept up to date as the window resizes. */
export function useElementSize(ref: RefObject<HTMLElement | null>): Box | null {
  const [size, setSize] = useState<Box | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return size
}

/** One seat's battlefield. The seat not being viewed is drawn flipped, its edge at the top. */
export function Battlefield({ seat, fieldRef }: { seat: SeatIndex; fieldRef?: RefObject<HTMLDivElement | null> }) {
  const board = useBoard()
  const own = useRef<HTMLDivElement>(null)
  const ref = fieldRef ?? own
  const size = useElementSize(ref)
  const flipped = seat !== board.viewer
  // `isolate`: the cards' z-indexes (10 for each card drawn over another) stay inside the half, under the menu and
  // its backdrop, the dialogs, the panels, and the preview drawn over the table.
  return (
    <div
      ref={ref}
      data-drop={`battlefield-${seat}`}
      aria-label={`${board.game.seats[seat]!.name}'s battlefield`}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && e.button === 0) board.beginBoxSelect(e, seat)
      }}
      onContextMenu={(e) => {
        if (e.target === e.currentTarget) board.openFieldMenu(e, seat)
      }}
      className={`relative isolate min-h-0 flex-1 touch-none overflow-hidden rounded-lg border border-stone-800 bg-stone-900/40 ${board.attaching ? 'cursor-crosshair' : ''}`}
    >
      {size &&
        looseCards(board.game, seat).map((card, i) => <FieldCard key={card.id} card={card} layer={i} size={size} flipped={flipped} />)}
    </div>
  )
}

/** A card at its spot, with the cards attached to it tucked behind, peeking out toward the middle of the table. */
function FieldCard({ card, layer, size, flipped }: { card: CardState; layer: number; size: Box; flipped: boolean }) {
  const board = useBoard()
  const height = board.cardHeight
  const width = height / CARD_RATIO
  const { x, y } = toScreen(card.pos!, size, flipped)
  const tucked = attachmentsOf(board.game, card)
  const peek = height * 0.22 * (flipped ? 1 : -1)
  return (
    <>
      {tucked.map((a, i) => (
        <Placed key={a.id} card={a} left={x - width / 2} top={y - height / 2 + peek * (tucked.length - i)} z={layer * 10 + i} />
      ))}
      <Placed card={card} left={x - width / 2} top={y - height / 2} z={layer * 10 + 9} />
    </>
  )
}

function Placed({ card, left, top, z }: { card: CardState; left: number; top: number; z: number }) {
  const board = useBoard()
  return (
    <div
      data-card={card.id}
      style={{ left, top, zIndex: z, transform: card.tapped ? 'rotate(90deg)' : undefined }}
      onPointerDown={(e) => board.beginCardDrag(e, card.id, 'battlefield')}
      onContextMenu={(e) => board.openCardMenu(e, card.id)}
      {...hoverOn(board, card.id)}
      className="absolute cursor-grab touch-none transition-transform duration-150"
    >
      <CardView
        data={board.game.data[card.id]!}
        card={card}
        height={board.cardHeight}
        hidden={!visibleTo(card, board.viewer)}
        selected={board.selection.has(card.id)}
      />
    </div>
  )
}

/** The hand of the seat being viewed, face up; the other's is card backs and a count. */
export function HandStrip({ seat }: { seat: SeatIndex }) {
  const board = useBoard()
  const ref = useRef<HTMLDivElement>(null)
  const size = useElementSize(ref)
  const hand = board.game.seats[seat]!.hand
  if (seat !== board.viewer) {
    return (
      <div data-drop={`hand-${seat}`} aria-label={`${board.game.seats[seat]!.name}'s hand`} className="flex h-9 shrink-0 items-center justify-center">
        {hand.slice(0, 15).map((id, i) => (
          <CardBack key={id} height={34} className={i > 0 ? '-ml-4' : ''} />
        ))}
        <span className="ml-3 text-xs text-stone-500">{hand.length === 1 ? '1 card in hand' : `${hand.length} cards in hand`}</span>
      </div>
    )
  }
  const height = handHeight(board.cardHeight)
  const width = height / CARD_RATIO
  // Cards overlap once the hand is wider than the strip.
  const room = (size?.width ?? 0) - width
  const step = hand.length > 1 ? Math.min(width + 6, room / (hand.length - 1)) : 0
  return (
    <div
      ref={ref}
      data-drop={`hand-${seat}`}
      aria-label="Your hand"
      style={{ height: height + 10 }}
      className="relative flex shrink-0 justify-center"
    >
      {hand.length === 0 && <p className="self-center text-xs text-stone-600">No cards in hand</p>}
      {hand.map((id, i) => (
        <div
          key={id}
          data-card={id}
          style={{ marginLeft: i === 0 ? 0 : step - width }}
          onPointerDown={(e) => board.beginCardDrag(e, id, 'hand')}
          onDoubleClick={() => board.doubleClickCard(id)}
          onContextMenu={(e) => board.openCardMenu(e, id)}
          {...hoverOn(board, id)}
          className="cursor-grab touch-none pt-2 transition-transform hover:-translate-y-2"
        >
          <CardView data={board.game.data[id]!} height={height} />
        </div>
      ))}
    </div>
  )
}

/** A tally's − and +: a finger's are 36 px. */
const TALLY_STEP = 'size-6 rounded border border-stone-700 text-stone-300 hover:bg-stone-800 pointer-coarse:size-9'

/** A number with − and + (each a step of 1); clicking the number lets me type a new one. */
function Tally({ label, value, big = false, onChange }: { label: string; value: number; big?: boolean; onChange: (delta: number) => void }) {
  const { coarse } = useBoard()
  const [editing, setEditing] = useState<string | null>(null)
  const commit = () => {
    const next = Number(editing)
    if (editing !== null && editing.trim() !== '' && Number.isInteger(next) && next !== value) onChange(next - value)
    setEditing(null)
  }
  return (
    <div className="flex items-center justify-between gap-1">
      <span title={label} className={`min-w-0 truncate ${big ? 'text-stone-300' : 'text-xs text-stone-400'}`}>
        {label}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <button aria-label={`${label}: one less`} onClick={() => onChange(-1)} className={TALLY_STEP}>
          −
        </button>
        {editing === null ? (
          <button
            aria-label={`${label}: ${value}. ${coarse ? 'Tap' : 'Click'} to type a number`}
            onClick={() => setEditing(String(value))}
            className={`min-w-9 rounded text-center tabular-nums hover:bg-stone-800 pointer-coarse:min-h-9 ${big ? 'text-2xl leading-7 font-bold text-stone-50' : 'text-sm text-stone-100'}`}
          >
            {value}
          </button>
        ) : (
          <input
            autoFocus
            aria-label={label}
            inputMode="numeric"
            enterKeyHint="done"
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') setEditing(null)
            }}
            className="w-12 rounded border border-stone-600 bg-stone-950 px-1 text-center text-stone-50"
          />
        )}
        <button aria-label={`${label}: one more`} onClick={() => onChange(1)} className={TALLY_STEP}>
          +
        </button>
      </div>
    </div>
  )
}

/** A seat's name, life, poison, commander damage taken, and its piles: library, graveyard, exile, command zone. */
export function SideBlock({ seat }: { seat: SeatIndex }) {
  const board = useBoard()
  const { game, play } = board
  const s = game.seats[seat]!
  const enemy = game.seats.length === 2 ? (seat === 0 ? 1 : 0) : null
  const enemyCommanders = enemy === null ? [] : Object.values(game.cards).filter((c) => c.commander && c.owner === enemy)
  const reasons = losingReasons(s)
  // Four piles in a row fit the block's width up to 64 px tall.
  const pile = Math.min(64, Math.max(48, Math.round(board.cardHeight * 0.6)))
  return (
    <aside
      aria-label={`${s.name}, seat ${seat + 1}`}
      className="flex w-60 shrink-0 flex-col gap-1.5 overflow-y-auto rounded-lg border border-stone-800 bg-stone-900/60 p-2 text-sm"
    >
      <div className="flex items-center gap-2">
        {game.active === seat && <span aria-label="Their turn" className="size-2 shrink-0 rounded-full bg-amber-400" />}
        <span className="truncate font-serif text-base text-amber-400" title={s.name}>
          {s.name}
        </span>
      </div>
      {reasons.length > 0 && (
        <p role="status" className="rounded bg-red-900/70 px-2 py-0.5 text-xs text-red-100">
          Would lose: {reasons.join(', ')}
        </p>
      )}
      <Tally label="Life" value={s.life} big onChange={(delta) => play({ type: 'life', seat, delta })} />
      <Tally label="Poison" value={s.poison} onChange={(delta) => play({ type: 'poison', seat, delta })} />
      {enemyCommanders.map((c) => (
        <Tally
          key={c.id}
          label={`From ${game.data[c.id]!.name}`}
          value={s.commanderDamage[c.id] ?? 0}
          onChange={(delta) => play({ type: 'commanderDamage', seat, commander: c.id, delta })}
        />
      ))}
      <div className="flex items-end gap-2">
        <Library seat={seat} height={pile} />
        <PublicPile seat={seat} zone="graveyard" label="Grave" height={pile} />
        <PublicPile seat={seat} zone="exile" label="Exile" height={pile} />
        <CommandZone seat={seat} height={pile} />
      </div>
    </aside>
  )
}

/**
 * A seat's library: a click draws, and a right-click (a finger: holding it, or its ⋯) opens the rest (spec §5.9.4).
 */
function Library({ seat, height }: { seat: SeatIndex; height: number }) {
  const board = useBoard()
  const count = board.game.seats[seat]!.library.length
  return (
    <div className="relative flex shrink-0">
      <button
        data-drop={`library-${seat}`}
        aria-label={`Library, ${count === 1 ? '1 card' : `${count} cards`}. ${board.coarse ? 'Tap to draw; press and hold for more' : 'Click to draw; right-click for more'}`}
        title={board.coarse ? 'Tap to draw a card; press and hold for more' : 'Click to draw a card; right-click for more'}
        onClick={() => board.play({ type: 'draw', seat, count: 1 })}
        onPointerDown={(e) => board.beginHold(e, { library: seat })}
        onContextMenu={(e) => board.openLibraryMenu(e, seat)}
        className="flex shrink-0 flex-col items-center gap-0.5 text-[11px] whitespace-nowrap text-stone-400"
      >
        {count > 0 ? <CardBack height={height} /> : <EmptyPile height={height} />}
        <span>Library {count}</span>
      </button>
      {/* The menu in reach of a finger that doesn't know to hold: a small button, its target bigger than it looks. */}
      {board.coarse && (
        <button
          aria-label="More: draw several, look, search, mill, reveal, shuffle"
          onClick={(e) => board.openLibraryMenu(e, seat)}
          className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full border border-stone-600 bg-stone-800 text-sm leading-none text-stone-100 shadow before:absolute before:-inset-2"
        >
          ⋯
        </button>
      )}
    </div>
  )
}

function PublicPile({ seat, zone, label, height }: { seat: SeatIndex; zone: 'graveyard' | 'exile'; label: string; height: number }) {
  const board = useBoard()
  const cards = board.game.seats[seat]![zone]
  const top = cards.at(-1)
  return (
    <button
      data-drop={`${zone}-${seat}`}
      aria-label={`${zone === 'graveyard' ? 'Graveyard' : 'Exile'}, ${cards.length === 1 ? '1 card' : `${cards.length} cards`}. ${board.coarse ? 'Tap' : 'Click'} to see them`}
      onClick={() => board.openPile(seat, zone)}
      {...hoverOn(board, top)}
      className="flex shrink-0 flex-col items-center gap-0.5 text-[11px] whitespace-nowrap text-stone-400"
    >
      {top ? <CardView data={board.game.data[top]!} height={height} /> : <EmptyPile height={height} />}
      <span>
        {label} {cards.length}
      </span>
    </button>
  )
}

function EmptyPile({ height }: { height: number }) {
  return <div style={{ height, width: height / CARD_RATIO }} className="rounded-[6%] border border-dashed border-stone-700" />
}

/**
 * The command zone: its cards (commanders and emblems), and each commander's tax under them. It takes the room the
 * row's other piles leave. Its cards sit side by side while they fit there, else overlap just enough to fit
 * (commandStep), each drawn over the one before, so every earlier card shows its left edge, where its name is.
 */
function CommandZone({ seat, height }: { seat: SeatIndex; height: number }) {
  const board = useBoard()
  const ref = useRef<HTMLDivElement>(null)
  // The zone's width comes from the row (flex-1), not from its cards, so measuring it can't feed back into it.
  const room = useElementSize(ref)?.width ?? Infinity
  const ids = board.game.seats[seat]!.command
  const width = height / CARD_RATIO
  const step = commandStep(width, ids.length, room)
  const owned = Object.values(board.game.cards).filter((c) => c.commander && c.owner === seat)
  const taxes = owned.map((c) => `${board.game.data[c.id]!.name}: tax +${commanderTax(board.game, c.id)}`)
  // A grid of one column, as wide as its cards or its label (no wider than the zone): both centered in it, at the
  // zone's left, as they sat before the zone took the row's room.
  return (
    <div
      ref={ref}
      data-drop={`command-${seat}`}
      aria-label="Command zone"
      className="grid min-w-0 flex-1 grid-cols-[minmax(0,max-content)] justify-items-center gap-0.5 text-[11px] text-stone-400"
    >
      <div className="flex">
        {ids.map((id, i) => (
          <div
            key={id}
            data-card={id}
            style={i > 0 ? { marginLeft: step - width } : undefined}
            onPointerDown={(e) => board.beginCardDrag(e, id, 'command')}
            onDoubleClick={() => board.doubleClickCard(id)}
            onContextMenu={(e) => board.openCardMenu(e, id)}
            {...hoverOn(board, id)}
            className="cursor-grab touch-none"
          >
            <CardView data={board.game.data[id]!} height={height} />
          </div>
        ))}
        {ids.length === 0 && <EmptyPile height={height} />}
      </div>
      <span title={taxes.join('\n')} className="max-w-full truncate">
        {owned.length === 0 ? 'Command' : `Tax ${owned.map((c) => `+${commanderTax(board.game, c.id)}`).join(' / ')}`}
      </span>
    </div>
  )
}

/**
 * The bar between the halves: the turn, the stack when something's on it, and the game's buttons. With a finger, Select
 * makes a tap select cards (a finger has no Shift), and Clear clears them (it has no Escape); below lg, its Log, Switch
 * side and End game wait behind a ⋯ (onMore). A mouse's bar keeps them at every width, as it always has.
 */
export function TurnBar({
  saveStatus,
  canUndo,
  canSwitch,
  selecting,
  onSelecting,
  onClear,
  onUndo,
  onLog,
  onSwitch,
  onEnd,
  onMore,
  onNextTurn,
}: {
  saveStatus: SaveStatus
  canUndo: boolean
  canSwitch: boolean
  selecting: boolean
  onSelecting: (on: boolean) => void
  onClear: () => void
  onUndo: () => void
  onLog: () => void
  onSwitch: () => void
  onEnd: () => void
  onMore: (e: MouseEvent) => void
  onNextTurn: () => void
}) {
  const board = useBoard()
  const { game } = board
  return (
    <div
      data-drop="stack"
      className="flex shrink-0 items-center gap-3 rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 text-sm"
    >
      {/* The deck's name gives way first when the bar is short of room. */}
      <div className="flex min-w-0 items-baseline">
        <span className="shrink-0 font-semibold text-amber-400">Turn {game.turn}</span>
        <span className="truncate text-stone-300">&nbsp;· {game.seats[game.active]!.name}</span>
      </div>
      <Stack />
      <span className="shrink-0 text-xs text-stone-500" aria-live="polite">
        {saveStatus === 'saving' ? 'Saving…' : ''}
      </span>
      <div className="flex shrink-0 gap-1.5">
        {board.coarse && (
          <>
            <BarButton
              pressed={selecting}
              onClick={() => onSelecting(!selecting)}
              title={selecting ? 'Tapping a card selects it, or takes it out of the selection' : 'Select cards by tapping them'}
            >
              Select
            </BarButton>
            {board.selection.size > 0 && <BarButton onClick={onClear}>{`Clear ${board.selection.size}`}</BarButton>}
          </>
        )}
        <BarButton onClick={onUndo} disabled={!canUndo} title={`Undo (${undoKeyLabel})`}>
          Undo
        </BarButton>
        <div className="hidden gap-1.5 lg:flex pointer-fine:flex">
          <BarButton onClick={onLog}>Log</BarButton>
          <BarButton onClick={onSwitch} disabled={!canSwitch} title="Switch side (Tab)">
            Switch side
          </BarButton>
          <BarButton onClick={onEnd}>End game</BarButton>
        </div>
        <BarButton onClick={onMore} label="More: Log, Switch side, End game" className="lg:hidden pointer-fine:hidden">
          ⋯
        </BarButton>
        <button
          onClick={onNextTurn}
          className="rounded-md border border-amber-600 bg-amber-700 px-3 py-1 font-medium text-white hover:bg-amber-600 pointer-coarse:py-2"
        >
          Next turn
        </button>
      </div>
    </div>
  )
}

function BarButton({
  children,
  onClick,
  disabled,
  title,
  label,
  pressed,
  className = '',
}: {
  children: string
  onClick: (e: MouseEvent) => void
  disabled?: boolean
  title?: string
  label?: string
  /** A toggle's state (Select). */
  pressed?: boolean
  className?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      aria-pressed={pressed}
      className={`rounded-md border border-stone-700 bg-stone-800 px-2.5 py-1 text-stone-200 hover:bg-stone-700 disabled:opacity-40 disabled:hover:bg-stone-800 aria-pressed:border-amber-500 aria-pressed:bg-amber-900/60 aria-pressed:text-amber-100 pointer-coarse:py-2 ${className}`}
    >
      {children}
    </button>
  )
}

/**
 * What's on the stack, oldest on the left: spells as cards, abilities as tags naming their card. A double-click resolves
 * an item; a finger's tap opens its menu, Resolve first. A finger swiping sideways scrolls the strip to the newest; one
 * moving up or down drags a spell off it.
 */
function Stack() {
  const board = useBoard()
  const { game } = board
  if (game.stack.length === 0) return <div className="flex-1" />
  return (
    <ol aria-label="The stack" className="flex min-w-0 flex-1 touch-pan-x items-center gap-2 overflow-x-auto">
      <li className="shrink-0 text-xs text-stone-500">Stack:</li>
      {game.stack.map((item, i) => (
        <li
          key={item.id}
          data-card={item.kind === 'spell' ? item.id : undefined}
          title={board.coarse ? 'Tap for Resolve and more' : 'Double-click to resolve; right-click for more'}
          onDoubleClick={() => {
            // Resolving takes this item from under the pointer. An ability's hover is its source, which stays where it
            // is, so the Board can't tell the hover has ended: end it here.
            board.setHovered(null)
            board.play({ type: 'resolve', item: item.id })
          }}
          onContextMenu={(e) => board.openStackMenu(e, item.id)}
          onPointerDown={(e) => (item.kind === 'spell' ? board.beginCardDrag(e, item.id, 'stack') : board.beginHold(e, { item: item.id }))}
          {...hoverOn(board, item.kind === 'spell' ? item.id : item.source)}
          className={`shrink-0 touch-pan-x ${i === game.stack.length - 1 ? 'ring-2 ring-amber-500/70' : ''} rounded`}
        >
          {item.kind === 'spell' ? (
            <CardView data={game.data[item.id]!} height={52} />
          ) : (
            <span className="block rounded bg-stone-700 px-2 py-1 text-xs text-stone-100">{item.name}: ability</span>
          )}
        </li>
      ))}
    </ol>
  )
}
