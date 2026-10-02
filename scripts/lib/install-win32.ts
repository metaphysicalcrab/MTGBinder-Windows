// Binder on Windows: electron-builder's per-user installer (package.json's nsis), run silently. It installs Binder in
// %LOCALAPPDATA%\Programs\binder with no administrator prompt, a Start menu shortcut (and one on the desktop), and an
// entry in Settings → Apps to uninstall it, which leaves the library alone: it's the owner's data, in
// %LOCALAPPDATA%\Binder (nsis.deleteAppDataOnUninstall stays false). A running Binder is asked to quit before
// packaging (`Binder.exe --quit`), so it closes the library itself: electron-builder starts by deleting
// release\win-unpacked, which Windows refuses while a Binder runs from it, and the installer would end one mid-write.
// `pnpm app --no-install` makes the folder instead (`dir`): release\win-unpacked\Binder.exe.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CliOptions } from 'electron-builder'
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

/** What packaging and installing on Windows need of the computer: tests pass their own. */
export interface WindowsDeps {
  env: NodeJS.ProcessEnv
  home: string
  /** Runs a program and waits for it; throws when it fails (its exit code in `status`). */
  run(file: string, args: string[]): void
  running(): boolean
  exists(file: string): boolean
  /** When the file last changed (ms since 1970), or null when there's none. */
  modified(file: string): number | null
  /** The Binder.exe in release\ (the last build's), when there's one: it asks Binder to quit when none is installed. */
  builtExe(): string | null
  sleep(ms: number): Promise<void>
  now(): number
  /** Packages Binder (electronBuilder). */
  electronBuilder(options: CliOptions): Promise<string[]>
}

function windowsDeps(): WindowsDeps {
  return {
    env: process.env,
    home: os.homedir(),
    // Binder.exe --quit returns as soon as it has asked; the installer, once it has installed (minutes at most).
    run: (file, args) => void execFileSync(file, args, { stdio: 'ignore', windowsHide: true, timeout: 5 * 60_000 }),
    running: () => binderRunning(),
    exists: (file) => fs.existsSync(file),
    modified: (file) => fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null,
    builtExe: () => {
      try {
        return builtExe(path.join(ROOT_DIR, 'release'))
      } catch {
        return null
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    electronBuilder,
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

/** Asks a running Binder, if there's one, to quit; throws the line saying to quit it when it doesn't. */
export async function quitRunningBinder(deps: WindowsDeps): Promise<void> {
  if (!deps.running()) return
  console.log('Binder is running: asking it to quit…')
  // The installed one can ask any Binder (they share the library, and its lock); without one, the one in release\.
  const target = installTarget(deps.env, deps.home)
  const asker = deps.exists(target) ? target : deps.builtExe()
  if (!asker || !(await quitBinder(asker, deps))) throw new InstallError(QUIT_FIRST)
}

/**
 * Installs Binder with its installer, silently (/S: no window, no questions, and it doesn't open Binder after), once
 * any running Binder has quit, and checks it did: the Binder.exe it leaves is new. Returns the line saying where it is.
 */
export async function installOnWindows(installer: string, deps: WindowsDeps): Promise<string> {
  const target = installTarget(deps.env, deps.home)
  // Asked again: one may have been opened while Binder was packaged.
  await quitRunningBinder(deps)
  // The installed one's time, if there's one: an installer that gives up without a word (one that finds Binder running
  // and can't end it, say) exits as if it had installed, and leaves it as it was.
  const before = deps.modified(target)
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
  const after = deps.modified(target)
  if (after === null) throw new InstallError(`Binder's installer finished, but there's no ${EXE} at ${target}.`)
  if (before !== null && after <= before) {
    throw new InstallError(
      `Binder's installer finished without replacing ${target}. Run pnpm app again; if it fails again, open ` +
        `${installer} to see why.`,
    )
  }
  return `Installed Binder in ${path.win32.dirname(target)}. Open Binder from the Start menu.`
}

/** Binder on Windows, as `pnpm app` builds it and installs it with its installer. */
export function windowsApp(deps: WindowsDeps = windowsDeps()): DesktopApp {
  return {
    name: 'Binder',
    // A running Binder is asked to quit just before packaging, rather than refused.
    blocked: () => null,
    async package(install) {
      // Both builds start by deleting release\win-unpacked, where `pnpm app --no-install`'s Binder may still run.
      await quitRunningBinder(deps)
      console.log(install ? 'Packaging Binder and its installer…' : 'Packaging Binder…')
      const win = [install ? 'nsis' : 'dir']
      const artifacts = await step("Couldn't package Binder", () => deps.electronBuilder({ win }))
      return install ? installerIn(artifacts) : builtExe(path.join(ROOT_DIR, 'release'))
    },
    install: (installer) => installOnWindows(installer, deps),
  }
}
