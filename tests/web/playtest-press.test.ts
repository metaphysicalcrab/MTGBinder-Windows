import { describe, expect, it } from 'vitest'
import {
  DOUBLE_TAP_MS,
  dragStartPx,
  holdOpensMenu,
  isTouch,
  LONG_PRESS_MS,
  movedFar,
  type Press,
  SMALL_SCREEN_QUERY,
  smallScreenText,
  TABLE_MIN_SCREEN_HEIGHT,
  TABLE_MIN_WIDTH,
  TABLET_SCREEN_QUERY,
  tapAction,
  UPRIGHT_SCREEN_QUERY,
} from '../../src/web/lib/playtest-board.ts'

// A press on the table by a mouse, a finger, or a pen (M13): when it's a drag, when holding it opens a menu, and what
// it does when it comes up where it went down.

const press = (touch: boolean, extra: Partial<Press> = {}): Press => ({ start: { x: 100, y: 100 }, touch, moved: false, ...extra })

describe('a press on the playtest table', () => {
  it("takes a finger and a pen for touch, and a mouse (or a pointer it can't tell) for a mouse", () => {
    expect(isTouch('touch')).toBe(true)
    expect(isTouch('pen')).toBe(true)
    expect(isTouch('mouse')).toBe(false)
    expect(isTouch('')).toBe(false)
  })

  it('is a drag past 5 px with a mouse, and past 10 with a finger, which wobbles', () => {
    expect(dragStartPx(false)).toBe(5)
    expect(dragStartPx(true)).toBe(10)
    expect(movedFar(press(false), { x: 104, y: 102 })).toBe(false)
    expect(movedFar(press(false), { x: 104, y: 104 })).toBe(true)
    expect(movedFar(press(true), { x: 106, y: 106 })).toBe(false)
    expect(movedFar(press(true), { x: 108, y: 107 })).toBe(true)
    expect(movedFar(press(true), { x: 100, y: 89 })).toBe(true)
  })

  it('stays a drag once it is one, back where it started or not', () => {
    expect(movedFar(press(true, { moved: true }), { x: 100, y: 100 })).toBe(true)
    expect(movedFar(press(false, { moved: true }), { x: 101, y: 100 })).toBe(true)
  })

  it('opens its menu when a finger holds still, not once it has dragged, and never for a mouse (which right-clicks)', () => {
    expect(LONG_PRESS_MS).toBeGreaterThanOrEqual(400)
    expect(LONG_PRESS_MS).toBeLessThanOrEqual(500)
    expect(holdOpensMenu(press(true))).toBe(true)
    expect(holdOpensMenu(press(true, { moved: true }))).toBe(false)
    expect(holdOpensMenu(press(false))).toBe(false)
  })

  it('taps a card on the battlefield, adds it to the selection with Shift or Select, or attaches cards to it', () => {
    const none = { attaching: false, selecting: false }
    for (const touch of [false, true]) {
      // Right after a tap played a card from hand, too: a double-tap on the battlefield taps and untaps.
      for (const sincePlay of [Infinity, 100]) {
        expect(tapAction('battlefield', { touch, shift: false, sincePlay }, none)).toBe('tap')
        expect(tapAction('battlefield', { touch, shift: true, sincePlay }, none)).toBe('select')
        expect(tapAction('battlefield', { touch, shift: false, sincePlay }, { attaching: false, selecting: true })).toBe('select')
        // Attaching comes first: the card tapped is the host, whatever the selection.
        expect(tapAction('battlefield', { touch, shift: true, sincePlay }, { attaching: true, selecting: true })).toBe('attach')
      }
    }
  })

  it("plays a card a finger taps in hand or the command zone, and leaves a mouse's click to its double-click", () => {
    const none = { attaching: false, selecting: false }
    for (const source of ['hand', 'command'] as const) {
      expect(tapAction(source, { touch: true, shift: false, sincePlay: Infinity }, none)).toBe('play')
      expect(tapAction(source, { touch: false, shift: false, sincePlay: Infinity }, none)).toBe('none')
      // Neither Select nor attaching changes a tap off the battlefield.
      expect(tapAction(source, { touch: true, shift: true, sincePlay: Infinity }, { attaching: true, selecting: true })).toBe('play')
    }
  })

  it("plays one card for a double-tap, not the one that moves under the finger as well, then plays the next tap's", () => {
    const none = { attaching: false, selecting: false }
    expect(DOUBLE_TAP_MS).toBeGreaterThanOrEqual(300)
    expect(DOUBLE_TAP_MS).toBeLessThanOrEqual(500)
    for (const source of ['hand', 'command'] as const) {
      expect(tapAction(source, { touch: true, shift: false, sincePlay: 0 }, none)).toBe('none')
      expect(tapAction(source, { touch: true, shift: false, sincePlay: DOUBLE_TAP_MS - 1 }, none)).toBe('none')
      expect(tapAction(source, { touch: true, shift: false, sincePlay: DOUBLE_TAP_MS }, none)).toBe('play')
      expect(tapAction(source, { touch: true, shift: false, sincePlay: 2000 }, none)).toBe('play')
    }
  })

  it("opens a finger's menu on the stack (Resolve first) and in a pile, and leaves a mouse's click to its double-click", () => {
    const none = { attaching: false, selecting: false }
    for (const source of ['stack', 'pile'] as const) {
      for (const sincePlay of [Infinity, 100]) {
        expect(tapAction(source, { touch: true, shift: false, sincePlay }, none)).toBe('menu')
        expect(tapAction(source, { touch: false, shift: false, sincePlay }, none)).toBe('none')
        expect(tapAction(source, { touch: true, shift: true, sincePlay }, { attaching: true, selecting: true })).toBe('menu')
      }
    }
  })

  it("needs a tablet for the table: a tablet's width, and a screen taller than a phone's on its side", () => {
    // Tailwind's md: a Pixel 7 is 412 px wide upright (too narrow).
    expect(TABLE_MIN_WIDTH).toBe(768)
    // A phone on its side is 360–430 px tall (a Pixel 7's 412); Android's smallest tablet, 600.
    expect(TABLE_MIN_SCREEN_HEIGHT).toBeGreaterThan(430)
    expect(TABLE_MIN_SCREEN_HEIGHT).toBeLessThanOrEqual(600)
    // The screen's height, not the window's, which a tablet's keyboard shortens; either one too small is enough.
    expect(SMALL_SCREEN_QUERY).toBe(`(width < 768px), (device-height < ${TABLE_MIN_SCREEN_HEIGHT}px)`)
  })

  it('tells a tablet how to make room for the table, and a phone that it needs a tablet', () => {
    // A tablet's screen is 600 px or more either way, a phone's 360–430 across; upright goes by the screen, not the window.
    expect(TABLET_SCREEN_QUERY).toBe('(device-width >= 600px) and (device-height >= 600px)')
    expect(UPRIGHT_SCREEN_QUERY).toBe('(device-aspect-ratio < 1)')
    // A Galaxy Tab S4 upright (712 px wide), and on its side with another app beside Binder.
    expect(smallScreenText({ tablet: true, upright: true })).toBe('Playtest needs a wider screen: turn the tablet on its side.')
    expect(smallScreenText({ tablet: true, upright: false })).toBe('Playtest needs a wider window: give Binder the whole screen.')
    for (const upright of [true, false]) {
      expect(smallScreenText({ tablet: false, upright })).toBe('Playtest needs a bigger screen: a tablet or the PC.')
    }
  })
})
