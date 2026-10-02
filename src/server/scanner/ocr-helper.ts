import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { buildOcrHelper } from './ocr-client.ts'

/** Which OCR helper reads scans on this computer (spec §5.1.4), and how to get it ready. */
export interface OcrHelper {
  /** The helper's command and arguments, or null when this platform has no helper. */
  command: string[] | null
  /**
   * Builds or checks the helper before its first image; a rejection fails that image with its message. What it did,
   * if anything, it says through `log` ("Built the OCR helper").
   */
  prepare?: (log?: (line: string) => void) => Promise<void>
  /** What the helper is, for logs and the benchmark: 'Apple Vision' | 'Windows OCR' | 'none'. */
  engine: string
}

/** Why a computer that's neither a Mac nor a Windows PC can't scan. */
export const NO_OCR_HELPER =
  'Scanning reads cards with Apple Vision on a Mac or Windows OCR on a Windows PC; this computer has neither.'

/**
 * The OCR helper for a platform, with Binder's own files at `appRoot`:
 * - on a Mac, `bin/ocr` (Swift and Apple Vision), built from `native/ocr.swift` with swiftc when `buildFromSource`
 *   (run from the project) and it's missing or older than its source; Binder.app ships it built;
 * - on Windows, `native/ocr.ps1` in Windows PowerShell 5.1 (Windows OCR, through WinRT), which needs no building;
 * - anywhere else, none: every scan fails with NO_OCR_HELPER.
 */
export function ocrHelper(input: {
  platform: NodeJS.Platform
  appRoot: string
  buildFromSource: boolean
  env?: NodeJS.ProcessEnv
}): OcrHelper {
  const { platform, appRoot, buildFromSource, env = process.env } = input
  if (platform === 'darwin') {
    const binary = path.posix.join(appRoot, 'bin', 'ocr')
    const source = path.posix.join(appRoot, 'native', 'ocr.swift')
    return {
      command: [binary],
      ...(buildFromSource
        ? {
            prepare: async (log?: (line: string) => void) => {
              if (await buildOcrHelper(source, binary)) log?.('Built the OCR helper')
            },
          }
        : {}),
      engine: 'Apple Vision',
    }
  }
  if (platform === 'win32') {
    const script = path.win32.join(appRoot, 'native', 'ocr.ps1')
    const command = powershellCommand(script, env)
    return {
      command,
      prepare: async () => {
        if (!fs.existsSync(command[0]!)) {
          throw new Error(`Scanning needs Windows PowerShell, which isn't at ${command[0]}.`)
        }
        if (!fs.existsSync(script)) throw new Error(`Binder's OCR helper isn't at ${script}: reinstall Binder.`)
      },
      engine: 'Windows OCR',
    }
  }
  return {
    command: null,
    prepare: () => Promise.reject(new Error(NO_OCR_HELPER)),
    engine: 'none',
  }
}

/**
 * Runs a PowerShell script the way Binder runs its OCR helper on Windows: in Windows PowerShell 5.1 by its full path
 * (never `pwsh`, PowerShell 7, which can't reach WinRT, nor whatever is first on the PATH), without the user's profile,
 * and past the execution policy, whose default refuses every script (a policy set by Group Policy still wins).
 */
export function powershellCommand(script: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const windows = env.SystemRoot || 'C:\\Windows'
  const powershell = path.win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return [powershell, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]
}

/** What the Windows helper's -Check found: the languages Windows OCR reads on this PC, and the English one, if any. */
export interface WindowsOcrCheck {
  languages: string[]
  english: string | null
  /** Why it can't read English, with what to do about it; null when it can. */
  error: string | null
}

const CheckAnswer = z.object({
  languages: z.array(z.string()),
  english: z.string().nullable(),
  error: z.string().nullable(),
})

const execFileAsync = promisify(execFile)

/**
 * Has the Windows helper check that Windows OCR can read English here (`pnpm run setup`). Rejects when the helper
 * can't be run or doesn't say.
 */
export async function checkWindowsOcr(helper: OcrHelper): Promise<WindowsOcrCheck> {
  await helper.prepare?.()
  if (!helper.command) throw new Error(NO_OCR_HELPER)
  const [bin, ...args] = helper.command
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(bin!, [...args, '-Check'], { windowsHide: true, timeout: 60_000 }))
  } catch (err) {
    const detail = (err as { stderr?: string }).stderr?.trim() || (err as Error).message
    throw new Error(`The OCR helper's check failed: ${detail}`)
  }
  // Its answer is its last line of JSON; anything before it (a BOM, a warning) isn't.
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const text = line.replace(/^\uFEFF/, '').trim()
    if (!text.startsWith('{')) continue
    try {
      const answer = CheckAnswer.safeParse(JSON.parse(text))
      if (answer.success) return answer.data
    } catch {
      // not JSON after all
    }
  }
  throw new Error(`The OCR helper's check answered something unexpected: ${stdout.trim().slice(0, 500)}`)
}
