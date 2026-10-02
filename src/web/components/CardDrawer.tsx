import { useQuery } from '@tanstack/react-query'
import { Fragment, useEffect, useRef, useState } from 'react'
import { listPrice } from '../../shared/prices.ts'
import type { Card, CardDetail, CardFace, Copy, Printing } from '../../shared/types.ts'
import { ApiRequestError, apiGet } from '../lib/api.ts'
import { useCardDrawer } from '../lib/card-drawer.tsx'
import { formatUsd } from '../lib/format.ts'
import { AddCopy, YourCopies } from './drawer/CollectionSections.tsx'
import { AddToDeck, DeckList } from './drawer/DeckSections.tsx'
import { sectionHeading } from './drawer/styles.ts'
import { ManaText } from './ManaText.tsx'

const FORMATS = ['standard', 'pioneer', 'modern', 'legacy', 'vintage', 'pauper', 'commander'] as const

const LEGALITY_STYLE: Record<string, string> = {
  legal: 'border-emerald-800 bg-emerald-900/50 text-emerald-300',
  banned: 'border-rose-900 bg-rose-900/40 text-rose-300',
  restricted: 'border-amber-900 bg-amber-900/40 text-amber-300',
  not_legal: 'border-stone-800 bg-stone-800/60 text-stone-500',
}

/**
 * Slide-over with a printing's details and my copies of the card. Opened from anywhere via useCardDrawer().open(id).
 * The panel mounts on open, so a reopened drawer never flashes the previous card.
 */
export function CardDrawer() {
  const { cardId, open, close } = useCardDrawer()
  if (!cardId) return null
  return <DrawerPanel cardId={cardId} onSelectPrinting={open} onClose={close} />
}

function DrawerPanel({ cardId, onSelectPrinting, onClose }: { cardId: string; onSelectPrinting: (id: string) => void; onClose: () => void }) {
  const panelRef = useRef<HTMLElement>(null)
  // What had focus before the drawer opened, read on the first render: an effect would run again under StrictMode (dev)
  // after focus had already moved into the drawer.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null))

  // Focus moves into the drawer when it opens and goes back where it was when it closes.
  useEffect(() => {
    panelRef.current?.focus()
    return () => opener?.focus()
  }, [opener])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Switching printings inside the drawer keeps the current card on screen (dimmed) until the next one loads.
  const { data, error, isPending, isPlaceholderData } = useQuery({
    queryKey: ['card', cardId],
    queryFn: ({ signal }) => apiGet<CardDetail>(`/api/cards/${encodeURIComponent(cardId)}`, signal),
    placeholderData: (previous) => previous,
  })

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button aria-label="Close card details" tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-black/60" />
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={data?.card.name ?? 'Card details'}
        aria-busy={isPlaceholderData}
        className="relative flex h-full w-full max-w-3xl flex-col overflow-y-auto overscroll-contain border-l border-stone-800 bg-stone-950 pb-[env(safe-area-inset-bottom)] shadow-2xl outline-none"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-stone-800 bg-stone-950/95 px-4 py-3 sm:px-5">
          <span className="text-xs tracking-[0.2em] text-stone-500 uppercase">
            Card{isPlaceholderData && <span className="ml-2 tracking-normal normal-case">loading…</span>}
          </span>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-stone-400 hover:bg-stone-800 hover:text-stone-100 pointer-coarse:-my-1.5 pointer-coarse:px-3 pointer-coarse:py-2.5"
          >
            Close ✕
          </button>
        </div>
        {isPending && <div className="p-8 text-stone-400">Loading…</div>}
        {error && (
          <div className="m-5 rounded-lg border border-rose-900 bg-rose-950/50 p-4 text-rose-200">
            {error instanceof ApiRequestError && error.status === 404
              ? "This printing isn't in your local card data yet. Refresh card data in Settings to add it."
              : error.message}
          </div>
        )}
        {data && (
          <div className={isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}>
            <CardDetailView detail={data} onSelectPrinting={onSelectPrinting} />
          </div>
        )}
      </aside>
    </div>
  )
}

