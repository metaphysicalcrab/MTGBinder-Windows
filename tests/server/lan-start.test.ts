import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { describe, expect, it, onTestFinished } from 'vitest'
import { openDb } from '../../src/server/db/index.ts'
import { setMeta } from '../../src/server/db/meta.ts'
import { migrate } from '../../src/server/db/migrate.ts'
import type { LanSummary } from '../../src/server/lan/controller.ts'
import { type BinderOptions, type RunningBinder, startBinder } from '../../src/server/start.ts'
import type { LanStatus } from '../../src/shared/types.ts'
import { stubScryfall } from '../helpers/app.ts'
import { tempDir } from '../helpers/tmp.ts'

/** A throwaway library, with phone access listening on 127.0.0.1 (so no firewall asks) when it's turned on. */
function library(): BinderOptions & { lines: string[]; changes: LanSummary[] } {
  const dir = tempDir('binder-lan-start-')
  const lines: string[] = []
  const changes: LanSummary[] = []
  return {
    dataDir: path.join(dir, 'library'),
    envPath: path.join(dir, 'library', '.env'),
    ocr: { command: null, engine: 'none' },
    scryfall: stubScryfall(),
    port: 0,
    lanPort: 0,
    lanHost: '127.0.0.1',
    log: (line) => lines.push(line),
    onLanChange: (summary) => changes.push(summary),
    lines,
    changes,
  }
}

async function runBinder(options: BinderOptions): Promise<RunningBinder> {
  const binder = await startBinder(options)
  onTestFinished(() => binder.stop())
  return binder
}

/** Turns phone access on or off from Settings on the PC. */
async function phoneAccess(binder: RunningBinder, enabled: boolean): Promise<LanStatus> {
  const res = await fetch(`${binder.url}/api/lan`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as LanStatus
}

describe("the phones' listener (spec §5.10)", () => {
  it('starts and stops while Binder runs, serving the same app by the phones\' rules', async () => {
    const options = library()
    const binder = await runBinder(options)
    expect(binder.lan).toEqual({ enabled: false, listening: false, urls: [], error: null })
    const on = await phoneAccess(binder, true)
    expect(on).toMatchObject({ enabled: true, listening: true, error: null })
    expect(binder.lan).toMatchObject({ enabled: true, listening: true, error: null })
    expect(options.changes.at(-1)).toMatchObject({ listening: true })
    expect(options.lines.some((line) => line.startsWith('[phone] '))).toBe(true)

    const phones = `http://127.0.0.1:${on.port}`
    expect(await (await fetch(`${phones}/api/health`)).json()).toEqual({ ok: true })
    // The same app: what this computer may do, a request to the phones' port may not.
    const me = await fetch(`${phones}/api/lan/me`)
    expect(await me.json()).toEqual({ client: 'unpaired', https: false })
    expect((await fetch(`${phones}/api/collection/stats`)).status).toBe(401)
    expect((await fetch(`${binder.url}/api/collection/stats`)).status).toBe(200)

    const off = await phoneAccess(binder, false)
    expect(off).toMatchObject({ enabled: false, listening: false })
    await expect(fetch(`${phones}/api/health`)).rejects.toThrow()
    expect(options.lines).toContain('[phone] Phone access is off')
    // This computer's listener is untouched.
    expect((await fetch(`${binder.url}/api/health`)).status).toBe(200)
  })

  it('is back on after a restart when it was left on, and stop() closes both listeners', async () => {
    const options = library()
    const first = await runBinder(options)
    await phoneAccess(first, true)
    await first.stop()
    const binder = await runBinder(options)
    expect(binder.lan).toMatchObject({ enabled: true, listening: true })
    const { port } = (await (await fetch(`${binder.url}/api/lan`)).json()) as LanStatus
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200)
    await binder.stop()
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow()
    await expect(fetch(`${binder.url}/api/health`)).rejects.toThrow()
  })

  it("says in Settings and the log when it can't listen, and Binder runs on", async () => {
    const taken = net.createServer()
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve))
    onTestFinished(() => new Promise<void>((resolve) => taken.close(() => resolve())))
    const { port } = taken.address() as net.AddressInfo
    const options = { ...library(), lanPort: port }
    fs.mkdirSync(options.dataDir, { recursive: true })
    const db = openDb(path.join(options.dataDir, 'binder.db'))
    setMeta(db, 'lan_enabled', '1')
    db.close()
    const binder = await runBinder(options)
    const failure = `Couldn't listen on port ${port}: another program is using it. Set BINDER_LAN_PORT to use another port`
    expect(options.lines).toContain(`[phone] ${failure}`)
    expect(binder.lan).toEqual({ enabled: true, listening: false, urls: [], error: failure })
    expect(options.changes.at(-1)).toEqual(binder.lan)
    expect((await fetch(`${binder.url}/api/health`)).status).toBe(200)
    const status = (await (await fetch(`${binder.url}/api/lan`)).json()) as LanStatus
    expect([status.enabled, status.listening, status.error]).toEqual([true, false, failure])
  })

  it('stays off with BINDER_LAN=0 (lanPort null), whatever Settings says', async () => {
    const options = { ...library(), lanPort: null }
    fs.mkdirSync(options.dataDir, { recursive: true })
    const db = openDb(path.join(options.dataDir, 'binder.db'))
    setMeta(db, 'lan_enabled', '1')
    db.close()
    const binder = await runBinder(options)
    expect(binder.lan).toMatchObject({ enabled: false, listening: false })
    expect(options.lines.some((line) => line.startsWith('[phone]'))).toBe(false)
  })
})

describe('migration 009 (paired phones)', () => {
  it('upgrades a library from before phones, keeping what is in it', () => {
    const dir = tempDir('binder-009-')
    const migrations = fileURLToPath(new URL('../../src/server/db/migrations/', import.meta.url))
    const older = path.join(dir, 'older')
    fs.mkdirSync(older)
    for (const file of fs.readdirSync(migrations).filter((f) => /^00[1-8]_.+\.sql$/.test(f))) {
      fs.copyFileSync(path.join(migrations, file), path.join(older, file))
    }
    const file = path.join(dir, 'binder.db')
    const before = new Database(file)
    migrate(before, { migrationsDir: older })
    setMeta(before, 'buylist_ignore_basics', '0')
    before.close()
    const db = openDb(file, { backupDir: path.join(dir, 'backups') })
    onTestFinished(() => {
      if (db.open) db.close()
    })
    expect(db.prepare("SELECT value FROM meta WHERE key = 'buylist_ignore_basics'").pluck().get()).toBe('0')
    expect(db.prepare('SELECT max(version) FROM schema_migrations').pluck().get()).toBe(9)
    const columns = (db.prepare('PRAGMA table_info(lan_devices)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(columns).toEqual(['id', 'name', 'token_hash', 'created_at', 'last_seen_at', 'last_ip', 'origin', 'user_agent'])
    expect(fs.readdirSync(path.join(dir, 'backups')).some((f) => f.endsWith('-before-009.db'))).toBe(true)
  })
})
