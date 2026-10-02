// `pnpm app`: builds the desktop app (its icons, the web app, then the platform's own: the Mac's OCR helper and
// Binder.app; Windows' installer) and installs it, replacing the one there: Binder.app in /Applications, refused while
// it runs; on Windows, with its installer, run silently once a running Binder has quit. `pnpm app --no-install` leaves
// it in release/ (Binder.app, or win-unpacked\Binder.exe), where the check runs it. Each step that fails says so in
// one line.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { build as viteBuild } from 'vite'
import { APP_LIBRARY_DIR, DB_PATH, libraryPaths, ROOT_DIR } from '../src/server/config.ts'
import { firstLine, step } from './lib/build.ts'
import { desktopApp } from './lib/install.ts'

const install = !process.argv.includes('--no-install')
const desktop = desktopApp()
if (!desktop) {
  console.error('pnpm app builds the desktop app on a Mac or a Windows PC; here, pnpm app:dev runs it from the project.')
  process.exit(1)
}
const blocked = install ? desktop.blocked() : null
if (blocked) {
  console.error(blocked)
  process.exit(1)
}
// vite.config.ts and electron-builder read the project from the working folder, as `pnpm exec` ran them.
process.chdir(ROOT_DIR)
try {
  console.log('Drawing the icons…')
  // make-icons.ts in this Node, which runs TypeScript as it is (on a Mac it runs make-icons.swift too).
  await step("Couldn't draw the icons", () =>
    execFileSync(process.execPath, ['scripts/make-icons.ts', 'build/icons'], { stdio: 'inherit' }),
  )
  console.log('Building the web app…')
  await step("Couldn't build the web app", () => viteBuild())
  const built = await desktop.package(install)
  if (!install) {
    console.log(`Built ${built}`)
  } else {
    console.log(await desktop.install(built))
    // The first install: the app opened before the move starts a library of its own, which a scan or a card added
    // there keeps from being replaced by the move.
    if (!fs.existsSync(libraryPaths(APP_LIBRARY_DIR).dbPath) && fs.existsSync(DB_PATH)) {
      console.log('Before opening it the first time, run pnpm move-library to bring your library over.')
    }
  }
} catch (err) {
  console.error(firstLine(err))
  process.exitCode = 1
}
