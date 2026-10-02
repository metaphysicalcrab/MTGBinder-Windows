// The desktop app (spec §3.4): one window onto Binder's pages, an icon in the Mac's menu bar or Windows' notification
// area, and Binder's server in its own process. Closing the window keeps Binder running (scans finish, card data
// refreshes); Quit (Cmd+Q on a Mac, Ctrl+Q on Windows, or the icon's menu) stops everything, and so does opening Binder
// again with --quit (`Binder.exe --quit`), which `pnpm app` uses before installing. Entry point: package.json "main".
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  app,
  BaseWindow,
  BrowserWindow,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  nativeTheme,
  session,
  shell,
  systemPreferences,
  Tray,
  type UtilityProcess,
  utilityProcess,
} from 'electron'
import { externalUrl, isAppUrl, permissionAllowed } from './links.ts'
import { rotateLog } from './log.ts'
import { startingPage, startupFailure } from './messages.ts'
import { type AppPaths, appPaths, PATHS_VARIABLE } from './paths.ts'
import {
  APP_USER_MODEL_ID,
  cameraDecision,
  menuTemplate,
  quitRequested,
  trayClickOpensWindow,
  trayIcon,
  windowIcon,
} from './platform.ts'
import type { ServerMessage } from './server.ts'

app.setName('Binder')
// Before any window or tray icon: Windows groups them, the taskbar button and the Start menu shortcut by this ID. The
// installer's when packaged; run from the project, Electron's own path, so it isn't taken for the installed app.
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? APP_USER_MODEL_ID : process.execPath)

let paths: AppPaths
try {
  paths = appPaths({
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    appRoot: app.getAppPath(),
    packaged: app.isPackaged,
  })
} catch (err) {
  dialog.showErrorBox("Binder couldn't start", err instanceof Error ? err.message : String(err))
  app.exit(1)
  throw err
}
// The window's own files (storage, caches) go beside the library, not in it. Before anything reads userData (the
// single-instance lock is kept there too).
fs.mkdirSync(paths.electronDir, { recursive: true })
app.setPath('userData', paths.electronDir)

/** The server's process, until it exits. */
let server: UtilityProcess | null = null
/** The web app's address, once the server listens. */
let appUrl: string | null = null
let status = 'Starting…'
let window: BrowserWindow | null = null
let tray: Tray | null = null
/** Windows: the hidden window that hears the session end (stopWithWindows). */
let sessionListener: BaseWindow | null = null
let quitting = false
/** Whether the server has been told to stop (by Quit, or Windows ending the session). */
let stopping = false
/**
 * This run's log, opened first thing once Electron is ready. It's never ended: the server's output can still arrive
 * after its process exits, and Binder's own exit closes the file.
 */
let log: fs.WriteStream | null = null

/** The server's log file, one per run, the one before kept beside it as binder.previous.log. */
const logFile = () => path.join(paths.logDir, 'binder.log')

function openLog(): fs.WriteStream {
  try {
    fs.mkdirSync(paths.logDir, { recursive: true })
    rotateLog(logFile(), path.join(paths.logDir, 'binder.previous.log'))
  } catch {
    // No folder for it: the stream below fails quietly, and Binder runs without a log.
  }
  // Appending (to a file new after the rotation), so the stream's writes land after appLog's rather than over them.
  const stream = fs.createWriteStream(logFile(), { flags: 'a' })
  // The log is best-effort: a write that fails (a full disk, say) must never throw in the main process.
  stream.on('error', () => {})
  return stream
}

/**
 * Adds why Binder stops to the log, at once: the dialog that follows holds the main process (and the log's stream)
 * until Binder quits. Best-effort, like the log.
 */
function appLog(message: string): void {
  try {
    fs.appendFileSync(logFile(), `[app] ${message}\n`)
  } catch {
    // No log to add to: the dialog still says it.
  }
}

/**
 * Loads a page in the window. A newer load replacing one still in flight is expected (the "upgrading" page over
 * "Starting…", say), and rejects the older one's promise: that's ignored.
 */
function load(win: BrowserWindow, url: string): void {
  win.loadURL(url).catch(() => {})
}

