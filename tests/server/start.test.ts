import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { describe, expect, it, onTestFinished } from 'vitest'
import { migrate } from '../../src/server/db/migrate.ts'
import { type BinderOptions, type RunningBinder, startBinder, StartupError } from '../../src/server/start.ts'
import { stubScryfall } from '../helpers/app.ts'
import { tempDir } from '../helpers/tmp.ts'

/**
 * A throwaway library folder with a built web app in it; removed when the test ends, after every Binder started on it
 * (with runBinder) has stopped.
 */
function library(): Pick<BinderOptions, 'dataDir' | 'envPath' | 'webDistDir' | 'ocrBinary' | 'scryfall' | 'log'> & { lines: string[] } {
  const dir = tempDir('binder-start-')
  const web = path.join(dir, 'web')
  fs.mkdirSync(web)
  fs.writeFileSync(path.join(web, 'index.html'), '<title>Binder</title>')
  const lines: string[] = []
  return {
    dataDir: path.join(dir, 'library'),
    envPath: path.join(dir, 'library', '.env'),
    webDistDir: web,
    ocrBinary: path.join(dir, 'no-ocr-helper'),
    // Card data is never imported in these tests: the refresh a new library starts fails without reaching Scryfall.
    scryfall: stubScryfall(),
    log: (line) => lines.push(line),
    lines,
  }
}

/** Starts Binder, stopping it when the test ends even if the test fails first (stopping again is harmless). */
async function runBinder(options: BinderOptions): Promise<RunningBinder> {
  const binder = await startBinder(options)
  onTestFinished(() => binder.stop())
  return binder
}

/** A port nothing listens on, from the system. */
async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as net.AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

describe('startBinder (spec §6)', () => {
  it('opens the library, serves the API and the web app on the port it was given, and stops', async () => {
    const options = library()
    const port = await freePort()
    const binder = await runBinder({ ...options, port })
    expect(binder.url).toBe(`http://localhost:${port}`)
    const health = await fetch(`${binder.url}/api/health`)
    expect(await health.json()).toEqual({ ok: true })
    const page = await fetch(`${binder.url}/decks`)
    expect(await page.text()).toBe('<title>Binder</title>')
    // The headers every answer gets reach the browser, over a real connection too.
    expect([health.headers.get('cache-control'), health.headers.get('x-frame-options')]).toEqual(['no-store', 'DENY'])
    expect([page.headers.get('cache-control'), page.headers.get('x-content-type-options')]).toEqual(['no-cache', 'nosniff'])
    expect(fs.existsSync(path.join(options.dataDir, 'binder.db'))).toBe(true)
    // A new library gets its first daily backup, said in one line.
    expect(options.lines.some((l) => l.startsWith('[backup] Saved '))).toBe(true)
    await binder.stop()
    await expect(fetch(`${binder.url}/api/health`)).rejects.toThrow()
    // The library was closed: SQLite folds its write-ahead log back in and removes it only when the last handle closes.
    expect(fs.existsSync(path.join(options.dataDir, 'binder.db-wal'))).toBe(false)
    // Stopped for good: the library can be opened and started again.
    const again = await runBinder({ ...options, port })
    await again.stop()
  })

  it('says in one line when the port is taken, and leaves the library closed', async () => {
    const options = library()
    const taken = net.createServer()
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve))
    onTestFinished(() => new Promise<void>((resolve) => taken.close(() => resolve())))
    const { port } = taken.address() as net.AddressInfo
    const failure = await startBinder({ ...options, port }).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(StartupError)
    expect(failure).toMatchObject({
      code: 'port_in_use',
      message: `Port ${port} is already in use: Binder may already be running. Stop it, or start this one with PORT set to another port.`,
    })
    expect(fs.existsSync(path.join(options.dataDir, 'binder.db-wal'))).toBe(false)
    // Nothing kept the library open: another Binder starts on it.
    const binder = await runBinder({ ...options, port: await freePort() })
    await binder.stop()
  })

  it("says in one line when the library can't be opened", async () => {
    const options = library()
    fs.mkdirSync(options.dataDir, { recursive: true })
    fs.writeFileSync(path.join(options.dataDir, 'binder.db'), 'this is not a database')
    const failure = await startBinder({ ...options, port: await freePort() }).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(StartupError)
    expect(failure).toMatchObject({ code: 'library', message: '[database] file is not a database' })
  })

  it('stops at once while card data is still downloading, leaving the library to open again', async () => {
    const options = library()
    let downloading!: () => void
    const started = new Promise<void>((resolve) => (downloading = resolve))
    // Scryfall answers with its card data's address, then the download never finishes.
    const scryfall = stubScryfall({
      getJson: async () => ({ type: 'default_cards', updated_at: '2026-09-28T00:00:00.000Z', jsonl_download_uri: 'https://example.invalid/cards.jsonl' }),
      download: () => {
        downloading()
        return new Promise<Response>(() => {})
      },
    })
    const port = await freePort()
    const binder = await runBinder({ ...options, scryfall, port })
    await started
    const stopping = Date.now()
    await binder.stop()
    expect(Date.now() - stopping).toBeLessThan(2000)
    const again = await runBinder({ ...options, port })
    await again.stop()
  })

  it('says when it backs up the library before a migration upgrades it', async () => {
    const options = library()
    // A library from the version before this one: every migration but the newest.
    const migrations = fileURLToPath(new URL('../../src/server/db/migrations/', import.meta.url))
    const all = fs.readdirSync(migrations).filter((file) => /^\d{3}_.+\.sql$/.test(file)).sort()
    const older = path.join(path.dirname(options.dataDir), 'older-migrations')
    fs.mkdirSync(older)
    for (const file of all.slice(0, -1)) fs.copyFileSync(path.join(migrations, file), path.join(older, file))
    fs.mkdirSync(options.dataDir)
    const db = new Database(path.join(options.dataDir, 'binder.db'))
    migrate(db, { migrationsDir: older })
    db.close()
    let upgrading = 0
    const binder = await runBinder({ ...options, port: await freePort(), onUpgradeBackup: () => upgrading++ })
    await binder.stop()
    expect(upgrading).toBe(1)
    expect(options.lines).toContain('[backup] Backing up the database before upgrading it…')
    const newest = all.at(-1)!.slice(0, 3)
    expect(fs.readdirSync(path.join(options.dataDir, 'backups')).some((file) => file.endsWith(`-before-${newest}.db`))).toBe(true)
  })
})
