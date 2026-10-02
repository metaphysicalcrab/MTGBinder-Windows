import { clampPos } from '../../shared/playtest/placement.ts'
import type { CardData, CardKind, CardState, Dest, Pos, SeatIndex } from '../../shared/playtest/types.ts'
import type { FormatId } from '../../shared/types.ts'
import { IS_MAC, isUndoKey } from './platform.ts'

/** The playtest board's arithmetic (spec §5.9.3, §5.9.4), kept apart from React so it can be tested. */

/** A card is 63 × 88 mm. */
export const CARD_RATIO = 88 / 63

/** A battlefield card's height for a half this tall: 30% of it (its three rows just fit), from 56 to 150 px. */
export function cardHeight(halfHeight: number): number {
  return Math.round(Math.min(150, Math.max(56, halfHeight * 0.3)))
}

/**
 * The table card height to draw, from the one drawn now (null before the first) and the one the table's height asks
 * for: a change of 1 px is ignored. The hand's strip comes out of the table's height, so rounding can otherwise flip
 * the two back and forth every frame at some window heights.
 */
export function steadyCardHeight(drawn: number | null, wanted: number): number {
  return drawn !== null && Math.abs(wanted - drawn) < 2 ? drawn : wanted
}

/**
 * A card in the hand: half again as tall as one on the table, up to 240 px. No floor: the hand's strip comes out of the
 * table's height, and on a short window a taller hand would squeeze the table.
 */
export function handHeight(cardHeight: number): number {
  return Math.round(Math.min(240, cardHeight * 1.5))
}

/** The hover preview: 520 px tall, less on a window too short for it and the lines under it, but at least 240. */
export function previewHeight(windowHeight: number): number {
  return Math.round(Math.min(520, Math.max(240, windowHeight - 240)))
}

/**
 * How far apart the left edges of the command zone's cards sit, in a zone `room` px wide (spec §5.9.8): side by side,
 * 4 px apart, when they fit; else overlapped just enough to fit, so each earlier card shows as much of its left edge
 * (where its name is) as the room allows. Never under 2 px, so no card disappears under the next. The floor is that
 * low because the room is small: at the largest piles, the side block's row leaves the zone about 54 px, and a card is
 * 46 px wide, so three cards leave each earlier one about 4 px.
 */
export function commandStep(cardWidth: number, count: number, room: number): number {
  const sideBySide = cardWidth + 4
  if (count < 2 || cardWidth + (count - 1) * sideBySide <= room) return sideBySide
  // Whole pixels, rounded down, so rounding never pushes the last card past the room.
  return Math.max(2, Math.floor((room - cardWidth) / (count - 1)))
}

/** Scryfall's small image is this tall; a card drawn taller uses the normal image, so it isn't blurred. */
export const SMALL_IMAGE_HEIGHT = 204

export interface Box {
  width: number
  height: number
}

/**
 * A spot's pixel position (the card's center) in its battlefield. The bottom half has its seat's edge at the bottom;
 * the top half is flipped, with its seat's edge at the top.
 */
export function toScreen(pos: Pos, box: Box, flipped: boolean): { x: number; y: number } {
  return { x: pos.x * box.width, y: (flipped ? pos.y : 1 - pos.y) * box.height }
}

/** The spot for a pixel position in a battlefield, kept on it. */
export function fromScreen(point: { x: number; y: number }, box: Box, flipped: boolean): Pos {
  const y = point.y / box.height
  return clampPos({ x: point.x / box.width, y: flipped ? y : 1 - y })
}

/** Starting life (spec §5.9.2): 40 when either deck is a Commander deck, else 20. */
export function startingLife(formats: readonly FormatId[]): number {
  return formats.includes('commander') ? 40 : 20
}

/** Playing a card (a double-click): a permanent to its default spot, an instant or sorcery onto the stack. */
export function playDest(kind: CardKind, seat: SeatIndex): Dest {
  return kind === 'spell' ? { zone: 'stack' } : { zone: 'battlefield', seat }
}

