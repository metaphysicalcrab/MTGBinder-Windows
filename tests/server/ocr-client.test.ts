import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { asciiJson, buildOcrHelper, createOcrClient, type OcrClient } from '../../src/server/scanner/ocr-client.ts'

// A file path, not the URL's (which is `/C:/…` on Windows, with any space in it as %20).
const FAKE = [process.execPath, fileURLToPath(new URL('../helpers/fake-ocr.ts', import.meta.url))]
const text = async (client: OcrClient, request: string) => (await client.recognize(request)).lines[0]?.text ?? ''
const pid = (answer: string) => answer.split(':')[0]
const alive = (id: string | undefined) => {
  try {
    process.kill(Number(id), 0)
    return true
  } catch {
    return false
  }
}

let client: OcrClient | undefined
afterEach(() => client?.close())

describe('createOcrClient', () => {
  // The budgets leave room for a slow start: a new process on Windows, which antivirus checks first, can take half a
  // second before it reads its first request.
  it("sends one image at a time, so waiting doesn't count against an image's time", async () => {
    client = createOcrClient({ command: FAKE, timeoutMs: 1000 })
    // The helper starts first, so its starting up doesn't count against the first image's second. Three images of
    // 0.6 s each would pass it if their waiting counted.
    const warm = pid(await text(client, 'warm'))
    const order: string[] = []
    const read = (name: string) => client!.recognize(`delay:600:${name}`).then((r) => (order.push(name), r))
    const answers = await Promise.all([read('first'), read('second'), read('third')])
    expect(answers.map((a) => a.lines[0]?.text.split(':')[1])).toEqual(['first', 'second', 'third'])
    expect(order).toEqual(['first', 'second', 'third'])
    expect(answers.map((a) => pid(a.lines[0]!.text))).toEqual([warm, warm, warm])
    expect(answers[0]).toMatchObject({ width: 100, height: 140 })
  }, 10_000)

  it("fails a request with the helper's error", async () => {
    client = createOcrClient({ command: FAKE })
    await expect(client.recognize("error:Can't read an image at /x.jpg")).rejects.toThrow("Can't read an image at /x.jpg")
  })

  it('fails the image being read when the helper crashes, and sends the next one to a new helper', async () => {
    client = createOcrClient({ command: FAKE })
    const before = pid(await text(client, 'one'))
    const crashed = client.recognize('crash')
    const next = text(client, 'two')
    await expect(crashed).rejects.toThrow(/The OCR helper stopped \(exit code 3\): boom/)
    expect(pid(await next)).not.toBe(before)
  })

  it('gives up on an image after the timeout, kills the helper, and sends the next one to a new helper (spec §5.1.4)', async () => {
    client = createOcrClient({ command: FAKE, timeoutMs: 2000 })
    const before = pid(await text(client, 'one'))
    const hung = client.recognize('hang')
    const next = text(client, 'two')
    await expect(hung).rejects.toThrow('OCR took longer than 2 s')
    expect(pid(await next)).not.toBe(before)
    await expect.poll(() => alive(before)).toBe(false)
  }, 10_000)

  it("fails an image at once when the helper couldn't read the request", async () => {
    client = createOcrClient({ command: FAKE, timeoutMs: 2000 })
    await expect(client.recognize('unreadable')).rejects.toThrow('Not a request: unreadable')
    expect(await text(client, 'two')).toMatch(/:two$/)
  })

  it("ignores a line from the helper that is JSON but not an answer (null), and takes the answer after it", async () => {
    client = createOcrClient({ command: FAKE, timeoutMs: 2000 })
    expect(await text(client, 'null')).toMatch(/:null$/)
  })

  it('fails the image being read and those waiting when closed', async () => {
    client = createOcrClient({ command: FAKE })
    // Both expectations are in place before close() rejects the waiting image at once.
    const reading = expect(client.recognize('hang')).rejects.toThrow('The OCR helper stopped (SIGTERM)')
    const waiting = expect(client.recognize('two')).rejects.toThrow('The OCR helper was stopped')
    await new Promise((resolve) => setTimeout(resolve, 100))
    client.close()
    await Promise.all([reading, waiting])
  })

  it('prepares once before the first start, and again after a failed preparation', async () => {
    let calls = 0
    client = createOcrClient({
      command: FAKE,
      prepare: async () => {
        if (++calls === 1) throw new Error('no swiftc')
      },
    })
    await expect(client.recognize('one')).rejects.toThrow('no swiftc')
    await text(client, 'two')
    await text(client, 'three')
    expect(calls).toBe(2)
  })

  it("fails requests when the helper can't start", async () => {
    client = createOcrClient({ command: ['/nonexistent/binder-ocr'] })
    await expect(client.recognize('one')).rejects.toThrow(/The OCR helper stopped \(spawn .*ENOENT/)
  })

  it('fails every image with the reason when this computer has no helper, starting nothing', async () => {
    client = createOcrClient({ command: null, prepare: () => Promise.reject(new Error('No helper here')) })
    await expect(client.recognize('one')).rejects.toThrow('No helper here')
    await expect(client.recognize('two')).rejects.toThrow('No helper here')
    client = createOcrClient({ command: null })
    await expect(client.recognize('one')).rejects.toThrow('This computer has no OCR helper')
  })

  // Windows' tools can start a line with a byte order mark and end it with CRLF.
  it('reads an answer after a byte order mark or a blank line, or ending in CRLF', async () => {
    client = createOcrClient({ command: FAKE, timeoutMs: 2000 })
    expect(await text(client, 'bom')).toMatch(/:bom$/)
    expect(await text(client, 'crlf')).toMatch(/:crlf$/)
  })

  it("ignores a line with no id, as a helper saying it's ready would write", async () => {
    client = createOcrClient({ command: [...FAKE, '--ready'], timeoutMs: 2000 })
    expect(await text(client, 'one')).toMatch(/:one$/)
  })

  it('sends a path with letters outside ASCII as ASCII, which comes back whole', async () => {
    client = createOcrClient({ command: FAKE, timeoutMs: 2000 })
    const file = 'C:\\Users\\Zoë\\AppData\\Local\\Binder\\scans\\12 ★.jpg'
    expect((await text(client, file)).split(':').slice(1).join(':')).toBe(file)
  })

  it("fails an image whose answer isn't one the matcher can use, and keeps the helper", async () => {
    client = createOcrClient({ command: FAKE, timeoutMs: 2000 })
    const before = pid(await text(client, 'one'))
    await expect(client.recognize('malformed')).rejects.toThrow('The OCR helper answered something unexpected')
    await expect(client.recognize('infinite')).rejects.toThrow('The OCR helper answered something unexpected')
    expect(pid(await text(client, 'two'))).toBe(before)
  })

  it('says what the helper printed that was no answer when it gives up on an image', async () => {
    client = createOcrClient({ command: FAKE, timeoutMs: 2000, startupTimeoutMs: 2000 })
    await expect(client.recognize('noise')).rejects.toThrow('OCR took longer than 2 s: WARNING: this is not JSON')
  }, 10_000)

  // native/ocr.ps1 under device policy (Constrained Language mode) answers why with the id "", then exits.
  it('says why a helper that answers and exits stopped, to the image sent to it as it exits too', async () => {
    client = createOcrClient({ command: [...FAKE, '--blocked'], timeoutMs: 2000 })
    const why = "This PC's device policy keeps Binder from using Windows OCR"
    await Promise.all(['one', 'two', 'three'].map((name) => expect(client!.recognize(name)).rejects.toThrow(why)))
  }, 10_000)

  it("reads a helper's last line when its exit is reported first", async () => {
    client = createOcrClient({ command: [...FAKE, '--blocked=late'], timeoutMs: 2000 })
    await expect(client.recognize('one')).rejects.toThrow(/^This PC's device policy keeps Binder from using Windows OCR$/)
  }, 10_000)

  it("gives a helper's first image longer, for the helper's start, and the images after it the usual time", async () => {
    client = createOcrClient({ command: [...FAKE, '--start-delay=1500'], timeoutMs: 1000, startupTimeoutMs: 5000 })
    expect(await text(client, 'one')).toMatch(/:one$/)
    await expect(client.recognize('delay:1500:two')).rejects.toThrow('OCR took longer than 1 s')
  }, 15_000)
})

describe('asciiJson', () => {
  it('writes everything past 0x7E as \\u escapes, which JSON reads back', () => {
    const value = { id: '1', path: 'C:\\Users\\Zoë\\★ 😀\u007f.jpg' }
    const line = asciiJson(value)
    expect(line).toBe('{"id":"1","path":"C:\\\\Users\\\\Zo\\u00eb\\\\\\u2605 \\ud83d\\ude00\\u007f.jpg"}')
    expect(JSON.parse(line)).toEqual(value)
  })
})

describe('buildOcrHelper', () => {
  const dir = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-ocr-'))
    onTestFinished(() => fs.rmSync(d, { recursive: true, force: true }))
    return d
  }

  it('leaves a binary newer than its source alone', async () => {
    const d = dir()
    fs.writeFileSync(path.join(d, 'ocr.swift'), '// source')
    fs.writeFileSync(path.join(d, 'ocr'), 'binary')
    fs.utimesSync(path.join(d, 'ocr.swift'), new Date(2000, 0, 1), new Date(2000, 0, 1))
    expect(await buildOcrHelper(path.join(d, 'ocr.swift'), path.join(d, 'ocr'))).toBe(false)
  })

  it("explains when swiftc can't build it", async () => {
    const d = dir()
    fs.writeFileSync(path.join(d, 'ocr.swift'), 'this is not swift(')
    await expect(buildOcrHelper(path.join(d, 'ocr.swift'), path.join(d, 'bin', 'ocr'))).rejects.toThrow(
      "Couldn't build the OCR helper with swiftc",
    )
  }, 30_000)
})
