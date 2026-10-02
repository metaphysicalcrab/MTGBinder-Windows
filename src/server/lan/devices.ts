import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { LanDevice } from '../../shared/types.ts'
import type { DB } from '../db/index.ts'
import { ownerOnlyOnWindows, runTool, writeOwnerOnly, type RunTool } from '../owner-only.ts'

/** How long a phone's cookie lasts: 400 days, the most Chrome keeps one. It's sent again as the phone is used. */
export const DEVICE_COOKIE_MAX_AGE = 34_560_000
/** A device's last seen time and address are written at most this often (the Scan page asks every second). */
const SEEN_EVERY_MS = 60_000

/** A device's cookie: `<id>.<its token, 32 bytes in base64url>`. */
const COOKIE = /^([1-9]\d{0,14})\.([A-Za-z0-9_-]{43})$/

/** A phone that has just paired: its name, where it is, the address it paired at, and its browser. */
export interface NewDevice {
  name: string
  ip: string | null
  origin: string
  userAgent: string | null
}

export interface DeviceStore {
  /** Pairs a phone: a new device and the cookie that names it from now on. */
  add(input: NewDevice): { device: LanDevice; cookie: string }
  /** The device a cookie names, or null: unknown, forgotten, or from before every phone was forgotten. */
  verify(cookie: string | undefined): { id: number; name: string } | null
  /** Notes that a device was just used, and from where. */
  seen(id: number, ip: string | null): void
  list(): LanDevice[]
  rename(id: number, name: string): LanDevice | null
  /**
   * Forgets one phone: its cookie stops working at once, and for good (a backup brought back doesn't bring it back).
   * False when there's no such device.
   */
  forget(id: number): boolean
  /** Forgets every phone, and changes the secret, so no cookie from before works again (spec §5.10). */
  forgetAll(): void
  /** Called with the device's id when it's forgotten, or null when every phone is. */
  onForget(listener: (id: number | null) => void): void
}

export interface DeviceStoreOptions {
  db: DB
  /** The library's `lan/` folder, which keeps the secret. */
  dir: string
  now?: () => Date
  /** Whose rules make the secret private (Windows' access lists, or mode 600); tests pass their own. */
  platform?: NodeJS.Platform
  run?: RunTool
}

interface DeviceRow {
  id: number
  name: string
  created_at: string
  last_seen_at: string | null
  last_ip: string | null
  /** The page it paired from: `http://192.168.1.5:4322`, or `https://…:4323`. */
  origin: string
}

const toDevice = (row: DeviceRow): LanDevice => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  lastIp: row.last_ip,
  https: row.origin.startsWith('https:'),
})

/**
 * Paired phones (spec §5.10), in `lan_devices`. A phone's token is never stored: only its HMAC-SHA256 under a secret
 * kept outside binder.db, in `<library>/lan/secret` (private to its owner). So a copy of the database (a backup, or
 * one moved with the library) can neither check nor make a token. Nor can an old backup brought back let in a phone
 * forgotten since: forgetting every phone changes the secret, and the ids of phones forgotten one at a time are kept
 * beside it, in `lan/forgotten` (ids are never reused). Devices are kept in memory between changes, as every request a
 * phone makes checks its cookie.
 */
