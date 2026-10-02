import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { externalUrl, isAppUrl, permissionAllowed } from '../../electron/links.ts'
import { rotateLog } from '../../electron/log.ts'
import { startingPage, startupFailure } from '../../electron/messages.ts'
import { appPaths } from '../../electron/paths.ts'
import {
  APP_USER_MODEL_ID,
  cameraDecision,
  type MediaAccessStatus,
  menuTemplate,
  quitRequested,
  trayClickOpensWindow,
  trayIcon,
  trayMenuTemplate,
  trayToolTip,
  windowIcon,
} from '../../electron/platform.ts'
import { APP_LIBRARY_DIR, appLibraryDir } from '../../src/server/config.ts'
import { tempDir } from '../helpers/tmp.ts'

describe('appPaths (spec §3.4)', () => {
  const mac = {
    platform: 'darwin',
    env: {},
    home: '/Users/me',
    appRoot: '/Applications/Binder.app/Contents/Resources/app',
    packaged: true,
  } as const
  const windows = {
    platform: 'win32',
    env: { LOCALAPPDATA: String.raw`C:\Users\me\AppData\Local` },
    home: String.raw`C:\Users\me`,
    appRoot: String.raw`C:\Users\me\AppData\Local\Programs\binder\resources\app`,
    packaged: true,
  } as const

  it('keeps a Mac\'s library in Application Support, with the key file in it and the window\'s own files apart', () => {
    expect(appPaths(mac)).toEqual({
      dataDir: '/Users/me/Library/Application Support/Binder',
      envPath: '/Users/me/Library/Application Support/Binder/.env',
      electronDir: '/Users/me/Library/Application Support/Binder/Electron',
      logDir: '/Users/me/Library/Application Support/Binder/Logs',
      webDistDir: '/Applications/Binder.app/Contents/Resources/app/dist/web',
      appRoot: '/Applications/Binder.app/Contents/Resources/app',
      packaged: true,
      port: 4321,
    })
  })

  it('keeps a Windows PC\'s library in %LOCALAPPDATA%\\Binder, not Roaming, beside the installed program', () => {
    expect(appPaths(windows)).toEqual({
      dataDir: String.raw`C:\Users\me\AppData\Local\Binder`,
      envPath: String.raw`C:\Users\me\AppData\Local\Binder\.env`,
      electronDir: String.raw`C:\Users\me\AppData\Local\Binder\Electron`,
      logDir: String.raw`C:\Users\me\AppData\Local\Binder\Logs`,
      webDistDir: String.raw`C:\Users\me\AppData\Local\Programs\binder\resources\app\dist\web`,
      appRoot: String.raw`C:\Users\me\AppData\Local\Programs\binder\resources\app`,
      packaged: true,
      port: 4321,
    })
    // Without LOCALAPPDATA, where Windows keeps it.
    expect(appPaths({ ...windows, env: {} }).dataDir).toBe(String.raw`C:\Users\me\AppData\Local\Binder`)
  })

  it('keeps a Linux library where XDG_DATA_HOME says, or ~/.local/share', () => {
    const linux = { platform: 'linux', env: {}, home: '/home/me', appRoot: '/opt/Binder/resources/app', packaged: true } as const
    expect(appPaths(linux).dataDir).toBe('/home/me/.local/share/Binder')
    expect(appPaths({ ...linux, env: { XDG_DATA_HOME: '/data/me' } }).dataDir).toBe('/data/me/Binder')
  })

  it('uses the project\'s data/ when run from the project, where the server builds the OCR helper from its source', () => {
    expect(appPaths({ ...mac, appRoot: '/dev/binder', packaged: false })).toMatchObject({
      dataDir: '/dev/binder/data',
      envPath: '/dev/binder/data/.env',
      appRoot: '/dev/binder',
      packaged: false,
    })
    expect(appPaths({ ...windows, appRoot: String.raw`C:\dev\binder`, packaged: false })).toMatchObject({
      dataDir: String.raw`C:\dev\binder\data`,
      logDir: String.raw`C:\dev\binder\data\Logs`,
      packaged: false,
    })
  })

  it('takes BINDER_DATA_DIR and PORT for checks, and says when PORT is not a port number', () => {
    const here = { ...mac, platform: process.platform }
    expect(appPaths({ ...here, env: { BINDER_DATA_DIR: 'relative/lib', PORT: '4455' } })).toMatchObject({
      dataDir: path.resolve('relative/lib'),
      envPath: path.join(path.resolve('relative/lib'), '.env'),
      port: 4455,
    })
    expect(appPaths({ ...windows, env: { BINDER_DATA_DIR: String.raw`D:\Binder` } }).envPath).toBe(String.raw`D:\Binder\.env`)
    expect(() => appPaths({ ...mac, env: { PORT: 'abc' } })).toThrow('PORT must be a port number from 1 to 65535, not "abc".')
  })

  it('opens the library pnpm move-library copies to, and pnpm start names', () => {
    const { BINDER_DATA_DIR: _data, PORT: _port, ...env } = process.env
    const paths = appPaths({ platform: process.platform, env, home: os.homedir(), appRoot: '/app', packaged: true })
    expect(paths.dataDir).toBe(APP_LIBRARY_DIR)
  })
})

