#!/usr/bin/env node
/**
 * MEDIA-INTRO-01 — course Introduction video release CLI.
 *
 *   node scripts/media/intro-release.mjs plan                              READ-ONLY
 *   node scripts/media/intro-release.mjs verify                            READ-ONLY
 *   node scripts/media/intro-release.mjs upload   --approved --project-ref=<ref>
 *   node scripts/media/intro-release.mjs apply    --approved --project-ref=<ref>
 *   node scripts/media/intro-release.mjs rollback --approved --project-ref=<ref>
 *
 *   Uploaded bytes are re-downloaded and re-hashed by default; that SHA-256 is
 *   the release evidence. `--no-deep-verify` opts out and falls back to size
 *   plus content type. `--deep-verify` remains accepted and is now the default.
 *
 * ── WHY A SCRIPT AND NOT THE ADMIN UI ────────────────────────────────────────
 *
 * Seven films across seven courses is seven chances to attach the wrong video
 * to the wrong course, and the Admin uploader cannot check a SHA-256 or notice
 * that a course already has an Introduction. Every operation here is derived
 * from `courses.code` — UNIQUE and immutable (migration 028) — verified against
 * the database immediately before each write, and checkpointed to a manifest so
 * what shipped is auditable and reversible afterwards.
 *
 * All logic lives in `intro-release-core.mjs`, which takes its storage and
 * database boundaries as injected dependencies. That is what lets
 * `__tests__/media/media-intro-03-release-tool.test.ts` drive the whole
 * lifecycle — including crashes, retries and concurrent admin edits — against
 * mocks, with no network and no production write.
 *
 * ── SAFETY MODEL ─────────────────────────────────────────────────────────────
 *
 *   • `plan` and `verify` only read. Everything else needs BOTH --approved and
 *     --project-ref matching the project the configured URL actually points at.
 *   • Object paths are deterministic in (course code, content hash), so a retry
 *     after a crash reconciles the existing object instead of minting a second.
 *   • The manifest is checkpointed atomically after every completed operation.
 *   • The rollback baseline is captured once and frozen.
 *   • Rollback deletes only a lesson this release demonstrably created, only
 *     when it carries no learner progress, and refuses when anything is
 *     ambiguous. Storage objects are never deleted.
 *   • Variable PRESENCE is read, never a value. No secret is printed.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, COMMANDS, readManifest } from './intro-release-core.mjs'

const SOURCE_DIR = 'incoming media'
const MANIFEST = join('docs', 'media-intro-01-manifest.json')

/**
 * Source of truth for the release. `code` is resolved against the database;
 * the UUIDs are assertions, not lookups — a mismatch stops the run.
 * Hashes were measured from the delivered files (MEDIA-INTRO-01 Phase 1).
 */
export const TARGETS = [
  { code: 'C1-F1', file: 'C1_F1_Intro.mp4', courseId: 'debc2117-dc55-4b6f-98d7-280da12c2505',
    sha256: 'afdc8ef544bc3ec7c02af7109e7463bb3fbd48fa72e14bd46985f1d201e2dad5' },
  { code: 'C1-F2', file: 'C1_F2_Intro.mp4', courseId: 'b0e3d6f3-af9e-4681-9865-751cff643fa3',
    sha256: '2e601c24b633d00ceb020494cdef4dfb5c43eb5121f5e671388fc8477ce57a19' },
  { code: 'C1-F3', file: 'C1_F3_Intro.mp4', courseId: 'ed68e1be-8805-42b5-9f87-c5d1d17a31c6',
    sha256: 'b6c9079f7ae72ca9a81830446f46fc98ecfe032d5963be0033131d13b77a0d47' },
  { code: 'C2-F1', file: 'C2_F1_Intro.mp4', courseId: 'd92ea494-36cf-4a19-8b01-db45666ac268',
    sha256: 'a4a900fd9e171649200aefa1a4056dc88e9e74eaf9645f01a017c814b32f8f5c' },
  { code: 'C2-F2', file: 'C2_F2_Intro.mp4', courseId: '3731d5cc-7245-4fc7-9ddf-a10b9215d6cc',
    sha256: '8cde7ecec5dc256f6347decce1d9c1659b8d6ec42c82908bccae87dbb9aea25d' },
  { code: 'C2-F4', file: 'C2_F4_Intro.mp4', courseId: '99a532c5-cc66-4bda-bb69-5527066b6007',
    sha256: 'fc2d1ca48c96787c4bccb3a467a3c9ea3a15b6445dbba641105d5a554f893955' },
  { code: 'C2-F5', file: 'C2_F5_Intro.mp4', courseId: 'caaeff66-9095-4cf3-9294-e08188522e3a',
    sha256: '458b53ea8cb0ceeb2c89f60fe3bdc51ff78d27ad4d60f4a4c45d9f86a3e70f5b' },
]

