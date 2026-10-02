import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // One time zone on every computer, so a date's local day is the same wherever the tests run (a test that needs
    // another zone sets it, and puts this one back).
    env: { TZ: 'UTC' },
    // VITEST_SIMULATE_WINDOWS_LOCKS=1 (Linux): a database file that's open can't be deleted or renamed, as on Windows.
    setupFiles: process.env.VITEST_SIMULATE_WINDOWS_LOCKS ? ['tests/helpers/windows-locks.ts'] : [],
  },
})
