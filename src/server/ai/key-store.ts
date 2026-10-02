import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { removeWithRetry, renameWithRetry } from '../fs-retry.ts'

/** A key line: its prefix (leading space and any `export `), then the value. */
const KEY_LINE = /^(\s*(?:export\s+)?)ANTHROPIC_API_KEY\s*=\s*(.*?)\s*$/

/**
 * A key line's value: a quoted value without its quotes (and whatever follows them, such as a comment), an unquoted
 * one without a trailing ` # comment`. A value that is only a comment (`# paste here`) is no key.
 */
function keyValue(raw: string): string {
  const quoted = /^(['"])(.*?)\1/.exec(raw)
  if (quoted) return quoted[2]!
  return raw.startsWith('#') ? '' : raw.replace(/\s+#.*$/, '')
}

/**
 * The Anthropic API key, kept in a `.env` file: the project's for Binder run from the terminal, the library folder's
 * for the desktop app (spec §3.1, §3.4, §5.6). Other lines in the file are left as they are, with its line endings
 * (a `.env` made in Notepad has CRLF). The file is private to its owner: mode 600 on the Mac, and on Windows, where
 * mode bits don't exist, an access list with the current user alone on it.
 */
export interface KeyStore {
  /** The saved key, or null. */
  read(): string | null
  /** Saves a key, or removes it with null. */
  write(key: string | null): void
}

export interface KeyStoreOptions {
  /** Whose rules make the file private: Windows' access lists, or mode 600 everywhere else. Default: this platform. */
  platform?: NodeJS.Platform
  /** Runs a Windows tool (whoami, icacls) and returns what it printed. Tests pass a stand-in. */
  run?: (command: string, args: string[]) => string
}

/** The file a save writes: `.env` itself, or the file a symlinked `.env` points to. */
function realFile(envPath: string): string {
  try {
    return fs.realpathSync(envPath)
  } catch {
    return envPath // not there yet (or a link to nothing): write it where it's named
  }
}

/**
 * The text of a `.env`: UTF-8, or UTF-16 with its byte order mark, as Windows PowerShell 5.1's `echo … > .env` writes
 * it. A save writes it back as UTF-8.
 */
function readText(file: string): string {
  const bytes = fs.readFileSync(file)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return Buffer.from(bytes.subarray(2, bytes.length - (bytes.length % 2))).swap16().toString('utf16le')
  }
  return bytes.toString('utf8')
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
 * Removes the temporary copies saves leave when a crash or kill stops them between writing and renaming
 * (`<.env>.<pid>.tmp`): they hold the key. One whose process is still running is that process's save in progress,
 * and is left to it. Best effort.
 */
function removeLeftovers(file: string): void {
  const name = path.basename(file)
  try {
    for (const entry of fs.readdirSync(path.dirname(file))) {
      const pid = entry.startsWith(`${name}.`) ? /^\.(\d+)\.tmp$/.exec(entry.slice(name.length))?.[1] : undefined
      if (pid !== undefined && !otherProcessRunning(Number(pid))) {
        fs.rmSync(path.join(path.dirname(file), entry), { force: true })
      }
    }
  } catch {
    // The folder can't be read: nothing to clean.
  }
}

/** Windows' own tools, by full path, so a program of the same name elsewhere on the PATH is never run instead. */
const windowsTool = (name: string) =>
  path.win32.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', name)

const runTool = (command: string, args: string[]) =>
  execFileSync(command, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

/**
 * On Windows, makes `file` readable and writable by the current user alone: its inherited entries (which a folder
 * like C:\dev hands to every account on the PC) are removed, and the user, named by their security identifier
 * (S-1-5-21-…, the same in every language Windows speaks), is given full control. Best effort: when it can't, the
 * file keeps its folder's access list, and the reason is logged.
 */
function ownerOnlyOnWindows(run: NonNullable<KeyStoreOptions['run']>) {
  let sid: string | undefined
  return (file: string) => {
    try {
      // `whoami /user /fo csv /nh` prints `"pc\name","S-1-5-21-…"`.
      sid ??= /"(S-1-[\d-]+)"\s*$/.exec(run(windowsTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh']).trim())?.[1]
      if (!sid) throw new Error("whoami didn't say who the current user is")
      run(windowsTool('icacls.exe'), [file, '/inheritance:r', '/grant:r', `*${sid}:F`])
    } catch (err) {
      console.error(`[api key] Couldn't make ${file} private to this user: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export function createKeyStore(envPath: string, options: KeyStoreOptions = {}): KeyStore {
  const windows = (options.platform ?? process.platform) === 'win32'
  const ownerOnly = ownerOnlyOnWindows(options.run ?? runTool)
  removeLeftovers(realFile(envPath))
  const text = () => (fs.existsSync(envPath) ? readText(envPath) : '')
  const lines = () => text().split(/\r?\n/)
  return {
    read() {
      for (const line of lines()) {
        const raw = KEY_LINE.exec(line)?.[2]
        const value = raw && keyValue(raw)
        if (value) return value
      }
      return null
    },
    write(key) {
      // The key goes where the first key line was (keeping its `export `), and any other key lines go.
      const before = text()
      const current = before.split(/\r?\n/)
      const eol = /\r?\n/.exec(before)?.[0] ?? '\n'
      const at = current.findIndex((line) => KEY_LINE.test(line))
      const prefix = at >= 0 ? KEY_LINE.exec(current[at]!)![1]! : ''
      const kept = current.flatMap((line, i) =>
        i === at ? (key === null ? [] : [`${prefix}ANTHROPIC_API_KEY=${key}`]) : KEY_LINE.test(line) ? [] : [line],
      )
      while (kept.length > 0 && kept.at(-1) === '') kept.pop()
      if (key !== null && at < 0) kept.push(`ANTHROPIC_API_KEY=${key}`)
      const contents = kept.length > 0 ? `${kept.join(eol)}${eol}` : ''
      const file = realFile(envPath)
      removeLeftovers(file)
      if (fs.existsSync(file) && fs.statSync(file).nlink > 1) {
        // A hard-linked file is written in place, so every name for it sees the key; renaming over it would split it.
        // Writing in place isn't atomic (a crash part-way can cut the file short), but a hard link needs it. The file
        // is made private before the key goes in, so others can't read it even for a moment.
        if (windows) {
          ownerOnly(file)
          fs.chmodSync(file, 0o666) // clears the read-only attribute, which would refuse the write
        } else {
          fs.chmodSync(file, 0o600)
        }
        fs.writeFileSync(file, contents)
        return
      }
      // A private file renamed over .env (or the file a symlinked .env points to): the key is never in a file others
      // can read, and a crash can't cut off the owner's other lines.
      const temp = `${file}.${process.pid}.tmp`
      try {
        if (windows) {
          // Made private while it's still empty; the rename keeps its access list.
          fs.writeFileSync(temp, '', { flag: 'wx' })
          ownerOnly(temp)
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
          removeWithRetry(temp, { platform: options.platform }) // it holds the key
        } catch {
          // The next save or start removes it (removeLeftovers); the save's own failure is the one to report.
        }
        throw err
      }
    },
  }
}
