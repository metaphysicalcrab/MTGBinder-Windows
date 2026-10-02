import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onOverlayEntry, openOverlayEntry } from '../../src/web/lib/back-to-close.ts'

/**
 * A browser window's history, enough for overlays: entries and the one shown, popstate, and Back, which (as in a
 * browser) happens a moment after it's asked for. `press.back()` is the phone's Back.
 */
function browser() {
  const entries: unknown[] = [{ idx: 0, key: 'page' }]
  let at = 0
  const listeners = new Set<() => void>()
  const step = (to: number) => {
    at = to
    for (const listener of [...listeners]) listener()
  }
  const window = {
    scrollX: 0,
    scrollY: 0,
    scrollTo: vi.fn((x: number, y: number) => Object.assign(window, { scrollX: x, scrollY: y })),
    requestAnimationFrame: (run: () => void) => setTimeout(run),
    addEventListener: (type: string, listener: () => void) => type === 'popstate' && listeners.add(listener),
    removeEventListener: (type: string, listener: () => void) => type === 'popstate' && listeners.delete(listener),
    history: {
      get state() {
        return entries[at]
      },
      get length() {
        return entries.length
      },
      pushState(state: unknown, _title: string) {
        entries.splice(at + 1, Infinity, structuredClone(state))
        at++
      },
      replaceState(state: unknown, _title: string) {
        entries[at] = structuredClone(state)
      },
      back: vi.fn(() => {
        setTimeout(() => at > 0 && step(at - 1))
      }),
    },
  }
  vi.stubGlobal('window', window)
  return {
    window,
    entries,
    at: () => at,
    press: { back: () => step(at - 1), forward: () => step(at + 1) },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('openOverlayEntry', () => {
  it("adds an entry a moment after opening, keeping the page's state, and Back closes the overlay", () => {
    const b = browser()
    const onBack = vi.fn()
    const close = openOverlayEntry(onBack)
    expect(b.entries).toHaveLength(1)
    vi.runAllTimers()
    expect(b.entries).toHaveLength(2)
    expect(b.window.history.state).toMatchObject({ idx: 0, key: 'page' })
    expect(onOverlayEntry()).toBe(true)
    b.press.back()
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(onOverlayEntry()).toBe(false)
    // The overlay closes in turn; its entry is gone already.
    close()
    vi.runAllTimers()
    expect(b.window.history.back).not.toHaveBeenCalled()
    expect(b.at()).toBe(0)
  })

  it('takes its entry back off when closed another way, keeping the page where it was scrolled to', () => {
    const b = browser()
    const onBack = vi.fn()
    const close = openOverlayEntry(onBack)
    vi.runAllTimers()
    b.window.scrollTo(0, 600)
    close()
    vi.runAllTimers()
    expect(b.window.history.back).toHaveBeenCalledTimes(1)
    expect(b.at()).toBe(0)
    expect(onBack).not.toHaveBeenCalled()
    expect(b.window.scrollTo).toHaveBeenLastCalledWith(0, 600)
  })

  it('adds one entry when opened, closed and opened again at once, as StrictMode runs an effect twice', () => {
    const b = browser()
    openOverlayEntry(() => {})()
    const close = openOverlayEntry(() => {})
    vi.runAllTimers()
    expect(b.entries).toHaveLength(2)
    close()
    vi.runAllTimers()
    expect(b.at()).toBe(0)
    expect(b.window.history.back).toHaveBeenCalledTimes(1)
  })

  it('leaves an entry that a link closing the overlay replaced, or went on from', () => {
    const b = browser()
    const close = openOverlayEntry(() => {})
    vi.runAllTimers()
    close()
    b.window.history.replaceState({ idx: 0, key: 'deck' }, '')
    vi.runAllTimers()
    expect(b.window.history.back).not.toHaveBeenCalled()
    expect(b.entries).toEqual([{ idx: 0, key: 'page' }, { idx: 0, key: 'deck' }])

    const next = openOverlayEntry(() => {})
    vi.runAllTimers()
    next()
    b.window.history.pushState({ idx: 1, key: 'settings' }, '')
    vi.runAllTimers()
    expect(b.window.history.back).not.toHaveBeenCalled()
  })

  it('adds another entry after a navigation from its own replaced it (a search with the import panel open)', () => {
    const b = browser()
    const panel = vi.fn()
    const first = openOverlayEntry(panel)
    vi.runAllTimers()
    // The search sees it's on the overlay's entry, and replaces it rather than leaving it in the history...
    expect(onOverlayEntry()).toBe(true)
    b.window.history.replaceState({ idx: 0, key: 'search' }, '')
    // ...and the panel, seeing the new location (useBackToClose's entryKey), gives up its old entry and adds another.
    first()
    const second = openOverlayEntry(panel)
    vi.runAllTimers()
    expect(b.window.history.back).not.toHaveBeenCalled()
    expect(b.entries).toEqual([{ idx: 0, key: 'page' }, { idx: 0, key: 'search' }, { idx: 0, key: 'search', binderOverlay: expect.any(Number) }])
    // Back closes the panel and keeps the search.
    b.press.back()
    expect(panel).toHaveBeenCalledTimes(1)
    expect(b.window.history.state).toEqual({ idx: 0, key: 'search' })
    second()
    vi.runAllTimers()
    expect(b.window.history.back).not.toHaveBeenCalled()
  })

  it('closes stacked overlays one Back at a time, the top one first', () => {
    const b = browser()
    const panel = vi.fn()
    const drawer = vi.fn()
    openOverlayEntry(panel)
    vi.runAllTimers()
    openOverlayEntry(drawer)
    vi.runAllTimers()
    b.press.back()
    expect([panel.mock.calls.length, drawer.mock.calls.length]).toEqual([0, 1])
    b.press.back()
    expect([panel.mock.calls.length, drawer.mock.calls.length]).toEqual([1, 1])
  })

  it("doesn't close an overlay closed by Escape when the one under it takes its entry off", () => {
    const b = browser()
    const panel = vi.fn()
    openOverlayEntry(panel)
    vi.runAllTimers()
    const closeDrawer = openOverlayEntry(() => {})
    vi.runAllTimers()
    closeDrawer()
    vi.runAllTimers()
    expect(b.at()).toBe(1)
    expect(panel).not.toHaveBeenCalled()
    expect(onOverlayEntry()).toBe(true)
  })
})
