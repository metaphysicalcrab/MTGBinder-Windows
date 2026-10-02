import { describe, expect, it } from 'vitest'
import { createGoTo, GO_TO, GO_TO_MS, isTypingTarget, shortcutAllowed, shortcutList, SHORTCUTS } from '../../src/web/lib/shortcuts.ts'

const press = (key: string, target: unknown = { tagName: 'BODY' }, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  target,
  ...mods,
})

describe('keyboard shortcuts', () => {
  it('goes to a page when its letter follows g in time', () => {
    const go = createGoTo()
    expect(go.press('g', 0)).toBeNull()
    expect(go.press('s', 400)).toBe('/search')
    // One page per g.
    expect(go.press('d', 500)).toBeNull()
    expect([go.press('g', 1000), go.press('d', 1000 + GO_TO_MS)]).toEqual([null, '/decks'])
    expect([go.press('g', 5000), go.press('c', 5000 + GO_TO_MS + 1)]).toEqual([null, null])
    // Another key after g, or a letter that names no page, goes nowhere.
    expect([go.press('g', 9000), go.press('x', 9100), go.press('s', 9200)]).toEqual([null, null, null])
    // Another g starts the wait over.
    expect([go.press('g', 10_000), go.press('g', 10_000 + GO_TO_MS), go.press('l', 10_000 + 2 * GO_TO_MS)]).toEqual([null, null, '/library'])
    // Look up is gone: h names no page.
    expect([go.press('g', 20_000), go.press('h', 20_100)]).toEqual([null, null])
  })

  it("has a letter for every page, each its own, in the header's order, and lists every shortcut", () => {
    expect(GO_TO.map((p) => p.path)).toEqual(['/library', '/scan', '/decks', '/playtest', '/search', '/sets', '/brainstorm', '/settings'])
    expect(new Set(GO_TO.map((p) => p.key)).size).toBe(GO_TO.length)
    expect(shortcutList(true).map((s) => s.keys.join(' '))).toEqual([
      '?', '/', 'g l', 'g c', 'g d', 'g p', 'g s', 'g e', 'g b', 'g t', 'Space', 'a', 't', 'f', '+ -', 'd', 'Tab', '⌘Z', 'Esc',
    ])
  })

  it('names undo as the computer does: ⌘Z on a Mac, Ctrl+Z on Windows', () => {
    const undo = (mac: boolean) => shortcutList(mac).find((s) => s.does === 'Undo')?.keys
    expect([undo(true), undo(false)]).toEqual([['⌘Z'], ['Ctrl+Z']])
    expect(SHORTCUTS).toHaveLength(shortcutList(false).length)
  })

  it('never fires while typing, with Ctrl, Cmd or Alt, or with the card details open', () => {
    expect(shortcutAllowed(press('g'), false)).toBe(true)
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) expect(shortcutAllowed(press('g', { tagName }), false)).toBe(false)
    expect(shortcutAllowed(press('g', { tagName: 'DIV', isContentEditable: true }), false)).toBe(false)
    expect(shortcutAllowed(press('g', { tagName: 'BUTTON' }), false)).toBe(true)
    for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) expect(shortcutAllowed(press('g', undefined, { [mod]: true }), false)).toBe(false)
    expect(shortcutAllowed(press('?'), true)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })

  it('fires on inputs nothing is typed into (a checkbox, a radio, a button), as Space capture does', () => {
    for (const type of ['checkbox', 'radio', 'button', 'Checkbox']) {
      expect([type, shortcutAllowed(press('g', { tagName: 'INPUT', type }), false)]).toEqual([type, true])
    }
    for (const type of ['text', 'search', 'number', 'Search', '']) {
      expect([type, shortcutAllowed(press('g', { tagName: 'INPUT', type }), false)]).toEqual([type, false])
    }
  })
})