function CardDetailView({ detail, onSelectPrinting }: { detail: CardDetail; onSelectPrinting: (id: string) => void }) {
  const { card, printings, copies } = detail
  const faceImages = card.faces.map((f) => f.imageNormal).filter((url): url is string => url !== null)
  const [faceIndex, setFaceIndex] = useState(0)
  useEffect(() => setFaceIndex(0), [card.id])
  const image = faceImages.length > 1 ? faceImages[faceIndex % faceImages.length] : card.imageNormal
  const faces: CardFace[] =
    card.faces.length > 1
      ? card.faces
      : [{ name: card.name, manaCost: card.manaCost, typeLine: card.typeLine, oracleText: card.oracleText, power: card.power, toughness: card.toughness, loyalty: card.loyalty, imageNormal: card.imageNormal }]

  // Below sm (a phone) the image is small, beside its prices, and the sections marked order-1 move below Your copies
  // and Add a copy, which then come straight after the card's text rather than a screen or two further down.
  return (
    <div className="grid gap-5 p-4 sm:grid-cols-[minmax(0,15rem)_1fr] sm:gap-6 sm:p-5">
      <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-start gap-4 sm:block sm:space-y-3">
        <div className="space-y-3">
          {image ? (
            <img src={image} alt={card.name} className="w-full rounded-xl shadow-xl shadow-black/60" />
          ) : (
            <div className="aspect-[63/88] rounded-xl bg-stone-900" />
          )}
          {faceImages.length > 1 && (
            <button
              onClick={() => setFaceIndex((i) => i + 1)}
              className="w-full rounded-md border border-stone-700 py-1.5 text-sm text-stone-300 hover:bg-stone-800 pointer-coarse:py-2.5"
            >
              Flip ↻
            </button>
          )}
        </div>
        <div className="space-y-3">
          <PriceTable card={card} />
          <a
            href={card.scryfallUri}
            target="_blank"
            rel="noreferrer"
            className="block text-center text-xs text-stone-500 hover:text-amber-400 pointer-coarse:py-3"
          >
            View on Scryfall ↗
          </a>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-5 sm:block sm:space-y-5">
        {faces.map((face, i) => (
          <FaceBlock key={i} face={face} />
        ))}
        <div className="order-1 text-sm text-stone-400 sm:order-none">
          <span className="text-stone-300">{card.setName}</span> · {card.setCode.toUpperCase()} #{card.collectorNumber} ·{' '}
          <span className="capitalize">{card.rarity}</span>
          {card.artist && <> · Illus. {card.artist}</>}
        </div>
        <div className="order-1 sm:order-none">
          <Legalities legalities={card.legalities} />
        </div>
        <YourCopies detail={detail} onSelectPrinting={onSelectPrinting} />
        <AddCopy key={card.id} card={card} printings={printings} />
        <div className="order-1 space-y-5 sm:order-none">
          <DeckList ownership={detail.ownership} />
          <AddToDeck card={card} />
          <PrintingList printings={printings} copies={copies} currentId={card.id} onSelect={onSelectPrinting} />
        </div>
      </div>
    </div>
  )
}

function FaceBlock({ face }: { face: CardFace }) {
  const stats = face.loyalty
    ? `Loyalty ${face.loyalty}`
    : face.power !== null && face.toughness !== null
      ? `${face.power}/${face.toughness}`
      : null
  return (
    <section className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-serif text-2xl font-semibold text-stone-50">{face.name}</h2>
        {face.manaCost && <ManaText text={face.manaCost} className="shrink-0 pt-1.5" />}
      </div>
      <div className="text-sm text-stone-300">{face.typeLine}</div>
      {face.oracleText && (
        <div className="space-y-2 rounded-lg border border-stone-800 bg-stone-900/60 p-3 leading-relaxed text-stone-200">
          {face.oracleText.split('\n').map((paragraph, i) => (
            <p key={i}>
              <ManaText text={paragraph} />
            </p>
          ))}
        </div>
      )}
      {stats && <div className="text-right text-sm font-semibold text-stone-200">{stats}</div>}
    </section>
  )
}