/** Shows Binder's window, opening it (on Binder's pages, or what it's doing while it starts) if it's closed. */
function showWindow(): void {
  // A second launch or a Dock click just before Electron is ready can't open a window yet, and needn't: whenReady
  // opens it.
  if (!app.isReady()) return
  if (window) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    return
  }
  const icon = windowIcon(process.platform, app.getAppPath())
  const win = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 820,
    minHeight: 560,
    title: 'Binder',
    backgroundColor: '#0c0a09',
    show: false,
    // Windows: the menu bar shows with Alt, rather than as a white strip above the dark page.
    ...(process.platform === 'win32' ? { autoHideMenuBar: true } : {}),
    ...(icon ? { icon } : {}),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  window = win
  win.once('ready-to-show', () => win.show())
  // Closing the window keeps Binder running; the page (and its camera) goes with the window.
  win.on('closed', () => {
    if (window === win) window = null
    if (!quitting) sayStillRunning()
  })
  // Web links open in the browser; Binder's own pages stay in the window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalUrl(url)
    if (external && !(appUrl && isAppUrl(url, appUrl))) void shell.openExternal(external)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (appUrl && isAppUrl(url, appUrl)) return
    event.preventDefault()
    const external = externalUrl(url)
    if (external) void shell.openExternal(external)
  })
  load(win, appUrl ?? startingPage(status))
}

/**
 * Windows, the first time the window is closed: says Binder is still running, and where its icon is. Windows 11 tucks
 * a new tray icon away under the notification area's arrow, so without this Binder seems gone while it still keeps the
 * library open. Once: a file in the window's own folder remembers it was said.
 */
function sayStillRunning(): void {
  if (process.platform !== 'win32' || !tray) return
  const said = path.join(paths.electronDir, 'still-running-said')
  try {
    if (fs.existsSync(said)) return
    fs.writeFileSync(said, '')
  } catch {
    return
  }
  tray.displayBalloon({
    title: 'Binder is still running',
    content: 'To open it, click its icon in the notification area. To quit, right-click the icon → Quit Binder.',
  })
}

/** Says what Binder is doing in a window still waiting for it to start. */
function setStatus(text: string): void {
  status = text
  if (window && !appUrl) load(window, startingPage(text))
}

/** Stops Binder for good after a message, when it can't start or its server stops. */
function fail(message: string): void {
  quitting = true
  appLog(message)
  dialog.showErrorBox("Binder couldn't start", message)
  server?.kill()
  app.exit(1)
}

function startServer(): void {
  const child = utilityProcess.fork(path.join(import.meta.dirname, 'server.ts'), [], {
    serviceName: 'Binder server',
    stdio: 'pipe',
    env: { ...process.env, [PATHS_VARIABLE]: JSON.stringify(paths) },
  })
  server = child
  child.stdout?.on('data', (chunk: Buffer) => log?.write(chunk))
  child.stderr?.on('data', (chunk: Buffer) => log?.write(chunk))
  child.on('message', (message: ServerMessage) => {
    if (message.type === 'log') log?.write(`${message.line}\n`)
    else if (message.type === 'upgrading') setStatus('Backing up your library before upgrading it (a few seconds)…')
    else if (message.type === 'failed') fail(startupFailure(message, paths.port))
    else if (message.type === 'ready') {
      appUrl = message.url
      if (window) load(window, message.url)
    }
  })
  child.on('exit', (code) => {
    // Gone: a quit now goes ahead.
    if (server === child) server = null
    if (!quitting) {
      quitting = true
      const message = `Binder's server stopped unexpectedly (exit ${code}). Open Binder again to restart it.`
      appLog(message)
      dialog.showErrorBox('Binder stopped', message)
      app.exit(1)
    }
  })
}

/**
 * Binder's own pages get the camera (the Scan page: with the Mac's permission, asked for once; on Windows, unless its
 * camera privacy switch is off) and clipboard writes (the Copy buttons); nothing else, and no other page.
 */
function allowPermissions(): void {
  // Chromium's fake camera (the end-to-end check's) isn't the computer's: there's nothing to ask for.
  const fakeCamera = app.commandLine.hasSwitch('use-fake-device-for-media-stream')
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => permissionAllowed(permission, origin, appUrl))
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    // Every request is answered, once: one left unanswered would leave the page's camera waiting for good.
    let answered = false
    const answer = (allowed: boolean) => {
      if (answered) return
      answered = true
      callback(allowed)
    }
    try {
      const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
      if (!permissionAllowed(permission, details.requestingUrl ?? contents.getURL(), appUrl, mediaTypes)) return answer(false)
      const video = permission === 'media' && mediaTypes.includes('video')
      if (!video || fakeCamera) return answer(true)
      const decision = cameraDecision(process.platform, () => systemPreferences.getMediaAccessStatus('camera'))
      if (decision !== 'ask') return answer(decision)
      void systemPreferences.askForMediaAccess('camera').then(answer, () => answer(false))
    } catch {
      answer(false)
    }
  })
}

