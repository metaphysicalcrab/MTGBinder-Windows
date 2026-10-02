import type { TLSSocket } from 'node:tls'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AppEnv } from '../http.ts'
import { DEVICE_COOKIE_MAX_AGE } from './devices.ts'

/**
 * Whether a request came over HTTPS (the phones' HTTPS listener): by its connection, not its URL, whose scheme a
 * request line naming a whole URL (`GET https://…/api/… HTTP/1.1`) sets even on the plain HTTP port.
 */
export function isHttps(c: Context<AppEnv>): boolean {
  return (c.env?.incoming?.socket as TLSSocket | undefined)?.encrypted === true
}

/**
 * The paired phone's cookie: `binder_device` over HTTP; over HTTPS `__Host-binder_device`, which a browser keeps only
 * when it's Secure, for the whole site and for this host alone, so no other page can set it.
 */
export function deviceCookieName(https: boolean): string {
  return https ? '__Host-binder_device' : 'binder_device'
}

export function readDeviceCookie(c: Context<AppEnv>): string | undefined {
  return getCookie(c, deviceCookieName(isHttps(c)))
}

/**
 * Gives the phone its cookie (spec §5.10): sent only by Binder's own pages (SameSite=Strict: a link or form from
 * another site carries none), never readable by scripts (HttpOnly), for this host alone (no Domain), and kept for 400
 * days.
 */
export function setDeviceCookie(c: Context<AppEnv>, value: string): void {
  const https = isHttps(c)
  setCookie(c, deviceCookieName(https), value, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: DEVICE_COOKIE_MAX_AGE,
    secure: https,
  })
}

export function clearDeviceCookie(c: Context<AppEnv>): void {
  const https = isHttps(c)
  deleteCookie(c, deviceCookieName(https), { httpOnly: true, sameSite: 'Strict', path: '/', secure: https })
}
