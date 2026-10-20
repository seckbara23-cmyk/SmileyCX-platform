#!/usr/bin/env node
/**
 * MEDIA-INTRO-01 — course Introduction video release tool.
 *
 *   node scripts/media/intro-release.mjs plan                 (default, READ-ONLY)
 *   node scripts/media/intro-release.mjs upload   --approved
 *   node scripts/media/intro-release.mjs apply    --approved
 *   node scripts/media/intro-release.mjs verify                (READ-ONLY)
 *   node scripts/media/intro-release.mjs rollback --approved
 *
 * ── WHY A SCRIPT AND NOT THE ADMIN UI ────────────────────────────────────────
 *
 * Seven films across seven courses is seven chances to attach the wrong video to
 * the wrong course, and the Admin uploader cannot check a SHA-256 or notice that
 * a course already has an Introduction. Every operation here is derived from
 * `courses.code`, which is UNIQUE and immutable (migration 028), verified
 * against the database at run time, and recorded in a manifest with the source
 * hash — so what shipped is auditable afterwards and reversible.
 *
 * ── SAFETY MODEL ─────────────────────────────────────────────────────────────
 *
 *   • `plan` and `verify` only ever issue GET requests.
 *   • `upload`, `apply` and `rollback` refuse to run without --approved.
 *   • Idempotent: an already-uploaded object or an existing Introduction lesson
 *     is detected and skipped, so a re-run can never double-create.
 *   • The new video goes to a NEW object path. The previous object is left in
 *     place, which is what makes the media swap reversible by a single UPDATE.
 *   • No existing lesson row is modified when creating an Introduction. The new
 *     lesson takes `order_index = 0`, which sorts first without renumbering
 *     anything: `lessons.order_index` has no UNIQUE or CHECK constraint and no
 *     lesson in the catalogue currently uses 0 (measured 2026-10-20). A reindex
 *     of 3-7 instructional rows per course would be the riskier way to achieve
 *     the identical ordering.
 *   • Rollback deletes a created lesson ONLY when it has no progress rows, so a
 *     learner who has already watched the Introduction is never erased.
 *   • The manifest carries no secret and no learner data.
 */
import { readFileSync, writeFileSync, existsSync, statSync, createReadStream } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'

// ── configuration ───────────────────────────────────────────────────────────

const SOURCE_DIR = 'incoming media'
const MANIFEST   = join('docs', 'media-intro-01-manifest.json')
const BUCKET     = 'course-content'   // PRIVATE. lib/media/paths.ts PROTECTED_BUCKET
const FOLDER     = 'video'            // PROTECTED_FOLDERS

/**
 * Source of truth for the release. `code` is resolved against the database;
 * the UUIDs below are assertions, not lookups — a mismatch stops the run.
 * Hashes were measured from the delivered files (MEDIA-INTRO-01 Phase 1).
 */
const TARGETS = [
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

const LESSON_TITLE = 'Introduction'
const LESSON_SLUG  = 'introduction'
const INTRO_ORDER  = 0

// ── bootstrap ───────────────────────────────────────────────────────────────

const mode     = (process.argv[2] ?? 'plan').toLowerCase()
const approved = process.argv.includes('--approved')

const env = {}
try {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* real environment variables win below */ }

const SB  = env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const SVC = env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SB || !SVC) {
  console.error('✗ Missing Supabase configuration (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).')
  process.exit(1)
}

const MUTATING = ['upload', 'apply', 'rollback']
if (MUTATING.includes(mode) && !approved) {
  console.error(
    `\n✗ [NOT_AUTHORIZED] '${mode}' changes production and needs explicit owner approval.\n\n` +
    '  MEDIA-INTRO-01 was delivered as a plan, not an execution. Re-run with\n' +
    `  --approved only after the owner has authorized this specific action:\n\n` +
    `      node scripts/media/intro-release.mjs ${mode} --approved\n\n` +
    "  'plan' and 'verify' are read-only and need no approval.\n",
  )
  process.exit(1)
}

const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' }

