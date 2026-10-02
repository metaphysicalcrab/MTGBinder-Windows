import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { LanDevice } from '../../shared/types.ts'
import type { DB } from '../db/index.ts'
import { ownerOnlyOnWindows, removeOwnerOnlyLeftovers, runTool, writeOwnerOnly, type RunTool } from '../owner-only.ts'

/** How long a phone's cookie lasts: 400 days, the most Chrome keeps one. It's sent again as the phone is used. */
export const DEVICE_COOKIE_MAX_AGE = 34_560_000
/** A device's last seen time and address are written at most this often (the Scan page asks every second). */
const SEEN_EVERY_MS = 60_000

/** A device's cookie: `<id>.<its token, 32 bytes in base64url>`. */
const COOKIE = /^([1-9]\d{0,14})\.([A-Za-z0-9_-]{43})$/

/**
 * A phone that has just paired: its name, where it is, the address it paired at (`http://…`, or `https://…` when it
 * paired over HTTPS: its cookie works only that way), and its browser.
 */
export interface NewDevice {
  name: string
  ip: string | null
  origin: string
  userAgent: string | null
}

export interface DeviceStore {
  /** Pairs a phone: a new device and the cookie that names it from now on. */
  add(input: NewDevice): { device: LanDevice; cookie: string }
  /**
   * The device a cookie names, sent over HTTPS or not, or null: unknown, forgotten, from before every phone was
   * forgotten, or paired the other way. A cookie works only as it was paired: one that crossed the Wi-Fi in clear over
   * HTTP never works over HTTPS, and a phone paired over HTTPS pairs again to use HTTP.
   */
  verify(cookie: string | undefined, over: { https: boolean }): { id: number; name: string } | null
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

/** Whether a phone paired over HTTPS, by the page it paired from. */
const pairedOverHttps = (origin: string) => origin.startsWith('https:')

const toDevice = (row: DeviceRow): LanDevice => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  lastIp: row.last_ip,
  https: pairedOverHttps(row.origin),
})

/** The ids that can't let a phone in again: every one up to `upTo` (0: none), and `ids`. */
interface Forgotten {
  upTo: number
  ids: Set<number>
}

