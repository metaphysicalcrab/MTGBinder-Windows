import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type PointerEvent } from 'react'
import { list } from '../../../shared/playtest/log.ts'
import { canFlip, looseCards, visibleTo } from '../../../shared/playtest/status.ts'
import type { Action, CardData, CardState, Dest, GameState, SavedGame, SeatIndex } from '../../../shared/playtest/types.ts'
import { useBackToClose } from '../../lib/back-to-close.ts'
import { useDecks } from '../../lib/decks.ts'
import { useCoarsePointer } from '../../lib/platform.ts'
import { useEndGame, useStartGame, type GameSession } from '../../lib/playtest.ts'
import {
  asksCommandZone,
  boardKey,
  cardHeight,
  cardsInBox,
  counterChoices,
  fromScreen,
  holdOpensMenu,
  isTouch,
  LONG_PRESS_MS,
  menuCounters,
  movedFar,
  playDest,
  steadyCardHeight,
  tapAction,
  tapTo,
  tokenLabel,
  type Press,
} from '../../lib/playtest-board.ts'
import { GO_TO_MS, isTypingTarget } from '../../lib/shortcuts.ts'
import { BoardContext, type BoardApi, type DragSource, type HoldTarget } from './board-context.ts'
import { CardView } from './CardView.tsx'
import { CommandZoneDialog, CountDialog, CounterDialog, EndGameDialog, LookDialog, SearchDialog, TokenDialog } from './dialogs.tsx'
import { ContextMenu, type MenuItem, type MenuState } from './Menu.tsx'
import { CardViewer, LogPanel, PilePanel, Preview } from './panels.tsx'
import { Battlefield, HandStrip, SideBlock, TurnBar, useElementSize } from './Table.tsx'

type Point = { x: number; y: number }

/** Where a menu opens, and whether a finger's press opened it (a tap or a hold), not a right-click or a ⋯. */
type MenuAt = Point & { byFinger: boolean }

/**
 * A press in progress, from the pointer going down (spec §5.9.4): cards that follow it once it moves, a box being drawn
 * to select cards, or a finger held on a library or an ability on the stack, which does something only when held still.
 * `pointer` is its pointer's id: a second finger on the table while one is down does nothing.
 */
type Drag = Press & { pointer: number; at: Point } & (
    | {
        kind: 'cards'
        /** The card pressed; `ids` are the cards that move with it (the selection it's in). */
        card: string
        ids: string[]
        source: DragSource
        /** Each card's center from the pointer, and its height, when the drag began. */
        offsets: Record<string, { dx: number; dy: number; height: number }>
        shift: boolean
      }
    | { kind: 'box'; seat: SeatIndex; field: DOMRect; shift: boolean }
    | { kind: 'hold'; target: HoldTarget }
  )

type Dialog =
  | { kind: 'count'; title: string; label: string; initial: number; max: number; onSubmit: (n: number) => void }
  | { kind: 'look'; seat: SeatIndex; count: number }
  | { kind: 'search'; seat: SeatIndex }
  | { kind: 'counters'; ids: string[] }
  | { kind: 'token'; seat: SeatIndex }
  | { kind: 'commander'; ids: string[]; commanders: string[]; to: Dest }
  | { kind: 'end' }

const other = (seat: SeatIndex): SeatIndex => (seat === 0 ? 1 : 0)

const PLACE_LABEL: Record<string, string> = {
  hand: 'Hand',
  graveyard: 'Graveyard',
  exile: 'Exile',
  library: 'Library',
}

/** The element to drop on under the pointer: the nearest one marked `data-drop` (a panel's is "none"). */
function dropTarget(x: number, y: number): HTMLElement | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const target = (el as HTMLElement).closest<HTMLElement>('[data-drop]')
    if (target) return target
  }
  return null
}

/** A card's name as the seat viewed knows it: a face-down card it can't see stays unnamed. */
function nameFor(game: GameState, id: string, viewer: SeatIndex): string {
  const card = game.cards[id]
  return card === undefined || visibleTo(card, viewer) ? game.data[id]!.name : 'A face-down card'
}

/**
 * Where a menu opens, from the event that opens it, which does nothing else: at the pointer for a right-click, under
 * the button for a click on one (a ⋯).
 */
function menuEvent(e: MouseEvent): MenuAt {
  e.preventDefault()
  e.stopPropagation()
  if (e.type !== 'click') return { x: e.clientX, y: e.clientY, byFinger: false }
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  return { x: rect.left, y: rect.bottom + 4, byFinger: false }
}

/** A finger's menu for a card it can see: View card after the first item, as a finger has no hover to preview it. */
function withView(items: MenuItem[], view: (() => void) | null): MenuItem[] {
  return view === null ? items : [items[0]!, { label: 'View card', onSelect: view }, ...items.slice(1)]
}