async function rest(path, init = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: { ...H, ...(init.headers ?? {}) },
  })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* empty body */ }
  return { ok: r.ok, status: r.status, rows: Array.isArray(json) ? json : (json ? [json] : []), text }
}

const sha256 = path => new Promise((res, rej) => {
  const h = createHash('sha256')
  createReadStream(path).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej)
})

const readManifest = () =>
  existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { version: 1, entries: [] }

const writeManifest = m => {
  writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n', 'utf8')
  console.log(`\n  manifest → ${MANIFEST}`)
}

const ok   = (l, d = '') => console.log(`  ✓ ${l.padEnd(46)} ${d}`)
const bad  = (l, d = '') => console.log(`  ✗ ${l.padEnd(46)} ${d}`)
const info = (l, d = '') => console.log(`    · ${l.padEnd(44)} ${d}`)

// ── resolve: sources + database, with every assumption checked ─────────────

async function resolve() {
  const courses = (await rest('courses?select=id,code,slug,title,title_fr,is_published')).rows
  const modules = (await rest('modules?select=id,course_id,slug,title,order_index')).rows
  const lessons = (await rest('lessons?select=id,module_id,slug,title,order_index,video_object_path,video_source,is_preview')).rows

  const isIntro = l => {
    const s = (l.slug ?? '').toLowerCase().trim()
    return s === LESSON_SLUG || s === 'intro' || /^introduction\b/i.test((l.title ?? '').trim())
  }

  const plan = []
  const errors = []

  for (const t of TARGETS) {
    const src = join(SOURCE_DIR, t.file)
    const entry = { ...t, source: src }

    if (!existsSync(src)) { errors.push(`${t.code}: source missing — ${src}`); continue }
    entry.bytes = statSync(src).size
    entry.actualSha256 = await sha256(src)
    if (entry.actualSha256 !== t.sha256) {
      errors.push(`${t.code}: SHA-256 mismatch — refusing to ship an unverified file`)
      continue
    }

    const course = courses.find(c => c.code === t.code)
    if (!course) { errors.push(`${t.code}: no course carries this code`); continue }
    if (course.id !== t.courseId) {
      errors.push(`${t.code}: course id changed — expected ${t.courseId}, found ${course.id}`)
      continue
    }
    if (!course.is_published) errors.push(`${t.code}: course is not published`)
    entry.courseSlug = course.slug
    entry.courseTitle = course.title_fr ?? course.title

    const mods = modules.filter(m => m.course_id === course.id)
      .sort((a, b) => (a.order_index !== b.order_index
        ? a.order_index - b.order_index
        : a.id < b.id ? -1 : 1))
    if (mods.length === 0) { errors.push(`${t.code}: course has no modules`); continue }
    entry.moduleId = mods[0].id
    entry.moduleTitle = mods[0].title
    entry.moduleOrder = mods[0].order_index

    const existing = lessons.filter(l => l.module_id === entry.moduleId).filter(isIntro)
    if (existing.length > 1) {
      errors.push(`${t.code}: ${existing.length} Introduction lessons already exist — refusing`)
      continue
    }
    if (existing.length === 1) {
      entry.operation = 'REPLACE'
      entry.lessonId = existing[0].id
      entry.previousObjectPath = existing[0].video_object_path ?? null
      entry.lessonSlug = existing[0].slug
      entry.lessonOrder = existing[0].order_index
    } else {
      entry.operation = 'CREATE'
      entry.lessonId = null
      entry.previousObjectPath = null
      entry.lessonSlug = LESSON_SLUG
      entry.lessonOrder = INTRO_ORDER
      const collide = lessons.filter(l => l.module_id === entry.moduleId)
        .filter(l => l.order_index === INTRO_ORDER)
      entry.orderCollision = collide.length
      entry.slugTaken = lessons.some(l => l.module_id === entry.moduleId && l.slug === LESSON_SLUG)
      if (entry.slugTaken) errors.push(`${t.code}: slug '${LESSON_SLUG}' already used in the owning module`)
    }
    entry.siblingLessons = lessons.filter(l => l.module_id === entry.moduleId).length
    plan.push(entry)
  }

  return { plan, errors }
}

