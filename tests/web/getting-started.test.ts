import { describe, expect, it } from 'vitest'
import { scanStepText } from '../../src/web/components/library/GettingStarted.tsx'

describe('Getting started', () => {
  it('says how scanning goes on the computer or phone Binder is open on', () => {
    expect(scanStepText('mac')).toBe('Hold each card under your iPhone or webcam; Binder reads it on this Mac.')
    expect(scanStepText('windows')).toBe('Hold each card under a webcam, or scan with your phone; Binder reads it on this PC.')
    expect(scanStepText('android')).toBe("Photograph each card with this phone's camera; Binder reads it on your computer.")
    for (const platform of ['windows', 'android', 'other'] as const) expect(scanStepText(platform)).not.toMatch(/Mac|iPhone/)
  })
})
