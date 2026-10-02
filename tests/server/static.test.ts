import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isServablePath } from '../../src/server/app.ts'
import { makeApp } from '../helpers/app.ts'
import { tempDir } from '../helpers/tmp.ts'

/** The app serving a built web app: its page, a build file, an icon, and the manifest. */
function withWebApp() {
  const dir = tempDir('binder-web-')
  fs.writeFileSync(path.join(dir, 'index.html'), '<title>Binder</title>')
  fs.mkdirSync(path.join(dir, 'assets'))
  fs.writeFileSync(path.join(dir, 'assets', 'index-B1nd3r.js'), 'console.log("Binder")')
  fs.mkdirSync(path.join(dir, 'icons'))
  fs.writeFileSync(path.join(dir, 'icons', 'icon-192.png'), 'png')
  fs.writeFileSync(path.join(dir, 'manifest.webmanifest'), '{}')
  // A file named like a Windows device, which macOS and Linux allow: never served, on any platform.
  if (process.platform !== 'win32') fs.writeFileSync(path.join(dir, 'nul.txt'), 'not the page')
  return makeApp({ webDistDir: dir })
}

describe("the web app's files", () => {
  it("never looks up a Windows device name, or a path with a ':' in it", () => {
    for (const ok of ['/', '/index.html', '/assets/index-B1nd3r.js', '/sets/m10', '/decks/12', '/console', '/contact.html', '/com10', '/lpt', '/nullable', '/.con']) {
      expect([ok, isServablePath(ok)]).toEqual([ok, true])
    }
    for (const device of [
      '/CON', '/con', '/Nul', '/nul.txt', '/aux.tar.gz', '/PRN.', '/aux. ', '/Com1 .js', '/a/lpt9/b', '/COM0', '/LPT¹',
      '/CONIN$', '/conout$.txt', '/clock$', '/%43ON', '/assets/con.js', '/index.html::$DATA', '/C:/Windows/win.ini', '/a%3Ab',
    ]) {
      expect([device, isServablePath(device)]).toEqual([device, false])
    }
  })

  it("answers a device name with the app's page, as any path that names no file", async () => {
    const app = withWebApp()
    for (const url of ['/nul.txt', '/CON', '/sets/con']) {
      const res = await app.request(url)
      expect([url, res.status, await res.text()]).toEqual([url, 200, '<title>Binder</title>'])
    }
    expect(await (await app.request('/assets/index-B1nd3r.js')).text()).toBe('console.log("Binder")')
  })

  it("answers a missing build file with a 404, not the app's page", async () => {
    const res = await withWebApp().request('/assets/index-gone.js')
    expect(res.status).toBe(404)
  })

  it('says how long each answer may be kept: the API not at all, build files for good, the rest checked each time', async () => {
    const app = withWebApp()
    const cacheOf = async (url: string) => (await app.request(url)).headers.get('cache-control')
    expect(await cacheOf('/api/health')).toBe('no-store')
    expect(await cacheOf('/api/collection/export.csv')).toBe('no-store')
    expect(await cacheOf('/assets/index-B1nd3r.js')).toBe('public, max-age=31536000, immutable')
    for (const url of ['/', '/decks', '/icons/icon-192.png', '/manifest.webmanifest', '/assets/index-gone.js']) {
      expect([url, await cacheOf(url)]).toEqual([url, 'no-cache'])
    }
  })

  it('sends the security headers with every answer, a refused one too', async () => {
    const app = withWebApp()
    const refused = await app.request('/api/health', { headers: { Host: 'evil.example' } })
    expect(refused.status).toBe(403)
    for (const res of [refused, await app.request('/api/health'), await app.request('/'), await app.request('/api/nothing')]) {
      expect({
        nosniff: res.headers.get('x-content-type-options'),
        frame: res.headers.get('x-frame-options'),
        csp: res.headers.get('content-security-policy'),
        referrer: res.headers.get('referrer-policy'),
      }).toEqual({ nosniff: 'nosniff', frame: 'DENY', csp: "frame-ancestors 'none'", referrer: 'no-referrer' })
    }
  })
})