// ── plan ────────────────────────────────────────────────────────────────────

async function cmdPlan() {
  console.log('\nMEDIA-INTRO-01 — release plan (READ-ONLY)\n')
  const { plan, errors } = await resolve()

  for (const e of plan) {
    console.log(`  ${e.code}  ${e.operation}`)
    info('source', `${e.file}  ${e.bytes.toLocaleString('en-US')} B  sha256 ok`)
    info('course', `${e.courseId}  "${String(e.courseTitle).slice(0, 40)}"`)
    info('owning module', `${e.moduleId}  order=${e.moduleOrder}  lessons=${e.siblingLessons}`)
    if (e.operation === 'REPLACE') {
      info('lesson (preserved)', `${e.lessonId}  slug=${e.lessonSlug}  order=${e.lessonOrder}`)
      info('previous object', e.previousObjectPath ?? '(none)')
    } else {
      info('new lesson', `title="${LESSON_TITLE}" slug=${LESSON_SLUG} order=${INTRO_ORDER} is_preview=false`)
      info('order collisions at 0', String(e.orderCollision))
      info('existing rows modified', '0 — nothing is reindexed')
    }
  }

  console.log(`\n  ${plan.length} target(s): ` +
    `${plan.filter(p => p.operation === 'REPLACE').length} replace, ` +
    `${plan.filter(p => p.operation === 'CREATE').length} create`)

  if (errors.length) {
    console.log('\n  BLOCKING ISSUES:')
    for (const e of errors) bad(e)
  } else ok('no blocking issues', 'sources verified, mapping verified')

  const manifest = readManifest()
  const byCode = new Map(manifest.entries.map(x => [x.code, x]))
  manifest.version = 1
  manifest.slice = 'MEDIA-INTRO-01'
  manifest.bucket = BUCKET
  manifest.entries = plan.map(e => {
    const prior = byCode.get(e.code) ?? {}
    return {
      code: e.code,
      courseId: e.courseId,
      courseSlug: e.courseSlug,
      moduleId: e.moduleId,
      lessonId: e.lessonId,
      operation: e.operation,
      sourceFile: e.file,
      sourceSha256: e.actualSha256,
      sourceBytes: e.bytes,
      newObjectPath: prior.newObjectPath ?? null,
      previousObjectPath: e.previousObjectPath,
      expectedMediaSource: 'protected',
      isPreview: false,
      uploadVerified: prior.uploadVerified ?? false,
      applied: prior.applied ?? false,
      rollback: e.operation === 'REPLACE'
        ? `UPDATE lessons SET video_object_path = '${e.previousObjectPath ?? ''}' WHERE id = '${e.lessonId}'`
        : 'DELETE the created lesson only if it has zero lesson_progress rows',
    }
  })
  writeManifest(manifest)
  if (errors.length) process.exit(1)
}

// ── upload ──────────────────────────────────────────────────────────────────

async function cmdUpload() {
  console.log('\nMEDIA-INTRO-01 — upload to the PRIVATE bucket\n')
  const { plan, errors } = await resolve()
  if (errors.length) { for (const e of errors) bad(e); process.exit(1) }

  const manifest = readManifest()
  const byCode = new Map(manifest.entries.map(x => [x.code, x]))

  for (const e of plan) {
    const entry = byCode.get(e.code)
    if (!entry) { bad(e.code, 'not in the manifest — run plan first'); process.exit(1) }

    if (entry.newObjectPath && entry.uploadVerified) { ok(e.code, `already uploaded → ${entry.newObjectPath}`); continue }

    const objectPath = entry.newObjectPath
      ?? `${FOLDER}/${Date.now()}-intro-${e.code.toLowerCase().replace('-', '')}-${randomBytes(4).toString('hex')}.mp4`

    const body = readFileSync(e.source)
    const r = await fetch(`${SB}/storage/v1/object/${BUCKET}/${objectPath}`, {
      method: 'POST',
      headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'video/mp4', 'x-upsert': 'false' },
      body,
    })
    if (!r.ok) { bad(e.code, `upload failed HTTP ${r.status} ${(await r.text()).slice(0, 120)}`); process.exit(1) }

    const head = await fetch(`${SB}/storage/v1/object/info/${BUCKET}/${objectPath}`, {
      headers: { apikey: SVC, Authorization: `Bearer ${SVC}` },
    })
    const meta = head.ok ? await head.json() : null
    const sizeOk = meta && Number(meta.size ?? meta.contentLength ?? -1) === e.bytes

    entry.newObjectPath  = objectPath
    entry.uploadVerified = !!sizeOk
    ok(e.code, `${objectPath}  verified=${!!sizeOk}`)
    if (!sizeOk) bad(e.code, 'uploaded size does not match the source — investigate before apply')
  }
  writeManifest(manifest)
}

