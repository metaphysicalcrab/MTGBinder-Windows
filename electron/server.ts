// Binder's server inside Binder.app, in its own process (Electron's utility process), so the window and the menu-bar
// icon stay responsive while the library does slow work (a backup before an upgrade, compacting, a card data refresh).
// main.ts starts it with the paths as JSON; it answers with messages (ServerMessage) and stops when told to.
import { ocrHelper } from '../src/server/scanner/ocr-helper.ts'
import { type RunningBinder, startBinder, StartupError } from '../src/server/start.ts'
import type { AppPaths } from './paths.ts'

/** What the server tells the app. */
export type ServerMessage =
  | { type: 'log'; line: string }
  | { type: 'upgrading' }
  | { type: 'ready'; url: string }
  | { type: 'failed'; code: string; message: string }

const port = process.parentPort
const post = (message: ServerMessage) => port.postMessage(message)
const paths = JSON.parse(process.argv[2] ?? '{}') as AppPaths
let binder: RunningBinder | null = null

port.on('message', ({ data }: { data: unknown }) => {
  if ((data as { type?: string } | null)?.type !== 'stop') return
  void (binder?.stop() ?? Promise.resolve()).finally(() => {
    post({ type: 'log', line: 'Binder stopped' })
    process.exit(0)
  })
})

startBinder({
  dataDir: paths.dataDir,
  envPath: paths.envPath,
  webDistDir: paths.webDistDir,
  // Run from the project, the Mac's helper is built from its source; Binder.app ships it built.
  ocr: ocrHelper({ platform: process.platform, appRoot: paths.appRoot, buildFromSource: !paths.packaged }),
  port: paths.port,
  log: (line) => post({ type: 'log', line }),
  onUpgradeBackup: () => post({ type: 'upgrading' }),
}).then(
  (running) => {
    binder = running
    post({ type: 'ready', url: running.url })
  },
  (err: unknown) => {
    const failure = err instanceof StartupError ? { code: err.code, message: err.message } : { code: 'crash', message: String(err) }
    // The app shows it and quits, which ends this process too.
    post({ type: 'failed', ...failure })
  },
)
