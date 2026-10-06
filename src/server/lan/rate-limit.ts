/**
 * Token buckets, kept in memory, one per key (a peer's address, or a device): each holds up to `limit` tokens, and
 * gets them back evenly over `perMs`. A request takes one; with none left it's refused until one comes back.
 */
export interface RateLimiter {
  /** Takes a token for `key`: null when there was one, else the seconds until there is (for Retry-After). */
  take(key: string): number | null
}

/** Buckets kept before full ones (forgotten keys) are dropped. */
const MAX_KEYS = 1000

export function createRateLimiter(options: { limit: number; perMs: number; now?: () => number }): RateLimiter {
  const { limit, perMs } = options
  const now = options.now ?? Date.now
  const rate = limit / perMs // tokens per millisecond
  const buckets = new Map<string, { tokens: number; at: number }>()

  return {
    take(key) {
      const at = now()
      const bucket = buckets.get(key) ?? { tokens: limit, at }
      bucket.tokens = Math.min(limit, bucket.tokens + (at - bucket.at) * rate)
      bucket.at = at
      buckets.set(key, bucket)
      if (buckets.size > MAX_KEYS) {
        for (const [k, b] of buckets) if (k !== key && b.tokens + (at - b.at) * rate >= limit) buckets.delete(k)
      }
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1
        return null
      }
      return Math.max(1, Math.ceil((1 - bucket.tokens) / rate / 1000))
    },
  }
}