/** The tray icon's menu. */
function trayMenu(): MenuItemConstructorOptions[] {
  return [
    { label: 'Open Binder', click: showWindow },
    { type: 'separator' },
    { label: 'Quit Binder', click: () => app.quit() },
  ]
}

function buildMenus(): void {
  const menus = menuTemplate(process.platform, { packaged: app.isPackaged, quit: () => app.quit() })
  Menu.setApplicationMenu(Menu.buildFromTemplate(menus))
  // Drawn by `pnpm icons` (scripts/make-icons.ts) into build/icons.
  const { file, template } = trayIcon(process.platform, app.getAppPath())
  const icon = nativeImage.createFromPath(file)
  if (icon.isEmpty()) appLog(`No tray icon at ${file}: run pnpm icons.`)
  if (template) icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Binder')
  tray.setContextMenu(Menu.buildFromTemplate(trayMenu()))
  // Windows and Linux: a click opens Binder, and the menu is a right-click away. A Mac's click shows the menu.
  if (trayClickOpensWindow(process.platform)) tray.on('click', showWindow)
}

/**
 * Windows: stops the server cleanly when Windows ends the session (shutting down, restarting, signing out), which
 * doesn't quit apps the usual way. A hidden window hears it (Binder may have no window open); Windows ends Binder once
 * the handler returns, so it waits there, up to 3 seconds, for the server to close the library. Best-effort: without
 * it, the library's log is folded back in when it's next opened.
 */
function stopWithWindows(): void {
  try {
    sessionListener = new BaseWindow({ show: false, skipTaskbar: true })
  } catch (err) {
    appLog(`Couldn't listen for Windows ending the session: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  sessionListener.on('session-end', () => {
    if (!server) return
    const { pid } = server
    // A quit may have asked it to stop already: then it's only waited for.
    if (!stopping) appLog('Windows is ending the session: stopping the server')
    stopServer()
    const until = Date.now() + 3_000
    while (pid !== undefined && running(pid) && Date.now() < until) blockFor(50)
  })
}

/**
 * Asks the server to stop (it closes the library), kills it if it hasn't after 5 seconds, and quits Binder once it has
 * exited. Once: asked again while it stops, it's left to finish.
 */
function stopServer(): void {
  if (!server || stopping) return
  stopping = true
  quitting = true
  const child = server
  const force = setTimeout(() => child.kill(), 5000)
  child.once('exit', () => {
    clearTimeout(force)
    app.quit()
  })
  child.postMessage({ type: 'stop' })
}

/** Whether the process is still running. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits, holding the main process: only while Windows ends the session, when nothing else is left to do. */
const blockFor = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// One Binder at a time: opening it again brings its window forward, or with --quit, quits it. A second launch's
// command line can come through changed (Chromium's), so --quit also travels in the lock's data.
const quitAsked = quitRequested(process.argv)
if (!app.requestSingleInstanceLock({ quit: quitAsked })) {
  app.quit()
} else if (quitAsked) {
  // No Binder running to quit.
  app.quit()
} else {
  app.on('second-instance', (_event, argv, _cwd, data) => {
    if (quitRequested(argv, data)) app.quit()
    else showWindow()
  })
  // Clicking the Dock icon with the window closed opens it again (a Mac's).
  app.on('activate', showWindow)
  // Closing the window keeps Binder running (in the menu bar, or the notification area).
  app.on('window-all-closed', () => {})
  // Quitting stops the server first (stopServer). Every quit waits until it has exited: one let through while it stops
  // (Ctrl+Q again, the tray's Quit Binder, `Binder.exe --quit`) would end it mid-stop.
  app.on('before-quit', (event) => {
    if (!server) return
    event.preventDefault()
    stopServer()
  })
  // No top-level await on whenReady: an ES module entry that awaits it never gets there.
  void app.whenReady().then(() => {
    // Anything that throws here would leave Binder without a window, or on "Starting…" for good: it's said instead.
    try {
      // First, so what's said before the server starts (a missing tray icon, say) is in this run's log, not rotated out
      // with the last run's.
      log = openLog()
      // Windows draws the title bar dark, over the dark page, whatever its own light or dark setting.
      if (process.platform !== 'darwin') nativeTheme.themeSource = 'dark'
      allowPermissions()
      buildMenus()
      startServer()
      showWindow()
      if (process.platform === 'win32') stopWithWindows()
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })
}
