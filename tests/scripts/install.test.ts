import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { appRunning, builtApp, installApp } from '../../scripts/lib/install.ts'
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
