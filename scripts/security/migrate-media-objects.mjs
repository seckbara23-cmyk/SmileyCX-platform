#!/usr/bin/env node
/**
 * XPA-8 W3 (F-2) — move protected lesson media into the private bucket.
 *
 *   node scripts/security/migrate-media-objects.mjs            # dry run
 *   node scripts/security/migrate-media-objects.mjs --copy     # copy objects
 *   node scripts/security/migrate-media-objects.mjs --delete-originals
 *
 * ── WHY THIS IS THREE COMMANDS AND NOT ONE ────────────────────────────────
 *
 * Copying is additive and reversible: until the originals are deleted, every
 * historical URL still works and the platform is exactly as it was. Deleting
 * is the irreversible half, and it is the half that actually closes F-2 —
 * because a bucket becoming private does NOT retroactively invalidate an
 * object that still sits in a public bucket somewhere else.
 *
 * Running them separately means the migration can be verified while it is
 * still undoable, and the destructive step is a decision someone made rather
 * than a side effect of the safe one.
 *
 * ── ORDER ─────────────────────────────────────────────────────────────────
 *
 *   1. apply 041          creates course-content (private) + path columns
 *   2. deploy application paths are NULL, players fall back to the old URL
 *   3. --copy             objects exist in BOTH buckets; nothing changes yet
 *   4. apply 042          backfills paths, verifying each object landed
 *   5. verify             node scripts/security/verify-xpa-8-storage.mjs
 *   6. --delete-originals historical URLs die; F-2 closes
 *
 * `cover/` is deliberately NOT moved. Course thumbnails are rendered by the
 * anonymous marketing catalogue and are meant to be public.
 */
import { readFileSync } from 'node:fs'

const env = {}
try {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* fall through to process.env */ }

const SB = env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const SVC = env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SB || !SVC) { console.error('Missing Supabase configuration.'); process.exit(1) }

const SOURCE = 'course-media'
const TARGET = 'course-content'
const MOVE_PREFIXES = ['video', 'pdf', 'subtitle']

const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' }
const argv = process.argv.slice(2)
const DO_COPY = argv.includes('--copy')
const DO_DELETE = argv.includes('--delete-originals')

const list = async (bucket, prefix) => {
  const out = []
  let offset = 0
  for (;;) {
    const r = await fetch(`${SB}/storage/v1/object/list/${bucket}`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
    })
    const page = await r.json()
    if (!Array.isArray(page) || page.length === 0) break
    for (const e of page) if (e.id) out.push(prefix ? `${prefix}/${e.name}` : e.name)
    if (page.length < 1000) break
    offset += page.length
  }
  return out
}

