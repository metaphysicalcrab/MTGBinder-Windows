import { TEXT_INPUT_TYPES } from './capture.ts'
import { IS_MAC, undoKeyLabelFor } from './platform.ts'

/** The pages `g` then a letter goes to, in the order the header (Layout's NAV) and the shortcuts list show them. */
export const GO_TO: ReadonlyArray<{ key: string; path: string; label: string }> = [
  { key: 'l', path: '/library', label: 'Library' },
  { key: 'c', path: '/scan', label: 'Scan' },
  { key: 'd', path: '/decks', label: 'Decks' },
  { key: 'p', path: '/playtest', label: 'Playtest' },
  { key: 's', path: '/search', label: 'Search' },
  { key: 'e', path: '/sets', label: 'Sets' },
  { key: 'b', path: '/brainstorm', label: 'Brainstorm' },
  { key: 't', path: '/settings', label: 'Settings' },
]

/** How long after `g` the page letter may come. */
export const GO_TO_MS = 1500

/**
 * Every shortcut, for the list `?` opens: the keys, and what they do (`where` when only one page has it). Undo is ⌘Z on
 * a Mac and Ctrl+Z elsewhere.
 */
export function shortcutList(mac: boolean): ReadonlyArray<{ keys: string[]; does: string; where?: string }> {
  return [
    { keys: ['?'], does: 'Show these shortcuts' },
    { keys: ['/'], does: 'Find a card by name' },
    ...GO_TO.map((page) => ({ keys: ['g', page.key], does: `Go to ${page.label}` })),
    { keys: ['Space'], does: 'Capture the card in the guide', where: 'Scan' },
    { keys: ['a'], does: 'Switch between Auto and Manual capture', where: 'Scan' },
    { keys: ['t'], does: 'Tap or untap the card under the pointer, or the selection', where: 'Playtest' },
    { keys: ['f'], does: 'Flip the card under the pointer', where: 'Playtest' },
    { keys: ['+', '-'], does: 'Add or remove a +1/+1 counter', where: 'Playtest' },
    { keys: ['d'], does: 'Draw a card', where: 'Playtest' },
    { keys: ['Tab'], does: 'Switch side', where: 'Playtest' },
    { keys: [undoKeyLabelFor(mac)], does: 'Undo', where: 'Playtest' },
    { keys: ['Esc'], does: 'Close the card details or this list' },
  ]
}

/** The shortcuts on this computer. */
export const SHORTCUTS = shortcutList(IS_MAC)

/**
 * Whether keys pressed with focus on `target` type into it: a text-like input (a missing type is text), a textarea, a
 * select, or an editable element. A checkbox, a radio or a button-type input takes no typing, as for Space capture.
 */
export function isTypingTarget(target: { tagName: string; type?: string; isContentEditable?: boolean } | null): boolean {
  if (!target) return false
  if (target.tagName === 'INPUT') return TEXT_INPUT_TYPES.has((target.type ?? '').toLowerCase())
  return ['TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable === true
}

/**
 * Whether a key press can be a page shortcut: not typed into a field, not with Ctrl, Cmd or Alt (the browser's and the
 * Mac's own shortcuts), and not while a modal dialog (the card details) has its own keys.
 */
export function shortcutAllowed(
  e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; target: unknown },
  modalOpen: boolean,
): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || modalOpen) return false
  return !isTypingTarget(e.target as { tagName: string; type?: string; isContentEditable?: boolean } | null)
}

/**
 * The `g` then a letter sequence: feed it each allowed key press; it answers the path to go to once a page letter
 * follows `g` within GO_TO_MS, else null. Another `g` starts the wait over.
 */
export function createGoTo(timeoutMs = GO_TO_MS) {
  let pressedAt: number | null = null
  return {
    press(key: string, now: number): string | null {
      const armed = pressedAt !== null && now - pressedAt <= timeoutMs
      pressedAt = key === 'g' ? now : null
      return armed && key !== 'g' ? (GO_TO.find((page) => page.key === key)?.path ?? null) : null
    },
  }
}
