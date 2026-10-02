// What `pnpm app` and `pnpm move-library` do differently on each platform, behind one interface: Binder.app on a Mac
// (install-darwin.ts), Binder's installer on Windows (install-win32.ts).
import { appRunning, macApp, MAC_INSTALLED } from './install-darwin.ts'
import { binderRunning, windowsApp } from './install-win32.ts'

/** The desktop app on one platform, as `pnpm app` packages and installs it. */
export interface DesktopApp {
  /** What it's called while it's packaged: "Binder.app" on a Mac, "Binder" on Windows. */
  name: string
  /** Why it can't be installed now, or null; asked before anything is built. */
  blocked(): string | null
  /**
   * Builds what's packaged besides the web app (the Mac's OCR helper), and packages Binder with electron-builder (on
   * Windows, once a running Binder has quit): to install, or (install false) to run from release/. Returns what it
   * made.
   */
  package(install: boolean): Promise<string>
  /** Installs what package() made, replacing the installed Binder; returns the line saying where it is now. */
  install(built: string): Promise<string>
}

/** The desktop app on this platform, or null where `pnpm app` doesn't make one. */
export function desktopApp(platform: NodeJS.Platform = process.platform): DesktopApp | null {
  if (platform === 'darwin') return macApp()
  if (platform === 'win32') return windowsApp()
  return null
}

/** Whether the installed desktop app is running: Binder.app (pgrep) on a Mac, Binder.exe (tasklist) on Windows. */
export function desktopRunning(platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'darwin') return appRunning(MAC_INSTALLED)
  if (platform === 'win32') return binderRunning()
  return false
}
