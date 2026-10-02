import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where a library keeps its database and files: `binder.db`, with `backups/` and `scans/` beside it. */
export function libraryPaths(dataDir: string) {
  return {
    dbPath: path.join(dataDir, 'binder.db'),
    backupDir: path.join(dataDir, 'backups'),
    /** Captured card photos waiting in the scan queue (spec §5.1.2). */
    scansDir: path.join(dataDir, 'scans'),
  }
}

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const DATA_DIR = process.env.BINDER_DATA_DIR
  ? path.resolve(process.env.BINDER_DATA_DIR)
  : path.join(ROOT_DIR, 'data')
export const { dbPath: DB_PATH, backupDir: BACKUP_DIR } = libraryPaths(DATA_DIR)
export const WEB_DIST_DIR = path.join(ROOT_DIR, 'dist', 'web')
export const HOST = '127.0.0.1'
export const PORT = Number(process.env.PORT ?? 4321)
/** The Mac's OCR helper: its Swift source, and the binary built from it (spec §5.1.4). */
export const OCR_SOURCE = path.join(ROOT_DIR, 'native', 'ocr.swift')
export const OCR_BINARY = path.join(ROOT_DIR, 'bin', 'ocr')
/** Where `pnpm ocr:bench` keeps the card images it downloads (spec §5.1.6). */
export const BENCH_DIR = path.join(DATA_DIR, 'bench')
/** Holds ANTHROPIC_API_KEY, written by the Settings page (spec §3.1). */
export const ENV_PATH = path.join(ROOT_DIR, '.env')
/**
 * The desktop app's library (spec §3.4), named here for everything that needs it: the app, `pnpm move-library` (which
 * copies data/ there), `pnpm app`, and `pnpm start`'s note. On a Mac `~/Library/Application Support/Binder`; on
 * Windows `%LOCALAPPDATA%\Binder` (Local, not Roaming: the library is large and belongs to this PC; and not Documents,
 * which OneDrive syncs); elsewhere `$XDG_DATA_HOME/Binder` (`~/.local/share/Binder`).
 */
export function appLibraryDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string {
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'Binder')
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'Binder')
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share'), 'Binder')
}
export const APP_LIBRARY_DIR = appLibraryDir()