/** The playtest's table (spec §5.9.3–§5.9.6): both halves, the hands, the turn bar, and everything the page opens. */
export function Board({ saved, game, session }: { saved: SavedGame; game: GameState; session: GameSession }) {
  const { play, undo, canUndo, saveStatus } = session
  const setup = saved.setup
  const twoSeats = game.seats.length === 2
  const [viewer, setViewer] = useState<SeatIndex>(game.phase === 'playing' ? game.active : game.choosing)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  // The card under the pointer, and the zone it was in then (see `hovered` below).
  const [hoverAt, setHoverAt] = useState<{ id: string; zone: CardState['zone'] } | null>(null)
  // Where the pointer is across the window, for the preview's side: kept out of state, so moving doesn't re-render.
  const pointerX = useRef(0)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [pile, setPile] = useState<{ seat: SeatIndex; zone: 'graveyard' | 'exile' } | null>(null)
  const [logOpen, setLogOpen] = useState(false)
  const [attaching, setAttaching] = useState<string[] | null>(null)
  // The main pointer is a finger (M13). It has no Shift: Select, in the turn bar, makes a tap add a card to the
  // selection or take it out.
  const coarse = useCoarsePointer()
  const [selecting, setSelecting] = useState(false)
  // The card shown large from its menu's View card (a finger has no hover), until a tap anywhere.
  const [viewing, setViewing] = useState<string | null>(null)
  // The drag follows the pointer in its own layer, so the table doesn't re-render as it moves.
  const [dragStore] = useState(createDragStore)
  const [dragging, setDragging] = useState(false)
  const fieldRef = useRef<HTMLDivElement>(null)
  const field = useElementSize(fieldRef)
  // The height drawn last, kept through a 1-px change (see steadyCardHeight).
  const [drawnHeight, setDrawnHeight] = useState<number | null>(null)
  const height = steadyCardHeight(drawnHeight, cardHeight(field?.height ?? 400))
  if (height !== drawnHeight) setDrawnHeight(height)
  const decks = useDecks()
  const startGame = useStartGame()
  const endGame = useEndGame()

  // Only cards still on the battlefield stay selected.
  const selection = useMemo(() => new Set([...selected].filter((id) => game.cards[id]?.zone === 'battlefield')), [selected, game])

  // Handlers read the latest game and view through this, so they needn't change on every action.
  // (Select's mode only while its button shows: not once a mouse is the main pointer.)
  const latest = useRef({ game, viewer, selection, attaching, selecting: coarse && selecting })
  latest.current = { game, viewer, selection, attaching, selecting: coarse && selecting }

  // The card viewed, while it's still one the seat viewed can see.
  const viewingCard = viewing === null ? undefined : game.cards[viewing]
  const viewed = viewingCard !== undefined && visibleTo(viewingCard, viewer) ? viewing : null

  // A card played, resolved, or moved from under the pointer takes its element with it, and no pointerleave follows:
  // once the card hovered has left the zone it was hovered in, or the game, nothing is hovered.
  if (hoverAt !== null && game.cards[hoverAt.id]?.zone !== hoverAt.zone) setHoverAt(null)
  const hovered = hoverAt?.id ?? null
  const setHovered = useCallback((id: string | null) => {
    const zone = id === null ? undefined : latest.current.game.cards[id]?.zone
    setHoverAt(id === null || zone === undefined ? null : { id, zone })
  }, [])

  const moveCards = useCallback(
    (ids: string[], to: Dest) => {
      const g = latest.current.game
      const commanders = ids.filter((id) => asksCommandZone(g.cards[id]!, to))
      if (commanders.length > 0) setDialog({ kind: 'commander', ids, commanders, to })
      else play({ type: 'move', ids, to })
    },
    [play],
  )

  const playCard = useCallback(
    (id: string) => {
      const g = latest.current.game
      const card = g.cards[id]
      // An emblem isn't played: it stays in the command zone.
      if (!card || g.data[id]!.kind === 'emblem') return
      play({ type: 'move', ids: [id], to: playDest(g.data[id]!.kind, card.owner) })
    },
    [play],
  )

  /** A menu's items for the tokens and emblems a card makes (spec §5.9.8), each made at once for `seat`. */
  const tokenItems = useCallback(
    (data: CardData, seat: SeatIndex): MenuItem[] =>
      (data.tokens ?? []).map((token) => ({
        label: tokenLabel(token),
        image: token.imageSmall,
        onSelect: () => play({ type: 'token', seat, token, count: 1 }),
      })),
    [play],
  )

  /** Taps a card, or the selection it's in: all of them, or untaps them when all are tapped. */
  const tapCards = useCallback(
    (id: string) => {
      const { game: g, selection: sel } = latest.current
      const ids = sel.has(id) ? [...sel] : [id]
      play({ type: 'tap', ids, tapped: tapTo(ids.map((i) => g.cards[i]!)) })
    },
    [play],
  )

  // The press under way, followed from its pointerdown to its pointerup by window listeners (followDrag).
  const dragRef = useRef<Drag | null>(null)
  // A finger held still this long opens a menu (LONG_PRESS_MS).
  const holdTimer = useRef<number | undefined>(undefined)
  // A finger's press has opened a menu: what the browser still makes of it is spent (the effect below).
  const spent = useRef(false)

  /** Ends the press under way, if there is one, without a drop or a tap. */
  const endPress = useCallback(() => {
    window.clearTimeout(holdTimer.current)
    if (dragRef.current === null) return
    dragRef.current = null
    dragStore.set(null)
    setDragging(false)
  }, [dragStore])

  /**
   * Opens a menu, ending the press under way: the finger that held a card for its menu (or the button of a Mac's
   * Control-click) lifts without tapping or dropping it.
   */
  const openMenu = useCallback(
    (at: MenuAt, title: string, items: MenuItem[]) => {
      endPress()
      if (at.byFinger) spent.current = true
      setMenu({ x: at.x, y: at.y, title, items })
    },
    [endPress],
  )

  /** A card's menu (spec §5.9.4). A finger's has View card, as it has no hover for the large preview. */
  const cardMenu = useCallback(
    (at: MenuAt, id: string) => {
      const { game: g, selection: sel, viewer: v } = latest.current
      const card = g.cards[id]
      if (!card) return
      const name = nameFor(g, id, v)
      const ids = card.zone === 'battlefield' && sel.has(id) ? [...sel] : [id]
      const title = ids.length > 1 ? `${ids.length} cards` : name
      const open = (items: MenuItem[]) => openMenu(at, title, withView(items, at.byFinger && visibleTo(card, v) ? () => setViewing(id) : null))
      const moves = (except: string): MenuItem[] =>
        (
          [
            ['hand', 'Put into hand', { zone: 'hand' }],
            ['top', 'Put on top of library', { zone: 'library', at: 'top' }],
            ['bottom', 'Put on the bottom of library', { zone: 'library', at: 'bottom' }],
            ['graveyard', 'Put into graveyard', { zone: 'graveyard' }],
            ['exile', 'Exile', { zone: 'exile' }],
            ['command', 'Put into command zone', { zone: 'command' }],
          ] as Array<[string, string, Dest]>
        )
          .filter(([key]) => key !== except)
          .map(([, label, to]) => ({ label, onSelect: () => moveCards(ids, to) }))
      if (card.zone === 'battlefield') {
        const cards = ids.map((i) => g.cards[i]!)
        const plus = cards.some((c) => (c.counters['+1/+1'] ?? 0) > 0)
        // A face-down card can't flip or be copied: either would tell the other seat what it is (or that it has two faces).
        const oneFaceUp = ids.length === 1 && !card.faceDown
        open([
          { label: tapTo(cards) ? 'Tap' : 'Untap', hint: 't', onSelect: () => play({ type: 'tap', ids, tapped: tapTo(cards) }) },
          ...(oneFaceUp && canFlip(g, id) ? [{ label: 'Flip', hint: 'f', onSelect: () => play({ type: 'flip', id }) }] : []),
          {
            label: cards.every((c) => c.faceDown) ? 'Turn face up' : 'Turn face down',
            onSelect: () => play({ type: 'faceDown', ids, down: !cards.every((c) => c.faceDown) }),
          },
          { label: 'Add a +1/+1 counter', hint: '+', onSelect: () => play({ type: 'counter', ids, name: '+1/+1', delta: 1 }) },
          ...(plus ? [{ label: 'Remove a +1/+1 counter', hint: '-', onSelect: () => play({ type: 'counter', ids, name: '+1/+1', delta: -1 }) }] : []),
          // Each other kind already on the cards (Midnight Clock's hour counters) is one click from one more or one fewer.
          ...menuCounters(cards).flatMap((name) => [
            { label: `Add 1 ${name} counter`, onSelect: () => play({ type: 'counter', ids, name, delta: 1 }) },
            { label: `Remove 1 ${name} counter`, onSelect: () => play({ type: 'counter', ids, name, delta: -1 }) },
          ]),
          { label: 'Counters…', onSelect: () => setDialog({ kind: 'counters', ids }) },
          'separator',
          ...(card.attachedTo !== null && ids.length === 1
            ? [{ label: 'Detach', onSelect: () => play({ type: 'attach', id, to: null }) }]
            : [{ label: 'Attach to…', onSelect: () => setAttaching(ids) }]),
          ...(oneFaceUp ? [{ label: 'Copy (a token copy)', onSelect: () => play({ type: 'copy', id }) }] : []),
          { label: 'Create token…', onSelect: () => setDialog({ kind: 'token', seat: card.controller }) },
          // The tokens this card makes; not for a face-down card, whose tokens would tell what it is.
          ...(oneFaceUp ? tokenItems(g.data[id]!, card.controller) : []),
          ...(ids.length === 1 ? [{ label: 'Put an ability on the stack', onSelect: () => play({ type: 'ability', id }) }] : []),
          'separator',
          ...moves(''),
          { label: 'Reveal', onSelect: () => play({ type: 'reveal', ids }) },
        ])
        return
      }
      if (card.zone === 'hand') {
        open([
          { label: 'Play', onSelect: () => playCard(id) },
          { label: 'Put onto the battlefield', onSelect: () => moveCards(ids, { zone: 'battlefield', seat: card.owner }) },
          { label: 'Discard', onSelect: () => moveCards(ids, { zone: 'graveyard' }) },
          ...moves('hand').filter((m) => m !== 'separator' && !m.label.includes('graveyard')),
          { label: 'Put an ability on the stack', onSelect: () => play({ type: 'ability', id }) },
          { label: 'Reveal', onSelect: () => play({ type: 'reveal', ids }) },
        ])
        return
      }
      const zone = card.zone
      if (zone === 'command' && g.data[id]!.kind === 'emblem') {
        open([
          { label: 'Put an ability on the stack', onSelect: () => play({ type: 'ability', id }) },
          { label: 'Remove the emblem', onSelect: () => moveCards([id], { zone: 'exile' }) },
        ])
        return
      }
      open([
        ...(zone === 'command' ? [{ label: 'Play', onSelect: () => playCard(id) }] : []),
        { label: 'Put onto the battlefield', onSelect: () => moveCards(ids, { zone: 'battlefield', seat: card.owner }) },
        ...moves(zone),
        { label: 'Put an ability on the stack', onSelect: () => play({ type: 'ability', id }) },
      ])
    },
    [play, moveCards, playCard, tokenItems, openMenu],
  )

  const libraryMenu = useCallback(
    (at: MenuAt, seat: SeatIndex) => {
      const { game: g, viewer: v } = latest.current
      const size = g.seats[seat]!.library.length
      const mine = seat === v
      const top = g.seats[seat]!.library[0]
      openMenu(at, `${g.seats[seat]!.name}'s library (${size})`, [
        { label: 'Draw a card', onSelect: () => play({ type: 'draw', seat, count: 1 }) },
        {
          label: 'Draw…',
          onSelect: () =>
            setDialog({ kind: 'count', title: 'Draw', label: 'Cards to draw', initial: 2, max: Math.max(1, Math.min(100, size)), onSubmit: (count) => play({ type: 'draw', seat, count }) }),
        },
        {
          label: mine ? 'Look at the top…' : 'Look at the top… (switch side first)',
          disabled: !mine || size === 0,
          onSelect: () =>
            setDialog({ kind: 'count', title: 'Look', label: 'Cards to look at', initial: 3, max: Math.min(100, size), onSubmit: (count) => setDialog({ kind: 'look', seat, count }) }),
        },
        { label: mine ? 'Search…' : 'Search… (switch side first)', disabled: !mine, onSelect: () => setDialog({ kind: 'search', seat }) },
        {
          label: 'Mill…',
          disabled: size === 0,
          onSelect: () =>
            setDialog({ kind: 'count', title: 'Mill', label: 'Cards to mill', initial: 1, max: Math.min(100, size), onSubmit: (count) => play({ type: 'mill', seat, count }) }),
        },
        { label: 'Reveal the top card', disabled: top === undefined, onSelect: () => top && play({ type: 'reveal', ids: [top] }) },
        { label: 'Shuffle', onSelect: () => play({ type: 'shuffle', seat }) },
      ])
    },
    [play, openMenu],
  )

  const fieldMenu = useCallback(
    (at: MenuAt, seat: SeatIndex) => {
      const g = latest.current.game
      openMenu(at, `${g.seats[seat]!.name}'s battlefield`, [{ label: 'Create token…', onSelect: () => setDialog({ kind: 'token', seat }) }])
    },
    [openMenu],
  )

  const stackMenu = useCallback(
    (at: MenuAt, item: string) => {
      const { game: g, viewer: v } = latest.current
      const found = g.stack.find((i) => i.id === item)
      if (!found) return
      const spell = found.kind === 'spell'
      const items: MenuItem[] = [
        { label: 'Resolve', onSelect: () => play({ type: 'resolve', item }) },
        // A spell's tokens, for when it resolves: made for its controller.
        ...(spell ? tokenItems(g.data[item]!, g.cards[item]!.controller) : []),
        ...(spell
          ? [
              { label: 'Put into hand', onSelect: () => moveCards([item], { zone: 'hand' }) },
              { label: 'Put into graveyard (countered)', onSelect: () => moveCards([item], { zone: 'graveyard' }) },
              { label: 'Exile', onSelect: () => moveCards([item], { zone: 'exile' }) },
            ]
          : []),
      ]
      const view = at.byFinger && spell && visibleTo(g.cards[item]!, v) ? () => setViewing(item) : null
      openMenu(at, spell ? g.data[item]!.name : `${found.name}: ability`, withView(items, view))
    },
    [play, moveCards, tokenItems, openMenu],
  )

  /** The menu a finger's press opens where it went down: held still on anything, or a tap on a card off the battlefield. */
  const pressMenu = useCallback(
    (d: Drag) => {
      const at = { ...d.start, byFinger: true }
      if (d.kind === 'cards') {
        if (d.source === 'stack') stackMenu(at, d.card)
        else cardMenu(at, d.card)
      } else if (d.kind === 'box') fieldMenu(at, d.seat)
      else if ('library' in d.target) libraryMenu(at, d.target.library)
      else stackMenu(at, d.target.item)
    },
    [cardMenu, libraryMenu, fieldMenu, stackMenu],
  )

  const finishDrag = useCallback(
    (d: Drag) => {
      const { game: g, viewer: v, selection: sel, attaching: waiting, selecting: adding } = latest.current
      if (d.kind === 'hold') {
        // A tap on a library is its click (a draw); one on an ability on the stack opens its menu, Resolve first.
        if (!d.moved && 'item' in d.target) pressMenu(d)
        return
      }
      if (d.kind === 'box') {
        // Shift, or Select's mode, adds to the selection.
        if (!d.moved) {
          if (!d.shift && !adding) setSelected(new Set())
          return
        }
        const box = {
          left: Math.min(d.start.x, d.at.x) - d.field.left,
          right: Math.max(d.start.x, d.at.x) - d.field.left,
          top: Math.min(d.start.y, d.at.y) - d.field.top,
          bottom: Math.max(d.start.y, d.at.y) - d.field.top,
        }
        const ids = cardsInBox(looseCards(g, d.seat), box, d.field, d.seat !== v)
        setSelected(d.shift || adding ? new Set([...sel, ...ids]) : new Set(ids))
        return
      }
      const { card } = d
      if (!d.moved) {
        switch (tapAction(d.source, d, { attaching: waiting !== null, selecting: adding })) {
          case 'attach':
            if (waiting && !waiting.includes(card)) for (const id of waiting) play({ type: 'attach', id, to: card })
            setAttaching(null)
            break
          case 'select': {
            const next = new Set(sel)
            if (next.has(card)) next.delete(card)
            else next.add(card)
            setSelected(next)
            break
          }
          case 'tap':
            tapCards(card)
            break
          case 'menu':
            pressMenu(d)
            break
        }
        return
      }
      const target = dropTarget(d.at.x, d.at.y)
      const drop = target?.dataset.drop
      // A panel over the table ("none") keeps a card from dropping on what's under it.
      if (!target || !drop || drop === 'none') return
      const [zone, seatText] = drop.split('-') as [string, string | undefined]
      if (zone === 'battlefield') {
        const seat = Number(seatText) as SeatIndex
        const rect = target.getBoundingClientRect()
        const at = d.ids.map((id) =>
          fromScreen({ x: d.at.x + d.offsets[id]!.dx - rect.left, y: d.at.y + d.offsets[id]!.dy - rect.top }, rect, seat !== v),
        )
        play({ type: 'move', ids: d.ids, to: { zone: 'battlefield', seat, at } })
        return
      }
      const to: Dest =
        zone === 'library'
          ? { zone: 'library', at: 'top' }
          : zone === 'stack'
            ? { zone: 'stack' }
            : { zone: zone as 'hand' | 'graveyard' | 'exile' | 'command' }
      // A card dropped back where it is stays put.
      const moving = d.ids.filter((id) => g.cards[id]!.zone !== to.zone)
      if (moving.length > 0) moveCards(moving, to)
    },
    [play, moveCards, tapCards, pressMenu],
  )

  // One set of window listeners follows a press from its pointerdown to its pointerup, or to its pointercancel (the
  // browser took the pointer: a system gesture, say), which ends it without a drop or a tap.
  const followDrag = useCallback(
    (pointer: number) => {
      const onMove = (e: globalThis.PointerEvent) => {
        const d = dragRef.current
        if (e.pointerId !== pointer || d === null || d.pointer !== pointer) return
        const at = { x: e.clientX, y: e.clientY }
        const moved = movedFar(d, at)
        dragRef.current = { ...d, at, moved }
        if (moved && !d.moved) window.clearTimeout(holdTimer.current)
        // A held library or ability that moves is just no longer held: there's nothing to drag.
        if (d.kind === 'hold') return
        if (moved && !d.moved) setDragging(true)
        if (moved) dragStore.set(dragRef.current)
      }
      const onEnd = (e: globalThis.PointerEvent) => {
        if (e.pointerId !== pointer) return
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onEnd)
        window.removeEventListener('pointercancel', onEnd)
        const d = dragRef.current
        if (d === null || d.pointer !== pointer) return
        endPress()
        if (e.type === 'pointerup') finishDrag(d)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onEnd)
      window.addEventListener('pointercancel', onEnd)
    },
    [finishDrag, endPress, dragStore],
  )

  /**
   * Starts following a press. Its pointer is captured, so its moves and its end come to the board wherever they go; a
   * finger (or a pen) held still on it opens its menu.
   */
  const beginPress = useCallback(
    (e: PointerEvent, drag: Drag) => {
      // One press at a time: a second finger while one is down does nothing. The same pointer down again means its end
      // never came, so the new press takes its place.
      if (dragRef.current !== null && dragRef.current.pointer !== e.pointerId) return
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      window.clearTimeout(holdTimer.current)
      dragRef.current = drag
      if (drag.touch) {
        holdTimer.current = window.setTimeout(() => {
          const d = dragRef.current
          if (d !== null && d.pointer === drag.pointer && holdOpensMenu(d)) pressMenu(d)
        }, LONG_PRESS_MS)
      }
      followDrag(e.pointerId)
    },
    [followDrag, pressMenu],
  )

  const beginCardDrag = useCallback(
    (e: PointerEvent, id: string, source: DragSource) => {
      if (e.button !== 0) return
      e.stopPropagation()
      const { selection: sel } = latest.current
      const ids = source === 'battlefield' && sel.has(id) ? [...sel] : [id]
      const offsets: Record<string, { dx: number; dy: number; height: number }> = {}
      for (const i of ids) {
        const rect = document.querySelector(`[data-card="${CSS.escape(i)}"]`)?.getBoundingClientRect()
        offsets[i] = rect
          ? { dx: rect.left + rect.width / 2 - e.clientX, dy: rect.top + rect.height / 2 - e.clientY, height: Math.max(rect.width, rect.height) }
          : { dx: 0, dy: 0, height }
      }
      const start = { x: e.clientX, y: e.clientY }
      beginPress(e, {
        kind: 'cards',
        card: id,
        ids,
        source,
        offsets,
        shift: e.shiftKey,
        start,
        at: start,
        moved: false,
        touch: isTouch(e.pointerType),
        pointer: e.pointerId,
      })
    },
    [beginPress, height],
  )

  const beginBoxSelect = useCallback(
    (e: PointerEvent, seat: SeatIndex) => {
      const start = { x: e.clientX, y: e.clientY }
      const fieldRect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      beginPress(e, { kind: 'box', seat, field: fieldRect, shift: e.shiftKey, start, at: start, moved: false, touch: isTouch(e.pointerType), pointer: e.pointerId })
    },
    [beginPress],
  )

  const beginHold = useCallback(
    (e: PointerEvent, target: HoldTarget) => {
      // A mouse right-clicks for these menus (and clicks a library to draw): its press is the browser's.
      if (e.button !== 0 || !isTouch(e.pointerType)) return
      e.stopPropagation()
      const start = { x: e.clientX, y: e.clientY }
      beginPress(e, { kind: 'hold', target, start, at: start, moved: false, touch: true, pointer: e.pointerId })
    },
    [beginPress],
  )

  const openCardMenu = useCallback((e: MouseEvent, id: string) => cardMenu(menuEvent(e), id), [cardMenu])
  const openLibraryMenu = useCallback((e: MouseEvent, seat: SeatIndex) => libraryMenu(menuEvent(e), seat), [libraryMenu])
  const openFieldMenu = useCallback((e: MouseEvent, seat: SeatIndex) => fieldMenu(menuEvent(e), seat), [fieldMenu])
  const openStackMenu = useCallback((e: MouseEvent, item: string) => stackMenu(menuEvent(e), item), [stackMenu])

  // A finger's press that opened a menu: the browser's own long-press (a contextmenu) and the click the press ends with
  // would land on the menu now over it, closing it or choosing what's under the finger. They're spent, until the next
  // press. And while a finger is down, its long-press is the board's own (LONG_PRESS_MS), not the browser's.
  useEffect(() => {
    const onDown = () => {
      spent.current = false
    }
    const onContextMenu = (e: Event) => {
      if (!spent.current && !dragRef.current?.touch) return
      e.preventDefault()
      e.stopPropagation()
    }
    const onClick = (e: globalThis.MouseEvent) => {
      // A click from the keyboard (detail 0) is no press's.
      if (!spent.current || e.detail === 0) return
      spent.current = false
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('contextmenu', onContextMenu, true)
    window.addEventListener('click', onClick, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('contextmenu', onContextMenu, true)
      window.removeEventListener('click', onClick, true)
      window.clearTimeout(holdTimer.current)
    }
  }, [])

  // A finger's swipe down the table mustn't pull the page down to reload it (Chrome on Android) in the middle of a game.
  useEffect(() => {
    const root = document.documentElement
    const before = root.style.overscrollBehaviorY
    root.style.overscrollBehaviorY = 'none'
    return () => {
      root.style.overscrollBehaviorY = before
    }
  }, [])

  // Android's Back closes a menu, a dialog, or the card viewed. They share one history entry, as one can open the next
  // as it closes (a menu's Draw… opens its dialog).
  const closeOverlays = useCallback(() => {
    setMenu(null)
    setDialog(null)
    setViewing(null)
  }, [])
  useBackToClose(menu !== null || dialog !== null || viewed !== null, closeOverlays)

  const nextTurn = useCallback(() => {
    const g = latest.current.game
    if (play({ type: 'nextTurn' })) setViewer(g.seats.length === 2 ? other(g.active) : g.active)
  }, [play])

  const switchSide = useCallback(() => {
    if (!twoSeats) return
    setViewer((v) => other(v))
    // Every card moves out from under the pointer, and no pointerleave follows: nothing is hovered now.
    setHoverAt(null)
  }, [twoSeats])

  // The board's keys (spec §5.9.4). None while a field, a dialog, or a menu has them, nor right after `g`.
  // When `g` was last pressed; never, to start with (0 would hold the keys for the page's first 1.5 s).
  const lastG = useRef(-Infinity)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const now = performance.now()
      if (e.key === 'g' && !e.metaKey && !e.ctrlKey && !e.altKey) lastG.current = now
      if (isTypingTarget(e.target as HTMLElement) || document.querySelector('[aria-modal="true"], [role="menu"]')) return
      const key = boardKey(e, e.key !== 'g' && now - lastG.current <= GO_TO_MS)
      if (key === null) return
      const { game: g, selection: sel, viewer: v } = latest.current
      const hover = hovered !== null && g.cards[hovered]?.zone === 'battlefield' ? hovered : null
      const targets = hover !== null ? (sel.has(hover) ? [...sel] : [hover]) : [...sel]
      e.preventDefault()
      switch (key) {
        case 'tap':
          if (targets.length > 0) play({ type: 'tap', ids: targets, tapped: tapTo(targets.map((i) => g.cards[i]!)) })
          break
        case 'flip':
          if (hover !== null && !g.cards[hover]!.faceDown && canFlip(g, hover)) play({ type: 'flip', id: hover })
          break
        case 'plus':
          if (targets.length > 0) play({ type: 'counter', ids: targets, name: '+1/+1', delta: 1 })
          break
        case 'minus':
          // Like the menu, which offers "Remove a +1/+1 counter" only when one of the cards has one.
          if (targets.some((i) => (g.cards[i]!.counters['+1/+1'] ?? 0) > 0)) play({ type: 'counter', ids: targets, name: '+1/+1', delta: -1 })
          break
        case 'draw':
          play({ type: 'draw', seat: v, count: 1 })
          break
        case 'switch':
          switchSide()
          break
        case 'undo':
          undo()
          break
        case 'clear':
          setSelected(new Set())
          setAttaching(null)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hovered, play, undo, switchSide])

  const board: BoardApi = {
    game,
    setup,
    viewer,
    selection,
    hovered,
    setHovered,
    cardHeight: height,
    attaching,
    coarse,
    play,
    moveCards,
    playCard,
    beginCardDrag,
    beginBoxSelect,
    beginHold,
    openCardMenu,
    openLibraryMenu,
    openFieldMenu,
    openStackMenu,
    openPile: (seat, zone) => setPile({ seat, zone }),
  }

  /** The turn bar's ⋯, on a window too narrow for all its buttons: the ones that don't fit. */
  const openBarMenu = (e: MouseEvent) =>
    openMenu(menuEvent(e), 'The game', [
      { label: logOpen ? 'Close the log' : 'Log', onSelect: () => setLogOpen((open) => !open) },
      { label: 'Switch side', hint: 'Tab', disabled: !twoSeats, onSelect: switchSide },
      { label: 'End game', onSelect: () => setDialog({ kind: 'end' }) },
    ])

  const top = twoSeats ? other(viewer) : null
  const rematchable = decks.data !== undefined && setup.seats.every((s) => decks.data.some((d) => d.id === s.deckId))

  return (
    <BoardContext value={board}>
      <div
        onPointerMove={(e) => {
          pointerX.current = e.clientX
        }}
        onContextMenu={(e) => e.preventDefault()}
        // touch-none: a finger drags cards and draws boxes on the table; it doesn't scroll or zoom the page.
        className="relative flex h-full touch-none flex-col gap-1.5 select-none"
      >
        {saveStatus === 'retrying' && (
          <p role="alert" className="absolute top-1 left-1/2 z-50 -translate-x-1/2 rounded-md bg-red-800 px-3 py-1 text-sm text-red-50 shadow-lg">
            Couldn't save — retrying
          </p>
        )}
        {attaching && (
          <div className="absolute top-1 left-1/2 z-50 flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-3 rounded-md bg-amber-700 py-0.5 pr-1 pl-3 text-sm text-white shadow-lg">
            <p role="status" className="min-w-0">
              {coarse ? 'Tap' : 'Click'} the card to attach {list(attaching.map((id) => nameFor(game, id, viewer)))} to
              {coarse ? '' : ' (Esc cancels)'}
            </p>
            <button onClick={() => setAttaching(null)} className="shrink-0 rounded px-2 py-0.5 font-medium hover:bg-amber-600 pointer-coarse:py-2">
              Cancel
            </button>
          </div>
        )}
        {top !== null && (
          <>
            <HandStrip seat={top} />
            <div className="flex min-h-0 flex-1 gap-1.5">
              <Battlefield seat={top} />
              <SideBlock seat={top} />
            </div>
          </>
        )}
        <TurnBar
          saveStatus={saveStatus}
          canUndo={canUndo}
          canSwitch={twoSeats}
          selecting={selecting}
          onSelecting={setSelecting}
          onClear={() => setSelected(new Set())}
          onUndo={undo}
          onLog={() => setLogOpen((open) => !open)}
          onSwitch={switchSide}
          onEnd={() => setDialog({ kind: 'end' })}
          onMore={openBarMenu}
          onNextTurn={nextTurn}
        />
        <div className="flex min-h-0 flex-1 gap-1.5">
          <Battlefield seat={viewer} fieldRef={fieldRef} />
          <SideBlock seat={viewer} />
        </div>
        <HandStrip seat={viewer} />
      </div>

      <DragLayer store={dragStore} game={game} viewer={viewer} />
      {hovered !== null && !dragging && menu === null && viewed === null && <Preview id={hovered} pointerX={pointerX.current} />}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {viewed !== null && <CardViewer id={viewed} onClose={() => setViewing(null)} />}
      {pile && <PilePanel seat={pile.seat} zone={pile.zone} onClose={() => setPile(null)} />}
      {logOpen && <LogPanel actions={saved.actions} onClose={() => setLogOpen(false)} />}
      {dialog && (
        <DialogFor
          dialog={dialog}
          game={game}
          viewer={viewer}
          play={play}
          canRematch={rematchable}
          onRematch={() =>
            startGame.mutate({
              decks: [setup.seats[0]!.deckId, setup.seats[1]?.deckId ?? null],
              first: setup.startingSeat,
              life: setup.life,
              startingDraws: setup.startingDraws,
            })
          }
          onNewGame={() => endGame.mutate()}
          onClose={() => setDialog(null)}
        />
      )}
    </BoardContext>
  )
}