function PriceTable({ card }: { card: Card }) {
  const rows: Array<[string, number | null]> = [
    ['Nonfoil', card.prices.usd],
    ['Foil', card.prices.usdFoil],
    ['Etched', card.prices.usdEtched],
  ]
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg border border-stone-800 p-3 text-sm">
      {rows
        .filter(([, value], i) => i === 0 || value !== null)
        .map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-stone-400">{label}</dt>
            <dd className="text-right text-stone-100 tabular-nums">{formatUsd(value)}</dd>
          </Fragment>
        ))}
    </dl>
  )
}

/**
 * Each format, colored by the card's status in it, and saying it in words too, for a finger (no tooltip) and for
 * anyone who can't tell the colors apart: not legal struck through, banned and restricted named.
 */
function Legalities({ legalities }: { legalities: Record<string, string> }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {FORMATS.map((format) => {
        const status = legalities[format] ?? 'not_legal'
        const said = status.replace('_', ' ')
        return (
          <span
            key={format}
            title={said}
            className={`rounded border px-2 py-0.5 text-xs capitalize ${LEGALITY_STYLE[status] ?? LEGALITY_STYLE.not_legal ?? ''}`}
          >
            <span className={status === 'not_legal' ? 'line-through' : undefined}>{format}</span>
            {status === 'banned' || status === 'restricted' ? ` · ${said}` : <span className="sr-only">: {said}</span>}
          </span>
        )
      })}
    </div>
  )
}

function PrintingPrice({ printing }: { printing: Printing }) {
  const price = listPrice(printing.prices, printing.finishes)
  if (!price) return <>—</>
  return (
    <>
      {formatUsd(price.usd)}
      {price.finish !== 'nonfoil' && <span className="ml-1 text-[10px] text-amber-300/80">{price.finish}</span>}
    </>
  )
}

function PrintingList({
  printings,
  copies,
  currentId,
  onSelect,
}: {
  printings: Printing[]
  copies: Copy[]
  currentId: string
  onSelect: (id: string) => void
}) {
  const owned = new Map<string, number>()
  for (const copy of copies) owned.set(copy.cardId, (owned.get(copy.cardId) ?? 0) + copy.quantity)
  return (
    <div>
      <h3 className={sectionHeading}>Printings ({printings.length})</h3>
      {/* A list that scrolls inside the drawer only from sm up: on a phone it would catch the finger scrolling the drawer. */}
      <ul className="divide-y divide-stone-800/80 rounded-lg border border-stone-800 sm:max-h-72 sm:overflow-y-auto sm:overscroll-contain">
        {printings.map((p) => (
          <li key={p.id}>
            <button
              onClick={() => onSelect(p.id)}
              aria-current={p.id === currentId ? 'true' : undefined}
              className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-stone-900 pointer-coarse:py-3 ${p.id === currentId ? 'bg-stone-900 text-amber-300' : 'text-stone-300'}`}
            >
              <span className="w-12 shrink-0 font-mono text-xs text-stone-500 uppercase">{p.setCode}</span>
              <span className="min-w-0 flex-1 truncate">
                {p.setName} <span className="text-stone-500">#{p.collectorNumber}</span>
              </span>
              {owned.has(p.id) && <span className="shrink-0 rounded bg-emerald-900/60 px-1.5 text-[11px] text-emerald-200">×{owned.get(p.id)}</span>}
              <span className="shrink-0 text-xs text-stone-500 max-sm:hidden">{p.releasedAt.slice(0, 4)}</span>
              <span className="w-20 shrink-0 text-right tabular-nums">
                <PrintingPrice printing={p} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
