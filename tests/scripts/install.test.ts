import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { firstLine, InstallError, step } from '../../scripts/lib/build.ts'
import { desktopApp, desktopRunning } from '../../scripts/lib/install.ts'
import { appRunning, builtApp, installApp } from '../../scripts/lib/install-darwin.ts'
import {
  binderRunning,
  builtExe,
  installerIn,
  installOnWindows,
  installTarget,
  listsImage,
  quitBinder,
  windowsApp,
  type WindowsDeps,
} from '../../scripts/lib/install-win32.ts'
import { tempDir } from '../helpers/tmp.ts'

const scratch = () => tempDir('binder-install-')

/** A stand-in Binder.app holding one file. */
function app(dir: string, text: string): string {
  const bundle = path.join(dir, 'Binder.app')
  fs.mkdirSync(path.join(bundle, 'Contents'), { recursive: true })
  fs.writeFileSync(path.join(bundle, 'Contents', 'version.txt'), text)
  return bundle
}

describe('builtApp', () => {
  it('finds the Binder.app electron-builder made, for this Mac\'s architecture or the other', () => {
    const release = scratch()
    fs.mkdirSync(path.join(release, 'mac-arm64'))
    const bundle = app(path.join(release, 'mac-arm64'), 'new')
    expect(builtApp(release)).toBe(bundle)
  })

  it('says so when there is none', () => {
    expect(() => builtApp(scratch())).toThrow('No Binder.app in')
  })
})

// Installing goes through /usr/bin/ditto, which keeps a Mac app's signature and symlinks: there's no ditto elsewhere.
describe.runIf(process.platform === 'darwin')('installApp', () => {
  it('puts Binder.app in the folder, replacing the one there', () => {
    const dir = scratch()
    const built = app(path.join(dir, 'release'), 'new')
    const applications = path.join(dir, 'Applications')
    app(applications, 'old')
    fs.writeFileSync(path.join(applications, 'Binder.app', 'Contents', 'stale.txt'), 'from the old version')
    expect(installApp(built, applications)).toBe(path.join(applications, 'Binder.app'))
    expect(fs.readFileSync(path.join(applications, 'Binder.app', 'Contents', 'version.txt'), 'utf8')).toBe('new')
    expect(fs.existsSync(path.join(applications, 'Binder.app', 'Contents', 'stale.txt'))).toBe(false)
  })
})

// pgrep, and a script started by its #! line, are POSIX's: Windows has neither.
describe.skipIf(process.platform === 'win32')('appRunning', () => {
  it('tells whether Binder.app is running from that path, so pnpm app never replaces it under itself', async () => {
    const dir = scratch()
    const bundle = path.join(dir, 'Binder.app')
    const binary = path.join(bundle, 'Contents', 'MacOS', 'Binder')
    fs.mkdirSync(path.dirname(binary), { recursive: true })
    // A stand-in that waits, as Binder.app would while it runs.
    fs.writeFileSync(binary, `#!${process.execPath}\nsetTimeout(() => {}, 30_000)\n`, { mode: 0o755 })
    expect(appRunning(bundle)).toBe(false)
    const app = spawn(binary, [], { stdio: 'ignore' })
    onTestFinished(() => {
      app.kill()
    })
    for (let tries = 0; !appRunning(bundle) && tries < 40; tries++) await new Promise((r) => setTimeout(r, 50))
    expect(appRunning(bundle)).toBe(true)
    expect(appRunning(path.join(dir, 'Other.app'))).toBe(false)
  })
})

describe('the desktop app on each platform', () => {
  it('is Binder.app on a Mac and Binder on Windows, and nothing elsewhere', () => {
    expect(desktopApp('darwin')?.name).toBe('Binder.app')
    expect(desktopApp('win32')?.name).toBe('Binder')
    expect(desktopApp('linux')).toBeNull()
    expect(desktopRunning('linux')).toBe(false)
  })

  it('says a failed step in one line: what failed, and the first line of why', async () => {
    await expect(step("Couldn't build the web app", () => Promise.reject(new Error('[vite] boom\n    at stack line')))).rejects.toThrow(
      new InstallError("Couldn't build the web app: [vite] boom"),
    )
    // A step's own InstallError is said as it is.
    await expect(step("Couldn't package Binder", () => Promise.reject(new InstallError('Binder is running')))).rejects.toThrow(
      new InstallError('Binder is running'),
    )
    expect(await step('never', () => 7)).toBe(7)
    expect(firstLine(new Error('\n  Command failed: swift\nmore'))).toBe('Command failed: swift')
    expect(firstLine('plain')).toBe('plain')
  })
})