/** The drag in progress, told to the layer that draws it. */
function createDragStore() {
  let current: Drag | null = null
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    set(next: Drag | null) {
      current = next
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** The cards being dragged, following the pointer, or the box being drawn to select cards. */
function DragLayer({ store, game, viewer }: { store: ReturnType<typeof createDragStore>; game: GameState; viewer: SeatIndex }) {
  const drag = useSyncExternalStore(store.subscribe, store.get)
  if (drag === null || !drag.moved || drag.kind === 'hold') return null
  if (drag.kind === 'box') {
    return (
      <div
        aria-hidden
        style={{
          left: Math.min(drag.start.x, drag.at.x),
          top: Math.min(drag.start.y, drag.at.y),
          width: Math.abs(drag.at.x - drag.start.x),
          height: Math.abs(drag.at.y - drag.start.y),
        }}
        className="pointer-events-none fixed z-50 rounded border border-amber-400 bg-amber-400/10"
      />
    )
  }
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-50">
      {drag.ids.map((id) => {
        const o = drag.offsets[id]!
        const card = game.cards[id]
        if (!card) return null
        return (
          <div key={id} style={{ left: drag.at.x + o.dx, top: drag.at.y + o.dy }} className="absolute -translate-x-1/2 -translate-y-1/2 opacity-90">
            <CardView data={game.data[id]!} card={card} height={o.height} hidden={!visibleTo(card, viewer)} />
          </div>
        )
      })}
    </div>
  )
}

/** The dialog open on the board, wired to the game. */
function DialogFor({
  dialog,
  game,
  viewer,
  play,
  canRematch,
  onRematch,
  onNewGame,
  onClose,
}: {
  dialog: Dialog
  game: GameState
  viewer: SeatIndex
  play: (action: Action) => boolean
  canRematch: boolean
  onRematch: () => void
  onNewGame: () => void
  onClose: () => void
}) {
  switch (dialog.kind) {
    case 'count':
      return <CountDialog {...dialog} onClose={onClose} />
    case 'look':
      return (
        <LookDialog
          game={game}
          seat={dialog.seat}
          count={dialog.count}
          onSubmit={(placed) => play({ type: 'arrange', seat: dialog.seat, ...placed })}
          onClose={onClose}
        />
      )
    case 'search':
      return (
        <SearchDialog
          game={game}
          seat={dialog.seat}
          onSubmit={(ids, to, shuffle) => play({ type: 'search', seat: dialog.seat, ids, to, shuffle })}
          onClose={onClose}
        />
      )
    case 'counters':
      return (
        <CounterDialog
          names={list(dialog.ids.map((id) => nameFor(game, id, viewer)))}
          current={game.cards[dialog.ids[0]!]?.counters ?? {}}
          choices={counterChoices(Object.values(game.cards))}
          onAdd={(name, delta) => play({ type: 'counter', ids: dialog.ids, name, delta })}
          onSet={(name, value) => play({ type: 'setCounter', ids: dialog.ids, name, value })}
          onClose={onClose}
        />
      )
    case 'token':
      return <TokenDialog onSubmit={(token, count) => play({ type: 'token', seat: dialog.seat, token, count })} onClose={onClose} />
    case 'commander': {
      const others = dialog.ids.filter((id) => !dialog.commanders.includes(id))
      const place = dialog.to.zone === 'library' ? (dialog.to.at === 'top' ? 'Top of library' : 'Bottom of library') : PLACE_LABEL[dialog.to.zone]!
      return (
        <CommandZoneDialog
          names={list(dialog.commanders.map((id) => game.data[id]!.name))}
          placeLabel={place}
          onCommandZone={() => {
            play({ type: 'move', ids: dialog.commanders, to: { zone: 'command' } })
            if (others.length > 0) play({ type: 'move', ids: others, to: dialog.to })
          }}
          onPlace={() => play({ type: 'move', ids: dialog.ids, to: dialog.to })}
          onClose={onClose}
        />
      )
    }
    case 'end':
      return <EndGameDialog canRematch={canRematch} onRematch={onRematch} onNewGame={onNewGame} onClose={onClose} />
  }
}
