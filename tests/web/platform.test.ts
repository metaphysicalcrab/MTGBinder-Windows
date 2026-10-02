import { describe, expect, it } from 'vitest'
import { detectPlatform, inBinderApp, isUndoKey, undoKeyLabelFor } from '../../src/web/lib/platform.ts'

// What browsers say about themselves: Chrome on each system (with Chromium's userAgentData), Safari, Binder's own app.
const MAC_CHROME = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  platform: 'MacIntel',
  userAgentData: { platform: 'macOS' },
}
const MAC_SAFARI = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  platform: 'MacIntel',
}
const WINDOWS_APP = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Binder/0.1.0 Chrome/152.0.7977.130 Electron/44.4.5 Safari/537.36',
  platform: 'Win32',
  userAgentData: { platform: 'Windows' },
}
const ANDROID_CHROME = {
  userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36',
  platform: 'Linux armv81',
  userAgentData: { platform: 'Android' },
}
const LINUX_FIREFOX = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', platform: 'Linux x86_64' }

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

describe('platform', () => {
  it('tells a Mac, Windows (the app too), and an Android phone, whose platform says Linux, apart', () => {
    expect([MAC_CHROME, MAC_SAFARI, WINDOWS_APP, ANDROID_CHROME, LINUX_FIREFOX].map(detectPlatform)).toEqual([
      'mac',
      'mac',
      'windows',
      'android',
      'other',
    ])
    // Without the platform, the user agent says.
    expect(detectPlatform({ userAgent: MAC_CHROME.userAgent })).toBe('mac')
    expect(detectPlatform({ userAgent: WINDOWS_APP.userAgent, platform: '' })).toBe('windows')
    expect(detectPlatform(undefined)).toBe('other')
  })

  it("tells Binder's desktop app, which names Electron, from a browser", () => {
    expect([MAC_CHROME, MAC_SAFARI, WINDOWS_APP, ANDROID_CHROME, LINUX_FIREFOX].map((nav) => inBinderApp(nav.userAgent))).toEqual([
      false,
      false,
      true,
      false,
      false,
    ])
  })

  it('reads undo as Cmd+Z on a Mac and Ctrl+Z elsewhere, never with Shift or Alt', () => {
    expect([isUndoKey(key('z', { metaKey: true }), true), isUndoKey(key('z', { ctrlKey: true }), true)]).toEqual([true, false])
    expect([isUndoKey(key('z', { ctrlKey: true }), false), isUndoKey(key('z', { metaKey: true }), false)]).toEqual([true, false])
    expect(isUndoKey(key('Z', { ctrlKey: true }), false)).toBe(true)
    for (const mods of [{ shiftKey: true }, { altKey: true }, { metaKey: true }]) {
      expect(isUndoKey(key('z', { ctrlKey: true, ...mods }), false)).toBe(false)
    }
    expect(isUndoKey(key('y', { ctrlKey: true }), false)).toBe(false)
    expect(isUndoKey(key('z'), false)).toBe(false)
    expect([undoKeyLabelFor(true), undoKeyLabelFor(false)]).toEqual(['⌘Z', 'Ctrl+Z'])
  })
})
