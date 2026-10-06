import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isLockedError,
  removeWithRetry,
  renameWithRetry,
  RETRY_BUDGET_MS,
  retryAsync,
  retryDelays,
  retrySync,
} from '../../src/server/fs-retry.ts'
import { tempDir } from '../helpers/tmp.ts'

const locked = (code = 'EBUSY') => Object.assign(new Error(`${code}: resource busy or locked, rename 'a' -> 'b'`), { code })

/** A rename that fails with `errors`, one per call, then works; it counts its calls. */
function flaky(...errors: Error[]) {
  const calls = { count: 0 }
  const attempt = () => {
    const error = errors[calls.count++]
    if (error) throw error
    return 'renamed'
  }
  return { attempt, calls }
}

describe('retrying a file operation another program holds up (fs-retry)', () => {
  it('waits 50 ms, then twice as long each time up to a second, for up to 10 s in all', () => {
    const delays = retryDelays(RETRY_BUDGET_MS)
    expect(delays.slice(0, 7)).toEqual([50, 100, 200, 400, 800, 1000, 1000])
    expect(delays.reduce((a, b) => a + b, 0)).toBe(10_000)
    expect(retryDelays(120)).toEqual([50, 70])
  })

  it('counts EPERM, EACCES and EBUSY as a file held open, and nothing else', () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) expect(isLockedError(locked(code))).toBe(true)
    for (const err of [locked('ENOENT'), locked('EXDEV'), new Error('EBUSY: no code'), null, 'EBUSY']) {
      expect(isLockedError(err)).toBe(false)
    }
  })

  it('on Windows, tries again while the file is held, waiting between attempts', () => {
    const { attempt, calls } = flaky(locked('EPERM'), locked('EBUSY'), locked('EACCES'))
    const waits: number[] = []
    expect(retrySync(attempt, { platform: 'win32', sleep: (ms) => void waits.push(ms) })).toBe('renamed')
    expect(calls.count).toBe(4)
    expect(waits).toEqual([50, 100, 200])
  })

  it('gives up with the last error once the time is spent', () => {
    const { attempt, calls } = flaky(...Array.from({ length: 100 }, () => locked()))
    const waits: number[] = []
    expect(() => retrySync(attempt, { platform: 'win32', budgetMs: 1000, sleep: (ms) => void waits.push(ms) })).toThrow('EBUSY')
    expect(waits).toEqual([50, 100, 200, 400, 250])
    expect(calls.count).toBe(waits.length + 1)
  })

  it('fails at once for any other error, and tries once on the Mac and Linux, as before', () => {
    const missing = flaky(locked('ENOENT'))
    expect(() => retrySync(missing.attempt, { platform: 'win32', sleep: () => {} })).toThrow('ENOENT')
    expect(missing.calls.count).toBe(1)
    for (const platform of ['darwin', 'linux'] as const) {
      const held = flaky(locked())
      expect(() => retrySync(held.attempt, { platform, sleep: () => {} })).toThrow('EBUSY')
      expect(held.calls.count).toBe(1)
    }
  })

  it('waits without blocking when the operation is asynchronous', async () => {
    const { attempt, calls } = flaky(locked(), locked('EPERM'))
    const waits: number[] = []
    const sleep = async (ms: number) => void waits.push(ms)
    await expect(retryAsync(async () => attempt(), { platform: 'win32', sleep })).resolves.toBe('renamed')
    expect([calls.count, waits]).toEqual([3, [50, 100]])
    await expect(retryAsync(async () => flaky(locked()).attempt(), { platform: 'darwin', sleep })).rejects.toThrow('EBUSY')
  })

  it('renames over a file, and removes one, if it is there', () => {
    const dir = tempDir('binder-retry-')
    const [from, to] = [path.join(dir, 'new.db.tmp'), path.join(dir, 'new.db')]
    fs.writeFileSync(from, 'new')
    fs.writeFileSync(to, 'old')
    renameWithRetry(from, to)
    expect(fs.readdirSync(dir)).toEqual(['new.db'])
    expect(fs.readFileSync(to, 'utf8')).toBe('new')
    removeWithRetry(to)
    removeWithRetry(to)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('leaves a folder where a file was expected, saying so', () => {
    const dir = tempDir('binder-retry-')
    fs.mkdirSync(path.join(dir, '1.jpg'))
    expect(() => removeWithRetry(path.join(dir, '1.jpg'), { platform: 'win32' })).toThrow()
    expect(fs.existsSync(path.join(dir, '1.jpg'))).toBe(true)
  })
})
