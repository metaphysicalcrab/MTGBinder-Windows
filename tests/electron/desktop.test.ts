import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { externalUrl, isAppUrl, permissionAllowed } from '../../electron/links.ts'
import { startingPage, startupFailure } from '../../electron/messages.ts'
import { appPaths } from '../../electron/paths.ts'
import { APP_LIBRARY_DIR } from '../../src/server/config.ts'

describe('appPaths (spec §3.4)', () => {
  const appData = '/Users/me/Library/Application Support'
  const base = { appData, appRoot: '/Applications/Binder.app/Contents/Resources/app', packaged: true, env: {} }

  it('keeps the library in Application Support, with the key file in it and the window\'s own files apart', () => {
    expect(appPaths(base)).toEqual({
      dataDir: `${appData}/Binder`,
      envPath: `${appData}/Binder/.env`,
      electronDir: `${appData}/Binder/Electron`,
      logDir: `${appData}/Binder/Logs`,
      webDistDir: '/Applications/Binder.app/Contents/Resources/app/dist/web',
      appRoot: '/Applications/Binder.app/Contents/Resources/app',
      packaged: true,
      port: 4321,
    })
  })

  it('uses the project\'s data/ when run from the project, where the server builds the OCR helper from its source', () => {
    const paths = appPaths({ ...base, appRoot: '/dev/binder', packaged: false })
    expect(paths).toMatchObject({ dataDir: '/dev/binder/data', envPath: '/dev/binder/data/.env', appRoot: '/dev/binder', packaged: false })
  })

  it('takes BINDER_DATA_DIR and PORT for checks, and says when PORT is not a port number', () => {
    expect(appPaths({ ...base, env: { BINDER_DATA_DIR: 'relative/lib', PORT: '4455' } })).toMatchObject({
      dataDir: path.resolve('relative/lib'),
      envPath: path.join(path.resolve('relative/lib'), '.env'),
      port: 4455,
    })
    expect(() => appPaths({ ...base, env: { PORT: 'abc' } })).toThrow('PORT must be a port number from 1 to 65535, not "abc".')
  })

  it('opens the library pnpm move-library copies to, and pnpm start names', () => {
    const appData = path.join(os.homedir(), 'Library', 'Application Support')
    expect(appPaths({ ...base, appData }).dataDir).toBe(APP_LIBRARY_DIR)
  })
})

describe('links', () => {
  it('keeps Binder\'s own pages in the window', () => {
    expect(isAppUrl('http://localhost:4321/decks/3', 'http://localhost:4321')).toBe(true)
    expect(isAppUrl('http://localhost:4455/', 'http://localhost:4321')).toBe(false)
    expect(isAppUrl('https://scryfall.com/card/m10/146', 'http://localhost:4321')).toBe(false)
    expect(isAppUrl('not a url', 'http://localhost:4321')).toBe(false)
  })

  it('opens web links in the browser, and nothing else', () => {
    expect(externalUrl('https://scryfall.com/card/m10/146')).toBe('https://scryfall.com/card/m10/146')
    expect(externalUrl('http://example.com/')).toBe('http://example.com/')
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:me@example.com', 'nonsense']) expect(externalUrl(url)).toBeNull()
  })

  it('lets Binder\'s own pages use the camera and copy to the clipboard, and nothing else', () => {
    const appUrl = 'http://localhost:4321'
    for (const permission of ['media', 'clipboard-sanitized-write']) {
      expect(permissionAllowed(permission, 'http://localhost:4321/scan', appUrl)).toBe(true)
      expect(permissionAllowed(permission, 'https://scryfall.com/card/m10/146', appUrl)).toBe(false)
      expect(permissionAllowed(permission, 'http://localhost:4321/scan', null)).toBe(false)
      expect(permissionAllowed(permission, undefined, appUrl)).toBe(false)
    }
    for (const permission of ['geolocation', 'notifications', 'clipboard-read']) {
      expect(permissionAllowed(permission, 'http://localhost:4321/decks/3', appUrl)).toBe(false)
    }
    // The camera, but never the microphone, even asked for with it.
    expect(permissionAllowed('media', 'http://localhost:4321/scan', appUrl, ['video'])).toBe(true)
    expect(permissionAllowed('media', 'http://localhost:4321/scan', appUrl, ['audio'])).toBe(false)
    expect(permissionAllowed('media', 'http://localhost:4321/scan', appUrl, ['video', 'audio'])).toBe(false)
  })
})

describe('messages', () => {
  it('says what to do when the port is taken, and anything else as the server said it', () => {
    expect(startupFailure({ code: 'port_in_use', message: 'Port 4321 is already in use: …' }, 4321)).toBe(
      'Port 4321 is already in use: Binder may already be running from the terminal (pnpm start). Quit that one, then open Binder again.',
    )
    expect(startupFailure({ code: 'library', message: '[database] file is not a database' }, 4321)).toBe(
      '[database] file is not a database',
    )
  })

  it('shows what Binder is doing while it starts, escaped', () => {
    const page = startingPage('Backing up your library <before> upgrading it…')
    expect(page.startsWith('data:text/html;charset=utf-8,')).toBe(true)
    expect(decodeURIComponent(page)).toContain('Backing up your library &lt;before&gt; upgrading it…')
  })
})
