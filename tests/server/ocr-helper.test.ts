import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createOcrClient, type OcrClient } from '../../src/server/scanner/ocr-client.ts'
import { checkWindowsOcr, NO_OCR_HELPER, ocrHelper, powershellCommand } from '../../src/server/scanner/ocr-helper.ts'
import { tempDir } from '../helpers/tmp.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = path.join(ROOT, 'native', 'ocr.ps1')
const FAKE = [process.execPath, fileURLToPath(new URL('../helpers/fake-ocr.ts', import.meta.url))]

/**
 * A PowerShell to run native/ocr.ps1 in: BINDER_TEST_POWERSHELL when it's set, else Windows PowerShell on Windows (the
 * one Binder runs it in), else PowerShell 7 (`pwsh`) when it's on the PATH; null when there's none.
 */
function findPowerShell(): string | null {
  if (process.env.BINDER_TEST_POWERSHELL) return process.env.BINDER_TEST_POWERSHELL
  if (process.platform === 'win32') return powershellCommand(SCRIPT)[0]!
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const pwsh = path.join(dir, 'pwsh')
    if (dir && fs.existsSync(pwsh)) return pwsh
  }
  return null
}
const POWERSHELL = findPowerShell()
/** Whether it's PowerShell 7, which can run everything but Windows OCR. */
const CORE = POWERSHELL !== null && /^pwsh/i.test(path.basename(POWERSHELL))
/** How Binder runs a script, but in this PowerShell. */
const run = (...args: string[]) => [
  POWERSHELL!,
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  ...(process.platform === 'win32' ? ['-ExecutionPolicy', 'Bypass'] : []),
  '-File',
  SCRIPT,
  ...args,
]

let client: OcrClient | undefined
afterEach(() => client?.close())

