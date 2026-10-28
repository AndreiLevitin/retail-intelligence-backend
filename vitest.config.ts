import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // One disposable PostgreSQL cluster per test run; each integration test
    // file creates and drops its own database inside it.
    globalSetup: ['tests/support/globalSetup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
})
