import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiGet, ApiRequestError, apiSend, noAnswerText } from '../../src/web/lib/api.ts'

describe('a request that gets no answer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const noAnswer = () => vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))))

  it("says on this computer that Binder isn't running, not the browser's own words", async () => {
    noAnswer()
    vi.stubGlobal('location', { hostname: 'localhost' })
    const err = await apiGet('/api/decks').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(ApiRequestError)
    expect((err as Error).message).toBe("Couldn't reach Binder: check that it's still running")
    expect((err as Error).cause).toBeInstanceOf(TypeError)
  })

  it('says on a phone that the PC is out of reach, and what to check', async () => {
    noAnswer()
    vi.stubGlobal('location', { hostname: '192.168.1.5' })
    await expect(apiSend('POST', '/api/decks', { name: 'Elves' })).rejects.toThrow(noAnswerText(false))
    expect(noAnswerText(false)).toBe(
      "Couldn't reach Binder on the PC: check that it's running with Phone access on, and that this phone is on the same Wi-Fi",
    )
  })

  it('leaves an abort as it is, and an answer as the server gave it', async () => {
    const abort = new DOMException('This operation was aborted', 'AbortError')
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(abort)))
    await expect(apiGet('/api/decks')).rejects.toBe(abort)
    const body = { error: { code: 'not_found', message: 'There is no such deck' } }
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 404 }))))
    await expect(apiGet('/api/decks/9')).rejects.toMatchObject({ status: 404, code: 'not_found', message: 'There is no such deck' })
  })
})
