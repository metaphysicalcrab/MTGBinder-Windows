import type { DeckDetail } from '../../../shared/types.ts'
import { useCardDrawer } from '../../lib/card-drawer.tsx'
import { buyListText } from '../../lib/deck-view.ts'
import { copyText } from '../../lib/clipboard.ts'
import { formatUsd, plural } from '../../lib/format.ts'
import { useUpdateSettings } from '../../lib/settings.ts'
import { useToast } from '../../lib/toast.tsx'

/** Cards to buy, with the cheapest price and a TCGplayer link, a total, and "Copy as text" (spec §5.4.2). */
export function BuyListTab({ deck }: { deck: DeckDetail }) {
  const { items, totalUsd, unpriced, ignoreBasics } = deck.buyList
  const updateSettings = useUpdateSettings()
  const drawer = useCardDrawer()
  const toast = useToast()

  const totalLabel = `Total${unpriced > 0 ? ` (${plural(unpriced, 'card')} without a price)` : ''}`

  async function copy() {
    try {
      await copyText(buyListText(items))
      toast.success(`Copied ${plural(items.length, 'line')} to the clipboard.`)
    } catch {
      toast.error("Couldn't copy to the clipboard.")
    }
  }

  return (
    <section aria-label="Buy list" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-stone-300 pointer-coarse:min-h-10">
          <input
            type="checkbox"
            className="pointer-coarse:size-5"
            checked={ignoreBasics}
            disabled={updateSettings.isPending}
            onChange={(e) => updateSettings.mutate({ buylistIgnoreBasics: e.target.checked })}
          />
          Leave out basic lands <span className="text-stone-500">(for every deck)</span>
        </label>
        <button
          onClick={() => void copy()}
          disabled={items.length === 0}
          className="rounded-md border border-stone-700 px-3 py-1.5 text-sm text-stone-200 hover:bg-stone-800 disabled:opacity-50 pointer-coarse:py-2.5"
        >
          Copy as text
        </button>
      </div>
      {items.length === 0 ? (
        <p className="py-10 text-center text-stone-500">Nothing to buy: you have every card this deck needs.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-stone-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-stone-900/80 text-xs tracking-wide text-stone-400 uppercase">
              <tr>
                <th className="px-3 py-2 font-medium">Qty</th>
                <th className="px-3 py-2 font-medium">Card</th>
                <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Each</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2 font-medium">
                  <span className="sr-only">Buy</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-800/70">
              {items.map((item) => (
                <tr key={item.oracleId}>
                  <td className="px-3 py-2 text-stone-100 tabular-nums">{item.quantity}</td>
                  <td className="px-3 py-2">
                    <button onClick={() => drawer.open(item.cardId)} className="text-left text-stone-100 hover:text-amber-300 pointer-coarse:py-1">
                      {item.name}
                    </button>
                  </td>
                  <td className="hidden px-3 py-2 text-right text-stone-300 tabular-nums sm:table-cell">{formatUsd(item.priceUsd)}</td>
                  <td className="px-3 py-2 text-right text-stone-100 tabular-nums">
                    {formatUsd(item.priceUsd === null ? null : item.priceUsd * item.quantity)}
                  </td>
                  <td className="px-3 py-2">
                    {item.purchaseUrl && (
                      <a
                        href={item.purchaseUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs whitespace-nowrap text-amber-300 hover:underline pointer-coarse:inline-block pointer-coarse:py-2"
                      >
                        TCGplayer ↗
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-stone-800 text-sm">
              <tr>
                {/* Across the columns before Total: three, or two on a phone, which leaves out Each. */}
                <td colSpan={2} className="px-3 py-2 text-right text-stone-400 sm:hidden">
                  {totalLabel}
                </td>
                <td colSpan={3} className="hidden px-3 py-2 text-right text-stone-400 sm:table-cell">
                  {totalLabel}
                </td>
                <td className="px-3 py-2 text-right font-medium text-stone-50 tabular-nums">{formatUsd(totalUsd)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  )
}
