import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createKeyStore } from '../../src/server/ai/key-store.ts'
import { canSymlink, expectOwnerOnly } from '../helpers/private.ts'
import { tempDir } from '../helpers/tmp.ts'

/** A `.env` holding `text`, in a temporary folder that's removed after the test. */
function envFile(text: string): string {
  const dir = tempDir('binder-env-')
  const envPath = path.join(dir, '.env')
  fs.writeFileSync(envPath, text)
  return envPath
}

describe('createKeyStore (spec §5.6)', () => {
  it('saves over a .env others can read, leaving it private, its other lines kept, and no temporary file', () => {
    const envPath = envFile('OTHER_SETTING=1\n# a comment\n')
    fs.chmodSync(envPath, 0o644)
    fs.writeFileSync(`${envPath}.${process.pid}.tmp`, 'left by a save that crashed')
    createKeyStore(envPath).write('sk-ant-api03-good-key-1234')
    expect(fs.readFileSync(envPath, 'utf8')).toBe('OTHER_SETTING=1\n# a comment\nANTHROPIC_API_KEY=sk-ant-api03-good-key-1234\n')
    expectOwnerOnly(envPath)
    expect(fs.readdirSync(path.dirname(envPath))).toEqual(['.env'])
  })

  it('reads a key on an `export` line, and replaces it where it was, keeping its `export`', () => {
    const envPath = envFile('OTHER_SETTING=1\nexport ANTHROPIC_API_KEY=sk-ant-api03-exported-1111\nLATER=2\nANTHROPIC_API_KEY=old\n')
    const store = createKeyStore(envPath)
    expect(store.read()).toBe('sk-ant-api03-exported-1111')
    store.write('sk-ant-api03-new-key-2222')
    expect(fs.readFileSync(envPath, 'utf8')).toBe('OTHER_SETTING=1\nexport ANTHROPIC_API_KEY=sk-ant-api03-new-key-2222\nLATER=2\n')
    expect(store.read()).toBe('sk-ant-api03-new-key-2222')
    store.write(null)
    expect(fs.readFileSync(envPath, 'utf8')).toBe('OTHER_SETTING=1\nLATER=2\n')
  })

  it('leaves no temporary file holding the key when the save fails, and still reports the failure', () => {
    const envPath = envFile('OTHER_SETTING=1\n')
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('EXDEV: cross-device link not permitted')
    })
    onTestFinished(() => rename.mockRestore())
    expect(() => createKeyStore(envPath).write('sk-ant-api03-good-key-1234')).toThrow('EXDEV')
    expect(rename).toHaveBeenCalledOnce()
    expect(fs.readdirSync(path.dirname(envPath))).toEqual(['.env'])
    expect(fs.readFileSync(envPath, 'utf8')).toBe('OTHER_SETTING=1\n')
  })

  it("drops an unquoted key's trailing comment, and a quoted key's quotes and what follows them", () => {
    expect(createKeyStore(envFile('ANTHROPIC_API_KEY=sk-ant-abc123 # my key\n')).read()).toBe('sk-ant-abc123')
    expect(createKeyStore(envFile('ANTHROPIC_API_KEY="sk-ant-abc123"\n')).read()).toBe('sk-ant-abc123')
    expect(createKeyStore(envFile(`ANTHROPIC_API_KEY='sk-ant-abc123' # my key\n`)).read()).toBe('sk-ant-abc123')
  })

  it('reads no key from a line that holds only a comment', () => {
    expect(createKeyStore(envFile('ANTHROPIC_API_KEY= # paste here\n')).read()).toBeNull()
    expect(createKeyStore(envFile('ANTHROPIC_API_KEY=#paste-here\n')).read()).toBeNull()
  })

  // Windows makes symbolic links only with Developer Mode on, or from an administrator's shell.
  it.runIf(canSymlink())('writes through a symlinked .env, keeping the link', () => {
    const real = envFile('OTHER_SETTING=1\n')
    const envPath = path.join(path.dirname(real), 'linked.env')
    fs.symlinkSync(real, envPath)
    createKeyStore(envPath).write('sk-ant-api03-good-key-1234')
    expect(fs.lstatSync(envPath).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(real, 'utf8')).toBe('OTHER_SETTING=1\nANTHROPIC_API_KEY=sk-ant-api03-good-key-1234\n')
    expectOwnerOnly(real)
  })

  it('writes a hard-linked .env others can read in place, so every name for it sees the key, leaving it private', () => {
    const envPath = envFile('OTHER_SETTING=1\n')
    fs.chmodSync(envPath, 0o644)
    const other = path.join(path.dirname(envPath), 'other-name.env')
    fs.linkSync(envPath, other)
    createKeyStore(envPath).write('sk-ant-api03-good-key-1234')
    expect(fs.readFileSync(other, 'utf8')).toBe('OTHER_SETTING=1\nANTHROPIC_API_KEY=sk-ant-api03-good-key-1234\n')
    expectOwnerOnly(other)
  })

  it("removes temporary copies a crashed save left, this process's or an ended one's, and nothing else", () => {
    const envPath = envFile('OTHER_SETTING=1\n')
    const dir = path.dirname(envPath)
    // This process's own leftover, and ones under ids no process can have (2147483646 and 2147483645 are above any
    // system's limit).
    for (const name of ['.env.2147483646.tmp', `.env.${process.pid}.tmp`, '.env.backup', 'notes.tmp']) {
      fs.writeFileSync(path.join(dir, name), 'x')
    }
    const store = createKeyStore(envPath)
    expect(fs.readdirSync(dir).sort()).toEqual(['.env', '.env.backup', 'notes.tmp'])
    fs.writeFileSync(path.join(dir, '.env.2147483645.tmp'), 'left by a save that was killed')
    store.write('sk-ant-api03-good-key-1234')
    expect(fs.readdirSync(dir).sort()).toEqual(['.env', '.env.backup', 'notes.tmp'])
  })

  it('keeps a temporary copy another running process is still saving', () => {
    const envPath = envFile('OTHER_SETTING=1\n')
    const dir = path.dirname(envPath)
    const saving = `.env.${process.ppid}.tmp` // the process that started this one is running
    fs.writeFileSync(path.join(dir, saving), 'another save, not yet renamed')
    createKeyStore(envPath).write('sk-ant-api03-good-key-1234')
    expect(fs.readdirSync(dir).sort()).toEqual(['.env', saving])
    expect(fs.readFileSync(path.join(dir, saving), 'utf8')).toBe('another save, not yet renamed')
  })
})

