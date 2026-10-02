import { useCallback, useSyncExternalStore } from 'react'

/**
 * Whether a media query matches the window, kept up to date as it changes (a phone turned on its side). Rendered without
 * a window (the tests' server rendering), it's false.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {}
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true,
    () => false,
  )
}
