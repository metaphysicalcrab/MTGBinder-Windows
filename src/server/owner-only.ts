import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { removeWithRetry, renameWithRetry, renameWithRetryAsync, retryAsync } from './fs-retry.ts'
import { windowsSystemPath } from './platform.ts'

/**
 * Files only their owner may read: the API key's `.env`, phone access's secret and forgotten phones, and the
 * certificates for HTTPS with their keys. Mode 600 on the Mac (and Linux); on Windows, where mode bits don't exist, an
 * access list with the current user alone on it. Each is written through a private temporary copy,
 * `<file>.<pid>.tmp`, renamed over it.
 */

/** Runs a Windows tool (whoami, icacls) and returns what it printed. Tests pass a stand-in. */
export type RunTool = (command: string, args: string[]) => string

/**
 * Runs one of Windows' tools and returns what it printed, now or later: a RunTool, which tests pass, or (by default)
 * without blocking, for the certificates, made again while Binder serves (a new address, a renewal).
 */
export type RunToolAsync = (command: string, args: string[]) => string | Promise<string>

export const runTool: RunTool = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

const execFileAsync = promisify(execFile)

/** How long whoami or icacls may take without blocking: one that hangs leaves the file with its folder's access list. */
const TOOL_TIMEOUT_MS = 30_000

/** Windows' tools, run without blocking Binder while they do. */
export const runToolAsync: RunToolAsync = async (command, args) =>
  (await execFileAsync(command, args, { encoding: 'utf8', windowsHide: true, timeout: TOOL_TIMEOUT_MS })).stdout

/** whoami's question for the current user: it prints `"pc\name","S-1-5-21-…"`. */
const WHOAMI_ARGS = ['/user', '/fo', 'csv', '/nh']

/** The security identifier in whoami's answer. Throws when there's none. */
function userSid(printed: string): string {
  const sid = /"(S-1-[\d-]+)"\s*$/.exec(printed.trim())?.[1]
  if (!sid) throw new Error("whoami didn't say who the current user is")
  return sid
}

/** icacls's arguments that leave `file` to the user alone: no inherited entries, and full control for `sid`. */
const grantOnly = (file: string, sid: string) => [file, '/inheritance:r', '/grant:r', `*${sid}:F`]

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * On Windows, makes `file` readable and writable by the current user alone: its inherited entries (which a folder
 * like C:\dev hands to every account on the PC) are removed, and the user, named by their security identifier
 * (S-1-5-21-…, the same in every language Windows speaks, asked for once), is given full control. Best effort: when it
 * can't, the file keeps its folder's access list, and the reason is logged, after `label` ("[api key]").
 */
export function ownerOnlyOnWindows(run: RunTool, label: string): (file: string) => void {
  let sid: string | undefined
  return (file: string) => {
    try {
      sid ??= userSid(run(windowsSystemPath('whoami.exe'), WHOAMI_ARGS))
      run(windowsSystemPath('icacls.exe'), grantOnly(file, sid))
    } catch (err) {
      console.error(`${label} Couldn't make ${file} private to this user: ${reason(err)}`)
    }
  }
}

/** ownerOnlyOnWindows without blocking while Windows' tools run. */
export function ownerOnlyOnWindowsAsync(run: RunToolAsync, label: string): (file: string) => Promise<void> {
  let sid: string | undefined
  return async (file: string) => {
    try {
      sid ??= userSid(await run(windowsSystemPath('whoami.exe'), WHOAMI_ARGS))
      await run(windowsSystemPath('icacls.exe'), grantOnly(file, sid))
    } catch (err) {
      console.error(`${label} Couldn't make ${file} private to this user: ${reason(err)}`)
    }
  }
}

export interface OwnerOnlyWrite {
  /** Whose rules make the file private: Windows' access lists, or mode 600 everywhere else. Default: this platform. */
  platform?: NodeJS.Platform
  /** Restricts a file on Windows (ownerOnlyOnWindows). */
  ownerOnly: (file: string) => void
}

