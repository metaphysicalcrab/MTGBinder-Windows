// Binder's server inside the desktop app, in its own process (Electron's utility process), so the window and the tray
// icon stay responsive while the library does slow work (a backup before an upgrade, compacting, a card data refresh).
// main.ts starts it with the paths as JSON in BINDER_APP_PATHS (the environment, not the command line, whose quoting
// Windows paths, with their backslashes and a name's spaces or accents, needn't survive); it answers with messages
// (ServerMessage), stops when told to, and turns phone access on or off for the tray (AppMessage).
import { ocrHelper } from '../src/server/scanner/ocr-helper.ts'
import { type RunningBinder, startBinder, StartupError } from '../src/server/start.ts'
import type { LanSummary } from '../src/shared/types.ts'
import { type AppPaths, PATHS_VARIABLE } from './paths.ts'

/** What the server tells the app. */
export type ServerMessage =
  | { type: 'log'; line: string }
  | { type: 'upgrading' }
  | { type: 'ready'; url: string }
  | { type: 'failed'; code: string; message: string }
  /** Phone access, whenever it changes (on, off, listening, another address), for the tray. */
  | { type: 'lan'; summary: LanSummary }

/** What the app tells the server: to stop (Binder is quitting), or to turn phone access on or off (the tray). */
export type AppMessage = { type: 'stop' } | { type: 'lan'; enabled: boolean }

const port = process.parentPort
const post = (message: ServerMessage) => port.postMessage(message)
const paths = JSON.parse(process.env[PATHS_VARIABLE] ?? '{}') as AppPaths
// Not passed on to the OCR helper.
delete process.env[PATHS_VARIABLE]
let binder: RunningBinder | null = null

port.on('message', ({ data }: { data: unknown }) => {
  const message = data as AppMessage | null
  if (message?.type === 'lan') return setLan(message.enabled === true)
  if (message?.type !== 'stop') return
  void (binder?.stop() ?? Promise.resolve()).finally(() => {
    post({ type: 'log', line: 'Binder stopped' })
    process.exit(0)
  })
})

/**
 * The tray's Phone access, as Settings → Phone access turns it on or off, but in this process rather than through the
 * API. What it came to is posted back either way, so the tray shows it.
 */
function setLan(enabled: boolean): void {
  if (!binder) return
  const running = binder
  running.setLan(enabled).then(
    (summary) => post({ type: 'lan', summary }),
    (err: unknown) => {
      post({ type: 'log', line: `[phone] ${err instanceof Error ? err.message : String(err)}` })
      post({ type: 'lan', summary: running.lan })
    },
  )
}

startBinder({
  dataDir: paths.dataDir,
  envPath: paths.envPath,
  webDistDir: paths.webDistDir,
  // Run from the project, the Mac's helper is built from its source; Binder.app ships it built.
  ocr: ocrHelper({ platform: process.platform, appRoot: paths.appRoot, buildFromSource: !paths.packaged }),
  port: paths.port,
  log: (line) => post({ type: 'log', line }),
  onUpgradeBackup: () => post({ type: 'upgrading' }),
  onLanChange: (summary) => post({ type: 'lan', summary }),
}).then(
  (running) => {
    binder = running
    post({ type: 'ready', url: running.url })
    // Phone access left off says nothing as Binder starts.
    post({ type: 'lan', summary: running.lan })
  },
  (err: unknown) => {
    const failure = err instanceof StartupError ? { code: err.code, message: err.message } : { code: 'crash', message: String(err) }
    // The app shows it and quits, which ends this process too.
    post({ type: 'failed', ...failure })
  },
)
