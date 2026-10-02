import { useCallback, useSyncExternalStore } from 'react'

/**
 * Which platform the page runs on, for the few things that differ (M13): the undo key, wording that names the computer
 * or the phone, sizes as the system's file manager counts them, and what the browser allows (the live camera). Layout
 * and tap targets go by the screen and the pointer instead (Tailwind's breakpoints and `pointer-coarse:`). Pure helpers
 * take the platform as an argument, so tests run the same on every OS; the constants read this browser.
 */
export type Platform = 'mac' | 'windows' | 'android' | 'other'

/** What the platform is read from: the user agent, and the platform Chromium (userAgentData) or the browser names. */
interface NavigatorLike {
  userAgent?: string
  platform?: string
  userAgentData?: { platform?: string }
}

/** The platform a browser says it runs on. Android first: its `navigator.platform` says Linux. */
export function detectPlatform(nav: NavigatorLike | undefined): Platform {
  if (!nav) return 'other'
  const agent = nav.userAgent ?? ''
  const name = nav.userAgentData?.platform || nav.platform || ''
  if (/android/i.test(agent) || /android/i.test(name)) return 'android'
  if (/^mac|macos/i.test(name) || (name === '' && /macintosh/i.test(agent))) return 'mac'
  if (/^win/i.test(name) || (name === '' && /windows/i.test(agent))) return 'windows'
  return 'other'
}

/**
 * Whether the page runs in Binder's desktop app, whose window names Electron in its user agent. It has no address bar,
 * and its server is Binder itself (under `pnpm start`, Node.js is).
 */
export function inBinderApp(userAgent: string): boolean {
  return userAgent.includes('Electron/')
}

/**
 * Whether a page's hostname is this computer's own: 127.0.0.1 (the desktop app), `localhost` (pnpm start, the dev
 * server) or [::1]. Only there can the server take the page as the PC's; anywhere else (the phones' listener, the dev
 * server's `--host` address) it's a phone's.
 */
export function isThisComputersHostname(hostname: string): boolean {
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname.toLowerCase())
}

const nav: (NavigatorLike & Partial<Navigator>) | undefined = typeof navigator === 'undefined' ? undefined : navigator

export const PLATFORM: Platform = detectPlatform(nav)
export const IS_MAC = PLATFORM === 'mac'
export const IS_WINDOWS = PLATFORM === 'windows'
export const IS_ANDROID = PLATFORM === 'android'
export const IN_DESKTOP_APP = inBinderApp(nav?.userAgent ?? '')
/** The live camera needs a secure context: localhost, the desktop app, or the phone over HTTPS (not plain HTTP). */
export const CAN_USE_LIVE_CAMERA =
  typeof window !== 'undefined' && window.isSecureContext && typeof nav?.mediaDevices?.getUserMedia === 'function'

/** The undo key, as the shortcuts list and buttons name it: ⌘Z on a Mac, Ctrl+Z elsewhere. */
export function undoKeyLabelFor(mac: boolean): string {
  return mac ? '⌘Z' : 'Ctrl+Z'
}

export const undoKeyLabel = undoKeyLabelFor(IS_MAC)

/** Whether a key press is undo: Cmd+Z on a Mac (Control-Z isn't), Ctrl+Z elsewhere; never with Shift or Alt. */
export function isUndoKey(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  mac = IS_MAC,
): boolean {
  const modifier = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return modifier && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z'
}

/**
 * Whether a media query matches the window, kept up to date as it changes (a phone turned on its side). Rendered without
 * a window (the tests' server rendering), it's false.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {}
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true,
    () => false,
  )
}

/**
 * Whether the main pointer is a finger (a phone or a tablet), as Tailwind's `pointer-coarse:` reads it, for what CSS
 * can't change: a placeholder, what Enter does. A touchscreen laptop's main pointer is its mouse or trackpad.
 */
export function useCoarsePointer(): boolean {
  return useMediaQuery('(pointer: coarse)')
}
