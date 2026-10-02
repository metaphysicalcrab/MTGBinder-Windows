import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { IS_MAC, useCoarsePointer } from '../../lib/platform.ts'
import { isTouch } from '../../lib/playtest-board.ts'

/** A menu's item; `image` (a small card image) shows beside its label. */
export type MenuItem = { label: string; onSelect: () => void; disabled?: boolean; hint?: string; image?: string | null } | 'separator'

export interface MenuState {
  x: number
  y: number
  title: string
  items: MenuItem[]
}

/**
 * A right-click menu at the pointer, kept inside the window. A click or right-click outside it, Escape, or choosing an
 * item closes it. Arrow keys move between its items. Where the main pointer is a finger (M13), it's a sheet along the
 * bottom of the window instead, with items a finger can hit, that a tap outside closes.
 */
export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [spot, setSpot] = useState({ left: menu.x, top: menu.y })
  const sheet = useCoarsePointer()
  // The kind of pointer that last went down on the backdrop: a finger's tap closes the menu on its click (see there).
  const downType = useRef('')

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // A sheet's items take no focus: one highlighted under a finger would look chosen. The sheet has it, for the keys.
    if (sheet) {
      el.focus()
      return
    }
    const { width, height } = el.getBoundingClientRect()
    // Kept on the window; a menu taller than it scrolls (a card with several kinds of counter has a long one).
    setSpot({ left: Math.max(8, Math.min(menu.x, window.innerWidth - width - 8)), top: Math.max(8, Math.min(menu.y, window.innerHeight - height - 8)) })
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [menu, sheet])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
        buttons[(at + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <>
      {/*
        Behind the menu and over the table, so a click or right-click outside the menu only closes it: it never
        reaches a card (a tap), a library (a draw), or another menu. A right-click (or, on a Mac, a Control-click)
        closes on its contextmenu, which must land here too, so its pointerdown leaves the backdrop in place. A finger
        closes it on its click, the end of its tap: closed as the finger comes down, the click would land on what's
        under the backdrop.
      */}
      <div
        aria-hidden
        onPointerDown={(e) => {
          downType.current = e.pointerType
          if (e.pointerType === 'mouse' && e.button === 0 && !(IS_MAC && e.ctrlKey)) onClose()
        }}
        onClick={() => {
          if (isTouch(downType.current)) onClose()
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
        className={`fixed inset-0 z-50 ${sheet ? 'bg-black/50' : ''}`}
      />
      <div
        ref={ref}
        role="menu"
        aria-label={menu.title}
        tabIndex={sheet ? -1 : undefined}
        style={sheet ? undefined : spot}
        onContextMenu={(e) => e.preventDefault()}
        className={
          sheet
            ? 'fixed inset-x-0 bottom-0 z-50 mx-auto max-h-[70dvh] max-w-lg overflow-y-auto overscroll-contain rounded-t-2xl border-t border-stone-700 bg-stone-900 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] text-base shadow-2xl shadow-black outline-none'
            : 'fixed z-50 max-h-[calc(100dvh-16px)] min-w-52 overflow-y-auto rounded-lg border border-stone-700 bg-stone-900 py-1 text-sm shadow-2xl shadow-black/60'
        }
      >
        <div className={sheet ? 'truncate px-4 pt-3 pb-1 text-sm text-stone-400' : 'truncate px-3 pt-1 pb-1.5 text-xs text-stone-500'}>{menu.title}</div>
        {menu.items.map((item, i) =>
          item === 'separator' ? (
            <div key={i} className="my-1 border-t border-stone-800" />
          ) : (
            <button
              key={i}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                onClose()
                item.onSelect()
              }}
              className={`flex w-full items-center justify-between gap-4 text-left text-stone-200 outline-none hover:bg-stone-800 focus:bg-stone-800 disabled:text-stone-600 disabled:hover:bg-transparent ${sheet ? 'min-h-12 px-4 py-2' : 'px-3 py-1'}`}
            >
              <span className="flex items-center gap-2">
                {item.image && <img src={item.image} alt="" draggable={false} className="h-8 w-[23px] shrink-0 rounded-sm object-cover" />}
                {item.label}
              </span>
              {/* A key is no use to a finger. */}
              {item.hint && !sheet && <kbd className="font-mono text-xs text-stone-500">{item.hint}</kbd>}
            </button>
          ),
        )}
      </div>
    </>
  )
}

/**
 * A modal dialog: Escape or a click outside closes it. Focus starts on its default (the element marked
 * `data-autofocus`), or else its first field or button. Where the main pointer is a finger (M13), a text field isn't
 * focused, as its keyboard would cover half the screen; a number's is (Draw…'s number is the whole dialog).
 */
export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLElement>(null)
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null))
  const coarse = useCoarsePointer()

  useEffect(() => {
    // Two lookups, not one list of selectors: one list finds whichever comes first on the page, not the default.
    const section = ref.current
    const first =
      section?.querySelector<HTMLElement>('[data-autofocus]') ??
      section?.querySelector<HTMLElement>('input, select, button:not([aria-label="Close"])')
    if (coarse && first && bringsKeyboard(first)) section?.focus()
    else first?.focus()
    return () => opener?.focus()
    // Where focus starts is chosen once, as the dialog opens: not again if the pointer changes (so not on `coarse`).
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
      <button aria-label="Close" tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-black/60" />
      <section
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={coarse ? -1 : undefined}
        className={`relative max-h-[90dvh] w-full overflow-auto rounded-xl border border-stone-800 bg-stone-950 p-5 shadow-2xl outline-none ${wide ? 'max-w-4xl' : 'max-w-md'}`}
      >
        <h2 className="mb-4 font-serif text-xl text-stone-50">{title}</h2>
        {children}
      </section>
    </div>
  )
}

/** Whether focusing an element brings up a phone's keyboard for text: a text field's, not a number's or a button's. */
function bringsKeyboard(el: HTMLElement): boolean {
  if (el instanceof HTMLTextAreaElement) return true
  if (!(el instanceof HTMLInputElement)) return false
  return !['number', 'checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(el.type)
}
