// Binder on Windows: electron-builder's per-user installer (package.json's nsis), run silently. It installs Binder in
// %LOCALAPPDATA%\Programs\binder with no administrator prompt, a Start menu shortcut (and one on the desktop), and an
// entry in Settings → Apps to uninstall it, which leaves the library alone: it's the owner's data, in
// %LOCALAPPDATA%\Binder (nsis.deleteAppDataOnUninstall stays false). A running Binder is asked to quit first
// (`Binder.exe --quit`), so it closes the library itself: the installer would otherwise end it mid-write.
// `pnpm app --no-install` makes the folder instead (`dir`): release\win-unpacked\Binder.exe.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { QUIT_SWITCH } from '../../electron/platform.ts'
import { ROOT_DIR } from '../../src/server/config.ts'
import { electronBuilder, firstLine, InstallError, step } from './build.ts'
import type { DesktopApp } from './install.ts'

/** Binder's program (package.json's win.executableName). */
export const EXE = 'Binder.exe'

/** How long a running Binder gets to quit when asked: it stops its server first, for up to 5 seconds. */
export const QUIT_WAIT_MS = 10_000

const QUIT_FIRST =
  "Binder is running and didn't quit when asked: quit it (right-click its icon in the notification area → Quit " +
  'Binder), then run pnpm app again.'

/**
 * Where the installer puts Binder.exe: a one-click, per-user install (nsis.oneClick, not perMachine) goes in
 * %LOCALAPPDATA%\Programs, in a folder named for the package ("binder").
 */
export function installTarget(env: NodeJS.ProcessEnv, home: string): string {
  const local = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local')
  return path.win32.join(local, 'Programs', 'binder', EXE)
}

/**
 * Whether tasklist's answer (`/FO CSV /NH`: one quoted row per process) lists `image`. When nothing matches it says so
 * in Windows' own language instead, so only the rows are read.
 */
export function listsImage(csv: string, image = EXE): boolean {
  return csv.split(/\r?\n/).some((line) => /^"([^"]*)"/.exec(line.trim())?.[1]?.toLowerCase() === image.toLowerCase())
}

/** Runs a program and returns what it printed. */
export type Output = (file: string, args: string[]) => string

const output: Output = (file, args) =>
  execFileSync(file, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })

/**
 * Whether Binder.exe is running: the installed app, or one run from release\. Asks Windows' tasklist, by its full path
 * rather than whatever the PATH finds first. False when tasklist can't say.
 */
export function binderRunning(run: Output = output, env: NodeJS.ProcessEnv = process.env): boolean {
  const tasklist = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe')
  try {
    return listsImage(run(tasklist, ['/FI', `IMAGENAME eq ${EXE}`, '/FO', 'CSV', '/NH']))
  } catch {
    return false
  }
}

/** The installer among the files electron-builder made (nsis.artifactName): Binder-Setup-<version>.exe. */
export function installerIn(artifacts: readonly string[]): string {
  const installer = artifacts.find((file) => /^Binder-Setup-.+\.exe$/i.test(path.win32.basename(file)))
  if (!installer) throw new InstallError('electron-builder made no installer (Binder-Setup-<version>.exe) in release.')
  return installer
}

/** The Binder.exe electron-builder's folder build made: release\win-unpacked\, or win-arm64-unpacked\ on an Arm PC. */
export function builtExe(releaseDir: string): string {
  const found = (fs.existsSync(releaseDir) ? fs.readdirSync(releaseDir) : [])
    .filter((dir) => /^win-.*unpacked$/.test(dir))
    .map((dir) => path.join(releaseDir, dir, EXE))
    .find((exe) => fs.existsSync(exe))
  if (!found) throw new InstallError(`No ${EXE} in ${releaseDir}`)
  return found
}

/** What installing on Windows needs of the computer: tests pass their own. */
export interface WindowsDeps {
  env: NodeJS.ProcessEnv
  home: string
  /** Runs a program and waits for it; throws when it fails (its exit code in `status`). */
  run(file: string, args: string[]): void
  running(): boolean
  exists(file: string): boolean
  /** The Binder.exe just built, when there's one (it can ask a Binder that isn't the installed one to quit). */
  builtExe(): string | null
  sleep(ms: number): Promise<void>
  now(): number
}

function windowsDeps(): WindowsDeps {
  return {
    env: process.env,
    home: os.homedir(),
    // Binder.exe --quit returns as soon as it has asked; the installer, once it has installed (minutes at most).
    run: (file, args) => void execFileSync(file, args, { stdio: 'ignore', windowsHide: true, timeout: 5 * 60_000 }),
    running: () => binderRunning(),
    exists: (file) => fs.existsSync(file),
    builtExe: () => {
      try {
        return builtExe(path.join(ROOT_DIR, 'release'))
      } catch {
        return null
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  }
}

/**
 * Asks a running Binder to quit (`Binder.exe --quit`, which hands the request to the running one and exits) and waits
 * for every Binder.exe to be gone, up to `waitMs`. Returns whether they are.
 */
export async function quitBinder(exe: string, deps: WindowsDeps, waitMs = QUIT_WAIT_MS): Promise<boolean> {
  try {
    deps.run(exe, [QUIT_SWITCH])
  } catch {
    // It may be quitting anyway: the wait says.
  }
  const until = deps.now() + waitMs
  while (deps.running()) {
    if (deps.now() >= until) return false
    await deps.sleep(250)
  }
  return true
}

/**
 * Installs Binder with its installer, silently (/S: no window, no questions, and it doesn't open Binder after), once
 * any running Binder has quit. Returns the line saying where it is.
 */
export async function installOnWindows(installer: string, deps: WindowsDeps): Promise<string> {
  const target = installTarget(deps.env, deps.home)
  if (deps.running()) {
    console.log('Binder is running: asking it to quit…')
    // The installed one can ask any Binder (they share the library, and its lock); without one, the one just built.
    const asker = deps.exists(target) ? target : deps.builtExe()
    if (!asker || !(await quitBinder(asker, deps))) throw new InstallError(QUIT_FIRST)
  }
  console.log('Installing Binder…')
  try {
    deps.run(installer, ['/S'])
  } catch (err) {
    const status = (err as { status?: number | null }).status
    throw new InstallError(
      `Binder's installer failed (${typeof status === 'number' ? `exit code ${status}` : firstLine(err)}). Run pnpm app ` +
        `again; if it fails again, open ${installer} to see why.`,
    )
  }
  if (!deps.exists(target)) throw new InstallError(`Binder's installer finished, but there's no ${EXE} at ${target}.`)
  return `Installed Binder in ${path.win32.dirname(target)}. Open Binder from the Start menu.`
}

/** Binder on Windows, as `pnpm app` builds it and installs it with its installer. */
export function windowsApp(deps: WindowsDeps = windowsDeps()): DesktopApp {
  return {
    name: 'Binder',
    // A running Binder is asked to quit just before installing, rather than refused.
    blocked: () => null,
    async package(install) {
      console.log(install ? 'Packaging Binder and its installer…' : 'Packaging Binder…')
      const artifacts = await step("Couldn't package Binder", () => electronBuilder({ win: [install ? 'nsis' : 'dir'] }))
      return install ? installerIn(artifacts) : builtExe(path.join(ROOT_DIR, 'release'))
    },
    install: (installer) => installOnWindows(installer, deps),
  }
}
