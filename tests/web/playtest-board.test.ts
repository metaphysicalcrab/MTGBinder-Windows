import { describe, expect, it } from 'vitest'
import type { CardState } from '../../src/shared/playtest/types.ts'
import { cardData } from '../helpers/playtest.ts'
import {
  asksCommandZone,
  boardKey,
  CARD_RATIO,
  cardHeight,
  cardsInBox,
  commandStep,
  COMMON_COUNTERS,
  counterChoices,
  counterTag,
  fromScreen,
  handHeight,
  menuCounters,
  playDest,
  previewHeight,
  steadyCardHeight,
  startingLife,
  tapTo,
  tokenLabel,
  tokenName,
  toScreen,
} from '../../src/web/lib/playtest-board.ts'

function card(id: string, extra: Partial<CardState> = {}): CardState {
  return {
    id,
    owner: 0,
    controller: 0,
    zone: 'battlefield',
    commander: false,
    token: false,
    tapped: false,
    faceDown: false,
    face: 0,
    counters: {},
    attachedTo: null,
    pos: { x: 0.5, y: 0.5 },
    ...extra,
  }
}

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

describe('the board', () => {
  it('draws the bottom half with its edge at the bottom and the top half flipped', () => {
    const box = { width: 1000, height: 400 }
    expect(toScreen({ x: 0.1, y: 0.2 }, box, false)).toEqual({ x: 100, y: 320 })
    expect(toScreen({ x: 0.1, y: 0.2 }, box, true)).toEqual({ x: 100, y: 80 })
    expect(fromScreen({ x: 100, y: 320 }, box, false)).toEqual({ x: 0.1, y: 0.2 })
    expect(fromScreen({ x: 100, y: 80 }, box, true)).toEqual({ x: 0.1, y: 0.2 })
    expect(fromScreen({ x: -50, y: 900 }, box, false)).toEqual({ x: 0.03, y: 0.03 })
  })

  it('sizes cards to the half, within bounds', () => {
    expect(cardHeight(400)).toBe(120)
    expect(cardHeight(100)).toBe(56)
    expect(cardHeight(1000)).toBe(150)
  })

  it("keeps the card height drawn when the table asks for 1 px more or less, so the hand and table don't flip back and forth", () => {
    expect(steadyCardHeight(null, 84)).toBe(84)
    expect(steadyCardHeight(84, 83)).toBe(84)
    expect(steadyCardHeight(84, 85)).toBe(84)
    expect(steadyCardHeight(84, 86)).toBe(86)
    expect(steadyCardHeight(120, 60)).toBe(60)
  })

  it('draws the hand half again as tall as a table card, up to 240 px', () => {
    expect(handHeight(84)).toBe(126)
    expect(handHeight(56)).toBe(84)
    expect(handHeight(150)).toBe(225)
    expect(handHeight(200)).toBe(240)
  })

  it('draws the preview 520 px tall, less on a window too short for it', () => {
    expect(previewHeight(900)).toBe(520)
    expect(previewHeight(700)).toBe(460)
    expect(previewHeight(300)).toBe(240)
  })

  it("sits the command zone's cards side by side, 4 px apart, when they fit", () => {
    const width = 48 / CARD_RATIO
    expect(commandStep(width, 1, 70)).toBe(width + 4)
    expect(commandStep(width, 2, 94)).toBe(width + 4)
    expect(commandStep(width, 3, 3 * width + 8)).toBe(width + 4)
  })

  it("overlaps the command zone's cards just enough to fit its room, at the smallest and largest piles", () => {
    // The room the side block's row leaves the command zone, measured in headless Chrome: 222 px, less three 8-px gaps
    // and the other piles, each as wide as its card or its label ("Library 91" is 52 px, "Grave 0" 41).
    for (const { pile, room } of [
      { pile: 48, room: 70 },
      { pile: 64, room: 54 },
    ]) {
      const width = pile / CARD_RATIO
      for (let count = 1; count <= 5; count++) {
        const step = commandStep(width, count, room)
        const zone = (s: number) => width + (count - 1) * s
        expect(zone(step), `${count} cards at ${pile} px`).toBeLessThanOrEqual(room)
        // Each earlier card shows as much of its left edge as the room allows: a pixel more would overflow.
        if (step < width + 4) expect(zone(step + 1), `${count} cards at ${pile} px`).toBeGreaterThan(room)
      }
    }
    expect(commandStep(48 / CARD_RATIO, 3, 70)).toBe(17)
  })

  it('never overlaps a command-zone card past its last 2 px, so none disappears', () => {
    const width = 64 / CARD_RATIO
    expect(commandStep(width, 10, 54)).toBe(2)
    expect(commandStep(width, 3, 20)).toBe(2)
    expect(commandStep(width, 2, 0)).toBe(2)
  })

  it('finds the cards whose centers are in a dragged box', () => {
    const field = { width: 1000, height: 400 }
    const cards = [card('a', { pos: { x: 0.1, y: 0.5 } }), card('b', { pos: { x: 0.5, y: 0.5 } }), card('c', { pos: null })]
    expect(cardsInBox(cards, { left: 0, top: 0, right: 300, bottom: 400 }, field, false)).toEqual(['a'])
    expect(cardsInBox(cards, { left: 0, top: 150, right: 600, bottom: 250 }, field, true)).toEqual(['a', 'b'])
  })

  it('starts at 40 life when either deck is a Commander deck, else 20', () => {
    expect(startingLife(['commander', 'modern'])).toBe(40)
    expect(startingLife(['modern'])).toBe(20)
  })

  it('plays permanents to the battlefield and instants and sorceries onto the stack', () => {
    expect(playDest('creature', 1)).toEqual({ zone: 'battlefield', seat: 1 })
    expect(playDest('land', 0)).toEqual({ zone: 'battlefield', seat: 0 })
    expect(playDest('spell', 0)).toEqual({ zone: 'stack' })
  })

  it("labels a card's tokens by name and power/toughness, and its emblems as gotten", () => {
    expect(tokenName(cardData('Goblin'))).toBe('Goblin 1/1')
    expect(tokenName(cardData('Treasure', 'other'))).toBe('Treasure')
    expect(tokenLabel(cardData('Treasure', 'other'))).toBe('Create Treasure')
    expect(tokenLabel(cardData('Goblin'))).toBe('Create Goblin 1/1')
    expect(tokenLabel(cardData('Elspeth, Knight-Errant Emblem', 'emblem'))).toBe('Get Elspeth, Knight-Errant Emblem')
  })

  it('taps a selection unless all of it is tapped', () => {
    expect(tapTo([card('a'), card('b', { tapped: true })])).toBe(true)
    expect(tapTo([card('a', { tapped: true }), card('b', { tapped: true })])).toBe(false)
  })

  it('asks "Command zone instead?" when a commander goes to a graveyard, exile, a hand, or a library', () => {
    const commander = card('c', { commander: true })
    for (const zone of ['graveyard', 'exile', 'hand'] as const) expect(asksCommandZone(commander, { zone })).toBe(true)
    expect(asksCommandZone(commander, { zone: 'library', at: 'bottom' })).toBe(true)
    expect(asksCommandZone(commander, { zone: 'battlefield', seat: 1 })).toBe(false)
    expect(asksCommandZone(card('x'), { zone: 'graveyard' })).toBe(false)
  })

  it("doesn't ask for a commander that's in the command zone already", () => {
    expect(asksCommandZone(card('c', { commander: true, zone: 'command', pos: null }), { zone: 'graveyard' })).toBe(false)
  })

  it('shortens common counters', () => {
    expect(counterTag('+1/+1', 3)).toBe('+3/+3')
    expect(counterTag('-1/-1', 1)).toBe('−1/−1')
    expect(counterTag('loyalty', 4)).toBe('◆4')
    expect(counterTag('charge', 2)).toBe('charge 2')
  })

  it("offers one more or one fewer of each kind of counter on the cards, but +1/+1, which has its own items", () => {
    const clock = card('a', { counters: { hour: 2, '+1/+1': 1 } })
    const other = card('b', { counters: { charge: 3, hour: 1 } })
    expect(menuCounters([clock, other])).toEqual(['hour', 'charge'])
    expect(menuCounters([card('c')])).toEqual([])
  })

  it('offers the usual counters, then the others on the table', () => {
    const cards = [card('a', { counters: { hour: 2, loyalty: 3 } }), card('b', { counters: { verse: 1, hour: 1 } })]
    expect(counterChoices(cards)).toEqual([...COMMON_COUNTERS, 'hour', 'verse'])
    expect(counterChoices([])).toEqual(COMMON_COUNTERS)
  })

  it("reads the board's keys, and none right after a g", () => {
    for (const mac of [true, false]) {
      expect(boardKey(key('t'), false, mac)).toBe('tap')
      expect(boardKey(key('='), false, mac)).toBe('plus')
      expect(boardKey(key('Tab'), false, mac)).toBe('switch')
      expect(boardKey(key('Tab', { shiftKey: true }), false, mac)).toBeNull()
      expect(boardKey(key('d', { ctrlKey: true }), false, mac)).toBeNull()
      expect(boardKey(key('d', { metaKey: true }), false, mac)).toBeNull()
      expect(boardKey(key('d'), true, mac)).toBeNull()
      expect(boardKey(key('x'), false, mac)).toBeNull()
    }
  })

  it('undoes with Cmd+Z on a Mac and Ctrl+Z on Windows, never with Shift', () => {
    expect(boardKey(key('z', { metaKey: true }), false, true)).toBe('undo')
    expect(boardKey(key('Z', { metaKey: true }), false, true)).toBe('undo')
    expect(boardKey(key('z', { metaKey: true, shiftKey: true }), false, true)).toBeNull()
    // Control-Z isn't undo on a Mac (Control-click is its right-click; Control-letter types in some fields).
    expect(boardKey(key('z', { ctrlKey: true }), false, true)).toBeNull()
    expect(boardKey(key('z', { ctrlKey: true }), false, false)).toBe('undo')
    expect(boardKey(key('z', { ctrlKey: true, shiftKey: true }), false, false)).toBeNull()
    expect(boardKey(key('z', { ctrlKey: true, altKey: true }), false, false)).toBeNull()
    // The Windows key with Z is Windows' own.
    expect(boardKey(key('z', { metaKey: true }), false, false)).toBeNull()
    // Undo works right after a g too: it's no page letter.
    expect(boardKey(key('z', { ctrlKey: true }), true, false)).toBe('undo')
  })
})
