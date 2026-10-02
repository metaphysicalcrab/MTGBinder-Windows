import path from 'node:path'
import { portProblem } from '../src/server/startup.ts'

/** Where Binder.app listens: the same address as Binder from the terminal. */
export const APP_PORT = 4321

/** Where Binder.app keeps things, and where it listens (spec §3.4). */
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
 * Binder.app's paths. Packaged, the library is `~/Library/Application Support/Binder`; run from the project
 * (`pnpm app:dev`), it's the project's `data/`, like `pnpm start`. BINDER_DATA_DIR and PORT override both, for checks.
 * Throws the one-line message when PORT isn't a port number.
 */
export function appPaths(input: { appData: string; appRoot: string; packaged: boolean; env: NodeJS.ProcessEnv }): AppPaths {
  const { appData, appRoot, packaged, env } = input
  const badPort = portProblem(env.PORT)
  if (badPort) throw new Error(badPort)
  const dataDir = env.BINDER_DATA_DIR
    ? path.resolve(env.BINDER_DATA_DIR)
    : packaged
      ? path.join(appData, 'Binder')
      : path.join(appRoot, 'data')
  return {
    dataDir,
    envPath: path.join(dataDir, '.env'),
    electronDir: path.join(dataDir, 'Electron'),
    logDir: path.join(dataDir, 'Logs'),
    webDistDir: path.join(appRoot, 'dist', 'web'),
    appRoot,
    packaged,
    port: env.PORT === undefined ? APP_PORT : Number(env.PORT),
  }
}
