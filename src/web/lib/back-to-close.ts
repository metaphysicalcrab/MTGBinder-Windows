import { useEffect, useRef, useSyncExternalStore } from 'react'

/**
 * Android's Back (the gesture or the button) closes what's open over the page, as phone apps do, instead of leaving the
 * page under it (M13). An open overlay adds a history entry of its own, at the same address, marked with its id; Back
 * takes that entry off and the overlay closes. Closing it any other way (Escape, Close, a click outside) takes its
 * entry back off, so a later Back isn't spent on it. The router sees only a step to the address it already shows.
 */

const MARK = 'binderOverlay'

let nextId = 1
const watchers = new Set<() => void>()

const markOf = (state: unknown): unknown => (state !== null && typeof state === 'object' ? (state as Record<string, unknown>)[MARK] : undefined)

/** Whether the current history entry is an open overlay's. */
export function onOverlayEntry(): boolean {
  return typeof window !== 'undefined' && markOf(window.history.state) !== undefined
}

function changed() {
  for (const watcher of watchers) watcher()
}

/**
 * Gives an overlay its history entry while it's open, and calls `onBack` when Back takes the entry off. Returns what
 * to call when the overlay closes. The entry is added a moment later, not at once: StrictMode's second run of an
 * effect would otherwise add two, and a navigation the overlay's page makes as it opens (LibraryPage dropping the
 * state that opened its import panel) would replace the overlay's entry instead of the page's.
 */
export function openOverlayEntry(onBack: () => void): () => void {
  const id = nextId++
  let pushed = false
  let poppedOff = false
  const onPop = () => {
    if (pushed && !poppedOff && markOf(window.history.state) !== id) {
      poppedOff = true
      onBack()
    }
  }
  const pushing = setTimeout(() => {
    pushed = true
    // The page's own state (the router's key and index) is kept, so the router reads the entry as the page itself.
    const state = window.history.state as Record<string, unknown> | null
    window.history.pushState({ ...state, [MARK]: id }, '')
    changed()
  })
  window.addEventListener('popstate', onPop)
  return () => {
    window.removeEventListener('popstate', onPop)
    if (!pushed) return clearTimeout(pushing)
    if (poppedOff) return
    // A moment later, so that a link that closed the overlay as it left the page has replaced the entry, or gone on
    // from it: then it isn't this overlay's to take off.
    setTimeout(() => {
      if (markOf(window.history.state) === id) takeOff()
    })
  }
}

/**
 * Goes back off an overlay's entry, keeping the page where it's scrolled to: the browser would put it back where it was
 * when the overlay opened (an import panel scrolled through, say), just after the step's popstate.
 */
function takeOff() {
  const { scrollX, scrollY } = window
  const keep = () => {
    window.removeEventListener('popstate', keep)
    window.requestAnimationFrame(() => window.scrollTo(scrollX, scrollY))
  }
  window.addEventListener('popstate', keep)
  window.history.back()
}

/** Closes an overlay on Back while `open` (see openOverlayEntry). `onClose` may change from render to render. */
export function useBackToClose(open: boolean, onClose: () => void): void {
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    if (!open) return
    return openOverlayEntry(() => close.current())
  }, [open])
}

function watch(onChange: () => void): () => void {
  watchers.add(onChange)
  window.addEventListener('popstate', onChange)
  return () => {
    watchers.delete(onChange)
    window.removeEventListener('popstate', onChange)
  }
}

/**
 * Whether the current history entry is an open overlay's, for links that leave the page while one is open: they
 * replace the overlay's entry rather than going on from it, so Back from the next page goes straight to this one.
 */
export function useOnOverlayEntry(): boolean {
  return useSyncExternalStore(watch, onOverlayEntry, () => false)
}