describe('appLibraryDir', () => {
  it('names the desktop app\'s library on each platform', () => {
    expect(appLibraryDir('darwin', {}, '/Users/me')).toBe('/Users/me/Library/Application Support/Binder')
    expect(appLibraryDir('win32', { LOCALAPPDATA: String.raw`D:\Local` }, String.raw`C:\Users\me`)).toBe(String.raw`D:\Local\Binder`)
    expect(appLibraryDir('win32', {}, String.raw`C:\Users\me`)).toBe(String.raw`C:\Users\me\AppData\Local\Binder`)
    // An empty variable is as good as none.
    expect(appLibraryDir('win32', { LOCALAPPDATA: '' }, String.raw`C:\Users\me`)).toBe(String.raw`C:\Users\me\AppData\Local\Binder`)
    expect(appLibraryDir('linux', {}, '/home/me')).toBe('/home/me/.local/share/Binder')
  })
})

describe('the desktop app on each platform', () => {
  const quit = () => {}
  /** A menu template's items, for comparing: the roles, labels and accelerators, and whether there's a click. */
  const shape = (items: ReturnType<typeof menuTemplate>): unknown =>
    items.map(({ submenu, click, ...item }) => ({
      ...item,
      ...(click ? { click: true } : {}),
      ...(Array.isArray(submenu) ? { submenu: shape(submenu) } : {}),
    }))

  it('keeps the Mac\'s menus: Binder, File, Edit, View and Window, with the developer tools only run from the project', () => {
    const view = (devTools: boolean) => ({
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(devTools ? [{ role: 'toggleDevTools' }] : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    })
    const mac = (devTools: boolean) => [{ role: 'appMenu' }, { role: 'fileMenu' }, { role: 'editMenu' }, view(devTools), { role: 'windowMenu' }]
    expect(menuTemplate('darwin', { packaged: true, quit })).toEqual(mac(false))
    expect(menuTemplate('darwin', { packaged: false, quit })).toEqual(mac(true))
  })

  it('gives Windows and Linux File (Close window, Quit Binder), Edit, View and Help, without the Mac\'s own menus', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const menus = shape(menuTemplate(platform, { packaged: true, quit })) as Array<{ label?: string; role?: string; submenu?: unknown[] }>
      expect(menus.map((menu) => menu.label ?? menu.role)).toEqual(['File', 'editMenu', 'View', 'Help'])
      expect(menus[0]!.submenu).toEqual([
        { role: 'close', label: 'Close window', accelerator: 'Ctrl+W' },
        { type: 'separator' },
        { label: 'Quit Binder', accelerator: 'Ctrl+Q', click: true },
      ])
      expect(menus[3]!.submenu).toEqual([{ role: 'about' }])
      expect(JSON.stringify(menus)).not.toMatch(/appMenu|windowMenu|toggleDevTools/)
    }
    const quitter = vi.fn()
    const file = menuTemplate('win32', { packaged: false, quit: quitter })[0]!.submenu as Array<{ click?: () => void }>
    file[2]!.click!()
    expect(quitter).toHaveBeenCalledOnce()
    expect(JSON.stringify(menuTemplate('win32', { packaged: false, quit }))).toContain('toggleDevTools')
  })

  it('shows each platform\'s tray icon, and opens the window on a click except on a Mac', () => {
    expect(trayIcon('darwin', '/Applications/Binder.app/Contents/Resources/app')).toEqual({
      file: '/Applications/Binder.app/Contents/Resources/app/build/icons/trayTemplate.png',
      template: true,
    })
    expect(trayIcon('win32', String.raw`C:\Programs\binder\resources\app`)).toEqual({
      file: String.raw`C:\Programs\binder\resources\app\build\icons\tray.ico`,
      template: false,
    })
    expect(trayIcon('linux', '/dev/binder')).toEqual({ file: '/dev/binder/build/icons/tray.png', template: false })
    expect(trayClickOpensWindow('darwin')).toBe(false)
    expect(trayClickOpensWindow('win32')).toBe(true)
    expect(trayClickOpensWindow('linux')).toBe(true)
  })

  describe("the tray icon's menu", () => {
    const actions = () => ({ open: vi.fn(), phoneAccess: vi.fn(), phoneSettings: vi.fn(), quit: vi.fn() })
    const off = { enabled: false, available: true, listening: false, urls: [], error: null }
    const on = {
      enabled: true,
      available: true,
      listening: true,
      urls: ['http://192.168.1.5:4322', 'http://172.20.0.1:4322'],
      error: null,
    }

    it('keeps Open Binder and Quit Binder, with Phone access between them once the server is ready', () => {
      const starting = trayMenuTemplate('win32', { ready: false, lan: null }, actions())
      expect(shape(starting)).toEqual([
        { label: 'Open Binder', click: true },
        { type: 'separator' },
        { label: 'Phone access', type: 'checkbox', checked: false, enabled: false, click: true },
        { label: 'Phone access…', enabled: false, click: true },
        { type: 'separator' },
        { label: 'Quit Binder', click: true },
      ])
      const ready = trayMenuTemplate('win32', { ready: true, lan: off }, actions())
      expect(ready.filter((item) => item.label?.startsWith('Phone access')).map((item) => item.enabled)).toEqual([true, true])
      expect(trayToolTip(off)).toBe('Binder')
    })

    it('turns phone access on and off, and opens its settings', () => {
      const act = actions()
      const [open, , phones, settings, , quit] = trayMenuTemplate('win32', { ready: true, lan: off }, act)
      for (const item of [open, phones, settings, quit]) (item!.click as () => void)()
      expect(act.phoneAccess).toHaveBeenCalledWith(true)
      expect([act.open, act.phoneSettings, act.quit].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1])
      const listening = trayMenuTemplate('win32', { ready: true, lan: on }, act)
      ;(listening[2]!.click as () => void)()
      expect(act.phoneAccess).toHaveBeenLastCalledWith(false)
    })

    it('shows the address phones open while Binder listens for them, or why it cannot', () => {
      const listening = trayMenuTemplate('win32', { ready: true, lan: on }, actions())
      expect(listening[2]).toMatchObject({ label: 'Phone access', checked: true })
      expect(listening[3]).toEqual({ label: 'Phones: http://192.168.1.5:4322', enabled: false })
      expect(trayToolTip(on)).toBe('Binder · phones: http://192.168.1.5:4322')
      const secure = { ...on, urls: ['https://192.168.1.5:4323'] }
      expect(trayToolTip(secure)).toBe('Binder · phones: https://192.168.1.5:4323')

      const failure = "Couldn't listen on port 4322: another program is using it. Set BINDER_LAN_PORT to use another port"
      const failed = trayMenuTemplate('win32', { ready: true, lan: { ...off, enabled: true, error: failure } }, actions())
      expect(failed[2]).toMatchObject({ checked: true })
      expect(failed[3]).toEqual({ label: failure, enabled: false })
      expect(trayToolTip({ ...off, enabled: true, error: failure })).toBe('Binder')
      const nowhere = trayMenuTemplate('win32', { ready: true, lan: { ...on, urls: [] } }, actions())
      expect(nowhere[3]).toEqual({ label: "Phones: this PC isn't on a network a phone can reach", enabled: false })
      // Named as Settings names the computer: Binder.app's menu-bar icon says Mac.
      const mac = trayMenuTemplate('darwin', { ready: true, lan: { ...on, urls: [] } }, actions())
      expect(mac[3]).toEqual({ label: "Phones: this Mac isn't on a network a phone can reach", enabled: false })
      const linux = trayMenuTemplate('linux', { ready: true, lan: { ...on, urls: [] } }, actions())
      expect(linux[3]!.label).toBe("Phones: this computer isn't on a network a phone can reach")
    })

    it("says why phones can't use HTTPS while they open Binder over HTTP meanwhile", () => {
      const failure = "Couldn't listen on port 4323 for HTTPS: another program is using it. Set BINDER_LAN_PORT to use another port"
      const http = trayMenuTemplate('win32', { ready: true, lan: { ...on, error: failure } }, actions())
      expect(shape(http.slice(2, 6))).toEqual([
        { label: 'Phone access', type: 'checkbox', checked: true, enabled: true, click: true },
        { label: 'Phones: http://192.168.1.5:4322', enabled: false },
        { label: failure, enabled: false },
        { label: 'Phone access…', enabled: true, click: true },
      ])
    })

    it("can't turn phone access on when BINDER_LAN=0 keeps it off, and says why", () => {
      const off = 'Phone access is off for this Binder: it was started with BINDER_LAN=0'
      const lan = { enabled: false, available: false, listening: false, urls: [], error: off }
      const menu = trayMenuTemplate('win32', { ready: true, lan }, actions())
      expect(shape(menu.slice(2, 5))).toEqual([
        { label: 'Phone access', type: 'checkbox', checked: false, enabled: false, click: true },
        { label: off, enabled: false },
        { label: 'Phone access…', enabled: true, click: true },
      ])
    })
  })

  it('gives the window an icon on Windows and Linux, and none on a Mac', () => {
    expect(windowIcon('win32', String.raw`C:\dev\binder`)).toBe(String.raw`C:\dev\binder\build\icons\Binder.ico`)
    expect(windowIcon('linux', '/dev/binder')).toBe('/dev/binder/build/icons/icon.png')
    expect(windowIcon('darwin', '/dev/binder')).toBeNull()
  })

  it('asks a Mac for the camera, follows Windows\' camera privacy switch, and allows it on Linux', () => {
    const status = vi.fn((): MediaAccessStatus => 'granted')
    expect(cameraDecision('darwin', status)).toBe('ask')
    expect(cameraDecision('linux', status)).toBe(true)
    expect(status).not.toHaveBeenCalled()
    const windows = (answer: MediaAccessStatus) => cameraDecision('win32', () => answer)
    expect(windows('granted')).toBe(true)
    // Windows answers "not-determined" or "unknown" where it keeps no switch (older versions): the camera's tried.
    expect(windows('not-determined')).toBe(true)
    expect(windows('unknown')).toBe(true)
    expect(windows('denied')).toBe(false)
    expect(windows('restricted')).toBe(false)
  })

  it('quits a running Binder when it\'s opened again with --quit', () => {
    expect(quitRequested([String.raw`C:\Users\me\AppData\Local\Programs\binder\Binder.exe`, '--quit'])).toBe(true)
    expect(quitRequested(['Binder.exe', '--QUIT'])).toBe(true)
    expect(quitRequested(['/Applications/Binder.app/Contents/MacOS/Binder', '--allow-file-access-from-files', '--quit'])).toBe(true)
    expect(quitRequested(['Binder.exe'])).toBe(false)
    expect(quitRequested(['Binder.exe', '--quitter', 'quit'])).toBe(false)
    // The second launch's data says so whatever happened to its command line.
    expect(quitRequested(['Binder.exe'], { quit: true })).toBe(true)
    for (const data of [{ quit: false }, { quit: 'yes' }, null, undefined, 'quit']) expect(quitRequested(['Binder.exe'], data)).toBe(false)
  })

  it('carries the installer\'s app ID on Windows (package.json\'s build.appId)', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { build: { appId: string } }
    expect(APP_USER_MODEL_ID).toBe(pkg.build.appId)
  })
})