/**
 * Paired phones (spec §5.10), in `lan_devices`. A phone's token is never stored: only its HMAC-SHA256 under a secret
 * kept outside binder.db, in `<library>/lan/secret` (private to its owner). So a copy of the database (a backup, or
 * one moved with the library) can neither check nor make a token. Nor can an old backup brought back let in a phone
 * forgotten since, or list one: forgetting every phone changes the secret, and the ids that can't let a phone in again
 * are kept beside it, in `lan/forgotten`, one per line: those of phones forgotten one at a time, and `1-<id>`, every id
 * given out before every phone was last forgotten. No phone paired later gets one of those ids, though a backup brought
 * back winds binder.db's count of them back. Devices are kept in memory between changes, as every request a phone
 * makes checks its cookie.
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
  let forgottenIds: Forgotten | undefined
  let devices: Map<number, { hash: Buffer; name: string; https: boolean }> | null = null
  let pruned = false
  // What a crash or kill left between writing the secret or the forgotten ids and renaming them into place.
  removeOwnerOnlyLeftovers(options.dir, ['secret', 'forgotten'])

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

  /** The ids that can't let a phone in again (`lan/forgotten`). */
  function forgottenList(): Forgotten {
    if (!forgottenIds) {
      let text = ''
      try {
        text = fs.readFileSync(forgottenFile, 'utf8')
      } catch {
        // None forgotten yet.
      }
      const list: Forgotten = { upTo: 0, ids: new Set() }
      for (const line of text.split(/\s+/)) {
        const upTo = /^1-(\d+)$/.exec(line)?.[1]
        if (upTo !== undefined) list.upTo = Math.max(list.upTo, Number(upTo))
        else if (/^\d+$/.test(line)) list.ids.add(Number(line))
      }
      forgottenIds = list
    }
    return forgottenIds
  }

  function isForgotten(id: number): boolean {
    const { upTo, ids } = forgottenList()
    return id <= upTo || ids.has(id)
  }

  /** Writes the forgotten ids, then keeps them. Throws, keeping the ones before, when they can't be written. */
  function writeForgotten(list: Forgotten) {
    const lines = [...(list.upTo > 0 ? [`1-${list.upTo}`] : []), ...[...list.ids].filter((id) => id > list.upTo)]
    fs.mkdirSync(options.dir, { recursive: true, mode: 0o700 })
    writeOwnerOnly(forgottenFile, `${lines.join('\n')}\n`, { platform: options.platform, ownerOnly })
    forgottenIds = list
  }

  /** The last id given to a phone, as binder.db counts them (SQLite's AUTOINCREMENT, in sqlite_sequence). */
  const lastId = () =>
    (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'lan_devices'").pluck().get() as number | undefined) ?? 0

  /**
   * Once, before the devices are first read: drops the rows binder.db holds that can never let a phone in, so Settings
   * doesn't list them. Every row when there's no secret (binder.db moved, or brought back, without its lan/ folder),
   * and the forgotten ones a backup brought back: a phone forgotten on its own, and the phones paired before every
   * phone was forgotten, whose tokens were made with the secret before.
   */
  function prune() {
    if (pruned) return
    pruned = true
    if (readSecret() === null && noSecret) {
      db.prepare('DELETE FROM lan_devices').run()
      return
    }
    const { upTo, ids } = forgottenList()
    db.prepare('DELETE FROM lan_devices WHERE id <= ?').run(upTo)
    const remove = db.prepare('DELETE FROM lan_devices WHERE id = ?')
    for (const id of ids) remove.run(id)
  }

  const hmac = (key: Buffer, token: Buffer) => createHmac('sha256', key).update(token).digest()

  function known() {
    prune()
    if (!devices) {
      const rows = db.prepare('SELECT id, name, token_hash, origin FROM lan_devices').all() as Array<
        DeviceRow & { token_hash: Buffer }
      >
      devices = new Map(
        rows.map((row) => [row.id, { hash: row.token_hash, name: row.name, https: pairedOverHttps(row.origin) }]),
      )
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
      const hash = hmac(readSecret() ?? newSecret(), token)
      const id = db.transaction(() => {
        // Past every forgotten id: a backup brought back winds the count back, and a phone given one couldn't get in.
        const { upTo, ids } = forgottenList()
        const highest = Math.max(upTo, ...ids)
        if (highest > lastId()) {
          const moved = db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'lan_devices'").run(highest).changes
          if (moved === 0) db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('lan_devices', ?)").run(highest)
        }
        const insert = db.prepare(
          `INSERT INTO lan_devices (name, token_hash, created_at, last_seen_at, last_ip, origin, user_agent)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        return Number(insert.run(name, hash, at, at, ip, origin, userAgent).lastInsertRowid)
      })()
      devices = null
      lastWritten.set(id, now().getTime())
      return { device: toDevice(get(id)!), cookie: `${id}.${token.toString('base64url')}` }
    },
    verify(cookie, over) {
      const match = COOKIE.exec(cookie ?? '')
      const key = match && readSecret()
      if (!match || !key) return null
      const id = Number(match[1])
      const device = isForgotten(id) ? undefined : known().get(id)
      if (!device || device.https !== over.https) return null
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
      const { upTo, ids } = forgottenList()
      writeForgotten({ upTo, ids: new Set(ids).add(id) })
      db.prepare('DELETE FROM lan_devices WHERE id = ?').run(id)
      devices = null
      lastWritten.delete(id)
      forgotten(id)
      return true
    },
    forgetAll() {
      newSecret() // first: when it can't be written, every phone is still there, rather than forgotten in name only
      const { upTo, ids } = forgottenList()
      const last = Math.max(lastId(), upTo, ...ids)
      db.prepare('DELETE FROM lan_devices').run()
      devices = null
      lastWritten.clear()
      // No cookie from before the new secret works, but a backup brought back would list those phones: every id given
      // out so far is forgotten, in one line, rather than one at a time.
      try {
        if (last > 0) writeForgotten({ upTo: last, ids: new Set() })
      } catch {
        // Kept as they were: their phones can't get in, though a backup brought back lists them.
      }
      forgotten(null)
    },
    onForget(listener) {
      listeners.push(listener)
    },
  }
}
