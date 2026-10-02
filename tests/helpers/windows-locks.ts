// Windows' file locking, on Linux: with VITEST_SIMULATE_WINDOWS_LOCKS=1, vitest.config.ts loads this before each test
// file. As on Windows, a database file SQLite has open (`.db`, its `-wal` and `-shm`, a backup's `.db.tmp`) can't be
// deleted or renamed, nor can a folder holding one: a test that removes its temporary folder before closing a
// database in it fails here as it would on a Windows PC, without one. It reads the process's open files from /proc,
// so it's for Linux only.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'

const DATABASE_FILE = /\.db(?:-wal|-shm|\.tmp)?$/

/** The database file this process has open at `target` or inside it, if any. */
function openDatabaseAt(target: fs.PathLike): string | undefined {
  const root = path.resolve(String(target))
  for (const fd of fs.readdirSync('/proc/self/fd')) {
    let file: string
    try {
      file = fs.readlinkSync(`/proc/self/fd/${fd}`)
    } catch {
      continue // closed meanwhile (the listing's own descriptor)
    }
    if (DATABASE_FILE.test(file) && (file === root || file.startsWith(`${root}${path.sep}`))) return file
  }
  return undefined
}

function refuseWhileOpen(operation: string, targets: fs.PathLike[]): void {
  for (const target of targets) {
    const open = openDatabaseAt(target)
    if (open) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, ${operation} '${String(target)}' (${open} is open)`), {
        code: 'EBUSY',
      })
    }
  }
}

if (process.platform === 'linux') {
  const { rmSync, unlinkSync, rmdirSync, renameSync } = fs
  fs.rmSync = (target, options) => {
    refuseWhileOpen('rm', [target])
    rmSync(target, options)
  }
  fs.unlinkSync = (target) => {
    refuseWhileOpen('unlink', [target])
    unlinkSync(target)
  }
  fs.rmdirSync = (target) => {
    refuseWhileOpen('rmdir', [target])
    rmdirSync(target)
  }
  fs.renameSync = (from, to) => {
    refuseWhileOpen('rename', [from, to])
    renameSync(from, to)
  }
  syncBuiltinESMExports()
}
