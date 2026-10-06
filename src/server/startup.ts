import fs from 'node:fs'
import path from 'node:path'

/** Startup checks and messages for the server (`main.ts`): one clear line each, instead of a stack trace. */

/** What's wrong with the `PORT` setting, or null when it's unset or a port number (1–65535). */
export function portProblem(raw: string | undefined): string | null {
  if (raw === undefined) return null
  return /^[1-9]\d{0,4}$/.test(raw.trim()) && Number(raw) <= 65535
    ? null
    : `PORT must be a port number from 1 to 65535, not "${raw}".`
}

/**
 * The line to print when the server can't start listening. On Windows, a port refused for no reason Binder can see is
 * usually one Windows keeps for Hyper-V, WSL or Docker, which a free port can be too.
 */
export function listenFailure(err: NodeJS.ErrnoException, port: number, platform = process.platform): string {
  if (err.code === 'EADDRINUSE') {
    return `Port ${port} is already in use: Binder may already be running. Stop it, or start this one with PORT set to another port.`
  }
  if (err.code === 'EACCES') {
    const reserved =
      platform === 'win32'
        ? ' Windows may keep it for Hyper-V, WSL or Docker: `netsh interface ipv4 show excludedportrange protocol=tcp` lists the ports it keeps.'
        : ''
    return `Binder isn't allowed to listen on port ${port}. Start it with PORT set to another port.${reserved}`
  }
  return `Couldn't start the server on port ${port}: ${err.message}`
}

/**
 * What to do on Windows about a port it won't let Binder use, most often one it keeps for Hyper-V, WSL or Docker: how
 * to see those, and the setting (`PORT`, or `BINDER_LAN_PORT` for phones) as an environment variable for the user's
 * account, which is how the desktop app, opened from the Start menu, gets one. The desktop app's dialog says it of its
 * own port, and the phones' listener of theirs; each ends it with what to do next.
 */
export function windowsKeptPortAdvice(variable: string): string {
  return (
    'In a terminal, `netsh interface ipv4 show excludedportrange protocol=tcp` lists the ports it keeps. Restarting ' +
    `the PC often frees it; or set a ${variable} environment variable for your account to a port outside those ranges`
  )
}

/** Whether two paths name one folder: on Windows and the Mac, whose file systems ignore letter case, in any case. */
function sameFolder(a: string, b: string, platform: NodeJS.Platform): boolean {
  const [x, y] = [path.resolve(a), path.resolve(b)]
  return platform === 'win32' || platform === 'darwin' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/**
 * The line `pnpm start` prints when the desktop app keeps its own library (`appLibrary`) and this Binder uses another,
 * so the two aren't taken for one. Null when there's no desktop app library, or it's the one in use.
 */
export function appLibraryNote(dataDir: string, appLibrary: string, platform = process.platform): string | null {
  if (sameFolder(dataDir, appLibrary, platform)) return null
  if (!fs.existsSync(path.join(appLibrary, 'binder.db'))) return null
  const app = platform === 'darwin' ? 'Binder.app' : 'The Binder app'
  return `[library] ${app} keeps its library in ${appLibrary}; this Binder uses ${dataDir}.`
}

/** Where a Binder keeps its library and its key, for locationWarnings. */
export interface LibraryLocation {
  dataDir: string
  envPath: string
}

/**
 * Windows' path limit (MAX_PATH, with the closing NUL), which SQLite's files can be held to. The library's longest
 * paths are its backups' partial copies, `<folder>\backups\binder-YYYY-MM-DD-before-NNN-N.db.tmp`: the folder's and
 * about 50 characters more.
 */
const WINDOWS_MAX_PATH = 260
const LONGEST_LIBRARY_NAME = 50

/** Whether `file` is `folder` or inside it, in any letter case (Windows paths). */
function insideWindowsFolder(file: string, folder: string): boolean {
  const [f, d] = [path.win32.resolve(file).toLowerCase(), path.win32.resolve(folder).toLowerCase()]
  return f === d || f.startsWith(d.endsWith('\\') ? d : `${d}\\`)
}

/**
 * Lines warning about where the library or the key file is, on Windows (none elsewhere):
 * - in OneDrive, which uploads the database while Binder writes it (copies that don't match, files held open, and
 *   failed backups), and puts the API key in the cloud;
 * - on a network share, where SQLite can't keep its write-ahead log safely;
 * - in a folder so deep that the library's files come near Windows' 260-character path limit, past which SQLite can't
 *   open them.
 */
export function locationWarnings(location: LibraryLocation, platform = process.platform, env = process.env): string[] {
  if (platform !== 'win32') return []
  const { dataDir, envPath } = location
  const oneDrive = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter((dir): dir is string => !!dir)
  const inOneDrive = (file: string) => oneDrive.some((dir) => insideWindowsFolder(file, dir))
  const warnings: string[] = []
  if (inOneDrive(dataDir)) {
    warnings.push(
      `[library] ${dataDir} is in OneDrive, which copies the library while Binder writes it and can hold its files open: set BINDER_DATA_DIR to a folder outside OneDrive, such as %LOCALAPPDATA%\\Binder.`,
    )
  }
  if (inOneDrive(envPath)) {
    warnings.push(`[api key] ${envPath} is in OneDrive, which uploads your Anthropic API key with it.`)
  }
  // \\server\share\…, and \\?\UNC\server\share\…; not \\?\C:\… (a local path, written long).
  if (/^[\\/]{2}(?![?.][\\/])/.test(dataDir) || /^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(dataDir)) {
    warnings.push(
      `[library] ${dataDir} is on a network share, where the library can be damaged (SQLite can't share its log safely there): keep it on this PC, with BINDER_DATA_DIR.`,
    )
  }
  if (dataDir.length + LONGEST_LIBRARY_NAME >= WINDOWS_MAX_PATH) {
    warnings.push(
      `[library] ${dataDir} is a long path (${dataDir.length} characters): Windows can refuse the library's files past 260, so backups or the library itself may fail to open. Use a shorter folder, with BINDER_DATA_DIR.`,
    )
  }
  return warnings
}

/** What stopOnSignals needs of the process: tests pass a stand-in. */
export interface SignalTarget {
  on(signal: NodeJS.Signals, listener: () => void): unknown
  exit(code: number): void
}

/** How long a stop may take before the process exits anyway: within Windows' grace after its console window closes. */
export const STOP_WAIT_MS = 3_000

/**
 * Stops Binder cleanly (it stops listening and closes the library, so its log is folded back in) when the terminal
 * asks it to: Ctrl+C (SIGINT) or a `kill` (SIGTERM), and on Windows Ctrl+Break (SIGBREAK) or closing the console
 * window (SIGHUP, after which Windows ends the process within seconds). Then it exits. A second signal, or a stop
 * that takes longer than `waitMs`, exits at once.
 */
export function stopOnSignals(
  binder: { stop(): Promise<void> },
  { platform = process.platform, target = process as SignalTarget, waitMs = STOP_WAIT_MS, log = console.log } = {},
): void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', ...(platform === 'win32' ? (['SIGBREAK', 'SIGHUP'] as const) : [])]
  let stopping = false
  for (const signal of signals) {
    target.on(signal, () => {
      if (stopping) return target.exit(1)
      stopping = true
      setTimeout(() => target.exit(1), waitMs).unref()
      binder.stop().then(
        () => {
          log('Binder stopped')
          target.exit(0)
        },
        (err: unknown) => {
          console.error(`Couldn't stop Binder cleanly: ${err instanceof Error ? err.message : String(err)}`)
          target.exit(1)
        },
      )
    })
  }
}
