import fs from 'node:fs'
import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import type { Hono } from 'hono'
import { createAiClient } from './ai/client.ts'
import { createKeyStore } from './ai/key-store.ts'
import { createApp } from './app.ts'
import { backupIfDue } from './backup.ts'
import { createBulkImporter } from './bulk/import.ts'
import { ensureCardNamesCurrent } from './cards/repo.ts'
import { libraryPaths } from './config.ts'
import { type DB, openDb, openFailureLine } from './db/index.ts'
import { createCardLookups } from './scanner/lookups.ts'
import { createOcrClient } from './scanner/ocr-client.ts'
import type { OcrHelper } from './scanner/ocr-helper.ts'
import { createScanWorker } from './scanner/worker.ts'
import { createScryfallClient, type ScryfallClient } from './scryfall/client.ts'
import { listenFailure, locationWarnings } from './startup.ts'
import { trustSystemCertificates } from './system-ca.ts'

/** Where a Binder keeps its library and finds its parts, and where it listens (spec §6). */
export interface BinderOptions {
  /** The library folder: `binder.db`, with `backups/`, `bulk/`, and `scans/` beside it. */
  dataDir: string
  /** The file that keeps the Anthropic API key, which Settings writes. */
  envPath: string
  /** The built web app, served for every path outside /api. Without it (or when it isn't built), only the API. */
  webDistDir?: string
  /** The OCR helper for this computer (spec §5.1.4), which ocrHelper() picks. */
  ocr: OcrHelper
  /** 0 picks a free port. */
  port: number
  /** Default 127.0.0.1. */
  host?: string
  /** Progress, one line at a time ("[backup] Saved …"). Default console.log. */
  log?: (line: string) => void
  /** Called before a migration upgrades the library, while its backup is being saved. */
  onUpgradeBackup?: () => void
  /** Scryfall; the real one by default. */
  scryfall?: ScryfallClient
}

export interface RunningBinder {
  /** The web app's address: `http://localhost:<port>`. */
  url: string
  port: number
  /**
   * Stops listening, then closes the OCR helper and the library. It doesn't wait for a card-data refresh or a scan in
   * progress: it's meant to be followed by the process exiting, as the desktop app's server does. Calling it again
   * waits for the same stop.
   */
  stop(): Promise<void>
}

export type StartupErrorCode = 'port_in_use' | 'port_denied' | 'listen' | 'library'

/** Why Binder couldn't start, in one line to show as it is (spec §6 Startup). The library is left closed. */
export class StartupError extends Error {
  readonly code: StartupErrorCode
  constructor(code: StartupErrorCode, message: string) {
    super(message)
    this.name = 'StartupError'
    this.code = code
  }
}

/**
 * Starts Binder: opens the library (copying it to `backups/` first when a migration upgrades it), makes the daily
 * backup when one is due, and serves the app. Once it listens, it refreshes stale card data in the background and
 * picks up scans a restart interrupted. Rejects with a StartupError when the library can't be opened or the port
 * can't be listened on.
 */
export async function startBinder(options: BinderOptions): Promise<RunningBinder> {
  const log = options.log ?? ((line: string) => console.log(line))
  const paths = libraryPaths(options.dataDir)
  // On Windows: a library in OneDrive, on a network share, or in too deep a folder, said before it's opened.
  for (const warning of locationWarnings({ dataDir: options.dataDir, envPath: options.envPath })) log(warning)
  trustSystemCertificates()
  let db: DB
  try {
    db = openDb(paths.dbPath, {
      backupDir: paths.backupDir,
      onBackupStart: () => {
        log('[backup] Backing up the database before upgrading it…')
        options.onUpgradeBackup?.()
      },
      onBackup: (copy) => log(`[backup] Saved ${copy} before upgrading the database`),
    })
  } catch (err) {
    throw new StartupError('library', openFailureLine(err))
  }
  if (ensureCardNamesCurrent(db)) log('[card data] Rebuilt the card name index for this version')
  try {
    const backup = backupIfDue(db, paths.backupDir)
    if (backup?.status === 'saved') log(`[backup] Saved ${backup.file}`)
    if (backup?.status === 'exists') log(`[backup] Today's backup already exists: ${backup.file}`)
  } catch (err) {
    // A failed backup must not stop the app; it's retried at the next start.
    log(`[backup] Failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  const scryfall = options.scryfall ?? createScryfallClient()
  const bulk = createBulkImporter({ db, client: scryfall, dataDir: options.dataDir, log: (m) => log(`[card data] ${m}`) })
  const helper = options.ocr
  const ocr = createOcrClient({
    command: helper.command,
    // Before the first scan. On a Mac it builds bin/ocr when its source is newer: "[scan] Built the OCR helper".
    prepare: helper.prepare && (() => helper.prepare!((line) => log(`[scan] ${line}`))),
  })
  const worker = createScanWorker({ db, scansDir: paths.scansDir, ocr, lookups: createCardLookups(db) })
  const app = createApp({
    db,
    bulk,
    scryfall,
    ai: createAiClient(createKeyStore(options.envPath)),
    scanner: { scansDir: paths.scansDir, worker },
    backupDir: paths.backupDir,
    webDistDir: options.webDistDir && fs.existsSync(options.webDistDir) ? options.webDistDir : undefined,
  })
  let server: Server
  let port: number
  try {
    ;({ server, port } = await listen(app, options.port, options.host ?? '127.0.0.1'))
  } catch (err) {
    ocr.close()
    db.close()
    throw err
  }
  const url = `http://localhost:${port}`
  log(`Binder running at ${url}`)
  const stale = bulk.staleReason()
  if (stale) {
    log(`[card data] ${stale}; refreshing in the background`)
    // start() never rejects; the catch is a backstop so a bug there can't crash the server.
    bulk.start()?.catch((err: unknown) => log(`[card data] ${err instanceof Error ? err.message : String(err)}`))
  }
  // Only the Binder that owns the port picks up scans a restart interrupted: a second one, started while Binder runs,
  // would put the running one's scans back in the queue and then fail on the port.
  worker.recover()
  let stopping: Promise<void> | undefined
  return {
    url,
    port,
    stop() {
      stopping ??= (async () => {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()))
          // Connections a browser keeps open would hold close() back.
          server.closeAllConnections()
        })
        ocr.close()
        db.close()
      })()
      return stopping
    },
  }
}

/** Listens on the port, or rejects with the StartupError that says why it can't. */
function listen(app: Hono, port: number, hostname: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname }, (info) => resolve({ server, port: info.port })) as Server
    server.once('error', (err: NodeJS.ErrnoException) => {
      const code = err.code === 'EADDRINUSE' ? 'port_in_use' : err.code === 'EACCES' ? 'port_denied' : 'listen'
      reject(new StartupError(code, listenFailure(err, port)))
    })
  })
}