const MUTATING = ['upload', 'apply', 'rollback']

const argv     = process.argv.slice(2)
const mode     = (argv[0] ?? 'plan').toLowerCase()
const approved = argv.includes('--approved')
// MEDIA-INTRO-07: deep verification is ON by default. The SHA-256 of the bytes
// actually stored is the release evidence, and the size-plus-content-type pair
// it replaces turned out to be weaker than advertised. `--deep-verify` is still
// accepted so existing runbooks keep working; `--no-deep-verify` is the escape.
const deep     = !argv.includes('--no-deep-verify')
const refArg   = (argv.find(a => a.startsWith('--project-ref=')) ?? '').split('=')[1] ?? null

/**
 * Load .env.local, but let REAL environment variables win.
 *
 * The previous order had .env.local override process.env, which meant a
 * deliberate `NEXT_PUBLIC_SUPABASE_URL=... node …` could not redirect the tool
 * away from whatever a developer's file happened to point at. Matching
 * verify-prod-config.mjs ("real environment variables always win") makes the
 * target explicit and overridable.
 */
const fileEnv = {}
try {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (m) fileEnv[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* optional */ }
const cfg = name => process.env[name] ?? fileEnv[name]

const SB  = cfg('NEXT_PUBLIC_SUPABASE_URL')
const SVC = cfg('SUPABASE_SERVICE_ROLE_KEY')
if (!SB || !SVC) {
  console.error('✗ Missing Supabase configuration (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).')
  process.exit(1)
}

/** `https://<ref>.supabase.co` → `<ref>`. Never a secret: it is in the URL. */
export function projectRefOf(url) {
  try {
    const host = new URL(url).hostname
    const m = /^([a-z0-9-]+)\.supabase\.(co|in|net)$/i.exec(host)
    return m ? m[1] : host
  } catch { return null }
}
const liveRef = projectRefOf(SB)

if (!COMMANDS[mode]) {
  console.error(`✗ Unknown mode '${mode}'. Use: ${Object.keys(COMMANDS).join(' | ')}`)
  process.exit(1)
}

if (MUTATING.includes(mode)) {
  if (!approved) {
    console.error(
      `\n✗ [NOT_AUTHORIZED] '${mode}' changes production and needs explicit owner approval.\n\n` +
      `      node scripts/media/intro-release.mjs ${mode} --approved --project-ref=${liveRef}\n\n` +
      "  'plan' and 'verify' are read-only and need no approval.\n",
    )
    process.exit(1)
  }
  if (!refArg) {
    console.error(
      `\n✗ [PROJECT_REF_REQUIRED] '${mode}' will write to Supabase project '${liveRef}'.\n\n` +
      '  Name it explicitly so the wrong environment cannot be hit by accident:\n\n' +
      `      node scripts/media/intro-release.mjs ${mode} --approved --project-ref=${liveRef}\n`,
    )
    process.exit(1)
  }
  if (refArg !== liveRef) {
    console.error(
      `\n✗ [PROJECT_REF_MISMATCH] Refusing to write.\n\n` +
      `  --project-ref says : ${refArg}\n` +
      `  configuration says : ${liveRef}\n\n` +
      '  One of them is wrong. Nothing was changed.\n',
    )
    process.exit(1)
  }
}

const ctx = createContext({
  supabaseUrl: SB,
  serviceKey: SVC,
  fetchImpl: fetch,
  sourceDir: SOURCE_DIR,
  manifestPath: MANIFEST,
  targets: TARGETS,
  deepVerify: deep,
  log: msg => console.log(msg),
})

console.log(`\nMEDIA-INTRO-01 — ${mode}${MUTATING.includes(mode) ? '' : ' (READ-ONLY)'}  project=${liveRef}\n`)

const out = await COMMANDS[mode](ctx)

if (out.errors?.length) {
  console.error('')
  for (const e of out.errors) console.error(`  ✗ ${e}`)
}
if (out.results?.length) {
  console.log('')
  for (const r of out.results) {
    console.log(`  ${r.code.padEnd(7)} ${r.state}${r.why ? ` — ${r.why}` : ''}${r.lessonId ? ` (${r.lessonId})` : ''}`)
  }
}
if (mode === 'plan') {
  const m = readManifest(MANIFEST)
  console.log(`\n  ${m.entries.length} target(s): ` +
    `${m.entries.filter(e => e.plannedOperation === 'REPLACE').length} replace, ` +
    `${m.entries.filter(e => e.plannedOperation === 'CREATE').length} create`)
  console.log(`  manifest → ${MANIFEST}`)
}
if (out.failed?.length) console.error(`\n  ✗ ${out.failed.length} check(s) failed`)

console.log(out.ok === false ? '\n  ✗ incomplete — see above\n' : '\n  ✓ done\n')
process.exit(out.ok === false ? 1 : 0)