export function createDeviceStore(options: DeviceStoreOptions): DeviceStore {
  const { db } = options
  const now = options.now ?? (() => new Date())
  const secretFile = path.join(options.dir, 'secret')
  const forgottenFile = path.join(options.dir, 'forgotten')
  const ownerOnly = ownerOnlyOnWindows(options.run ?? runTool, '[phone]')
  const listeners: Array<(id: number | null) => void> = []
  const lastWritten = new Map<number, number>()
  let secret: Buffer | null | undefined
  /** Whether there's no secret at all (no file, or one that isn't a secret), rather than one that couldn't be read. */
  let noSecret = false
  let forgottenIds: Set<number> | undefined
  let devices: Map<number, { hash: Buffer; name: string }> | null = null
  let pruned = false

  /** The secret, or null before the first phone pairs (a file that isn't one counts as none). */
  function readSecret(): Buffer | null {
    if (secret !== undefined) return secret
    try {
      const text = fs.readFileSync(secretFile, 'utf8').trim()
      secret = /^[0-9a-f]{64}$/.test(text) ? Buffer.from(text, 'hex') : null
      noSecret = secret === null
    } catch (err) {
      secret = null
      noSecret = (err as NodeJS.ErrnoException).code === 'ENOENT'
    }
    return secret
  }

  function newSecret(): Buffer {
    const next = randomBytes(32)
    fs.mkdirSync(options.dir, { recursive: true, mode: 0o700 })
    writeOwnerOnly(secretFile, `${next.toString('hex')}\n`, { platform: options.platform, ownerOnly })
    secret = next
    noSecret = false
    return next
  }

  /** The ids of phones forgotten one at a time since every phone last was. */
  function forgottenSet(): Set<number> {
    if (!forgottenIds) {
      let text = ''
      try {
        text = fs.readFileSync(forgottenFile, 'utf8')
      } catch {
        // None forgotten yet.
      }
      forgottenIds = new Set(text.split(/\s+/).filter((id) => /^\d+$/.test(id)).map(Number))
    }
    return forgottenIds
  }

  /**
   * Once, before the devices are first read: drops the rows binder.db holds that can never let a phone in, so Settings
   * doesn't list them. Every row when there's no secret (binder.db moved, or brought back, without its lan/ folder),
   * and a phone forgotten on its own that a backup brought back.
   */
  function prune() {
    if (pruned) return
    pruned = true
    if (readSecret() === null && noSecret) {
      db.prepare('DELETE FROM lan_devices').run()
      return
    }
    const remove = db.prepare('DELETE FROM lan_devices WHERE id = ?')
    for (const id of forgottenSet()) remove.run(id)
  }

  const hmac = (key: Buffer, token: Buffer) => createHmac('sha256', key).update(token).digest()

  function known() {
    prune()
    if (!devices) {
      const rows = db.prepare('SELECT id, name, token_hash FROM lan_devices').all() as Array<DeviceRow & { token_hash: Buffer }>
      devices = new Map(rows.map((row) => [row.id, { hash: row.token_hash, name: row.name }]))
    }
    return devices
  }

  const get = (id: number) => db.prepare('SELECT * FROM lan_devices WHERE id = ?').get(id) as DeviceRow | undefined
  const forgotten = (id: number | null) => {
    for (const listener of listeners) listener(id)
  }

  return {
    add({ name, ip, origin, userAgent }) {
      prune()
      const token = randomBytes(32)
      const at = now().toISOString()
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO lan_devices (name, token_hash, created_at, last_seen_at, last_ip, origin, user_agent)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(name, hmac(readSecret() ?? newSecret(), token), at, at, ip, origin, userAgent)
      const id = Number(lastInsertRowid)
      devices = null
      lastWritten.set(id, now().getTime())
      return { device: toDevice(get(id)!), cookie: `${id}.${token.toString('base64url')}` }
    },
    verify(cookie) {
      const match = COOKIE.exec(cookie ?? '')
      const key = match && readSecret()
      if (!match || !key) return null
      const id = Number(match[1])
      const device = forgottenSet().has(id) ? undefined : known().get(id)
      if (!device) return null
      const token = Buffer.from(match[2]!, 'base64url')
      return token.length === 32 && timingSafeEqual(hmac(key, token), device.hash) ? { id, name: device.name } : null
    },
    seen(id, ip) {
      const at = now()
      if (at.getTime() - (lastWritten.get(id) ?? 0) < SEEN_EVERY_MS) return
      lastWritten.set(id, at.getTime())
      db.prepare('UPDATE lan_devices SET last_seen_at = ?, last_ip = ? WHERE id = ?').run(at.toISOString(), ip, id)
    },
    list() {
      prune()
      return (db.prepare('SELECT * FROM lan_devices ORDER BY id').all() as DeviceRow[]).map(toDevice)
    },
    rename(id, name) {
      if (db.prepare('UPDATE lan_devices SET name = ? WHERE id = ?').run(name, id).changes === 0) return null
      devices = null
      return toDevice(get(id)!)
    },
    forget(id) {
      if (!get(id)) return false
      // First: when it can't be written, the phone is still there, rather than forgotten until a backup comes back.
      const ids = new Set(forgottenSet()).add(id)
      fs.mkdirSync(options.dir, { recursive: true, mode: 0o700 })
      writeOwnerOnly(forgottenFile, `${[...ids].join('\n')}\n`, { platform: options.platform, ownerOnly })
      forgottenIds = ids
      db.prepare('DELETE FROM lan_devices WHERE id = ?').run(id)
      devices = null
      lastWritten.delete(id)
      forgotten(id)
      return true
    },
    forgetAll() {
      newSecret() // first: when it can't be written, every phone is still there, rather than forgotten in name only
      db.prepare('DELETE FROM lan_devices').run()
      devices = null
      lastWritten.clear()
      // No cookie from before the new secret works, so the ones forgotten before needn't be kept.
      try {
        fs.rmSync(forgottenFile, { force: true })
        forgottenIds = new Set()
      } catch {
        // Kept, which does no harm: ids are never reused.
      }
      forgotten(null)
    },
    onForget(listener) {
      listeners.push(listener)
    },
  }
}