describe('Binder on Windows (install-win32)', () => {
  const running = '"Binder.exe","4120","Console","1","98,304 K"\r\n"Binder.exe","5232","Console","1","61,440 K"\r\n'

  it('reads tasklist\'s rows, whatever language its "no tasks" line is in', () => {
    expect(listsImage(running)).toBe(true)
    expect(listsImage('"binder.EXE","4120","Console","1","98,304 K"')).toBe(true)
    expect(listsImage('INFO: No tasks are running which match the specified criteria.\r\n')).toBe(false)
    expect(listsImage('INFORMATION : aucune tâche en service ne correspond aux critères spécifiés.\r\n')).toBe(false)
    expect(listsImage('"Binder.exe.old","1","Console","1","1 K"\r\n"NotBinder.exe","2","Console","1","1 K"')).toBe(false)
    expect(listsImage('')).toBe(false)
  })

  it('asks tasklist, by its full path, whether Binder.exe runs, and says no when it can\'t tell', () => {
    const calls: Array<[string, string[]]> = []
    const tasklist = (answer: string) => (file: string, args: string[]) => {
      calls.push([file, args])
      return answer
    }
    expect(binderRunning(tasklist(running), { SystemRoot: String.raw`D:\Windows` })).toBe(true)
    expect(calls[0]).toEqual([String.raw`D:\Windows\System32\tasklist.exe`, ['/FI', 'IMAGENAME eq Binder.exe', '/FO', 'CSV', '/NH']])
    expect(binderRunning(tasklist('INFO: No tasks are running which match the specified criteria.'), {})).toBe(false)
    expect(calls[1]![0]).toBe(String.raw`C:\Windows\System32\tasklist.exe`)
    const missing = () => {
      throw Object.assign(new Error('spawnSync tasklist.exe ENOENT'), { code: 'ENOENT' })
    }
    expect(binderRunning(missing, {})).toBe(false)
  })

  it('installs per user, in %LOCALAPPDATA%\\Programs\\binder', () => {
    expect(installTarget({ LOCALAPPDATA: String.raw`C:\Users\me\AppData\Local` }, String.raw`C:\Users\me`)).toBe(
      String.raw`C:\Users\me\AppData\Local\Programs\binder\Binder.exe`,
    )
    expect(installTarget({}, String.raw`C:\Users\me`)).toBe(String.raw`C:\Users\me\AppData\Local\Programs\binder\Binder.exe`)
  })

  it('finds the installer among what electron-builder made, and the folder build\'s Binder.exe', () => {
    const release = String.raw`C:\dev\binder\release`
    expect(
      installerIn([`${release}\\Binder-Setup-0.1.0.exe.blockmap`, `${release}\\latest.yml`, `${release}\\Binder-Setup-0.1.0.exe`]),
    ).toBe(`${release}\\Binder-Setup-0.1.0.exe`)
    expect(() => installerIn([`${release}\\Binder-Setup-0.1.0.exe.blockmap`])).toThrow(InstallError)
    const dir = scratch()
    expect(() => builtExe(dir)).toThrow(`No Binder.exe in ${dir}`)
    fs.mkdirSync(path.join(dir, 'win-arm64-unpacked'))
    fs.writeFileSync(path.join(dir, 'win-arm64-unpacked', 'Binder.exe'), '')
    fs.mkdirSync(path.join(dir, 'mac-arm64'))
    expect(builtExe(dir)).toBe(path.join(dir, 'win-arm64-unpacked', 'Binder.exe'))
  })

  /**
   * A Windows PC to package and install on: what's running, what's on disk (and when it last changed), and what was
   * run, with its own clock.
   */
  function pc(options: { runningFor?: number; installed?: boolean; built?: string | null; installer?: (args: string[]) => void } = {}) {
    let clock = 0
    const target = String.raw`C:\Users\me\AppData\Local\Programs\binder\Binder.exe`
    const files = new Map(options.installed ? [[target, -1]] : [])
    const ran: string[] = []
    const deps: WindowsDeps = {
      env: { LOCALAPPDATA: String.raw`C:\Users\me\AppData\Local` },
      home: String.raw`C:\Users\me`,
      run: (file, args) => {
        ran.push([file, ...args].join(' '))
        if (args[0] === '/S') {
          options.installer?.(args)
          files.set(target, clock)
        }
      },
      // Binder quits `runningFor` ms after it's asked; running for good without being asked.
      running: () => {
        const asked = ran.some((line) => line.endsWith('--quit'))
        return options.runningFor !== undefined && (!asked || clock < options.runningFor)
      },
      exists: (file) => files.has(file),
      modified: (file) => files.get(file) ?? null,
      builtExe: () => options.built ?? null,
      sleep: async (ms) => {
        clock += ms
      },
      now: () => clock,
      electronBuilder: async (builder) => {
        ran.push(`electron-builder --win ${builder.win?.join(' ')}`)
        return [String.raw`C:\dev\binder\release\Binder-Setup-0.1.0.exe`]
      },
    }
    return { deps, ran, target }
  }

  it('asks a running Binder to quit, and waits for it to be gone', async () => {
    const { deps, ran } = pc({ runningFor: 3_000, installed: true })
    expect(await quitBinder('Binder.exe', deps)).toBe(true)
    expect(ran).toEqual(['Binder.exe --quit'])
    // One that doesn't quit (an older Binder, without --quit) is waited for 10 seconds, no longer.
    const stuck = pc({ runningFor: 60_000 })
    expect(await quitBinder('Binder.exe', stuck.deps)).toBe(false)
    expect(stuck.deps.now()).toBe(10_000)
  })

  it('installs silently once Binder has quit, and says where it is', async () => {
    const { deps, ran, target } = pc({ runningFor: 1_000, installed: true })
    expect(await installOnWindows(String.raw`C:\dev\binder\release\Binder-Setup-0.1.0.exe`, deps)).toBe(
      String.raw`Installed Binder in C:\Users\me\AppData\Local\Programs\binder. Open Binder from the Start menu.`,
    )
    expect(ran).toEqual([`${target} --quit`, String.raw`C:\dev\binder\release\Binder-Setup-0.1.0.exe /S`])
  })

  it('asks with the Binder.exe just built when none is installed (one run from release\\)', async () => {
    const built = String.raw`C:\dev\binder\release\win-unpacked\Binder.exe`
    const { deps, ran } = pc({ runningFor: 500, built })
    await installOnWindows('Binder-Setup-0.1.0.exe', deps)
    expect(ran).toEqual([`${built} --quit`, 'Binder-Setup-0.1.0.exe /S'])
  })

  it('refuses while a Binder that won\'t quit runs, and installs nothing', async () => {
    const { deps, ran } = pc({ runningFor: 60_000, installed: true })
    await expect(installOnWindows('Binder-Setup-0.1.0.exe', deps)).rejects.toThrow(
      new InstallError(
        "Binder is running and didn't quit when asked: quit it (right-click its icon in the notification area → Quit " +
          'Binder), then run pnpm app again.',
      ),
    )
    expect(ran.some((line) => line.endsWith('/S'))).toBe(false)
  })

  it('asks a running Binder to quit before packaging, which replaces release\\win-unpacked, where one may run', async () => {
    // `pnpm app --no-install`'s Binder, with none installed: it asks itself.
    const built = String.raw`C:\dev\binder\release\win-unpacked\Binder.exe`
    const { deps, ran } = pc({ runningFor: 500, built })
    expect(await windowsApp(deps).package(true)).toBe(String.raw`C:\dev\binder\release\Binder-Setup-0.1.0.exe`)
    expect(ran).toEqual([`${built} --quit`, 'electron-builder --win nsis'])
    // One that won't quit: nothing is packaged, for the folder build either.
    for (const install of [true, false]) {
      const stuck = pc({ runningFor: 60_000, built })
      await expect(windowsApp(stuck.deps).package(install)).rejects.toThrow(/^Binder is running and didn't quit when asked/)
      expect(stuck.ran).toEqual([`${built} --quit`])
    }
    // Nothing running: nothing asked.
    const idle = pc({ built })
    await windowsApp(idle.deps).package(true)
    expect(idle.ran).toEqual(['electron-builder --win nsis'])
  })

  it('says in one line when the installer fails, or leaves no Binder.exe', async () => {
    const failing = pc({
      installer: () => {
        throw Object.assign(new Error('Command failed: Binder-Setup-0.1.0.exe /S'), { status: 2 })
      },
    })
    await expect(installOnWindows('Binder-Setup-0.1.0.exe', failing.deps)).rejects.toThrow(
      new InstallError(
        "Binder's installer failed (exit code 2). Run pnpm app again; if it fails again, open Binder-Setup-0.1.0.exe to see why.",
      ),
    )
    const empty = pc()
    empty.deps.run = () => {}
    await expect(installOnWindows('Binder-Setup-0.1.0.exe', empty.deps)).rejects.toThrow(
      new InstallError(`Binder's installer finished, but there's no Binder.exe at ${empty.target}.`),
    )
  })

  it('says so when the installer exits without replacing the installed Binder', async () => {
    // As one that finds Binder running and can't end it does, silently.
    const unchanged = pc({ installed: true })
    unchanged.deps.run = () => {}
    await expect(installOnWindows('Binder-Setup-0.1.0.exe', unchanged.deps)).rejects.toThrow(
      new InstallError(
        `Binder's installer finished without replacing ${unchanged.target}. Run pnpm app again; if it fails again, open ` +
          'Binder-Setup-0.1.0.exe to see why.',
      ),
    )
    // A reinstall that does replace it.
    const reinstall = pc({ installed: true })
    expect(await installOnWindows('Binder-Setup-0.1.0.exe', reinstall.deps)).toMatch(/^Installed Binder in /)
  })
})

describe('packaging (package.json\'s build)', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    name: string
    author?: string
    build: {
      files: string[]
      mac: { files: string[] }
      win: { executableName: string; files: string[] }
      nsis: Record<string, unknown>
    }
  }

  it('never deletes the library when Binder is uninstalled: it\'s the owner\'s data', () => {
    expect(pkg.build.nsis.deleteAppDataOnUninstall).toBe(false)
  })

  it('makes the installer and the program pnpm app looks for', () => {
    expect(`${pkg.build.win.executableName}.exe`).toBe('Binder.exe')
    // A one-click, per-user install: no administrator prompt, in %LOCALAPPDATA%\Programs\<name> (installTarget).
    expect(pkg.build.nsis).toMatchObject({ oneClick: true, perMachine: false, runAfterFinish: false })
    expect(pkg.name).toBe('binder')
    const installer = String(pkg.build.nsis.artifactName).replace('${version}', '0.1.0').replace('${ext}', 'exe')
    expect(installerIn([installer])).toBe('Binder-Setup-0.1.0.exe')
    // Binder.exe's company and Settings → Apps' publisher: without an author, Electron's ("GitHub, Inc.") and none.
    expect(pkg.author).toBe('Binder')
  })

  it('ships each platform\'s OCR helper and tray icon, and only its own SQLite build', () => {
    expect(pkg.build.files).not.toContain('bin/ocr')
    expect(pkg.build.mac.files).toEqual(expect.arrayContaining(['bin/ocr', 'build/icons/trayTemplate*.png']))
    expect(pkg.build.win.files).toEqual(expect.arrayContaining(['native/ocr.ps1', 'build/icons/tray.ico', 'build/icons/Binder.ico']))
    expect(pkg.build.files).toContain('!node_modules/better-sqlite3/{deps,src}/**')
    expect(pkg.build.mac.files.find((file) => file.includes('prebuilds'))).not.toMatch(/darwin/)
    expect(pkg.build.win.files.find((file) => file.includes('prebuilds'))).not.toMatch(/win32/)
  })
})
