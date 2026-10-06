import path from 'node:path'
import { appLibraryDir } from '../src/server/config.ts'
import { portProblem } from '../src/server/startup.ts'

/** Where the desktop app listens: the same address as Binder from the terminal. */
export const APP_PORT = 4321

/** The environment variable main.ts passes the paths to the server's process in (electron/server.ts), as JSON. */
export const PATHS_VARIABLE = 'BINDER_APP_PATHS'

/** Where the desktop app keeps things, and where it listens (spec §3.4). */
export interface AppPaths {
  /** The library: `binder.db`, with `backups/`, `bulk/`, and `scans/` beside it. */
  dataDir: string
  /** The Anthropic API key, which Settings writes: in the library folder. */
  envPath: string
  /** The window's own files (its storage and caches), kept apart from the library. */
  electronDir: string
  /** The server's log, one file per run. */
  logDir: string
  webDistDir: string
  /** Binder's own files (the app's, or the project's), where the server finds its OCR helper (ocrHelper). */
  appRoot: string
  /** Whether it's the packaged app, whose OCR helper comes built; run from the project, the Mac's is built there. */
  packaged: boolean
  port: number
}

/**
 * The desktop app's paths, for `platform` (Windows' or POSIX paths, so both are checked on any computer). Packaged,
 * the library is appLibraryDir's: `~/Library/Application Support/Binder` on a Mac, `%LOCALAPPDATA%\Binder` on Windows;
 * run from the project (`pnpm app:dev`), it's the project's `data/`, like `pnpm start`. BINDER_DATA_DIR and PORT
 * override both, for checks. Throws the one-line message when PORT isn't a port number.
 */
export function appPaths(input: {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
  appRoot: string
  packaged: boolean
}): AppPaths {
  const { platform, env, home, appRoot, packaged } = input
  const { join, resolve } = platform === 'win32' ? path.win32 : path.posix
  const badPort = portProblem(env.PORT)
  if (badPort) throw new Error(badPort)
  const dataDir = env.BINDER_DATA_DIR
    ? resolve(env.BINDER_DATA_DIR)
    : packaged
      ? appLibraryDir(platform, env, home)
      : join(appRoot, 'data')
  return {
    dataDir,
    envPath: join(dataDir, '.env'),
    electronDir: join(dataDir, 'Electron'),
    logDir: join(dataDir, 'Logs'),
    webDistDir: join(appRoot, 'dist', 'web'),
    appRoot,
    packaged,
    port: env.PORT === undefined ? APP_PORT : Number(env.PORT),
  }
}