/** A token by its name and, for a creature, its power and toughness: "Treasure", "Beast 3/3". */
export function tokenName(token: CardData): string {
  const { power, toughness } = token.faces[0]!
  return `${token.name}${power !== null && toughness !== null ? ` ${power}/${toughness}` : ''}`
}

/**
 * A card menu's item for a token the card makes (spec §5.9.8): "Create Treasure", "Create Beast 3/3", or, for an
 * emblem, "Get Elspeth, Knight-Errant Emblem".
 */
export function tokenLabel(token: CardData): string {
  return token.kind === 'emblem' ? `Get ${token.name}` : `Create ${tokenName(token)}`
}

/** Clicking selected cards taps them all, unless they're all tapped already: then it untaps them. */
export function tapTo(cards: readonly CardState[]): boolean {
  return !cards.every((c) => c.tapped)
}

/**
 * Whether moving a commander there first asks "Command zone instead?" (spec §5.9.5): not when it's leaving the command
 * zone, where "instead" would be staying put.
 */
export function asksCommandZone(card: CardState, to: Dest): boolean {
  return card.commander && card.zone !== 'command' && ['graveyard', 'exile', 'hand', 'library'].includes(to.zone)
}

/** The cards whose centers fall inside a dragged box (pixels, in the battlefield). */
export function cardsInBox(
  cards: readonly CardState[],
  box: { left: number; top: number; right: number; bottom: number },
  field: Box,
  flipped: boolean,
): string[] {
  return cards
    .filter((c) => {
      if (!c.pos) return false
      const { x, y } = toScreen(c.pos, field, flipped)
      return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
    })
    .map((c) => c.id)
}

/** The counters the Counters… dialog offers first (spec §5.9.4). */
export const COMMON_COUNTERS = ['+1/+1', '-1/-1', 'loyalty', 'charge', 'time', 'lore', 'shield', 'stun', 'oil']

/** Each kind of counter on these cards, in the order first met. */
function countersOn(cards: CardState[]): string[] {
  return [...new Set(cards.flatMap((c) => Object.keys(c.counters)))]
}

/** The kinds of counter a card's menu adds or removes one of: each on the cards, but +1/+1, which has its own items. */
export function menuCounters(cards: CardState[]): string[] {
  return countersOn(cards).filter((name) => name !== '+1/+1')
}

/** The counters the Counters… dialog offers: the usual ones, then any other kind on the table (an hour counter). */
export function counterChoices(cards: CardState[]): string[] {
  return [...COMMON_COUNTERS, ...countersOn(cards).filter((name) => !COMMON_COUNTERS.includes(name))]
}

/** A counter's tag on a card: "+3/+3" for three +1/+1 counters, "◆4" for loyalty, else its name and number. */
export function counterTag(name: string, value: number): string {
  if (name === '+1/+1') return `+${value}/+${value}`
  if (name === '-1/-1') return `−${value}/−${value}`
  if (name === 'loyalty') return `◆${value}`
  return `${name} ${value}`
}

/** Where a drag started, which decides what a click without a drag does. */
export type DragSource = 'battlefield' | 'hand' | 'command' | 'stack' | 'pile'

/**
 * How long a finger (or a pen) held still on the table opens what a right-click would (M13): about as long as Android's
 * own long-press.
 */
export const LONG_PRESS_MS = 450

/** A finger or a pen, not a mouse: it drags after a longer move, holds for a menu, and taps to play a card. */
export function isTouch(pointerType: string): boolean {
  return pointerType === 'touch' || pointerType === 'pen'
}

/**
 * How far a press moves before it's a drag rather than a click: 5 px with a mouse, 10 with a finger or a pen, which
 * wobble as they come down and lift.
 */
export function dragStartPx(touch: boolean): number {
  return touch ? 10 : 5
}

