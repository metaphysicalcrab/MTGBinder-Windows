import { describe, expect, it } from 'vitest'
import { dragStartPx, holdOpensMenu, isTouch, LONG_PRESS_MS, movedFar, type Press, tapAction, TABLE_MIN_WIDTH } from '../../src/web/lib/playtest-board.ts'

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
      expect(tapAction('battlefield', { touch, shift: false }, none)).toBe('tap')
      expect(tapAction('battlefield', { touch, shift: true }, none)).toBe('select')
      expect(tapAction('battlefield', { touch, shift: false }, { attaching: false, selecting: true })).toBe('select')
      // Attaching comes first: the card tapped is the host, whatever the selection.
      expect(tapAction('battlefield', { touch, shift: true }, { attaching: true, selecting: true })).toBe('attach')
    }
  })

  it("opens a finger's menu off the battlefield (Play or Resolve first), and leaves a mouse's click to its double-click", () => {
    const none = { attaching: false, selecting: false }
    for (const source of ['hand', 'command', 'stack', 'pile'] as const) {
      expect(tapAction(source, { touch: true, shift: false }, none)).toBe('menu')
      expect(tapAction(source, { touch: false, shift: false }, none)).toBe('none')
      // Neither Select nor attaching changes a tap off the battlefield.
      expect(tapAction(source, { touch: true, shift: true }, { attaching: true, selecting: true })).toBe('menu')
    }
  })

  it("needs a tablet's width for the table, which a phone has on its side", () => {
    // Tailwind's md: a Pixel 7 is 412 px wide upright (too narrow) and 915 on its side.
    expect(TABLE_MIN_WIDTH).toBe(768)
  })
})
