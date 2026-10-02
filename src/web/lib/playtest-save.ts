import type { Action } from '../../shared/playtest/types.ts'
import { ApiRequestError } from './api.ts'

/**
 * Saving the playtest's actions (spec §5.9.7): the page plays each action at once and sends it to the server behind
 * any not yet saved, one at a time, in order. A save the server can't be reached for is tried again, waiting longer
 * each time; one the server refuses (the game changed in another window or on another device, or an action it can't
 * apply) drops the rest, and the page reloads the saved game.
 */

export type SaveOp =
  | { kind: 'append'; startedAt: string; seq: number; action: Action }
  | { kind: 'undo'; startedAt: string; seq: number }

/** Saved; sending; or waiting to try again after the server couldn't be reached. */
export type SaveStatus = 'saved' | 'saving' | 'retrying'

/** How long to wait before the next try: 1 s, then twice as long each time, up to 30 s. */
export function retryDelay(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt)
}

export interface SaverDeps {
  send: (op: SaveOp) => Promise<void>
  wait: (ms: number) => Promise<void>
  /** The server refused a save: everything after it was dropped. */
  onRefused: (err: ApiRequestError) => void
}

export interface Saver {
  append: (startedAt: string, seq: number, action: Action) => void
  /** Takes back the action at `seq`: dropped from the queue if it hasn't been sent, else undone on the server. */
  undo: (startedAt: string, seq: number) => void
  /** Drops everything not yet sent (a new game started, or the saved game was reloaded). */
  reset: () => void
  status: () => SaveStatus
  subscribe: (listener: () => void) => () => void
}

export function createSaver(deps: SaverDeps): Saver {
  let queue: SaveOp[] = []
  let running = false
  let status: SaveStatus = 'saved'
  const listeners = new Set<() => void>()
  const setStatus = (next: SaveStatus) => {
    if (next === status) return
    status = next
    for (const listener of listeners) listener()
  }

  async function run(): Promise<void> {
    if (running) return
    running = true
    let attempt = 0
    try {
      while (queue.length > 0) {
        const op = queue[0]!
        setStatus(attempt === 0 ? 'saving' : 'retrying')
        try {
          await deps.send(op)
          if (queue[0] === op) queue.shift()
          attempt = 0
        } catch (err) {
          // Dropped while it was being sent: whatever the server said about it no longer matters.
          if (queue[0] !== op) continue
          if (err instanceof ApiRequestError && err.status < 500) {
            queue = []
            deps.onRefused(err)
            break
          }
          setStatus('retrying')
          await deps.wait(retryDelay(attempt++))
        }
      }
    } finally {
      // Even when telling of a refusal throws, the next save must start the loop again, not wait on this one.
      running = false
      setStatus('saved')
    }
  }

  return {
    append(startedAt, seq, action) {
      queue.push({ kind: 'append', startedAt, seq, action })
      void run()
    },
    undo(startedAt, seq) {
      const last = queue.at(-1)
      // The first op may be on its way to the server (or waiting to be tried again): only a later one can be dropped.
      const unsent = !(running && queue.length === 1)
      if (last?.kind === 'append' && last.startedAt === startedAt && last.seq === seq && unsent) {
        queue.pop()
        return
      }
      queue.push({ kind: 'undo', startedAt, seq })
      void run()
    },
    reset() {
      queue = []
    },
    status: () => status,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
