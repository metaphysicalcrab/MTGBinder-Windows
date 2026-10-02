import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect } from 'vitest'

/**
 * Checks that only the file's owner can read it. On macOS and Linux that's mode 600. Windows has no mode bits (Node
 * reports 666 for any file that isn't read-only): there the file's access list must have no entries inherited from
 * its folder, and give full control (F) to one account, the key store's own user.
 */
export function expectOwnerOnly(file: string): void {
  if (process.platform !== 'win32') {
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    return
  }
  const icacls = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')
  // `<file> PC\me:(F)`, then a blank line and a summary; (I) marks an inherited entry. The marks aren't translated.
  const listing = execFileSync(icacls, [file], { encoding: 'utf8', windowsHide: true })
  const entries = listing.slice(file.length).split(/\r?\n/).map((line) => line.trim()).filter((line) => /:\(.*\)$/.test(line))
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatch(/:\(F\)$/)
  expect(listing).not.toContain('(I)')
}

/**
 * Whether this account can make symbolic links: always on macOS and Linux; on Windows only with Developer Mode on, or
 * from an administrator's shell.
 */
export function canSymlink(): boolean {
  if (process.platform !== 'win32') return true
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-symlink-'))
  try {
    fs.writeFileSync(path.join(dir, 'target'), '')
    fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'))
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
