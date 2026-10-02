/**
 * How long the tests guarding against runaway work (regex backtracking, a quadratic loop) give a run. Gone wrong, that
 * work takes seconds or minutes on their inputs; sound, it takes milliseconds, though a busy or throttled PC (a Windows
 * laptop scanning every file it opens, a garbage collection mid-run) can stretch that a long way, so the bound is
 * generous.
 */
export const QUICK_MS = 1000
