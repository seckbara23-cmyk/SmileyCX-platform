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
