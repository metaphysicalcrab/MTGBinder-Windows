import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { appLibraryNote, listenFailure, locationWarnings, portProblem, stopOnSignals } from '../../src/server/startup.ts'
import { tempDir } from '../helpers/tmp.ts'

const failure = (code: string, message = 'boom') => Object.assign(new Error(message), { code })

describe('startup messages', () => {
  it('accepts no PORT, or a port number, and explains anything else', () => {
    for (const ok of [undefined, '4321', '1', '65535', ' 8080 ']) expect(portProblem(ok)).toBeNull()
    for (const bad of ['abc', '0', '65536', '43.21', '-1', '', '0x10E1', '4321a']) {
      expect(portProblem(bad)).toBe(`PORT must be a port number from 1 to 65535, not "${bad}".`)
    }
  })

  it('says in one line why the server could not listen', () => {
    expect(listenFailure(failure('EADDRINUSE'), 4321)).toBe(
      'Port 4321 is already in use: Binder may already be running. Stop it, or start this one with PORT set to another port.',
    )
    expect(listenFailure(failure('EACCES'), 80, 'darwin')).toBe("Binder isn't allowed to listen on port 80. Start it with PORT set to another port.")
    expect(listenFailure(failure('EOTHER', 'the network is down'), 4321)).toBe("Couldn't start the server on port 4321: the network is down")
  })

  it('names the ports Windows keeps for itself when it refuses one', () => {
    expect(listenFailure(failure('EACCES'), 4321, 'win32')).toBe(
      "Binder isn't allowed to listen on port 4321. Start it with PORT set to another port. Windows may keep it for " +
        'Hyper-V, WSL or Docker: `netsh interface ipv4 show excludedportrange protocol=tcp` lists the ports it keeps.',
    )
  })

  it('says which library this Binder uses when the desktop app keeps its own', () => {
    const dir = tempDir('binder-startup-')
    const appLibrary = path.join(dir, 'Application Support', 'Binder')
    const data = path.join(dir, 'data')
    expect(appLibraryNote(data, appLibrary)).toBeNull()
    fs.mkdirSync(appLibrary, { recursive: true })
    fs.writeFileSync(path.join(appLibrary, 'binder.db'), '')
    expect(appLibraryNote(data, appLibrary, 'darwin')).toBe(`[library] Binder.app keeps its library in ${appLibrary}; this Binder uses ${data}.`)
    expect(appLibraryNote(data, appLibrary, 'win32')).toBe(
      `[library] The Binder app keeps its library in ${appLibrary}; this Binder uses ${data}.`,
    )
    expect(appLibraryNote(appLibrary, appLibrary)).toBeNull()
    // Windows and the Mac ignore letter case in paths: the same folder typed in another case is the same library.
    for (const platform of ['win32', 'darwin'] as const) {
      expect(appLibraryNote(appLibrary.toUpperCase(), appLibrary, platform)).toBeNull()
    }
    expect(appLibraryNote(appLibrary.toUpperCase(), appLibrary, 'linux')).not.toBeNull()
  })
})

describe('where the library is, on Windows', () => {
  const env = { OneDrive: String.raw`C:\Users\me\OneDrive`, OneDriveCommercial: String.raw`C:\Users\me\OneDrive - Contoso` }
  const at = (dataDir: string, envPath = String.raw`C:\dev\binder\.env`) => locationWarnings({ dataDir, envPath }, 'win32', env)

  it('says nothing about a library on this PC, nor anywhere on another platform', () => {
    expect(at(String.raw`C:\Users\me\AppData\Local\Binder`)).toEqual([])
    // Only the folder's name starts the same: not in OneDrive.
    expect(at(String.raw`C:\Users\me\OneDriveBackup\binder`)).toEqual([])
    const inOneDrive = { dataDir: String.raw`C:\Users\me\OneDrive\binder`, envPath: '/x/.env' }
    expect(locationWarnings(inOneDrive, 'darwin', env)).toEqual([])
  })

  it('warns about a library or a key file in OneDrive, in any letter case', () => {
    const dataDir = String.raw`c:\users\ME\onedrive\Documents\GitHub\binder\data`
    const envPath = String.raw`C:\Users\me\OneDrive - Contoso\binder\.env`
    expect(at(dataDir, envPath)).toEqual([
      `[library] ${dataDir} is in OneDrive, which copies the library while Binder writes it and can hold its files open: ` +
        String.raw`set BINDER_DATA_DIR to a folder outside OneDrive, such as %LOCALAPPDATA%\Binder.`,
      `[api key] ${envPath} is in OneDrive, which uploads your Anthropic API key with it.`,
    ])
  })

  it('warns about a library on a network share, but not about a local path written long', () => {
    for (const share of [String.raw`\\nas\binder`, String.raw`\\?\UNC\nas\binder`]) {
      expect(at(share)).toEqual([
        `[library] ${share} is on a network share, where the library can be damaged (SQLite can't share its log safely ` +
          'there): keep it on this PC, with BINDER_DATA_DIR.',
      ])
    }
    expect(at(String.raw`\\?\C:\binder`)).toEqual([])
  })

  it("warns about a folder so deep that the library's files come near Windows' 260-character limit", () => {
    const deep = `C:\\${'a'.repeat(210)}`
    expect(at(deep)).toEqual([
      `[library] ${deep} is a long path (213 characters): Windows can refuse the library's files past 260, so backups ` +
        'or the library itself may fail to open. Use a shorter folder, with BINDER_DATA_DIR.',
    ])
    expect(at(`C:\\${'a'.repeat(200)}`)).toEqual([])
  })
})

describe('stopping from the terminal', () => {
  /** A stand-in for the process: signals are emitted on it, and exit records its code. */
  const terminal = () => Object.assign(new EventEmitter(), { exit: vi.fn() })

  it('stops Binder, closing the library, then exits, on Ctrl+C or a kill', async () => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const target = terminal()
      const stop = vi.fn(() => Promise.resolve())
      const log = vi.fn()
      stopOnSignals({ stop }, { platform: 'darwin', target, log })
      target.emit(signal)
      await vi.waitFor(() => expect(target.exit).toHaveBeenCalledWith(0))
      expect(stop).toHaveBeenCalledOnce()
      expect(log).toHaveBeenCalledWith('Binder stopped')
    }
  })

  it("listens for Windows' own signals too, Ctrl+Break and closing the console window, and only on Windows", () => {
    const windows = terminal()
    stopOnSignals({ stop: () => Promise.resolve() }, { platform: 'win32', target: windows, log: () => {} })
    expect(windows.eventNames().sort()).toEqual(['SIGBREAK', 'SIGHUP', 'SIGINT', 'SIGTERM'])
    const mac = terminal()
    stopOnSignals({ stop: () => Promise.resolve() }, { platform: 'darwin', target: mac, log: () => {} })
    expect(mac.eventNames().sort()).toEqual(['SIGINT', 'SIGTERM'])
  })

  it('exits at once on a second signal, or when stopping takes too long', async () => {
    const twice = terminal()
    stopOnSignals({ stop: () => new Promise(() => {}) }, { platform: 'win32', target: twice, log: () => {} })
    twice.emit('SIGHUP')
    expect(twice.exit).not.toHaveBeenCalled()
    twice.emit('SIGINT')
    expect(twice.exit).toHaveBeenCalledWith(1)
    const slow = terminal()
    stopOnSignals({ stop: () => new Promise(() => {}) }, { platform: 'darwin', target: slow, waitMs: 20, log: () => {} })
    slow.emit('SIGTERM')
    await vi.waitFor(() => expect(slow.exit).toHaveBeenCalledWith(1))
  })
})
