import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { removeWithRetry, renameWithRetry } from './fs-retry.ts'

/**
 * Files only their owner may read: the API key's `.env`, and phone access's secret. Mode 600 on the Mac (and Linux);
 * on Windows, where mode bits don't exist, an access list with the current user alone on it.
 */

/** Runs a Windows tool (whoami, icacls) and returns what it printed. Tests pass a stand-in. */
export type RunTool = (command: string, args: string[]) => string

/** Windows' own tools, by full path, so a program of the same name elsewhere on the PATH is never run instead. */
const windowsTool = (name: string) =>
  path.win32.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', name)

export const runTool: RunTool = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

/**
 * On Windows, makes `file` readable and writable by the current user alone: its inherited entries (which a folder
 * like C:\dev hands to every account on the PC) are removed, and the user, named by their security identifier
 * (S-1-5-21-…, the same in every language Windows speaks), is given full control. Best effort: when it can't, the
 * file keeps its folder's access list, and the reason is logged, after `label` ("[api key]").
 */
export function ownerOnlyOnWindows(run: RunTool, label: string): (file: string) => void {
  let sid: string | undefined
  return (file: string) => {
    try {
      // `whoami /user /fo csv /nh` prints `"pc\name","S-1-5-21-…"`.
      sid ??= /"(S-1-[\d-]+)"\s*$/.exec(run(windowsTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh']).trim())?.[1]
      if (!sid) throw new Error("whoami didn't say who the current user is")
      run(windowsTool('icacls.exe'), [file, '/inheritance:r', '/grant:r', `*${sid}:F`])
    } catch (err) {
      console.error(`${label} Couldn't make ${file} private to this user: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export interface OwnerOnlyWrite {
  /** Whose rules make the file private: Windows' access lists, or mode 600 everywhere else. Default: this platform. */
  platform?: NodeJS.Platform
  /** Restricts a file on Windows (ownerOnlyOnWindows). */
  ownerOnly: (file: string) => void
}

/**
 * Writes `contents` to `file` so that no one else can read it, even for a moment: into a private temporary file
 * (`<file>.<pid>.tmp`) that is then renamed over it, so a crash can't cut the file short either. On Windows the
 * temporary file is made private while it's still empty, and the rename keeps its access list. A failed write
 * removes the temporary file and throws.
 */
export function writeOwnerOnly(file: string, contents: string | Uint8Array, options: OwnerOnlyWrite): void {
  const temp = `${file}.${process.pid}.tmp`
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