describe('the log (rotateLog)', () => {
  const logs = () => {
    const dir = tempDir('binder-log-')
    const file = path.join(dir, 'binder.log')
    const previous = path.join(dir, 'binder.previous.log')
    return { file, previous }
  }

  it('starts each run\'s log, keeping the one before', () => {
    const { file, previous } = logs()
    rotateLog(file, previous)
    expect(fs.existsSync(previous)).toBe(false)
    fs.writeFileSync(file, 'first run\n')
    rotateLog(file, previous)
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.readFileSync(previous, 'utf8')).toBe('first run\n')
  })

  it('copies and empties a log it can\'t rename (another program has it open, on Windows)', () => {
    const { file, previous } = logs()
    fs.writeFileSync(file, 'last run\n')
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' })
    })
    onTestFinished(() => rename.mockRestore())
    rotateLog(file, previous, 'linux')
    expect(fs.readFileSync(previous, 'utf8')).toBe('last run\n')
    expect(fs.readFileSync(file, 'utf8')).toBe('')
  })

  it('never throws: when the log can be neither renamed nor copied, this run\'s follows it', () => {
    const { file, previous } = logs()
    fs.writeFileSync(file, 'last run\n')
    const locked = () => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    }
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(locked)
    const copy = vi.spyOn(fs, 'copyFileSync').mockImplementation(locked)
    onTestFinished(() => {
      rename.mockRestore()
      copy.mockRestore()
    })
    expect(() => rotateLog(file, previous, 'linux')).not.toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe('last run\n')
  })
})