// ── apply ───────────────────────────────────────────────────────────────────

async function cmdApply() {
  console.log('\nMEDIA-INTRO-01 — attach videos to lessons\n')
  const { plan, errors } = await resolve()
  if (errors.length) { for (const e of errors) bad(e); process.exit(1) }

  const manifest = readManifest()
  const byCode = new Map(manifest.entries.map(x => [x.code, x]))

  for (const e of plan) {
    const entry = byCode.get(e.code)
    if (!entry?.newObjectPath || !entry.uploadVerified) {
      bad(e.code, 'no verified upload — run upload first'); process.exit(1)
    }

    if (e.operation === 'REPLACE') {
      if (entry.applied) { ok(e.code, 'already applied'); continue }
      const r = await rest(`lessons?id=eq.${e.lessonId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ video_object_path: entry.newObjectPath, video_source: 'protected' }),
      })
      if (!r.ok) { bad(e.code, `PATCH failed HTTP ${r.status} ${r.text.slice(0, 120)}`); process.exit(1) }
      entry.applied = true
      ok(e.code, `lesson ${e.lessonId} → ${entry.newObjectPath} (id, slug, module, progress untouched)`)
    } else {
      // Idempotency: never create a second Introduction.
      const dup = await rest(`lessons?select=id&module_id=eq.${e.moduleId}&slug=eq.${LESSON_SLUG}`)
      if (dup.rows.length > 0) {
        entry.lessonId = dup.rows[0].id
        entry.applied = true
        ok(e.code, `Introduction already exists (${entry.lessonId}) — skipped`)
        continue
      }
      const r = await rest('lessons', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          module_id: e.moduleId,
          slug: LESSON_SLUG,
          title: LESSON_TITLE,
          order_index: INTRO_ORDER,
          is_preview: false,
          video_object_path: entry.newObjectPath,
          video_source: 'protected',
        }),
      })
      if (!r.ok) { bad(e.code, `INSERT failed HTTP ${r.status} ${r.text.slice(0, 120)}`); process.exit(1) }
      entry.lessonId = r.rows[0]?.id ?? null
      entry.applied = true
      ok(e.code, `created lesson ${entry.lessonId} at order_index ${INTRO_ORDER}`)
    }
  }
  writeManifest(manifest)
}

// ── verify ──────────────────────────────────────────────────────────────────

async function cmdVerify() {
  console.log('\nMEDIA-INTRO-01 — post-release verification (READ-ONLY)\n')
  const manifest = readManifest()
  let fails = 0

  for (const entry of manifest.entries) {
    if (!entry.lessonId) { bad(entry.code, 'no lesson id recorded'); fails++; continue }
    const l = (await rest(`lessons?select=id,module_id,slug,title,order_index,video_object_path,video_source,is_preview&id=eq.${entry.lessonId}`)).rows[0]
    if (!l) { bad(entry.code, 'lesson not found'); fails++; continue }

    const checks = [
      ['object path matches manifest', l.video_object_path === entry.newObjectPath],
      ['media source is protected',    l.video_source === 'protected'],
      ['is_preview is false',          l.is_preview === false],
      ['slug is introduction',         l.slug === entry.lessonSlug || l.slug === LESSON_SLUG],
      ['owning module unchanged',      l.module_id === entry.moduleId],
    ]
    const bads = checks.filter(([, pass]) => !pass).map(([n]) => n)
    if (bads.length) { bad(entry.code, bads.join('; ')); fails += bads.length } else ok(entry.code, `lesson ${l.id}`)

    // The object must NOT be reachable without a signature.
    const pub = await fetch(`${SB}/storage/v1/object/public/${BUCKET}/${entry.newObjectPath}`, { method: 'HEAD' })
    if (pub.ok) { bad(entry.code, `PUBLIC URL IS REACHABLE (HTTP ${pub.status}) — storage is not private`); fails++ }
    else info('public URL refused', `HTTP ${pub.status}`)
  }

  // No course may end up with two Introductions.
  const all = (await rest('lessons?select=id,module_id,slug,title')).rows
  const introsPerModule = new Map()
  for (const l of all) {
    const s = (l.slug ?? '').toLowerCase()
    if (s === LESSON_SLUG || s === 'intro' || /^introduction\b/i.test(l.title ?? '')) {
      introsPerModule.set(l.module_id, (introsPerModule.get(l.module_id) ?? 0) + 1)
    }
  }
  const dupes = [...introsPerModule].filter(([, n]) => n > 1)
  if (dupes.length) { bad('duplicate Introductions', JSON.stringify(dupes)); fails += dupes.length }
  else ok('no duplicate Introduction', `${introsPerModule.size} module(s) carry exactly one`)

  console.log(`\n  ${fails === 0 ? '✓ all checks passed' : `✗ ${fails} check(s) failed`}`)
  if (fails) process.exit(1)
}

// ── rollback ────────────────────────────────────────────────────────────────

async function cmdRollback() {
  console.log('\nMEDIA-INTRO-01 — rollback\n')
  const manifest = readManifest()

  for (const entry of [...manifest.entries].reverse()) {
    if (!entry.applied) { info(entry.code, 'not applied — nothing to reverse'); continue }

    if (entry.operation === 'REPLACE') {
      const r = await rest(`lessons?id=eq.${entry.lessonId}`, {
        method: 'PATCH',
        body: JSON.stringify({ video_object_path: entry.previousObjectPath, video_source: 'protected' }),
      })
      if (!r.ok) { bad(entry.code, `restore failed HTTP ${r.status}`); continue }
      entry.applied = false
      ok(entry.code, `media reference restored → ${entry.previousObjectPath}`)
    } else {
      // Preserve learner activity: a watched Introduction is not deleted.
      const prog = await fetch(`${SB}/rest/v1/lesson_progress?select=id&lesson_id=eq.${entry.lessonId}&limit=1`,
        { headers: { ...H, Prefer: 'count=exact' } })
      const range = prog.headers.get('content-range') ?? ''
      const count = Number((/\/(\d+)$/.exec(range) ?? [])[1] ?? -1)
      if (count !== 0) {
        bad(entry.code, `KEPT — ${count} progress row(s) exist; deleting would erase learner activity`)
        continue
      }
      const r = await rest(`lessons?id=eq.${entry.lessonId}`, { method: 'DELETE' })
      if (!r.ok) { bad(entry.code, `delete failed HTTP ${r.status}`); continue }
      entry.applied = false
      entry.lessonId = null
      ok(entry.code, 'created lesson removed (had no progress)')
    }
  }
  console.log('\n  Storage objects are never deleted by rollback — the bytes stay for forensics.')
  writeManifest(manifest)
}

// ── dispatch ────────────────────────────────────────────────────────────────

const COMMANDS = { plan: cmdPlan, upload: cmdUpload, apply: cmdApply, verify: cmdVerify, rollback: cmdRollback }
const run = COMMANDS[mode]
if (!run) {
  console.error(`✗ Unknown mode '${mode}'. Use: ${Object.keys(COMMANDS).join(' | ')}`)
  process.exit(1)
}
await run()