/** A press on the table, from the pointer going down until it comes up (or the browser takes it: pointercancel). */
export interface Press {
  start: { x: number; y: number }
  touch: boolean
  /** It has gone far enough to be a drag (dragStartPx); once a drag, it stays one. */
  moved: boolean
}

/** Whether a press is a drag with the pointer at `at`. */
export function movedFar(press: Press, at: { x: number; y: number }): boolean {
  return press.moved || Math.hypot(at.x - press.start.x, at.y - press.start.y) > dragStartPx(press.touch)
}

/** Whether a press held for LONG_PRESS_MS opens its menu: a finger or a pen that hasn't moved. A mouse right-clicks. */
export function holdOpensMenu(press: Press): boolean {
  return press.touch && !press.moved
}

/**
 * How soon after a finger's tap plays a card the next press is that tap's second half: a double-tap (a mouse's habit, or
 * a pen's double-click) plays one card, not the one that moved under it as well. Windows' double-click time; Android's
 * double-tap is 300 ms.
 */
export const DOUBLE_TAP_MS = 500

/**
 * What a press on a card that comes up without moving does (spec §5.9.4, M13). On the battlefield: attaches the cards
 * waiting for a host, adds the card to the selection or takes it out (Shift, or Select's mode for a finger), or taps it.
 * In hand or the command zone a finger plays the card, unless it's a double-tap's second half (`sincePlay`, the time
 * since a tap last played one, under DOUBLE_TAP_MS); on the stack or in a pile it opens the card's menu, Resolve first
 * on the stack. A mouse plays and resolves with a double-click.
 */
export function tapAction(
  source: DragSource,
  press: { touch: boolean; shift: boolean; sincePlay: number },
  board: { attaching: boolean; selecting: boolean },
): 'attach' | 'select' | 'tap' | 'play' | 'menu' | 'none' {
  if (source === 'battlefield') return board.attaching ? 'attach' : press.shift || board.selecting ? 'select' : 'tap'
  if (!press.touch) return 'none'
  if (source === 'hand' || source === 'command') return press.sincePlay < DOUBLE_TAP_MS ? 'none' : 'play'
  return 'menu'
}

/** The narrowest window the table fits (M13): a tablet's. Narrower, with a finger, the page says so first. */
export const TABLE_MIN_WIDTH = 768

/**
 * The shortest screen the table fits (M13): a tablet's on its side, 600 px or more. A phone's on its side is 360–430,
 * and Chrome's address bar and Binder's header and tabs leave the battlefield a strip too thin to drop a card on, so
 * the page says so first, whichever way up the phone is. The screen's height, not the window's: the keyboard (a life
 * total typed on a tablet) shortens the window, and mustn't swap the table for the notice.
 */
export const TABLE_MIN_SCREEN_HEIGHT = 500

/** Where a finger's table doesn't fit (M13): a window narrower than a tablet's, or a phone's screen either way up. */
export const SMALL_SCREEN_QUERY = `(width < ${TABLE_MIN_WIDTH}px), (device-height < ${TABLE_MIN_SCREEN_HEIGHT}px)`

export type BoardKey = 'tap' | 'flip' | 'plus' | 'minus' | 'draw' | 'switch' | 'undo' | 'clear'

/**
 * What a key does on the board (spec §5.9.4), or null. Undo is Cmd+Z on a Mac and Ctrl+Z elsewhere (isUndoKey, the one
 * with a modifier); the rest are bare keys, and none follows a `g` (which starts going to another page).
 */
export function boardKey(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  afterG: boolean,
  mac = IS_MAC,
): BoardKey | null {
  if (isUndoKey(e, mac)) return 'undo'
  if (e.metaKey || e.ctrlKey || e.altKey || afterG) return null
  switch (e.key) {
    case 't':
      return 'tap'
    case 'f':
      return 'flip'
    case '+':
    case '=':
      return 'plus'
    case '-':
      return 'minus'
    case 'd':
      return 'draw'
    case 'Tab':
      return e.shiftKey ? null : 'switch'
    case 'Escape':
      return 'clear'
    default:
      return null
  }
}
