/**
 * Test-time stand-in for the `server-only` marker package.
 *
 * `import 'server-only'` is a BUILD-TIME marker: Next.js resolves it to a
 * module that throws if the importing file ends up in a client bundle, and to
 * nothing when it does not. The package is not a real dependency of this
 * project — it ships only as `next/dist/compiled/server-only` — so a bare
 * `server-only` specifier is not resolvable by vitest.
 *
 * That produced a trap. Under the default `jsdom` environment vite tries to
 * bundle the specifier and fails outright with "Failed to resolve import", so
 * ANY jsdom test that transitively imported a server-only module failed to
 * load — while the same import under `// @vitest-environment node` was
 * externalised and worked. The existing server-only modules happened to be
 * imported only by node-environment tests, so the trap stayed hidden until
 * PAY-2D-0 added the marker to lib/supabase/admin.ts, which 62 modules import.
 *
 * Aliasing the specifier here (see vitest.config.ts) resolves it to a no-op in
 * every environment, which is the correct test-time semantics: a vitest run is
 * not a client bundle, so the marker has nothing to forbid. It does NOT weaken
 * the real guarantee — Next still enforces the boundary at build time, and the
 * production build is the gate that proves it.
 */
export {}
