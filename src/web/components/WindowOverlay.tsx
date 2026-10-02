import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useCoverPage } from '../lib/cover.ts'

/**
 * An overlay over the whole window, drawn by a page: it's put at the end of the document, outside the page, and the
 * page behind it is made inert while it's open (lib/cover.ts). When it closes, focus goes back to what had it before,
 * once the page is no longer inert: Layout lifts that after the overlay has gone, too late for the overlay's own.
 */
export function WindowOverlay({ children }: { children: ReactNode }) {
  // What had focus before, read on the first render (as in ShortcutsDialog).
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null))
  useCoverPage()
  useEffect(
    () => () => {
      setTimeout(() => {
        if (!document.activeElement || document.activeElement === document.body) opener?.focus()
      })
    },
    [opener],
  )
  return createPortal(children, document.body)
}