describe('a .env made on Windows', () => {
  it("keeps a CRLF file's line endings (Notepad's), reading its key and replacing it in place", () => {
    const envPath = envFile('OTHER_SETTING=1\r\nANTHROPIC_API_KEY=sk-ant-api03-old-key-0000\r\n\r\n')
    const store = createKeyStore(envPath)
    expect(store.read()).toBe('sk-ant-api03-old-key-0000')
    store.write('sk-ant-api03-new-key-2222')
    expect(fs.readFileSync(envPath, 'utf8')).toBe('OTHER_SETTING=1\r\nANTHROPIC_API_KEY=sk-ant-api03-new-key-2222\r\n')
    store.write(null)
    expect(fs.readFileSync(envPath, 'utf8')).toBe('OTHER_SETTING=1\r\n')
  })

  it("reads a UTF-16 file (Windows PowerShell's `echo … > .env`), and saves it as UTF-8", () => {
    const envPath = envFile('')
    const text = 'ANTHROPIC_API_KEY=sk-ant-api03-from-powershell\r\nOTHER_SETTING=1\r\n'
    fs.writeFileSync(envPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
    const store = createKeyStore(envPath)
    expect(store.read()).toBe('sk-ant-api03-from-powershell')
    store.write('sk-ant-api03-new-key-2222')
    expect(fs.readFileSync(envPath, 'utf8')).toBe('ANTHROPIC_API_KEY=sk-ant-api03-new-key-2222\r\nOTHER_SETTING=1\r\n')
    // Big-endian, with its own mark, reads the same.
    fs.writeFileSync(envPath, Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]))
    expect(createKeyStore(envPath).read()).toBe('sk-ant-api03-from-powershell')
  })

  it('makes the file private to the current user, by their SID, while it is still empty, then renames it over .env', () => {
    const envPath = envFile('OTHER_SETTING=1\n')
    const calls: Array<{ command: string; args: string[]; contents?: string }> = []
    const run = (command: string, args: string[]) => {
      if (command.endsWith('whoami.exe')) {
        calls.push({ command, args })
        return '"desktop-1\\josé","S-1-5-21-1004336348-1177238915-682003330-1001"\r\n'
      }
      calls.push({ command, args, contents: fs.readFileSync(args[0]!, 'utf8') })
      return 'processed file\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n'
    }
    const store = createKeyStore(envPath, { platform: 'win32', run })
    store.write('sk-ant-api03-good-key-1234')
    store.write('sk-ant-api03-new-key-2222')
    const temp = `${envPath}.${process.pid}.tmp`
    const system32 = path.win32.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32')
    const restrict = {
      command: path.win32.join(system32, 'icacls.exe'),
      args: [temp, '/inheritance:r', '/grant:r', '*S-1-5-21-1004336348-1177238915-682003330-1001:F'],
      contents: '',
    }
    // The user is asked for once; each save restricts its own temporary file before the key goes in.
    expect(calls).toEqual([
      { command: path.win32.join(system32, 'whoami.exe'), args: ['/user', '/fo', 'csv', '/nh'] },
      restrict,
      restrict,
    ])
    expect(fs.readFileSync(envPath, 'utf8')).toBe('OTHER_SETTING=1\nANTHROPIC_API_KEY=sk-ant-api03-new-key-2222\n')
    expect(fs.readdirSync(path.dirname(envPath))).toEqual(['.env'])
  })

  it("still saves the key when Windows' tools can't make the file private, saying so", () => {
    const envPath = envFile('OTHER_SETTING=1\n')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => logged.mockRestore())
    const run = () => {
      throw new Error('spawnSync whoami.exe ENOENT')
    }
    createKeyStore(envPath, { platform: 'win32', run }).write('sk-ant-api03-good-key-1234')
    expect(fs.readFileSync(envPath, 'utf8')).toBe('OTHER_SETTING=1\nANTHROPIC_API_KEY=sk-ant-api03-good-key-1234\n')
    expect(logged.mock.calls).toEqual([
      [`[api key] Couldn't make ${envPath}.${process.pid}.tmp private to this user: spawnSync whoami.exe ENOENT`],
    ])
  })

  it('saves over a read-only .env, which Windows refuses to rename over', () => {
    const envPath = envFile('OTHER_SETTING=1\n')
    fs.chmodSync(envPath, 0o444)
    const run = () => '"pc\\me","S-1-5-21-1-2-3-1001"'
    createKeyStore(envPath, { platform: 'win32', run }).write('sk-ant-api03-good-key-1234')
    expect(fs.readFileSync(envPath, 'utf8')).toBe('OTHER_SETTING=1\nANTHROPIC_API_KEY=sk-ant-api03-good-key-1234\n')
  })
})
