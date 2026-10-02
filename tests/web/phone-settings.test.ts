import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { ClientContext, type ClientView } from '../../src/web/lib/client.ts'
import { ToastProvider } from '../../src/web/lib/toast.tsx'
import { cardDataQueries, CARD_DATA_QUERIES } from '../../src/web/lib/use-bulk-status.ts'
import { PairPage } from '../../src/web/pages/PairPage.tsx'
import { SettingsPage } from '../../src/web/pages/SettingsPage.tsx'

/** Settings as `client` sees it: the server's rendering, before anything is fetched. */
function settingsFor(client: ClientView): { html: string; asked: string[] } {
  const queryClient = new QueryClient()
  const tree = (children: ReactNode) =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(MemoryRouter, null, createElement(ClientContext, { value: client }, children))),
    )
  const html = renderToStaticMarkup(tree(createElement(SettingsPage)))
  return {
    html,
    asked: queryClient
      .getQueryCache()
      .getAll()
      .map((query) => String(query.queryKey[0])),
  }
}

describe('Settings on a paired phone (spec §5.10)', () => {
  it("shows what a phone may change, says the key is the PC's, and offers to forget this phone", () => {
    const { html } = settingsFor({ kind: 'device', id: 3, name: 'Pixel 8' })
    for (const heading of ['Card data', 'Scanner', 'Anthropic API key', 'Deckbuilder', 'This phone'])
      expect(html).toContain(`>${heading}</h2>`)
    expect(html).toContain('Paired with Binder as “Pixel 8”.')
    expect(html).toContain('Forget this phone')
  })

  it("leaves out the PC's own sections, and never asks for what they show", () => {
    const { html, asked } = settingsFor({ kind: 'device', id: 3, name: 'Pixel 8' })
    for (const heading of ['Backups', 'Library file', 'Phone access']) expect(html).not.toContain(`>${heading}</h2>`)
    expect(html).not.toContain('type="password"')
    expect(asked).not.toContain('backups')
    expect(asked).not.toContain('library-size')
    expect(asked).not.toContain('lan')
  })

  it('shows the PC all of its sections, Phone access among them where the tray opens it', () => {
    const { html, asked } = settingsFor({ kind: 'pc' })
    for (const heading of ['Card data', 'Scanner', 'Anthropic API key', 'Deckbuilder', 'Backups', 'Library file']) {
      expect(html).toContain(`>${heading}</h2>`)
    }
    expect(html).toMatch(/<section[^>]* id="phone-access"[^>]*>/)
    expect(html).toContain('role="switch"')
    expect(html).not.toContain('>This phone</h2>')
    expect(asked).toEqual(expect.arrayContaining(['backups', 'library-size', 'lan']))
  })
})

describe('after a card-data refresh on a phone', () => {
  it("doesn't ask for the library file's size, which only the PC may", () => {
    expect(cardDataQueries(false)).toEqual(CARD_DATA_QUERIES)
    expect(cardDataQueries(true)).toEqual(CARD_DATA_QUERIES.filter((key) => key !== 'library-size'))
  })
})

describe('the pairing page', () => {
  const page = (props: Partial<Parameters<typeof PairPage>[0]> = {}) =>
    renderToStaticMarkup(createElement(PairPage, { lost: false, pairedAs: null, onPaired: () => {}, onSkip: () => {}, ...props }))

  it('says where the PC shows the code, and takes the code as a phone types one', () => {
    const html = page()
    expect(html).toContain('Settings → Phone access → Pair a phone')
    expect(html).toMatch(/<input[^>]* inputMode="numeric"[^>]* autoComplete="one-time-code"/)
    expect(html).toContain('>Pair</button>')
  })

  it('says over plain HTTP that the live camera needs HTTPS, and that scanning works by photo meanwhile', () => {
    expect(page()).toContain('The live camera needs HTTPS (Settings → Phone access on the PC). Until then, scanning works by photo.')
  })

  it('says when the phone was paired until a moment ago', () => {
    expect(page({ lost: true })).toContain('This phone needs to pair with Binder again.')
    expect(page()).not.toContain('pair with Binder again')
  })
})
