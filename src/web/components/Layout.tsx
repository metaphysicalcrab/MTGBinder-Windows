import { useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { onOverlayEntry, useOnOverlayEntry } from '../lib/back-to-close.ts'
import { useCardDrawer } from '../lib/card-drawer.tsx'
import { createGoTo, GO_TO, shortcutAllowed } from '../lib/shortcuts.ts'
import { useBulkRefresh } from '../lib/use-bulk-status.ts'
import { CardDrawer } from './CardDrawer.tsx'
import { QuickFind } from './QuickFind.tsx'
import { OpenShortcutsContext, ShortcutsDialog } from './ShortcutsDialog.tsx'
import { TabBar } from './TabBar.tsx'

/** Top-level navigation: the pages `g` then a letter goes to (GO_TO), in the same order. */
export const NAV: Array<{ to: string; label: string }> = GO_TO.map(({ path, label }) => ({ to: path, label }))

export function Layout() {
  useBulkRefresh() // keeps lookups and searches fresh after a card-data refresh, whichever page is open
  const [helpOpen, setHelpOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const navigate = useNavigate()
  /** Opens the shortcuts list: the header's ? button, and pages through OpenShortcutsContext. */
  const openShortcuts = useCallback(() => setHelpOpen(true), [])
  const closeShortcuts = useCallback(() => setHelpOpen(false), [])
  // While the card drawer, the shortcuts or More's pages are open, the page behind can't be focused or clicked, so Tab
  // stays there.
  const drawerOpen = useCardDrawer().cardId !== null
  const covered = drawerOpen || helpOpen || moreOpen
  // The playtest's table fills the window below the header (spec §5.9.3).
  const table = useLocation().pathname === '/playtest'
  // Leaving the page with an overlay open (Library's import panel, say) replaces the overlay's history entry, so Back
  // from the next page comes straight back here.
  const fromOverlay = useOnOverlayEntry()

  // `?` lists the shortcuts; `g` then a letter goes to a page. The card finder's `/` and the Scan page's keys are
  // their own.
  useEffect(() => {
    const goTo = createGoTo()
    const onKey = (e: KeyboardEvent) => {
      if (!shortcutAllowed(e, document.querySelector('[aria-modal="true"]') !== null)) return
      if (e.key === '?') {
        e.preventDefault()
        setHelpOpen(true)
        return
      }
      const path = goTo.press(e.key, performance.now())
      if (path !== null) {
        e.preventDefault()
        // As the header's links do (Library's import panel is open, say).
        void navigate(path, { replace: onOverlayEntry() })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  // Below lg the header holds the name and the card finder, and the pages are tabs along the bottom (TabBar); pages
  // leave room for the tabs with pb-nav. From lg up, the header holds them all, as on the desktop.
  return (
    <OpenShortcutsContext value={openShortcuts}>
      <div className={`bg-stone-950 pb-nav text-stone-200 ${table ? 'flex h-dvh flex-col' : 'min-h-dvh'}`}>
        <header inert={covered} className="sticky top-0 z-20 border-b border-stone-800/80 bg-stone-950/90 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5 lg:gap-6">
            <NavLink to="/library" replace={fromOverlay} className="shrink-0 font-serif text-xl font-semibold tracking-wide text-amber-400">
              Binder
            </NavLink>
            <nav className="hidden gap-1 lg:flex">
              {NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  replace={fromOverlay}
                  className={({ isActive }) =>
                    `rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-stone-800 text-stone-50' : 'text-stone-400 hover:text-stone-100'}`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
            <div className="ml-auto min-w-0 flex-1 lg:w-full lg:max-w-sm lg:min-w-auto lg:flex-initial">
              <QuickFind />
            </div>
            {/* The shortcuts are keys: no use to a finger. */}
            <button
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (?)"
              onClick={openShortcuts}
              className="size-8 shrink-0 rounded-full border border-stone-700 text-sm text-stone-400 hover:bg-stone-800 hover:text-stone-100 pointer-coarse:hidden"
            >
              ?
            </button>
          </div>
        </header>
        <main
          inert={covered}
          className={table ? 'min-h-0 w-full flex-1 overflow-auto px-3 py-2' : 'mx-auto max-w-7xl px-3 py-4 sm:px-4 sm:py-8'}
        >
          <Outlet />
        </main>
        <TabBar covered={covered} replace={fromOverlay} moreOpen={moreOpen} onMoreChange={setMoreOpen} />
        <CardDrawer />
        {helpOpen && <ShortcutsDialog onClose={closeShortcuts} />}
      </div>
    </OpenShortcutsContext>
  )
}
