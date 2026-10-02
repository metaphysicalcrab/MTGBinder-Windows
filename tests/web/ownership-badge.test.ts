import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Ownership } from '../../src/shared/types.ts'
import { OwnershipBadge } from '../../src/web/components/search/OwnershipBadge.tsx'

const deck = (id: number, name: string, quantity: number, maybe = 0) => ({ id, name, status: 'built' as const, quantity, maybe })
const render = (ownership: Ownership) => renderToStaticMarkup(createElement(OwnershipBadge, { ownership }))

describe('OwnershipBadge', () => {
  it("names a card's decks for a mouse, and counts them for a finger, which has no tooltip for the names cut off", () => {
    const html = render({ owned: 3, free: 1, decks: [deck(1, 'Burn', 1), deck(2, 'Elves', 1), deck(3, 'Maybe', 0, 1)] })
    expect(html).toMatch(/<span class="pointer-coarse:hidden">In Burn, Elves<\/span>/)
    expect(html).toMatch(/<span class="hidden pointer-coarse:inline">In 2 decks<\/span>/)
    expect(html).toContain('Own 3 · 1 free')
  })

  it('names a single deck for everyone', () => {
    const html = render({ owned: 1, free: 0, decks: [deck(1, 'Burn', 1)] })
    expect(html).toContain('In Burn')
    expect(html).not.toContain('decks')
  })

  it("renders nothing for a card I don't own and no deck uses, and is a span, so a row's button can hold it", () => {
    expect(render({ owned: 0, free: 0, decks: [] })).toBe('')
    expect(render({ owned: 2, free: 2, decks: [] })).toMatch(/^<span /)
  })
})