const main = async () => {
  const buckets = await (await fetch(`${SB}/storage/v1/bucket`, { headers: H })).json()
  const target = buckets.find(b => b.id === TARGET)
  if (!target) {
    console.error(`✗ Bucket "${TARGET}" does not exist. Apply migration 041 first.`)
    process.exitCode = 1
    return
  }
  if (target.public) {
    console.error(`✗ Bucket "${TARGET}" is PUBLIC. Refusing to move protected media into it.`)
    process.exitCode = 1
    return
  }

  const source = []
  for (const p of MOVE_PREFIXES) source.push(...await list(SOURCE, p))
  const existing = new Set()
  for (const p of MOVE_PREFIXES) for (const o of await list(TARGET, p)) existing.add(o)

  const todo = source.filter(o => !existing.has(o))
  const done = source.filter(o => existing.has(o))

  console.log(`\nXPA-8 W3 — protected media migration`)
  console.log(`  source  ${SOURCE} (public)  → ${source.length} protected object(s)`)
  console.log(`  target  ${TARGET} (private) → ${existing.size} already present`)
  console.log(`  to copy ${todo.length}\n`)

  if (!DO_COPY && !DO_DELETE) {
    console.log('Dry run. Pass --copy to copy, then --delete-originals once verified.')
    for (const o of todo.slice(0, 5)) console.log(`    would copy  ${o}`)
    if (todo.length > 5) console.log(`    … and ${todo.length - 5} more`)
    return
  }

  if (DO_COPY) {
    let ok = 0
    const failed = []
    for (const [i, obj] of todo.entries()) {
      const r = await fetch(`${SB}/storage/v1/object/copy`, {
        method: 'POST', headers: H,
        body: JSON.stringify({
          bucketId: SOURCE, sourceKey: obj,
          destinationBucket: TARGET, destinationKey: obj,
        }),
      })
      if (r.status < 300) { ok++ } else { failed.push(`${obj} → ${r.status} ${(await r.text()).slice(0, 80)}`) }
      if ((i + 1) % 25 === 0) console.log(`    … ${i + 1}/${todo.length}`)
    }
    console.log(`\n  copied ${ok}, already present ${done.length}, failed ${failed.length}`)
    for (const f of failed.slice(0, 10)) console.log(`    ✗ ${f}`)
    if (failed.length) { process.exitCode = 1; return }

    // Verify byte-for-byte presence, not just a 200 from the copy call.
    const after = new Set()
    for (const p of MOVE_PREFIXES) for (const o of await list(TARGET, p)) after.add(o)
    const missing = source.filter(o => !after.has(o))
    console.log(`  verification: ${source.length - missing.length}/${source.length} present in ${TARGET}`)
    if (missing.length) {
      console.log(`  ✗ still missing: ${missing.slice(0, 5).join(', ')}`)
      process.exitCode = 1
      return
    }
    console.log(`\n✓ Copy complete. Next: apply migration 042, then run the verifier.`)
    console.log(`  Historical public URLs STILL WORK until --delete-originals.`)
  }

  if (DO_DELETE) {
    // Refuse to delete anything that is not safely in the private bucket AND
    // recorded in the database. Deleting an object no row points at is how a
    // lesson becomes permanently broken.
    const inTarget = new Set()
    for (const p of MOVE_PREFIXES) for (const o of await list(TARGET, p)) inTarget.add(o)

    const rowsRes = await fetch(
      `${SB}/rest/v1/lessons?select=video_object_path,pdf_object_path,subtitle_object_path`,
      { headers: { ...H, Prefer: 'count=exact' } })
    const rows = await rowsRes.json()
    const recorded = new Set()
    for (const r of rows) for (const v of [r.video_object_path, r.pdf_object_path, r.subtitle_object_path]) {
      if (v) recorded.add(v)
    }

    const unsafe = source.filter(o => !inTarget.has(o))
    if (unsafe.length) {
      console.error(`✗ ${unsafe.length} object(s) are not in ${TARGET} yet. Run --copy first. Nothing deleted.`)
      process.exitCode = 1
      return
    }
    const unrecorded = source.filter(o => !recorded.has(o))
    if (unrecorded.length) {
      console.error(`✗ ${unrecorded.length} object(s) are not referenced by any lesson path column.`)
      console.error(`  Apply migration 042 first, or these lessons will break. Nothing deleted.`)
      console.error(`  First: ${unrecorded.slice(0, 3).join(', ')}`)
      process.exitCode = 1
      return
    }

    console.log(`  all ${source.length} object(s) verified in ${TARGET} and referenced by a lesson row`)
    let removed = 0
    for (let i = 0; i < source.length; i += 100) {
      const batch = source.slice(i, i + 100)
      const r = await fetch(`${SB}/storage/v1/object/${SOURCE}`, {
        method: 'DELETE', headers: H, body: JSON.stringify({ prefixes: batch }),
      })
      if (r.status === 200) removed += batch.length
      else console.log(`    ✗ batch ${i} → ${r.status} ${(await r.text()).slice(0, 80)}`)
    }
    const leftover = []
    for (const p of MOVE_PREFIXES) leftover.push(...await list(SOURCE, p))
    console.log(`\n  removed ${removed}; ${SOURCE} protected objects remaining: ${leftover.length}`)
    console.log(leftover.length === 0
      ? '\n✓ Historical public URLs are now dead. Re-run the verifier to prove it.'
      : '\n✗ Some objects survived — re-run.')
    if (leftover.length) process.exitCode = 1
  }
}

await main()
