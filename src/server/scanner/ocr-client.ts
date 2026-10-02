import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { z } from 'zod'

/**
 * One line of text the OCR helper read, with its box normalized to the image (origin at the top left). `confidence` is
 * Apple Vision's, from 0 to 1; Windows OCR measures none and reports 1. The matcher doesn't read it: it's kept in the
 * scan's OCR record only.
 */
export interface OcrLine {
  text: string
  confidence?: number
  box: { x: number; y: number; w: number; h: number }
}

export interface OcrResult {
  width: number
  height: number
  lines: OcrLine[]
}

export interface OcrClient {
  /** Reads the text in an image file. Rejects if the helper fails, crashes, or takes longer than the timeout. */
  recognize(imagePath: string): Promise<OcrResult>
  /** Stops the helper. A later recognize() starts it again. */
  close(): void
}

export interface OcrClientOptions {
  /**
   * The helper's command and arguments, or null when this computer has none: every image then fails, with prepare's
   * message when it has one, and nothing is started.
   */
  command: readonly string[] | null
  /** How long one image may take (spec §5.1.4: 10 s). */
  timeoutMs?: number
  /**
   * How long the first image sent to a helper just started may take, its start included: Windows PowerShell takes
   * seconds to start and load Windows OCR, more the first time after a restart or while antivirus checks it.
   */
  startupTimeoutMs?: number
  /** Runs before the helper first starts, for example to build it; a rejection fails that request. */
  prepare?: () => Promise<void>
}

interface Job {
  imagePath: string
  resolve: (result: OcrResult) => void
  reject: (err: Error) => void
}

/** A helper process, and what it printed besides answers (its stderr, and stdout lines that aren't JSON). */
interface Helper {
  proc: ChildProcessWithoutNullStreams
  output: string
  /** Whether it has answered a request yet; until then it may still be starting. */
  answered: boolean
}

/** The image the helper is reading: its request id, its timer, and the helper process it went to. */
interface Reading extends Job {
  id: string
  timer: NodeJS.Timeout
  helper: Helper
}

const finite = z.number()
/** An answer the matcher can use: zod's numbers are finite, so a box can't hold NaN or Infinity (JSON's 1e999). */
const Answer = z.object({
  width: finite.optional(),
  height: finite.optional(),
  lines: z.array(
    z.object({
      text: z.string(),
      confidence: finite.optional(),
      box: z.object({ x: finite, y: finite, w: finite, h: finite }),
    }),
  ),
})

/**
 * A request line in pure ASCII: every character past 0x7E as a \uXXXX escape, which JSON readers decode. Windows
 * PowerShell reads what it's given in the console's code page unless told otherwise, so a library path with a letter
 * outside ASCII (C:\Users\Zoë\…) would otherwise arrive garbled.
 */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/**
 * Talks to the OCR helper (spec §5.1.4): one long-running process that reads one image at a time, answering one JSON
 * line per request. Images are sent to it one at a time, so each one's timeout counts from when the helper starts on
 * it, not while it waits behind another. A crash or a timeout fails the image being read and stops the process; the
 * images waiting behind it go to a new one.
 */
