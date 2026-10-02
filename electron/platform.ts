// What the desktop app does differently on a Mac, on Windows, and on Linux (spec §3.4): its menus, its tray icon and
// what clicking it does, the window's icon, and the camera's permission. Pure, with the platform passed in, so each
// platform's choices are checked on any computer; main.ts applies them.
import path from 'node:path'
import type { MenuItemConstructorOptions } from 'electron'
import type { LanSummary } from '../src/shared/types.ts'

/**
 * The app's ID on Windows (package.json's build.appId): the installer stamps its Start menu shortcut with it, and the
 * window, its taskbar button and notifications must carry the same one to be grouped as one app.
 */
export const APP_USER_MODEL_ID = 'local.binder.app'

/** The switch that asks a running Binder to quit (`Binder.exe --quit`), as Quit Binder does. */
export const QUIT_SWITCH = '--quit'

/**
 * Whether a launch asks Binder to quit: its command line has --quit (in any case, as Windows switches go), or a second
 * launch's data says so (requestSingleInstanceLock's, which arrives whatever Chromium does to the command line).
 */
export function quitRequested(argv: readonly string[], data?: unknown): boolean {
  if (argv.some((arg) => arg.toLowerCase() === QUIT_SWITCH)) return true
  return typeof data === 'object' && data !== null && (data as { quit?: unknown }).quit === true
}

/**
 * The menu bar. A Mac's: Binder, File (Close Window, Cmd+W: the window closes, Binder keeps running), Edit, View, and
 * Window. Elsewhere, where the Mac's app and Window menus mean nothing: File (Close window, Ctrl+W; Quit Binder,
 * Ctrl+Q), Edit, View, and Help (About Binder). View: reload, the developer tools when run from the project, zoom, and
 * full screen.
 */
export function menuTemplate(
  platform: NodeJS.Platform,
  options: { packaged: boolean; quit: () => void },
): MenuItemConstructorOptions[] {
  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { role: 'reload' },
      ...(options.packaged ? [] : [{ role: 'toggleDevTools' } as const]),
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  }
  if (platform === 'darwin') {
    return [{ role: 'appMenu' }, { role: 'fileMenu' }, { role: 'editMenu' }, view, { role: 'windowMenu' }]
  }
  return [
    {
      label: 'File',
      submenu: [
        { role: 'close', label: 'Close window', accelerator: 'Ctrl+W' },
        { type: 'separator' },
        { label: 'Quit Binder', accelerator: 'Ctrl+Q', click: options.quit },
      ],
    },
    { role: 'editMenu' },
    view,
    { label: 'Help', submenu: [{ role: 'about' }] },
  ]
}

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix)

/**
 * The tray icon, drawn by `pnpm icons` into build/icons: on a Mac the black menu-bar glyph, a template image macOS tints
 * for a light or dark menu bar (its @2x file beside it is picked up on its own); on Windows an .ico with every size
 * the notification area asks for, in amber on a dark page that reads on a light or dark taskbar; on Linux a PNG.
 */
export function trayIcon(platform: NodeJS.Platform, appRoot: string): { file: string; template: boolean } {
  const { join } = pathFor(platform)
  const icons = join(appRoot, 'build', 'icons')
  if (platform === 'darwin') return { file: join(icons, 'trayTemplate.png'), template: true }
  return { file: join(icons, platform === 'win32' ? 'tray.ico' : 'tray.png'), template: false }
}

/** What the tray icon's menu does. */
export interface TrayActions {
  open(): void
  /** Turns phone access on or off. */
  phoneAccess(enabled: boolean): void
  /** Opens Binder's window on Settings → Phone access. */
  phoneSettings(): void
  quit(): void
}

/** The address a phone opens while Binder listens for phones (the chosen one), else null. */
const phoneUrl = (lan: LanSummary | null) => (lan?.listening ? (lan.urls[0] ?? null) : null)

/**
 * The tray icon's menu, the same on every platform: Open Binder; Phone access, a checkbox that turns it on or off, the
 * address phones open beneath it while Binder listens for them (or why it can't), and Phone access… for its settings;
 * then Quit Binder. The phone items wait for the server to be ready (`lan` is what it last said of phone access).
 */
export function trayMenuTemplate(
  state: { ready: boolean; lan: LanSummary | null },
  actions: TrayActions,
): MenuItemConstructorOptions[] {
  const { ready, lan } = state
  const on = lan?.enabled ?? false
  const url = phoneUrl(lan)
  const line = url
    ? `Phones: ${url}`
    : lan?.listening
      ? "Phones: this PC isn't on a network a phone can reach"
      : (lan?.error ?? null)
  return [
    { label: 'Open Binder', click: actions.open },
    { type: 'separator' },
    { label: 'Phone access', type: 'checkbox', checked: on, enabled: ready, click: () => actions.phoneAccess(!on) },
    ...(ready && line ? [{ label: line, enabled: false }] : []),
    { label: 'Phone access…', enabled: ready, click: actions.phoneSettings },
    { type: 'separator' },
    { label: 'Quit Binder', click: actions.quit },
  ]
}

/** The tray icon's tooltip: Binder, and the address phones open while it listens for them. */
export function trayToolTip(lan: LanSummary | null): string {
  const url = phoneUrl(lan)
  return url ? `Binder · phones: ${url}` : 'Binder'
}

/**
 * Whether clicking the tray icon opens Binder's window. On Windows and Linux it does, as their tray icons do (the menu
 * is a right-click away); on a Mac a click shows the menu, as menu-bar icons do.
 */
export function trayClickOpensWindow(platform: NodeJS.Platform): boolean {
  return platform !== 'darwin'
}

/**
 * The window's icon (its title bar and taskbar button): Binder's, even run from the project (`pnpm app:dev`), whose
 * program is Electron's own. None on a Mac, whose windows have none (the Dock shows the app's).
 */
export function windowIcon(platform: NodeJS.Platform, appRoot: string): string | null {
  if (platform === 'darwin') return null
  return pathFor(platform).join(appRoot, 'build', 'icons', platform === 'win32' ? 'Binder.ico' : 'icon.png')
}

/** What the system says of the app's use of the camera (Electron's systemPreferences.getMediaAccessStatus). */
export type MediaAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

/**
 * Whether Binder's page may have the camera it asked for. A Mac asks the person, once ('ask': askForMediaAccess). On
 * Windows there's nothing to ask: Settings → Privacy & security → Camera has a switch for every desktop app, so the
 * camera is refused only when that's off (the Scan page then says where it is). Linux has no such permission.
 */
export function cameraDecision(platform: NodeJS.Platform, status: () => MediaAccessStatus): 'ask' | boolean {
  if (platform === 'darwin') return 'ask'
  if (platform === 'win32') {
    const answer = status()
    return answer !== 'denied' && answer !== 'restricted'
  }
  return true
}
