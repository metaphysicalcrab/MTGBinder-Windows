import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { useBackToClose } from '../lib/back-to-close.ts'
import { SHORTCUTS } from '../lib/shortcuts.ts'

/**
 * Opens the keyboard shortcuts list. Layout provides it, so a page can offer a button for the list (Library's Getting
 * started, for someone who doesn't know `?` yet). Outside Layout it does nothing.
 */
export const OpenShortcutsContext = createContext<() => void>(() => {})

/** The function that opens the keyboard shortcuts list. */
export function useOpenShortcuts(): () => void {
  return useContext(OpenShortcutsContext)
}

/** The keyboard shortcuts, as `?` shows them: a modal dialog that Escape, Back, a click outside, or Close closes. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useBackToClose(true, onClose)
  // What had focus before, read on the first render (an effect would run again under StrictMode, after focus moved).
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null))

  useEffect(() => {
    closeRef.current?.focus()
    return () => opener?.focus()
  }, [opener])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button aria-label="Close keyboard shortcuts" tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-black/60" />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-heading"
        className="relative w-full max-w-md rounded-xl border border-stone-800 bg-stone-950 p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="shortcuts-heading" className="font-serif text-xl text-stone-50">
            Keyboard shortcuts
          </h2>
          <button ref={closeRef} onClick={onClose} className="rounded px-2 py-1 text-sm text-stone-400 hover:bg-stone-800 hover:text-stone-100">
            Close ✕
          </button>
        </div>
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-sm">
          {SHORTCUTS.map((s) => (
            <div key={s.keys.join(' ')} className="contents">
              <dt className="flex gap-1">
                {s.keys.map((key) => (
                  <kbd key={key} className="rounded border border-stone-700 bg-stone-900 px-1.5 font-mono text-xs text-stone-200">
                    {key}
                  </kbd>
                ))}
              </dt>
              <dd className="text-stone-300">
                {s.does}
                {s.where && <span className="text-stone-500"> (on the {s.where} page)</span>}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-xs text-stone-500">
          Shortcuts wait while a text field or dropdown has focus. Space still captures on a dropdown, instead of opening it.
        </p>
      </section>
    </div>
  )
}