describe('links', () => {
  it('keeps Binder\'s own pages in the window', () => {
    expect(isAppUrl('http://localhost:4321/decks/3', 'http://localhost:4321')).toBe(true)
    expect(isAppUrl('http://localhost:4455/', 'http://localhost:4321')).toBe(false)
    expect(isAppUrl('https://scryfall.com/card/m10/146', 'http://localhost:4321')).toBe(false)
    expect(isAppUrl('not a url', 'http://localhost:4321')).toBe(false)
  })

  it('opens web links in the browser, and nothing else', () => {
    expect(externalUrl('https://scryfall.com/card/m10/146')).toBe('https://scryfall.com/card/m10/146')
    expect(externalUrl('http://example.com/')).toBe('http://example.com/')
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:me@example.com', 'nonsense']) expect(externalUrl(url)).toBeNull()
  })

  it('lets Binder\'s own pages use the camera and copy to the clipboard, and nothing else', () => {
    const appUrl = 'http://localhost:4321'
    for (const permission of ['media', 'clipboard-sanitized-write']) {
      expect(permissionAllowed(permission, 'http://localhost:4321/scan', appUrl)).toBe(true)
      expect(permissionAllowed(permission, 'https://scryfall.com/card/m10/146', appUrl)).toBe(false)
      expect(permissionAllowed(permission, 'http://localhost:4321/scan', null)).toBe(false)
      expect(permissionAllowed(permission, undefined, appUrl)).toBe(false)
    }
    for (const permission of ['geolocation', 'notifications', 'clipboard-read']) {
      expect(permissionAllowed(permission, 'http://localhost:4321/decks/3', appUrl)).toBe(false)
    }
    // The camera, but never the microphone, even asked for with it.
    expect(permissionAllowed('media', 'http://localhost:4321/scan', appUrl, ['video'])).toBe(true)
    expect(permissionAllowed('media', 'http://localhost:4321/scan', appUrl, ['audio'])).toBe(false)
    expect(permissionAllowed('media', 'http://localhost:4321/scan', appUrl, ['video', 'audio'])).toBe(false)
  })
})

