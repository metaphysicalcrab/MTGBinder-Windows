import { useEffect, useSyncExternalStore } from 'react'

/**
 * Overlays a page draws over the whole window (the Scan page's photo review, Settings' pairing dialog), as Layout's own
 * (the card drawer, the shortcuts, More) are: while one is open, Layout makes everything behind it inert, so Tab, a
 * screen reader, and a stray click stay in the overlay. Such an overlay is drawn outside the page (WindowOverlay), as
 * the page goes inert with the rest.
 */
let open = 0
const watchers = new Set<() => void>()

function changed() {
  for (const watcher of watchers) watcher()
}

/** Counts an overlay as covering the page while `covering`. */
export function useCoverPage(covering = true): void {
  useEffect(() => {
    if (!covering) return
    open++
    changed()
    return () => {
      open--
      changed()
    }
  }, [covering])
}

function watch(onChange: () => void): () => void {
  watchers.add(onChange)
  return () => watchers.delete(onChange)
}

/** Whether a page's overlay covers the window now. */
export function usePageCovered(): boolean {
  return useSyncExternalStore(
    watch,
    () => open > 0,
    () => false,
  )
}
