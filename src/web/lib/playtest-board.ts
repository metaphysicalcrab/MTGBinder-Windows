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
