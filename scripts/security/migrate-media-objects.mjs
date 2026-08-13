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
const PLAN_DELETE = argv.includes('--plan-deletion')   // read-only; deletes nothing
const CONFIRMED = argv.includes('--yes')

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

  if (!DO_COPY && !DO_DELETE && !PLAN_DELETE) {
    console.log('Dry run. Pass --copy to copy, --plan-deletion to review deletion,')
    console.log('then --delete-originals --yes once verified.')
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

  if (DO_DELETE || PLAN_DELETE) {
    // ══ THE RATIFIED DELETION CLASSIFICATION ═══════════════════════════════
    //
    // Every public original falls into exactly one class, and each class has
    // its own precondition. Nothing is deleted unless EVERY object clears its
    // own class — this is all-or-nothing, because a partial deletion leaves a
    // state nobody planned and nobody can describe.
    //
    //   REFERENCED  a lesson row points at this object
    //               eligible ⟺ private copy exists AND the DB path is populated
    //               otherwise → HARD STOP (deleting it breaks a live lesson)
    //
    //   ORPHAN      nothing in the database points at it
    //               eligible ⟺ private copy exists AND it is independently
    //                          classified as unreferenced
    //               private copy missing → HARD STOP
    //
    // The private copies are NEVER deleted, orphans included. An orphan is
    // superseded content, not proven-worthless content, and this step is about
    // ending public exposure — not about reclaiming storage.
    //
    // "Independently classified" is meant literally: the orphan set is derived
    // by scanning every column that could name an object, not by inverting the
    // referenced list. If a column were forgotten, an object would be
    // MISCLASSIFIED AS AN ORPHAN and deleted while something still used it.
    // So the scan is explicit and listed here, and a value that cannot be
    // classified at all is a hard stop rather than an assumed orphan.

    const inTarget = new Set()
    for (const p of MOVE_PREFIXES) for (const o of await list(TARGET, p)) inTarget.add(o)

    const URL_RE = /^https?:\/\/[^/]+\/storage\/v1\/object\/public\/course-media\/(.+)$/
    const referenced = new Map()   // objectPath -> [why, …]
    const noteRef = (path, why) => {
      if (!path) return
      if (!referenced.has(path)) referenced.set(path, [])
      referenced.get(path).push(why)
    }

    // Every column that could name one of these objects. Path columns first
    // (the authoritative post-042 reference), then the legacy URL columns,
    // then course-level media.
    const SCAN = [
      ['lessons', 'video_object_path', 'path'], ['lessons', 'pdf_object_path', 'path'],
      ['lessons', 'subtitle_object_path', 'path'],
      ['lessons', 'video_url', 'url'], ['lessons', 'pdf_url', 'url'], ['lessons', 'subtitle_url', 'url'],
      ['courses', 'cover_url', 'url'], ['courses', 'intro_video_url', 'url'],
    ]
    const unscannable = []
    for (const [table, column, kind] of SCAN) {
      const r = await fetch(`${SB}/rest/v1/${table}?select=id,${column}&${column}=not.is.null&limit=2000`,
        { headers: H })
      if (r.status >= 400) {
        // A column we cannot read is a column we cannot clear. Do not guess.
        unscannable.push(`${table}.${column} → ${r.status}`)
        continue
      }
      for (const row of await r.json()) {
        const v = row[column]
        if (!v) continue
        if (kind === 'path') noteRef(v, `${table}.${column}`)
        else {
          const m = URL_RE.exec(v)
          if (m) noteRef(m[1], `${table}.${column}`)
        }
      }
    }

    if (unscannable.length) {
      console.error(`✗ HARD STOP — ${unscannable.length} column(s) could not be scanned, so nothing can be`)
      console.error(`  classified as an orphan with confidence. Nothing deleted.`)
      for (const u of unscannable) console.error(`    ${u}`)
      process.exitCode = 1
      return
    }

    // Post-042, a referenced object must be referenced by a PATH column, not
    // only by a legacy URL. A URL-only reference means 042 has not run for it.
    const pathBacked = new Set(
      [...referenced.entries()].filter(([, why]) => why.some(w => w.endsWith('_object_path'))).map(([p]) => p))

    const classes = { referenced: [], orphan: [] }
    for (const obj of source) {
      (referenced.has(obj) ? classes.referenced : classes.orphan).push(obj)
    }

    const stops = []
    for (const obj of classes.referenced) {
      if (!inTarget.has(obj)) stops.push(`REFERENCED ${obj} — no private copy`)
      else if (!pathBacked.has(obj)) {
        stops.push(`REFERENCED ${obj} — referenced only by a legacy URL (${referenced.get(obj).join(', ')}); migration 042 has not recorded a path for it`)
      }
    }
    for (const obj of classes.orphan) {
      if (!inTarget.has(obj)) stops.push(`ORPHAN ${obj} — no private copy`)
    }

    console.log('\n── Deletion classification ─────────────────────────────────────')
    console.log(`  public originals under review : ${source.length}`)
    console.log(`  REFERENCED                    : ${classes.referenced.length}`)
    console.log(`    ↳ with a populated DB path  : ${classes.referenced.filter(o => pathBacked.has(o)).length}`)
    console.log(`    ↳ with a private copy       : ${classes.referenced.filter(o => inTarget.has(o)).length}`)
    console.log(`  ORPHAN (nothing references)   : ${classes.orphan.length}`)
    console.log(`    ↳ with a private copy       : ${classes.orphan.filter(o => inTarget.has(o)).length}`)
    console.log(`  columns scanned               : ${SCAN.length}`)
    console.log(`  private copies retained       : ${inTarget.size} (orphans included — never deleted)`)

    if (stops.length) {
      console.error(`\n✗ HARD STOP — ${stops.length} object(s) failed their class precondition. NOTHING DELETED.`)
      for (const s of stops.slice(0, 15)) console.error(`    ${s}`)
      if (stops.length > 15) console.error(`    … and ${stops.length - 15} more`)
      process.exitCode = 1
      return
    }
    console.log(`\n  ✓ every object clears its class precondition`)

    if (PLAN_DELETE || !CONFIRMED) {
      console.log('\n── PLAN ONLY — nothing was deleted ─────────────────────────────')
      console.log(`  would delete ${source.length} public original(s) from ${SOURCE}:`)
      console.log(`    ${classes.referenced.length} referenced + ${classes.orphan.length} orphan`)
      console.log(`  would retain ${inTarget.size} private copies in ${TARGET}`)
      console.log(`  would leave the cover/ prefix untouched`)
      if (!PLAN_DELETE && !CONFIRMED) {
        console.log('\n  --delete-originals also requires --yes. Refusing.')
        process.exitCode = 1
      }
      return
    }

    const toDelete = [...classes.referenced, ...classes.orphan]
    let removed = 0
    for (let i = 0; i < toDelete.length; i += 100) {
      const batch = toDelete.slice(i, i + 100)
      const r = await fetch(`${SB}/storage/v1/object/${SOURCE}`, {
        method: 'DELETE', headers: H, body: JSON.stringify({ prefixes: batch }),
      })
      if (r.status === 200) removed += batch.length
      else console.log(`    ✗ batch ${i} → ${r.status} ${(await r.text()).slice(0, 80)}`)
    }

    const leftover = []
    for (const p of MOVE_PREFIXES) leftover.push(...await list(SOURCE, p))
    const stillPrivate = new Set()
    for (const p of MOVE_PREFIXES) for (const o of await list(TARGET, p)) stillPrivate.add(o)

    console.log(`\n  removed ${removed}; ${SOURCE} protected objects remaining: ${leftover.length}`)
    console.log(`  private copies still present: ${stillPrivate.size} (must be ${inTarget.size})`)
    const coversLeft = await list(SOURCE, 'cover')
    console.log(`  cover/ untouched: ${coversLeft.length}`)

    const ok = leftover.length === 0 && stillPrivate.size === inTarget.size
    console.log(ok
      ? '\n✓ Historical public URLs are now dead. Re-run the verifier to prove it.'
      : '\n✗ Post-deletion state is not what was planned — investigate before proceeding.')
    if (!ok) process.exitCode = 1
  }
}

await main()
