import { createContext, useContext, type MouseEvent, type PointerEvent } from 'react'
import type { Action, Dest, GameState, SeatIndex, Setup } from '../../../shared/playtest/types.ts'
import type { DragSource } from '../../lib/playtest-board.ts'

export type { DragSource }

/** What a finger held on opens, besides a card: a library's menu, or an item's on the stack (an ability isn't dragged). */
export type HoldTarget = { library: SeatIndex } | { item: string }

/** What the table's parts read and do (spec §5.9.3, §5.9.4); the Board provides it. */
export interface BoardApi {
  game: GameState
  setup: Setup
  /** The seat at the bottom of the window. */
  viewer: SeatIndex
  selection: ReadonlySet<string>
  hovered: string | null
  setHovered: (id: string | null) => void
  /** Height of a card on the battlefield, in pixels. */
  cardHeight: number
  /** A card being attached waits for its host to be clicked. */
  attaching: string[] | null
  /** The main pointer is a finger (a tablet or a phone): the words say tap, and the turn bar offers Select (M13). */
  coarse: boolean
  play: (action: Action) => boolean
  /** Moves cards, first asking "Command zone instead?" for a commander going somewhere it may skip. */
  moveCards: (ids: string[], to: Dest) => void
  /**
   * A mouse's double-click on a card in hand or the command zone plays it: a permanent to the battlefield, an instant
   * or sorcery onto the stack. A finger's tap plays it (tapAction); its double-tap's dblclick does nothing.
   */
  doubleClickCard: (id: string) => void
  beginCardDrag: (e: PointerEvent, id: string, source: DragSource) => void
  beginBoxSelect: (e: PointerEvent, seat: SeatIndex) => void
  /** A finger or a pen held on a library or an ability on the stack opens its menu; a mouse right-clicks. */
  beginHold: (e: PointerEvent, target: HoldTarget) => void
  openCardMenu: (e: MouseEvent, id: string) => void
  openLibraryMenu: (e: MouseEvent, seat: SeatIndex) => void
  openFieldMenu: (e: MouseEvent, seat: SeatIndex) => void
  openStackMenu: (e: MouseEvent, item: string) => void
  openPile: (seat: SeatIndex, zone: 'graveyard' | 'exile') => void
}

export const BoardContext = createContext<BoardApi | null>(null)

export function useBoard(): BoardApi {
  const board = useContext(BoardContext)
  if (!board) throw new Error('useBoard must be used inside the Board')
  return board
}

/**
 * A card's hover handlers, for the large preview (spec §5.9.3): a mouse's only. A finger's tap would flash the preview
 * over the board; a finger opens it from the card's menu (View card) instead.
 */
export function hoverOn(board: BoardApi, id: string | undefined) {
  return {
    onPointerEnter: (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && id !== undefined) board.setHovered(id)
    },
    onPointerLeave: (e: PointerEvent) => {
      if (e.pointerType === 'mouse') board.setHovered(null)
    },
  }
}
