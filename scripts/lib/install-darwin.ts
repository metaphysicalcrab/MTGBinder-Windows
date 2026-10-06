// Binder.app on a Mac: the OCR helper built from its Swift source, electron-builder's --mac (a folder: Binder.app), and
// a copy into /Applications, refused while Binder.app runs there.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT_DIR } from '../../src/server/config.ts'
import { ocrHelper } from '../../src/server/scanner/ocr-helper.ts'
import { electronBuilder, InstallError, step } from './build.ts'
import type { DesktopApp } from './install.ts'

const APPLICATIONS = '/Applications'
/** Where `pnpm app` installs Binder.app. */
export const MAC_INSTALLED = path.join(APPLICATIONS, 'Binder.app')
const QUIT_FIRST = 'Binder is running: quit it (Cmd+Q, or Quit Binder in its menu-bar icon), then run pnpm app again.'

/** Binder.app, as `pnpm app` builds it and puts it in /Applications. */
export function macApp(): DesktopApp {
  return {
    name: 'Binder.app',
    blocked: () => (appRunning(MAC_INSTALLED) ? QUIT_FIRST : null),
    async package() {
      const helper = ocrHelper({ platform: 'darwin', appRoot: ROOT_DIR, buildFromSource: true })
      await step("Couldn't build the OCR helper", () => helper.prepare?.((line) => console.log(`${line}.`)))
      console.log('Packaging Binder.app…')
      await step("Couldn't package Binder.app", () => electronBuilder({ mac: [] }))
      return builtApp(path.join(ROOT_DIR, 'release'))
    },
    async install(built) {
      if (appRunning(MAC_INSTALLED)) throw new InstallError(QUIT_FIRST)
      return `Installed ${installApp(built, APPLICATIONS)}. Open Binder from Spotlight, Launchpad, or Applications.`
    },
  }
}

/** The Binder.app electron-builder made in `releaseDir`: `release/mac-arm64/`, or `release/mac/` on an Intel Mac. */
export function builtApp(releaseDir: string): string {
  const found = (fs.existsSync(releaseDir) ? fs.readdirSync(releaseDir) : [])
    .filter((dir) => dir.startsWith('mac'))
    .map((dir) => path.join(releaseDir, dir, 'Binder.app'))
    .find((bundle) => fs.existsSync(bundle))
  if (!found) throw new Error(`No Binder.app in ${releaseDir}`)
  return found
}

/** Copies Binder.app into `applicationsDir`, replacing the one there, and returns where it is. */
export function installApp(built: string, applicationsDir: string): string {
  const target = path.join(applicationsDir, 'Binder.app')
  fs.mkdirSync(applicationsDir, { recursive: true })
  fs.rmSync(target, { recursive: true, force: true })
  // ditto keeps what a Mac app needs: its signature, extended attributes, and the frameworks' symlinks.
  execFileSync('/usr/bin/ditto', [built, target])
  return target
}

/** Whether Binder.app is running from this path (replacing it then would pull files from under it). */
export function appRunning(bundle: string): boolean {
  try {
    execFileSync('/usr/bin/pgrep', ['-f', path.join(bundle, 'Contents', 'MacOS', 'Binder')], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