describe('messages', () => {
  it('says what to do when the port is taken, and anything else as the server said it', () => {
    expect(startupFailure({ code: 'port_in_use', message: 'Port 4321 is already in use: …' }, 4321)).toBe(
      'Port 4321 is already in use: Binder may already be running from the terminal (pnpm start). Quit that one, then open Binder again.',
    )
    expect(startupFailure({ code: 'library', message: '[database] file is not a database' }, 4321)).toBe(
      '[database] file is not a database',
    )
  })

  it('points Windows at the ports it keeps for itself when it refuses one', () => {
    const denied = { code: 'port_denied', message: "Binder isn't allowed to listen on port 4321. Start it with PORT set to another port." }
    const windows = startupFailure(denied, 4321, 'win32')
    expect(windows).toMatch(/^Windows won't let Binder use port 4321: it may keep that port for Hyper-V, WSL or Docker\./)
    expect(windows).toContain('`netsh interface ipv4 show excludedportrange protocol=tcp`')
    // On a Mac, the server's own line, as before.
    expect(startupFailure(denied, 4321, 'darwin')).toBe(denied.message)
  })

  it('shows what Binder is doing while it starts, escaped', () => {
    const page = startingPage('Backing up your library <before> upgrading it…')
    expect(page.startsWith('data:text/html;charset=utf-8,')).toBe(true)
    expect(decodeURIComponent(page)).toContain('Backing up your library &lt;before&gt; upgrading it…')
  })
})
