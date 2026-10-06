import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router'
import { useBackToClose } from '../lib/back-to-close.ts'

/** A page's icon: a few strokes, in the text's color. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-6">
      {children}
    </svg>
  )
}

const ICONS: Record<string, ReactNode> = {
  '/library': (
    <Icon>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 3v18M5 8h2M5 12h2M5 16h2" />
    </Icon>
  ),
  '/search': (
    <Icon>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.5-4.5" />
    </Icon>
  ),
  '/scan': (
    <Icon>
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
      <rect x="9" y="8" width="6" height="8" rx="1" />
    </Icon>
  ),
  '/decks': (
    <Icon>
      <rect x="8" y="7" width="11" height="14" rx="1.5" />
      <path d="M5 17V5.5A1.5 1.5 0 0 1 6.5 4H15" />
    </Icon>
  ),
  '/sets': (
    <Icon>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1" />
    </Icon>
  ),
  '/brainstorm': (
    <Icon>
      <path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4 4v-4H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
    </Icon>
  ),
  '/playtest': (
    <Icon>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="m10 9 5 3-5 3z" />
    </Icon>
  ),
  '/settings': (
    <Icon>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </Icon>
  ),
}

const MORE_ICON = (
  <Icon>
    <circle cx="6" cy="12" r="1.25" fill="currentColor" />
    <circle cx="12" cy="12" r="1.25" fill="currentColor" />
    <circle cx="18" cy="12" r="1.25" fill="currentColor" />
  </Icon>
)

/** The bottom tabs: the pages used most on a phone. */
const TABS = [
  { to: '/library', label: 'Library' },
  { to: '/search', label: 'Search' },
  { to: '/scan', label: 'Scan' },
  { to: '/decks', label: 'Decks' },
]

/** The rest, under More. */
const MORE = [
  { to: '/sets', label: 'Sets' },
  { to: '/brainstorm', label: 'Brainstorm' },
  { to: '/playtest', label: 'Playtest' },
  { to: '/settings', label: 'Settings' },
]

const onPage = (pathname: string, to: string) => pathname === to || pathname.startsWith(`${to}/`)

const tab = (active: boolean) =>
  `flex h-14 w-full flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${active ? 'text-amber-300' : 'text-stone-400'}`

/**
 * The pages, as tabs along the bottom of the window below lg, where the header has no room for them (a phone, a
 * portrait tablet, a narrow window): Library, Search, Scan, Decks, and More for the rest. Pages leave room for it with
 * `pb-nav`. `replace`: a tab replaces the history entry an open overlay added (see useOnOverlayEntry).
 */
export function TabBar({
  covered,
  replace,
  moreOpen,
  onMoreChange,
}: {
  covered: boolean
  replace: boolean
  moreOpen: boolean
  onMoreChange: (open: boolean) => void
}) {
  const { pathname } = useLocation()
  const closeMore = useCallback(() => onMoreChange(false), [onMoreChange])
  const moreActive = moreOpen || MORE.some((page) => onPage(pathname, page.to))
  return (
    <>
      <nav
        aria-label="Pages"
        inert={covered}
        className="fixed inset-x-0 bottom-0 z-30 border-t border-stone-800 bg-stone-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        <ul className="mx-auto grid max-w-xl grid-cols-5">
          {TABS.map((page) => (
            <li key={page.to}>
              <NavLink to={page.to} replace={replace} className={({ isActive }) => tab(isActive)}>
                {ICONS[page.to]}
                {page.label}
              </NavLink>
            </li>
          ))}
          <li>
            <button aria-haspopup="dialog" aria-expanded={moreOpen} onClick={() => onMoreChange(true)} className={tab(moreActive)}>
              {MORE_ICON}
              More
            </button>
          </li>
        </ul>
      </nav>
      {moreOpen && <MoreSheet pathname={pathname} replace={replace} onClose={closeMore} />}
    </>
  )
}

/** More's pages, in a sheet from the bottom that Back, Escape, or a tap outside closes. */
function MoreSheet({ pathname, replace, onClose }: { pathname: string; replace: boolean; onClose: () => void }) {
  const firstRef = useRef<HTMLAnchorElement>(null)
  // What had focus before, read on the first render (as in ShortcutsDialog).
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null))
  useBackToClose(true, onClose)

  useEffect(() => {
    firstRef.current?.focus()
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
    <div className="fixed inset-0 z-40 flex items-end">
      <button aria-label="Close" tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-black/60" />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="More pages"
        className="relative w-full rounded-t-2xl border-t border-stone-800 bg-stone-950 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] shadow-2xl shadow-black"
      >
        <div aria-hidden className="mx-auto mt-2 h-1 w-10 rounded-full bg-stone-700" />
        <ul className="mx-auto max-w-xl p-2">
          {MORE.map((page, i) => (
            <li key={page.to}>
              <NavLink
                ref={i === 0 ? firstRef : undefined}
                to={page.to}
                replace={replace}
                onClick={(e) => {
                  // The page that's open already: closing the sheet is all there is to do.
                  if (onPage(pathname, page.to)) e.preventDefault()
                  onClose()
                }}
                className={({ isActive }) =>
                  `flex min-h-14 items-center gap-4 rounded-lg px-4 text-base ${isActive ? 'bg-stone-900 text-amber-300' : 'text-stone-200'}`
                }
              >
                {ICONS[page.to]}
                {page.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
