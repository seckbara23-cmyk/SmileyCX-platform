/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  // Next.js compiles JSX with the automatic runtime, so page/component modules
  // never import React themselves. Match that here, otherwise importing a
  // Server Component in a test fails with "React is not defined".
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    globals: true,
    /**
     * Vitest defaults to 5000ms per test. That is too tight for THIS suite,
     * and the symptom was a flake that moved between files: four different
     * files timed out across one working session — cat-02-price-rendering,
     * enr-01c-c-entitlement-authority, course-detail and others — and every
     * one of them passed in isolation.
     *
     * Measured rather than guessed. A full run reports ~130s of aggregate
     * test time inside ~38s of wall clock, so tests are heavily parallel and
     * a worker can be descheduled for seconds at a time. Several tests also
     * legitimately spawn child processes — the mailer gate and the UAT
     * isolation gate are process-level tests by design — and those files run
     * 12-22s each. Under contention an individual test's WALL time crosses 5s
     * while its own work is short, which is precisely a false failure.
     *
     * 20s is chosen to absorb scheduling latency without hiding a hang: a
     * genuinely stuck test still fails, 15s later than before, and timeouts
     * are rare enough that this costs nothing in practice. It is not a licence
     * for slow tests — if a file's own work approaches this, fix the file.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/__tests__/**/*.{test,spec}.{ts,tsx}', '**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', '.next', 'e2e'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['lib/**', 'app/actions/**', 'components/**'],
      exclude: ['**/__tests__/**', '**/*.d.ts', '**/node_modules/**'],
      thresholds: {
        lines:      60,
        functions:  60,
        branches:   50,
        statements: 60,
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
      // PAY-2D-0. `server-only` is a build-time marker Next resolves itself; it
      // is not an installed package, so vite cannot resolve the bare specifier
      // and any jsdom test importing a server-only module failed to LOAD.
      // Resolved to a no-op for tests; the real boundary is still enforced by
      // the Next build. See __tests__/stubs/server-only.ts.
      'server-only': resolve(__dirname, '__tests__/stubs/server-only.ts'),
    },
  },
})