/** The temporary copy a write of `file` goes through, before it's renamed over it. */
const temporary = (file: string) => `${file}.${process.pid}.tmp`

/**
 * Writes `contents` to `file` so that no one else can read it, even for a moment: into a private temporary file
 * (`<file>.<pid>.tmp`) that is then renamed over it, so a crash can't cut the file short either. On Windows the
 * temporary file is made private while it's still empty, and the rename keeps its access list. A failed write
 * removes the temporary file and throws; one it can't remove is removed later (removeOwnerOnlyLeftovers).
 */
export function writeOwnerOnly(file: string, contents: string | Uint8Array, options: OwnerOnlyWrite): void {
  const temp = temporary(file)
  try {
    if ((options.platform ?? process.platform) === 'win32') {
      fs.writeFileSync(temp, '', { flag: 'wx' })
      options.ownerOnly(temp)
      fs.writeFileSync(temp, contents)
      // Windows won't rename over a read-only file. Binder's own saves leave none; one made so by hand is cleared.
      if (fs.existsSync(file)) fs.chmodSync(file, 0o666)
    } else {
      fs.writeFileSync(temp, contents, { flag: 'wx', mode: 0o600 })
      fs.chmodSync(temp, 0o600) // exactly 600, whatever the umask took away
    }
    renameWithRetry(temp, file, { platform: options.platform })
  } catch (err) {
    try {
      removeWithRetry(temp, { platform: options.platform }) // it holds what was being written
    } catch {
      // The write's own failure is the one to report.
    }
    throw err
  }
}

/** writeOwnerOnly's options without blocking: the file is restricted on Windows by ownerOnlyOnWindowsAsync. */
export interface OwnerOnlyWriteAsync {
  platform?: NodeJS.Platform
  ownerOnly: (file: string) => Promise<void>
}

/**
 * writeOwnerOnly without blocking, for files written while Binder serves (the certificates): Windows' tools, and a
 * file another program holds open (antivirus, the indexer), are waited for as Binder goes on.
 */
export async function writeOwnerOnlyAsync(file: string, contents: string, options: OwnerOnlyWriteAsync): Promise<void> {
  const platform = options.platform ?? process.platform
  const temp = temporary(file)
  try {
    if (platform === 'win32') {
      await fs.promises.writeFile(temp, '', { flag: 'wx' })
      await options.ownerOnly(temp)
      await fs.promises.writeFile(temp, contents)
      // Windows won't rename over a read-only file. Binder's own saves leave none; one made so by hand is cleared.
      if (fs.existsSync(file)) await fs.promises.chmod(file, 0o666)
    } else {
      await fs.promises.writeFile(temp, contents, { flag: 'wx', mode: 0o600 })
      await fs.promises.chmod(temp, 0o600) // exactly 600, whatever the umask took away
    }
    await renameWithRetryAsync(temp, file, { platform })
  } catch (err) {
    // It holds what was being written. The write's own failure is the one to report.
    await retryAsync(() => fs.promises.rm(temp, { force: true }), { platform }).catch(() => {})
    throw err
  }
}

/** Whether `pid` is another process that is still running: a signal 0 reaches it, or it exists but isn't ours. */
function otherProcessRunning(pid: number): boolean {
  if (pid <= 0 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Removes the temporary copies that writes of the files named `names` in `dir` left when a crash or kill stopped them
 * between writing and renaming (`<name>.<pid>.tmp`): they hold a key or a secret. One whose process is still running
 * is that process's write in progress, and is left to it; this process's own is a write that failed. Best effort.
 */
export function removeOwnerOnlyLeftovers(dir: string, names: readonly string[]): void {
  try {
    for (const entry of fs.readdirSync(dir)) {
      const [, name, pid] = /^(.+)\.(\d+)\.tmp$/.exec(entry) ?? []
      if (name !== undefined && names.includes(name) && !otherProcessRunning(Number(pid))) {
        fs.rmSync(path.join(dir, entry), { force: true })
      }
    }
  } catch {
    // The folder can't be read: nothing to clean.
  }
}
