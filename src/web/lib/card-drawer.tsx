import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { useBackToClose } from './back-to-close.ts'

interface CardDrawerApi {
  /** Printing id currently shown, or null when closed. */
  cardId: string | null
  open: (cardId: string) => void
  close: () => void
}

const CardDrawerContext = createContext<CardDrawerApi | null>(null)

export function CardDrawerProvider({ children }: { children: ReactNode }) {
  const [cardId, setCardId] = useState<string | null>(null)
  const open = useCallback((id: string) => setCardId(id), [])
  const close = useCallback(() => setCardId(null), [])
  // Back closes the drawer (Android's Back above all); switching printings inside it keeps the one entry.
  useBackToClose(cardId !== null, close)
  const value = useMemo(() => ({ cardId, open, close }), [cardId, open, close])
  return <CardDrawerContext value={value}>{children}</CardDrawerContext>
}

export function useCardDrawer(): CardDrawerApi {
  const ctx = useContext(CardDrawerContext)
  if (!ctx) throw new Error('useCardDrawer must be used inside CardDrawerProvider')
  return ctx
}
