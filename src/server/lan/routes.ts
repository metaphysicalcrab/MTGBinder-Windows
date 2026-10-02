import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { z } from 'zod'
import type { LanClient, LanDevice } from '../../shared/types.ts'
import { ApiError, parseWith, pathId, rateLimited, readJson, type AppEnv } from '../http.ts'
import { clearDeviceCookie, deviceCookieName, isHttps, setDeviceCookie } from './cookie.ts'
import type { LanController } from './controller.ts'
import { peerAddress } from './guard.ts'
import { PAIRING_TRIES } from './pairing.ts'

const Name = z.string().trim().min(1).max(60)
const UpdateBody = z
  .object({
    enabled: z.boolean().optional(),
    https: z.boolean().optional(),
    address: z.string().max(64).nullable().optional(),
  })
  .strict()
const PairBody = z
  .object({ code: z.string().max(32).optional(), key: z.string().max(64).optional(), name: Name })
  .strict()
  .refine((body) => body.code !== undefined || body.key !== undefined, 'Type the code the PC shows')
const RenameBody = z.object({ name: Name }).strict()

const deviceId = (param: string) => pathId(param, 'Phone not found')

/** A route this computer doesn't have, answered as the API answers any other. */
const noRoute = (method: string, path: string) => new ApiError(404, 'not_found', `No API route for ${method} ${path}`)

/** /api/lan (spec §5.10): phone access on the PC, pairing from the phone, and the paired devices. */
export function lanRoutes(lan: LanController): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.get('/me', (c) => {
    const client = c.get('client')
    const answer: LanClient =
      client.kind === 'device'
        ? { client: 'device', id: client.id, name: client.name }
        : client.kind === 'pc'
          ? { client: 'pc' }
          : { client: 'unpaired', https: lan.https() }
    return c.json(answer)
  })

  routes.get('/', (c) => c.json(lan.status()))
  routes.put('/', async (c) => c.json(await lan.update(parseWith(UpdateBody, await readJson(c.req)))))
  // A new certificate authority for HTTPS (phones install it again), when the old one may have been copied.
  routes.post('/https/rotate', async (c) => c.json(await lan.rotate()))

  routes.post('/pairing', (c) => c.json(lan.openPairing()))
  routes.delete('/pairing', (c) => {
    lan.pairing.cancel()
    return c.body(null, 204)
  })

  // A phone pairs with the code (or the QR code's key) on the phones' listener only: this computer needs no pairing.
  routes.post('/pair', async (c) => {
    const client = c.get('client')
    if (client.kind === 'pc') throw noRoute(c.req.method, c.req.path)
    const peer = peerAddress(c) ?? null
    const wait = lan.limits.pair.take(peer ?? 'unknown')
    if (wait) throw rateLimited(wait, 'Too many tries at pairing from this phone')
    const { code, key, name } = parseWith(PairBody, await readJson(c.req))
    const from = peer ?? 'an unknown address'
    const attempt = lan.pairing.attempt({ code, key }, peer ?? 'unknown')
    if (attempt.outcome === 'closed') {
      const message =
        attempt.reason === 'too_many_tries'
          ? 'Too many wrong codes, so pairing stopped: on the PC, start pairing again'
          : attempt.reason === 'expired'
            ? 'That code has expired: on the PC, start pairing again'
            : "Binder isn't pairing right now: on the PC, open Settings → Phone access → Pair a phone"
      throw new ApiError(409, 'not_pairing', message)
    }
    if (attempt.outcome === 'wrong') {
      lan.log(`[phone] Wrong pairing code from ${from} (${attempt.failures} of ${PAIRING_TRIES})`)
      if (attempt.closed) {
        lan.log('[phone] Too many wrong codes; pairing stopped')
      } else if (attempt.failures >= PAIRING_TRIES) {
        lan.log(`[phone] Too many wrong codes from ${from}: it can't pair until pairing starts again`)
      }
      if (attempt.closed || attempt.failures >= PAIRING_TRIES) {
        throw new ApiError(400, 'wrong_code', 'Too many wrong codes, so pairing stopped: on the PC, start pairing again')
      }
      throw new ApiError(400, 'wrong_code', "That code isn't right: check the code on the PC and type it again")
    }
    const https = isHttps(c)
    const origin = c.req.header('origin') ?? `${https ? 'https' : 'http'}://${c.req.header('host') ?? ''}`
    const userAgent = c.req.header('user-agent')?.slice(0, 300) ?? null
    const { device, cookie } = lan.devices.add({ name, ip: peer, origin, userAgent })
    // A phone pairing again replaces itself: its old cookie is gone with this answer. Over HTTPS, the device it paired
    // as over HTTP, before HTTPS was on, goes too, when the browser sends that cookie as well (it isn't HTTPS's alone).
    const overHttp = https ? lan.devices.verify(getCookie(c, deviceCookieName(false))) : null
    const before = client.kind === 'device' ? client : overHttp
    if (before) lan.devices.forget(before.id)
    lan.pairing.paired(device.name)
    setDeviceCookie(c, cookie)
    lan.log(`[phone] Paired ${JSON.stringify(device.name)} from ${from}`)
    return c.json({ id: device.id, name: device.name } satisfies Pick<LanDevice, 'id' | 'name'>, 201)
  })

  routes.patch('/devices/:id', async (c) => {
    const { name } = parseWith(RenameBody, await readJson(c.req))
    const device = lan.devices.rename(deviceId(c.req.param('id')), name)
    if (!device) throw new ApiError(404, 'not_found', 'Phone not found')
    return c.json(device)
  })
  routes.delete('/devices/:id', (c) => {
    const id = deviceId(c.req.param('id'))
    const device = lan.devices.list().find((d) => d.id === id)
    if (!device || !lan.devices.forget(id)) throw new ApiError(404, 'not_found', 'Phone not found')
    lan.log(`[phone] Forgot ${JSON.stringify(device.name)}`)
    return c.body(null, 204)
  })
  routes.post('/forget-all', (c) => {
    lan.devices.forgetAll()
    lan.log('[phone] Forgot every phone: each must pair again')
    return c.body(null, 204)
  })

  // A phone forgetting itself (Settings on the phone).
  routes.post('/forget', (c) => {
    const client = c.get('client')
    if (client.kind !== 'device') throw noRoute(c.req.method, c.req.path)
    lan.devices.forget(client.id)
    clearDeviceCookie(c)
    lan.log(`[phone] ${JSON.stringify(client.name)} forgot itself`)
    return c.body(null, 204)
  })

  return routes
}