export function createOcrClient({
  command,
  timeoutMs = 10_000,
  startupTimeoutMs = 30_000,
  prepare,
}: OcrClientOptions): OcrClient {
  let child: Helper | null = null
  let prepared: Promise<void> | null = null
  let nextId = 1
  const waiting: Job[] = []
  let reading: Reading | null = null

  /** Ends the image being read (with its answer, or an error), then sends the next. */
  function finish(outcome: { result: OcrResult } | { error: Error }) {
    const job = reading
    if (!job) return
    clearTimeout(job.timer)
    reading = null
    if ('error' in outcome) job.reject(outcome.error)
    else job.resolve(outcome.result)
    sendNext()
  }

  function sendNext() {
    if (reading || waiting.length === 0) return
    const job = waiting.shift()!
    child ??= start(command!)
    const helper = child
    const id = String(nextId++)
    const budget = helper.answered ? timeoutMs : Math.max(timeoutMs, startupTimeoutMs)
    const timer = setTimeout(() => {
      if (reading?.id !== id) return
      if (child === helper) child = null // the images waiting go to a new helper
      finish({ error: new Error(`OCR took longer than ${budget / 1000} s${said(helper)}`) })
      helper.proc.kill('SIGKILL')
    }, budget)
    reading = { ...job, id, timer, helper }
    helper.proc.stdin.write(`${asciiJson({ id, path: job.imagePath })}\n`)
  }

  /** What a helper printed besides answers, for the error that ends its image: ": <output>", or nothing. */
  function said(helper: Helper): string {
    return helper.output.trim() ? `: ${helper.output.trim()}` : ''
  }

  function start([bin, ...args]: readonly string[]): Helper {
    // windowsHide: the desktop app has no console, so Windows would open a console window for the helper otherwise.
    const proc = spawn(bin!, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const helper: Helper = { proc, output: '', answered: false }
    const keep = (text: string) => {
      helper.output = (helper.output + text).slice(-2000) // its last words
    }
    proc.stderr.on('data', (chunk: Buffer) => keep(chunk.toString()))
    createInterface({ input: proc.stdout }).on('line', (raw) => {
      // A byte order mark and CRLF line ends, which Windows' tools can add, and blank lines are no part of an answer.
      const line = raw.replace(/^\uFEFF/, '').trim()
      if (line === '') return
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        keep(`${line}\n`) // something it printed (a warning, say), said if it then stops
        return
      }
      if (reading?.helper !== helper) return
      // JSON that isn't an object (null, a number) isn't an answer either.
      if (typeof parsed !== 'object' || parsed === null) return
      const message = parsed as { id?: unknown; error?: unknown }
      // An answer with the id "" is the helper saying it couldn't read the request, which is the one it's on. A line
      // with no id at all ({"ready": true}) is about no image.
      if (message.id !== reading.id && message.id !== '') return
      helper.answered = true
      if (typeof message.error === 'string') {
        // A helper that couldn't read a request may stop next (ocr.ps1 under device policy says why, then exits), so
        // what it said is kept for the image sent to it in the meantime.
        if (message.id === '') keep(`${message.error}\n`)
        finish({ error: new Error(message.error) })
        return
      }
      const answer = Answer.safeParse(parsed)
      if (!answer.success) {
        finish({ error: new Error('The OCR helper answered something unexpected') })
        return
      }
      const { width = 0, height = 0, lines } = answer.data
      finish({ result: { width, height, lines } })
    })
    const stopped = (reason: string) => {
      if (child === helper) child = null
      if (reading?.helper === helper) finish({ error: new Error(`The OCR helper stopped (${reason})${said(helper)}`) })
    }
    proc.on('error', (err) => stopped(err.message))
    // Images that come after its exit go to a new helper, but the one it was reading fails only once its output has
    // closed: Node can report the exit before the last lines it wrote are read, and one may be its answer, or why it
    // stopped.
    proc.on('exit', () => {
      if (child === helper) child = null
    })
    proc.on('close', (code, signal) => stopped(signal ?? `exit code ${code}`))
    proc.stdin.on('error', () => {}) // a write to a helper that just died; 'close' reports it
    return helper
  }

  return {
    async recognize(imagePath) {
      if (prepare) {
        prepared ??= prepare().catch((err: unknown) => {
          prepared = null
          throw err
        })
        await prepared
      }
      if (command === null) throw new Error('This computer has no OCR helper')
      return new Promise<OcrResult>((resolve, reject) => {
        waiting.push({ imagePath, resolve, reject })
        sendNext()
      })
    },
    close() {
      const stopped = new Error('The OCR helper was stopped')
      for (const job of waiting.splice(0)) job.reject(stopped)
      child?.proc.kill() // its end fails the image it was reading
      child = null
    },
  }
}

const execFileAsync = promisify(execFile)

/**
 * Compiles the Mac's Swift helper with `swiftc` when the binary is missing or older than its source. Returns true when
 * it compiled.
 */
export async function buildOcrHelper(source: string, binary: string): Promise<boolean> {
  const built = fs.statSync(binary, { throwIfNoEntry: false })
  if (built && built.mtimeMs >= fs.statSync(source).mtimeMs) return false
  fs.mkdirSync(path.dirname(binary), { recursive: true })
  try {
    await execFileAsync('swiftc', ['-O', source, '-o', binary])
  } catch (err) {
    const detail = (err as { stderr?: string }).stderr?.trim() || (err as Error).message
    throw new Error(
      `Couldn't build the OCR helper with swiftc (install Xcode's command line tools: xcode-select --install): ${detail}`,
    )
  }
  return true
}
