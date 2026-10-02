import { describe, expect, it } from 'vitest'
import { cameraHelp, captureHint, describeCameraError } from '../../src/web/components/scan/CameraPanel.tsx'
import { liveCameraNote, photoTip } from '../../src/web/components/scan/PhotoCapture.tsx'

// Binder.app's window (Electron names itself in its user agent, after Binder) and two browsers.
const BINDER_APP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Binder/0.1.0 Chrome/152.0.7977.130 Electron/44.4.5 Safari/537.36'
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
// Binder's window on Windows, Chrome and Edge on Windows, and Chrome on an Android phone.
const WINDOWS_APP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Binder/0.1.0 Chrome/152.0.7977.130 Electron/44.4.5 Safari/537.36'
const WINDOWS_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0'
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36'

const refused = new DOMException('Permission denied', 'NotAllowedError')

describe('describeCameraError', () => {
  it('sends a refused camera to System Settings in Binder.app, which has no address bar', () => {
    expect(describeCameraError(refused, BINDER_APP)).toBe(
      "Binder isn't allowed to use the camera. Turn Binder on in System Settings → Privacy & Security → Camera, then quit and reopen Binder.",
    )
  })

  it('sends a refused camera to the address bar in a browser', () => {
    for (const userAgent of [CHROME, SAFARI]) {
      expect(describeCameraError(refused, userAgent)).toBe(
        "Binder isn't allowed to use the camera. Allow it from the camera icon in the address bar, then press Start it again.",
      )
    }
  })

  it('says the same about a missing or busy camera in both', () => {
    for (const userAgent of [BINDER_APP, SAFARI]) {
      expect(describeCameraError(new DOMException('', 'NotFoundError'), userAgent)).toBe('No camera found.')
      expect(describeCameraError(new DOMException('', 'NotReadableError'), userAgent)).toBe('The camera is in use by another app.')
    }
  })

  it("sends a refused camera to Windows' camera privacy settings in Binder's Windows app", () => {
    expect(describeCameraError(refused, WINDOWS_APP)).toBe(
      "Binder isn't allowed to use the camera. Turn on Camera access and Let desktop apps access your camera in Settings → Privacy & security → Camera, then press Start it again.",
    )
  })

  it("sends a refused camera to the address bar in a Windows browser, then to Windows' settings", () => {
    for (const userAgent of [WINDOWS_CHROME, EDGE]) {
      expect(describeCameraError(refused, userAgent)).toBe(
        "Binder isn't allowed to use the camera. Allow it from the camera icon in the address bar, then press Start it again. If it's allowed there, turn on Let desktop apps access your camera in Settings → Privacy & security → Camera.",
      )
    }
  })

  it("names Windows' camera setting for a camera Windows says it can't read", () => {
    for (const userAgent of [WINDOWS_APP, WINDOWS_CHROME]) {
      expect(describeCameraError(new DOMException('', 'NotReadableError'), userAgent)).toBe(
        'The camera is in use by another app, or turned off for desktop apps in Settings → Privacy & security → Camera.',
      )
      expect(describeCameraError(new DOMException('', 'NotFoundError'), userAgent)).toBe('No camera found.')
    }
  })

  it("sends a refused camera to the site's permissions in Chrome on Android", () => {
    expect(describeCameraError(refused, ANDROID_CHROME)).toBe(
      "Binder isn't allowed to use the camera. Tap the icon left of the address, then Permissions → Camera to allow it, and tap Start it again.",
    )
    expect(describeCameraError(new DOMException('', 'NotReadableError'), ANDROID_CHROME)).toBe('The camera is in use by another app.')
  })

  it('takes the platform from the page when given, over the user agent', () => {
    expect(describeCameraError(refused, CHROME, 'windows')).toMatch(/Let desktop apps access your camera/)
    expect(describeCameraError(refused, WINDOWS_CHROME, 'mac')).not.toMatch(/Windows|desktop apps/)
  })
})

describe('the camera help', () => {
  it('explains Continuity Camera on a Mac, as before', () => {
    expect(cameraHelp('mac')).toEqual({
      title: 'Using your iPhone as the camera (Continuity Camera)',
      text:
        'Sign both devices into the same Apple ID with Wi-Fi and Bluetooth on. For USB, plug the iPhone in and trust this ' +
        'Mac. Lock the iPhone, keep it still in landscape, and mount it over the scanning area; it then appears in the ' +
        `camera list under your iPhone's name, like "My iPhone Camera".`,
    })
  })

  it('offers a webcam over the mat or an Android phone on Windows, and nothing about iPhones', () => {
    const help = cameraHelp('windows')!
    expect(help.text).toMatch(/USB webcam mounted over the mat/)
    expect(help.text).toMatch(/Android phone: turn on Settings → Phone access on this PC/)
    expect(`${help.title} ${help.text}`).not.toMatch(/iPhone|Mac|Apple|Continuity/)
  })

  it('says nothing on a phone, or where it has nothing to suggest', () => {
    expect(cameraHelp('android')).toBeNull()
    expect(cameraHelp('other')).toBeNull()
  })
})

describe('what the Scan page says to do', () => {
  it('says tap on a touch screen and Space with keys', () => {
    expect(captureHint(false)).toBe('Place a card in the guide, then press Capture or Space.')
    expect(captureHint(true)).toBe('Place a card in the guide, then tap Capture.')
  })

  it('tells a phone how to hold it for a photo', () => {
    expect(photoTip(true)).toBe('Hold the phone upright over one card, so the card fills most of the picture, and avoid glare.')
    expect(photoTip(false)).not.toMatch(/phone/)
  })

  it('says why there is no live camera only on a page that could have one with HTTPS', () => {
    expect(liveCameraNote('android', true)).toBeNull()
    expect(liveCameraNote('android', false)).toBe('For a live camera view instead of photos, turn on HTTPS in Settings → Phone access on the PC.')
    expect(liveCameraNote('windows', false)).toMatch(/needs HTTPS/)
  })
})