describe('ocrHelper (spec §5.1.4)', () => {
  it('runs bin/ocr on a Mac, as Binder.app ships it', () => {
    const appRoot = '/Applications/Binder.app/Contents/Resources/app'
    const helper = ocrHelper({ platform: 'darwin', appRoot, buildFromSource: false })
    expect(helper).toEqual({ command: [`${appRoot}/bin/ocr`], engine: 'Apple Vision' })
  })

  it('builds bin/ocr on a Mac from the project when its source is newer, and only then', async () => {
    const dir = tempDir('binder-ocr-helper-')
    fs.mkdirSync(path.join(dir, 'native'))
    fs.mkdirSync(path.join(dir, 'bin'))
    fs.writeFileSync(path.join(dir, 'native', 'ocr.swift'), 'this is not swift(')
    fs.writeFileSync(path.join(dir, 'bin', 'ocr'), 'binary')
    fs.utimesSync(path.join(dir, 'native', 'ocr.swift'), new Date(2000, 0, 1), new Date(2000, 0, 1))
    const helper = ocrHelper({ platform: 'darwin', appRoot: dir, buildFromSource: true })
    const lines: string[] = []
    await helper.prepare!((line) => lines.push(line))
    expect(lines).toEqual([])
    fs.utimesSync(path.join(dir, 'native', 'ocr.swift'), new Date(), new Date(Date.now() + 60_000))
    await expect(helper.prepare!((line) => lines.push(line))).rejects.toThrow("Couldn't build the OCR helper with swiftc")
    expect(lines).toEqual([])
  }, 30_000)

  it('runs native/ocr.ps1 in Windows PowerShell 5.1 on Windows, by its full path', () => {
    const appRoot = 'C:\\Users\\Zoë\\AppData\\Local\\Programs\\binder\\resources\\app'
    const helper = ocrHelper({ platform: 'win32', appRoot, buildFromSource: false, env: { SystemRoot: 'D:\\WINDOWS' } })
    expect(helper.command).toEqual([
      'D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      `${appRoot}\\native\\ocr.ps1`,
    ])
    expect(helper.engine).toBe('Windows OCR')
    const unset = ocrHelper({ platform: 'win32', appRoot, buildFromSource: true, env: {} })
    expect(unset.command![0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  it.skipIf(process.platform === 'win32')("says so when Windows PowerShell isn't there", async () => {
    const helper = ocrHelper({ platform: 'win32', appRoot: ROOT, buildFromSource: true, env: {} })
    await expect(helper.prepare!()).rejects.toThrow(
      "Scanning needs Windows PowerShell, which isn't at C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe.",
    )
  })

  it.runIf(process.platform === 'win32')('finds Windows PowerShell and the script on Windows, and says when the script is missing', async () => {
    await ocrHelper({ platform: 'win32', appRoot: ROOT, buildFromSource: true }).prepare!()
    const elsewhere = tempDir('binder-ocr-helper-')
    await expect(ocrHelper({ platform: 'win32', appRoot: elsewhere, buildFromSource: false }).prepare!()).rejects.toThrow(
      "Binder's OCR helper isn't at",
    )
  })

  it('has none anywhere else, and fails every image saying why, starting nothing', async () => {
    for (const platform of ['linux', 'freebsd'] as const) {
      const helper = ocrHelper({ platform, appRoot: ROOT, buildFromSource: true })
      expect(helper).toMatchObject({ command: null, engine: 'none' })
      await expect(helper.prepare!()).rejects.toThrow(NO_OCR_HELPER)
    }
    client = createOcrClient(ocrHelper({ platform: 'linux', appRoot: ROOT, buildFromSource: true }))
    await expect(client.recognize('one.jpg')).rejects.toThrow(NO_OCR_HELPER)
    await expect(client.recognize('two.jpg')).rejects.toThrow(NO_OCR_HELPER)
  })
})

describe('checkWindowsOcr', () => {
  it("reads the helper's -Check answer, past what isn't one", async () => {
    expect(await checkWindowsOcr({ command: FAKE, engine: 'fake' })).toEqual({
      languages: ['en-US', 'de-DE'],
      english: 'en-US',
      error: null,
    })
    expect(await checkWindowsOcr({ command: [...FAKE, '--no-english'], engine: 'fake' })).toMatchObject({
      english: null,
      error: "Windows OCR can't read English on this PC (it reads: de-DE).",
    })
  })

  it("rejects when the helper can't be run", async () => {
    await expect(checkWindowsOcr({ command: ['/nonexistent/powershell.exe'], engine: 'fake' })).rejects.toThrow(
      "The OCR helper's check failed",
    )
    await expect(checkWindowsOcr(ocrHelper({ platform: 'linux', appRoot: ROOT, buildFromSource: true }))).rejects.toThrow(
      NO_OCR_HELPER,
    )
  })
})

describe('native/ocr.ps1', () => {
  // Windows PowerShell 5.1 reads a script without a byte order mark in the ANSI code page, which ASCII is alike in.
  it('is ASCII', () => {
    const bytes = fs.readFileSync(SCRIPT)
    expect(bytes.findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d))).toBe(-1)
  })

  it.runIf(POWERSHELL)('uses no syntax Windows PowerShell 5.1 lacks', () => {
    // PowerShell 5.1 itself refuses to parse any; PowerShell 7 parses them, so they're looked for by name.
    const check = [
      '$tokens = $null; $errors = $null',
      '$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:OCR_PS1, [ref]$tokens, [ref]$errors)',
      '$bad = @($errors | ForEach-Object { "parse error: line $($_.Extent.StartLineNumber): $($_.Message)" })',
      "$newer = 'TernaryExpressionAst', 'PipelineChainAst'",
      '$bad += @($ast.FindAll({ param($n) $n.GetType().Name -in $newer -or "$($n.Operator)" -eq "QuestionQuestion" -or',
      '  ($n.PSObject.Properties["NullConditional"] -and $n.NullConditional) }, $true) |',
      '  ForEach-Object { "7-only: line $($_.Extent.StartLineNumber): $($_.Extent.Text)" })',
      "$kinds = 'AndAnd', 'OrOr', 'QuestionQuestion', 'QuestionQuestionEquals', 'QuestionDot', 'QuestionLBracket'",
      '$bad += @($tokens | Where-Object { "$($_.Kind)" -in $kinds } |',
      '  ForEach-Object { "7-only: line $($_.Extent.StartLineNumber): $($_.Text)" })',
      '$bad -join "`n"',
    ].join('\n')
    const found = execFileSync(POWERSHELL!, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', check], {
      env: { ...process.env, OCR_PS1: SCRIPT },
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(found.trim()).toBe('')
  }, 60_000)

  it.runIf(POWERSHELL)('passes its self-test: splitting lines, boxes, and ASCII JSON', () => {
    const [bin, ...args] = run('-SelfTest')
    const { stdout: out, stderr } = spawnSync(bin!, args, { encoding: 'utf8', windowsHide: true })
    expect(`${out}${stderr}`).toMatch(/^passed \d+ checks$/m)
    // Its sample answer, read as the server reads one.
    const answer = JSON.parse(out.split('\n').find((line) => line.startsWith('{'))!) as unknown
    expect(answer).toEqual({
      id: '7★',
      width: 1000,
      height: 1400,
      lines: [
        { text: 'Zoë', confidence: 1, box: { x: 0.04, y: 0.64286, w: 0.012, h: 0.01429 } },
        { text: 'Zoë', confidence: 1, box: { x: 0.04, y: 0.64286, w: 0.012, h: 0.01429 } },
      ],
    })
  }, 60_000)

  // PowerShell 7 can't reach WinRT, but runs the rest: reading requests as they come, and answering each in ASCII.
  it.runIf(CORE)('answers in PowerShell 7 that it needs Windows PowerShell, and a line that is no request with the id ""', async () => {
    const [bin, ...args] = run()
    const proc = spawn(bin!, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const answers: string[] = []
    let out = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('latin1')
      const lines = out.split('\n')
      out = lines.pop()!
      answers.push(...lines)
    })
    proc.stdin.write('{"id":"1","path":"C:\\\\Users\\\\Zo\\u00eb\\\\1.jpg"}\n')
    proc.stdin.write('this is no request\r\n')
    await expect.poll(() => answers.length, { timeout: 30_000 }).toBe(2)
    proc.stdin.end()
    await new Promise((resolve) => proc.on('exit', resolve))
    expect(answers.join('\n')).toMatch(/^[\x20-\x7e\n]*$/)
    const needs = /^Binder's OCR helper runs in Windows PowerShell 5\.1/
    expect(JSON.parse(answers[0]!)).toEqual({ id: '1', error: expect.stringMatching(needs) })
    expect(JSON.parse(answers[1]!)).toEqual({ id: '', error: 'Not a request: this is no request' })
    expect(proc.exitCode).toBe(0)
    expect(await checkWindowsOcr({ command: run(), engine: 'Windows OCR' })).toEqual({
      languages: [],
      english: null,
      error: expect.stringMatching(/Windows PowerShell 5\.1/),
    })
  }, 60_000)

  // The real thing, on a card drawn for the test (at a path outside ASCII, as a library under C:\Users\Zoë would be).
  it.runIf(process.platform === 'win32')('reads a card with Windows OCR, splitting its collector line', async (context) => {
    const helper = ocrHelper({ platform: 'win32', appRoot: ROOT, buildFromSource: false })
    const check = await checkWindowsOcr(helper)
    if (!check.english) context.skip(`Windows OCR can't read English on this PC: ${check.error}`)
    const image = path.join(tempDir('binder-ocr-ps-'), 'Zoë card.jpg')
    const draw = [
      'Add-Type -AssemblyName System.Drawing',
      '$bitmap = New-Object Drawing.Bitmap 700, 980',
      '$g = [Drawing.Graphics]::FromImage($bitmap)',
      '$g.Clear([Drawing.Color]::White)',
      "$title = New-Object Drawing.Font 'Arial', 30",
      "$small = New-Object Drawing.Font 'Arial', 13",
      '$ink = [Drawing.Brushes]::Black',
      "$g.DrawString('Lightning Bolt', $title, $ink, 40, 40)",
      "$g.DrawString('Lightning Bolt deals 3 damage to any target.', $small, $ink, 40, 620)",
      "$g.DrawString('U 0201', $small, $ink, 40, 920)",
      "$g.DrawString('2023 Wizards of the Coast', $small, $ink, 400, 920)",
      '$g.Dispose()',
      '$bitmap.Save($env:CARD_IMAGE, [Drawing.Imaging.ImageFormat]::Jpeg)',
      '$bitmap.Dispose()',
    ].join('\n')
    execFileSync(helper.command![0]!, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', draw], {
      env: { ...process.env, CARD_IMAGE: image },
      windowsHide: true,
    })
    client = createOcrClient(helper)
    const result = await client.recognize(image)
    expect(result).toMatchObject({ width: 700, height: 980 })
    const title = result.lines.find((line) => /Lightning Bolt$/.test(line.text))
    expect(title?.box.y).toBeLessThan(0.1)
    const texts = result.lines.map((line) => line.text)
    expect(texts).toContain('U 0201')
    expect(texts.some((t) => /^2023 Wizards of the Coast$/.test(t))).toBe(true)
    // The image can be deleted at once: the helper holds no handle on it.
    fs.rmSync(image)
  }, 60_000)
})
