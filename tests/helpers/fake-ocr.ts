// A stand-in for the OCR helper in tests. Like bin/ocr, it reads one request at a time, in order, and answers each with
// one JSON line, with the behavior its "path" asks for: "crash" exits, "hang" never answers (so nothing after it is
// read), "error:<message>" fails, "delay:<ms>:<text>" answers late, "unreadable" answers the way bin/ocr answers a line
// that isn't a request (with no id), "null" writes a line of JSON that isn't an answer (null) before its answer, "bom"
// starts its answer with a byte order mark, "crlf" ends it (and a blank line before it) with CRLF, "malformed" answers
// with its lines as an object (as PowerShell's ConvertTo-Json can), "infinite" with a box at 1e999, "noise" prints a
// line that isn't JSON and never answers; anything else answers one line of text "<pid>:<path>". A request that isn't
// pure ASCII is refused, as Windows PowerShell would garble it.
//
// Arguments: --ready says {"ready":true} when it starts; --start-delay=<ms> reads nothing for that long, as Windows
// PowerShell takes seconds to start; -Check answers like native/ocr.ps1 -Check (after a BOM and a line that isn't
// JSON), with English unless --no-english; --blocked answers like native/ocr.ps1 under device policy, reading no
// request: why, with the id "", then exit code 1 a moment later. --blocked=late exits first and has a process it leaves
// behind write that line, as Node can report a helper's exit before the last lines it wrote are read.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const send = (message: object) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function handle(input: string): Promise<void> {
  const { id, path } = JSON.parse(input) as { id: string; path: string }
  const answer = (text: string, eol = '\n') => {
    const line = { text, confidence: 1, box: { x: 0, y: 0, w: 1, h: 0.1 } }
    process.stdout.write(`${JSON.stringify({ id, width: 100, height: 140, lines: [line] })}${eol}`)
  }
  if (/[^\x20-\x7e]/.test(input)) {
    send({ id, error: 'The request is not ASCII' })
  } else if (path === 'crash') {
    process.stderr.write('boom\n')
    process.exit(3)
  } else if (path === 'hang') {
    return new Promise(() => {})
  } else if (path === 'unreadable') {
    send({ id: '', error: 'Not a request: unreadable' })
  } else if (path === 'null') {
    process.stdout.write('null\n')
    answer(`${process.pid}:${path}`)
  } else if (path === 'bom') {
    process.stdout.write('\uFEFF')
    answer(`${process.pid}:${path}`)
  } else if (path === 'crlf') {
    process.stdout.write('\r\n')
    answer(`${process.pid}:${path}`, '\r\n')
  } else if (path === 'malformed') {
    send({ id, width: 100, height: 140, lines: { text: 'one line', confidence: 1, box: { x: 0, y: 0, w: 1, h: 0.1 } } })
  } else if (path === 'infinite') {
    process.stdout.write(`{"id":"${id}","width":100,"height":140,"lines":[{"text":"x","box":{"x":1e999,"y":0,"w":1,"h":0.1}}]}\n`)
  } else if (path === 'noise') {
    process.stdout.write('WARNING: this is not JSON\n')
    return new Promise(() => {})
  } else if (path.startsWith('error:')) {
    send({ id, error: path.slice('error:'.length) })
  } else if (path.startsWith('delay:')) {
    const [, ms, text] = path.split(':')
    return new Promise((resolve) => setTimeout(() => resolve(answer(`${process.pid}:${text}`)), Number(ms)))
  } else {
    answer(`${process.pid}:${path}`)
  }
  return Promise.resolve()
}

if (args.includes('-Check')) {
  process.stdout.write('\uFEFFWARNING: not part of the answer\n')
  send(
    args.includes('--no-english')
      ? { languages: ['de-DE'], english: null, error: "Windows OCR can't read English on this PC (it reads: de-DE)." }
      : { languages: ['en-US', 'de-DE'], english: 'en-US', error: null },
  )
  process.exit(0)
}
const blocked = args.find((a) => a.startsWith('--blocked'))
if (blocked) {
  const why = `${JSON.stringify({ id: '', error: "This PC's device policy keeps Binder from using Windows OCR" })}\n`
  if (blocked === '--blocked=late') {
    const write = `setTimeout(() => process.stdout.write(${JSON.stringify(why)}), 300)`
    // Detached, or Windows would end it with this process.
    spawn(process.execPath, ['-e', write], { stdio: ['ignore', 'inherit', 'inherit'], detached: true })
    process.exit(1)
  }
  process.stdout.write(why)
  setTimeout(() => process.exit(1), 200)
} else {
  if (args.includes('--ready')) send({ ready: true })
  const startDelay = Number(args.find((a) => a.startsWith('--start-delay='))?.split('=')[1] ?? 0)
  let reading = new Promise<void>((resolve) => setTimeout(resolve, startDelay))
  createInterface({ input: process.stdin }).on('line', (input) => {
    reading = reading.then(() => handle(input))
  })
}
