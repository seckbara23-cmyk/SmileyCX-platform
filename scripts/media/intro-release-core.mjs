/**
 * MEDIA-INTRO-01 release engine — the testable core.
 *
 * Every boundary is injected (`fetchImpl`, `sourceDir`, `manifestPath`,
 * `targets`, `log`), so the whole lifecycle can be driven against mocked
 * storage and database responses without a network, a child process or a
 * single production write. `intro-release.mjs` is the thin CLI that supplies
 * the production context.
 *
 * ── WHAT MEDIA-INTRO-03 CORRECTED ───────────────────────────────────────────
 *
 * D1  The manifest was written once, after the whole loop, with `process.exit`
 *     inside it. A failure on item 4 discarded the record of items 1-3 while
 *     their uploaded objects still existed in storage, so a retry uploaded
 *     them again under fresh names and orphaned the originals. Now every
 *     completed operation is checkpointed atomically, and the crash window
 *     between a remote write and the local checkpoint is closed by making the
 *     object path DETERMINISTIC: a retry computes the same path, finds the
 *     object, verifies it and adopts it. Duplicates are unreachable.
 *
 * D2  `plan` recomputed `previousObjectPath` from live data, so running it
 *     after `apply` replaced the rollback target with the newly applied path
 *     and silently turned rollback into a no-op. The baseline is now captured
 *     once and frozen; nothing can overwrite it.
 *
 * D3  An object could exist while verification failed, and the retry re-POSTed
 *     the same path with `x-upsert: false`, which storage refuses — the release
 *     could not move forward. Now an existing object is reconciled: size and
 *     content type are checked, optionally the bytes are re-hashed, and a good
 *     object is adopted rather than re-uploaded.
 *
 * D4  The manifest recorded the PLANNED operation; `apply` branched on live
 *     state. If an administrator created an Introduction in between, apply
 *     correctly updated it while the manifest still said CREATE — and rollback
 *     would then have deleted a lesson this release never created. The manifest
 *     now records what was actually executed and whether the lesson is ours,
 *     and rollback deletes only what it can prove it made.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export const BUCKET = 'course-content'
export const FOLDER = 'video'
export const LESSON_TITLE = 'Introduction'
export const LESSON_SLUG = 'introduction'
export const INTRO_ORDER = 0
export const MANIFEST_VERSION = 2

// ── the lessons write contract (MEDIA-INTRO-07) ────────────────────────────
//
// Migration 054 adds six columns to public.lessons as
// `generated always as (…) stored`. Postgres refuses to accept a value for
// any of them: `428C9 — column "x" can only be updated to DEFAULT`.
//
// MEDIA-INTRO-06's approved activation failed on its very first statement for
// exactly that reason: the REPLACE payload carried `video_source: 'protected'`.
// The write was not just rejected, it was redundant — 054's expression reads
//
//     when coalesce(video_object_path, '') <> '' then 'protected'
//
// so writing the raw object path already yields `protected`. The database is
// the authority on the derived value, and the release tool must not restate it.
//
// Listing the columns here, rather than deleting three offending lines, is the
// point: the same list is what the test harness rejects writes against, so the
// tool and its mock cannot disagree about the schema again — which is how 38
// green tests let a doomed statement reach production.
export const LESSON_GENERATED_COLUMNS = Object.freeze([
  'video_source', 'video_external_url',
  'pdf_source', 'pdf_external_url',
  'subtitle_source', 'subtitle_external_url',
])

/** Everything this release is ever allowed to write on `lessons`. */
export const LESSON_WRITABLE_COLUMNS = Object.freeze([
  'module_id', 'slug', 'title', 'order_index', 'is_preview', 'video_object_path',
])

/**
 * Refuse a payload before it reaches the network.
 *
 * Catching this locally turns a 400 from production into a loud failure in a
 * test, and keeps the allowlist narrow: `id` and `created_at` carry database
 * defaults and are deliberately absent, as is every column this release has no
 * business touching.
 */
export function assertWritablePayload(payload, where = 'lessons write') {
  const keys = Object.keys(payload ?? {})
  const generated = keys.filter(k => LESSON_GENERATED_COLUMNS.includes(k))
  if (generated.length > 0) {
    throw new Error(
      `${where}: refusing to write generated column(s) ${generated.join(', ')} — ` +
      'migration 054 derives them (Postgres 428C9). Write the raw object path instead.',
    )
  }
  const unknown = keys.filter(k => !LESSON_WRITABLE_COLUMNS.includes(k))
  if (unknown.length > 0) {
    throw new Error(`${where}: column(s) not on the release write allowlist: ${unknown.join(', ')}`)
  }
  return payload
}

/** Hash a local file. */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * The object path a source file will always occupy.
 *
 * Deterministic in (course code, content hash) — NOT in wall-clock time. This
 * is what makes a retry after a crash safe: the second run derives the same
 * path, sees the object already there and adopts it, instead of minting a new
 * name and leaving the first upload orphaned (D1).
 */
export function objectPathFor(code, sha256) {
  const slug = code.toLowerCase().replace(/[^a-z0-9]/g, '')
  return `${FOLDER}/intro-${slug}-${sha256.slice(0, 16)}.mp4`
}

const isIntroLesson = l => {
  const s = (l.slug ?? '').toLowerCase().trim()
  if (s === LESSON_SLUG || s === 'intro') return true
  return /^introduction\b/i.test((l.title ?? '').trim())
}

const byIndexThenId = (a, b) =>
  a.order_index !== b.order_index
    ? a.order_index - b.order_index
    : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// ── manifest persistence ───────────────────────────────────────────────────

export function readManifest(path) {
  if (!existsSync(path)) return { version: MANIFEST_VERSION, slice: 'MEDIA-INTRO-01', bucket: BUCKET, entries: [] }
  const m = JSON.parse(readFileSync(path, 'utf8'))
  m.entries ??= []
  return m
}

/**
 * Atomic write: a full temporary file, then one rename over the target.
 * A crash can leave the `.tmp` behind but can never leave the manifest itself
 * truncated, which is the file every retry and every rollback depends on.
 */
export function writeManifestAtomic(path, manifest) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}

// ── context ────────────────────────────────────────────────────────────────

export function createContext({
  supabaseUrl, serviceKey, fetchImpl, sourceDir, manifestPath, targets,
  log = () => {}, deepVerify = false,
}) {
  const H = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' }

  async function rest(path, init = {}) {
    const r = await fetchImpl(`${supabaseUrl}/rest/v1/${path}`, {
      ...init, headers: { ...H, ...(init.headers ?? {}) },
    })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* empty body */ }
    return {
      ok: r.ok, status: r.status, headers: r.headers,
      rows: Array.isArray(json) ? json : (json ? [json] : []),
      text,
    }
  }

  return { supabaseUrl, serviceKey, fetchImpl, sourceDir, manifestPath, targets, log, deepVerify, rest, H }
}

// ── resolution: every assumption re-checked against live data ─────────────

export async function resolve(ctx) {
  const courses = (await ctx.rest('courses?select=id,code,slug,title,title_fr,is_published')).rows
  const modules = (await ctx.rest('modules?select=id,course_id,slug,title,order_index')).rows
  const lessons = (await ctx.rest(
    'lessons?select=id,module_id,slug,title,order_index,video_object_path,video_source,is_preview')).rows

  const plan = []
  const errors = []

  for (const t of ctx.targets) {
    const src = join(ctx.sourceDir, t.file)
    const e = { ...t, source: src }

    if (!existsSync(src)) { errors.push(`${t.code}: source missing — ${src}`); continue }
    e.bytes = statSync(src).size
    e.actualSha256 = sha256File(src)
    if (e.actualSha256 !== t.sha256) {
      errors.push(`${t.code}: SHA-256 mismatch — refusing to ship an unverified file`)
      continue
    }
    e.objectPath = objectPathFor(t.code, e.actualSha256)

    const course = courses.find(c => c.code === t.code)
    if (!course) { errors.push(`${t.code}: no course carries this code`); continue }
    if (course.id !== t.courseId) {
      errors.push(`${t.code}: course id changed — expected ${t.courseId}, found ${course.id}`)
      continue
    }
    if (!course.is_published) errors.push(`${t.code}: course is not published`)
    e.courseSlug = course.slug
    e.courseTitle = course.title_fr ?? course.title

    const mods = modules.filter(m => m.course_id === course.id).sort(byIndexThenId)
    if (mods.length === 0) { errors.push(`${t.code}: course has no modules`); continue }
    e.moduleId = mods[0].id
    e.moduleTitle = mods[0].title
    e.moduleOrder = mods[0].order_index

    const existing = lessons.filter(l => l.module_id === e.moduleId).filter(isIntroLesson)
    if (existing.length > 1) {
      errors.push(`${t.code}: ${existing.length} Introduction lessons already exist — refusing`)
      continue
    }
    if (existing.length === 1) {
      e.operation = 'REPLACE'
      e.lessonId = existing[0].id
      e.livePath = existing[0].video_object_path ?? null
      e.lessonSlug = existing[0].slug
      e.lessonOrder = existing[0].order_index
    } else {
      e.operation = 'CREATE'
      e.lessonId = null
      e.livePath = null
      e.lessonSlug = LESSON_SLUG
      e.lessonOrder = INTRO_ORDER
      e.orderCollision = lessons
        .filter(l => l.module_id === e.moduleId && l.order_index === INTRO_ORDER).length
    }
    e.siblingLessons = lessons.filter(l => l.module_id === e.moduleId).length
    plan.push(e)
  }

  return { plan, errors, courses, modules, lessons }
}

/**
 * Re-read the identities for ONE entry, immediately before writing to it.
 * `resolve()` runs once per command; this closes the window between that read
 * and the write that follows several entries later.
 */
export async function revalidate(ctx, entry) {
  const c = (await ctx.rest(`courses?select=id,code,is_published&code=eq.${entry.code}`)).rows[0]
  if (!c) return { ok: false, why: `course ${entry.code} no longer exists` }
  if (c.id !== entry.courseId) return { ok: false, why: `course id for ${entry.code} changed` }

  const mods = (await ctx.rest(`modules?select=id,course_id,order_index&course_id=eq.${entry.courseId}`)).rows
  const first = [...mods].sort(byIndexThenId)[0]
  if (!first) return { ok: false, why: `course ${entry.code} has no modules` }
  if (first.id !== entry.moduleId) {
    return { ok: false, why: `first module of ${entry.code} changed (${entry.moduleId} -> ${first.id})` }
  }

  const intros = (await ctx.rest(
    `lessons?select=id,slug,title,order_index,video_object_path,video_source,is_preview&module_id=eq.${entry.moduleId}`,
  )).rows.filter(isIntroLesson)
  if (intros.length > 1) return { ok: false, why: `${entry.code} now has ${intros.length} Introduction lessons` }

  return { ok: true, course: c, module: first, intro: intros[0] ?? null }
}

// ── manifest shaping ───────────────────────────────────────────────────────

/**
 * Merge a freshly resolved plan into the manifest WITHOUT disturbing anything
 * a previous run earned: the frozen baseline, the recorded upload and the
 * executed operation. This is the whole of D2 — the only way the rollback
 * target can be lost is if this function overwrites it, so it never does.
 */
export function mergeEntry(prior, e) {
  const next = {
    code: e.code,
    courseId: e.courseId,
    courseSlug: e.courseSlug,
    moduleId: e.moduleId,
    // Frozen once recorded. After `apply` creates an Introduction, every later
    // `plan` classifies that course as a REPLACE — so recomputing this would
    // erase the original intent and with it the evidence D4 exists to keep
    // (`executed.plannedOperation` vs what actually ran).
    plannedOperation: prior?.plannedOperation ?? e.operation,
    sourceFile: e.file,
    sourceSha256: e.actualSha256,
    sourceBytes: e.bytes,
    objectPath: e.objectPath,           // deterministic — same every run
    expectedMediaSource: 'protected',
    isPreview: false,
    // ── earned state, never recomputed ──
    baseline: prior?.baseline ?? null,
    upload: prior?.upload ?? { verified: false },
    executed: prior?.executed ?? null,
  }

  // Capture the rollback baseline the FIRST time we see a lesson to replace,
  // and freeze it. After `apply`, `e.livePath` is the path we just wrote, so
  // recomputing here is exactly the bug D2 described.
  //
  // `!next.executed` is load-bearing and was found by the idempotency test: a
  // lesson this release CREATED is seen as a REPLACE candidate by every later
  // `plan`, because it now has an Introduction. Without this guard the second
  // plan would invent a baseline pointing at our own uploaded object — D2 in a
  // different costume. A baseline only ever describes media that predates us.
  if (!next.baseline && !next.executed && e.operation === 'REPLACE' && e.lessonId) {
    next.baseline = {
      captured: true,
      capturedAt: null,
      lessonId: e.lessonId,
      objectPath: e.livePath,
    }
  }
  next.lessonId = next.executed?.lessonId ?? next.baseline?.lessonId ?? e.lessonId ?? null
  return next
}

export function describeRollback(entry) {
  if (!entry.executed) return 'nothing executed — no rollback needed'
  if (entry.executed.operation === 'REPLACE') {
    return `restore lessons.video_object_path = ${entry.baseline?.objectPath ?? '(none)'} on lesson ${entry.executed.lessonId}`
  }
  return entry.executed.createdByThisRelease
    ? `delete lesson ${entry.executed.lessonId} only if it has zero lesson_progress rows`
    : `lesson ${entry.executed.lessonId} was NOT created by this release — restore media only`
}

// ── plan ───────────────────────────────────────────────────────────────────

export async function cmdPlan(ctx) {
  const { plan, errors } = await resolve(ctx)
  const manifest = readManifest(ctx.manifestPath)
  const byCode = new Map(manifest.entries.map(x => [x.code, x]))

  manifest.version = MANIFEST_VERSION
  manifest.slice = 'MEDIA-INTRO-01'
  manifest.bucket = BUCKET
  manifest.entries = plan.map(e => {
    const merged = mergeEntry(byCode.get(e.code), e)
    merged.rollback = describeRollback(merged)
    return merged
  })

  for (const e of plan) {
    const m = manifest.entries.find(x => x.code === e.code)
    ctx.log(`  ${e.code}  ${e.operation}`)
    ctx.log(`    source      ${e.file}  ${e.bytes} B  sha256 ok`)
    ctx.log(`    object path ${e.objectPath}  (deterministic)`)
    ctx.log(`    course      ${e.courseId}`)
    ctx.log(`    module      ${e.moduleId}  order=${e.moduleOrder}  lessons=${e.siblingLessons}`)
    if (m.baseline) ctx.log(`    baseline    lesson ${m.baseline.lessonId} -> ${m.baseline.objectPath ?? '(none)'} [FROZEN]`)
    if (m.executed) ctx.log(`    executed    ${m.executed.operation} on ${m.executed.lessonId} (ours=${m.executed.createdByThisRelease})`)
  }

  writeManifestAtomic(ctx.manifestPath, manifest)
  return { ok: errors.length === 0, errors, manifest, plan }
}

// ── upload ─────────────────────────────────────────────────────────────────

async function objectInfo(ctx, path) {
  const r = await ctx.fetchImpl(`${ctx.supabaseUrl}/storage/v1/object/info/${BUCKET}/${path}`, {
    headers: { apikey: ctx.serviceKey, Authorization: `Bearer ${ctx.serviceKey}` },
  })
  if (!r.ok) return null
  try { return JSON.parse(await r.text()) } catch { return null }
}

async function deepHash(ctx, path) {
  const r = await ctx.fetchImpl(`${ctx.supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
    headers: { apikey: ctx.serviceKey, Authorization: `Bearer ${ctx.serviceKey}` },
  })
  if (!r.ok) return null
  const buf = Buffer.from(await r.arrayBuffer())
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Reconcile an object that may already be there (D3).
 * Size and content type must agree with the source; with `deepVerify` the
 * stored bytes are re-hashed. A good object is adopted, never re-uploaded;
 * a bad one is reported rather than silently overwritten.
 */
async function reconcile(ctx, entry) {
  const info = await objectInfo(ctx, entry.objectPath)
  if (!info) return { state: 'absent' }

  const size = Number(info.size ?? info.contentLength ?? info.metadata?.size ?? -1)
  // MEDIA-INTRO-07: production storage reports the type as `content_type`.
  // The resolver only knew `mimetype`/`contentType`, so it always read null and
  // the check it advertises never ran. Harmless at the time — the SHA-256 is
  // strictly stronger and did run — but a verification that silently does
  // nothing is worse than none, because it is believed.
  const type = info.content_type
    ?? info.mimetype ?? info.contentType
    ?? info.metadata?.content_type ?? info.metadata?.mimetype
    ?? null

  if (size !== entry.sourceBytes) {
    return { state: 'mismatch', why: `size ${size} != source ${entry.sourceBytes}` }
  }
  if (type !== null && type !== 'video/mp4') {
    return { state: 'mismatch', why: `content type ${type} != video/mp4` }
  }

  if (ctx.deepVerify) {
    const h = await deepHash(ctx, entry.objectPath)
    if (h === null) {
      return { state: 'mismatch', why: 'deep verification requested but the object could not be read back' }
    }
    if (h !== entry.sourceSha256) return { state: 'mismatch', why: 'stored bytes hash differently' }
    return { state: 'verified', size, type, sha256: h }
  }

  // No deep hash: an unresolvable content type is the only evidence left, so it
  // may not be waved through. Either name the type or verify the bytes.
  if (type === null) {
    return {
      state: 'mismatch',
      why: 'content type unavailable and deep verification was skipped — nothing left to verify beyond size',
    }
  }
  return { state: 'verified', size, type }
}

export async function cmdUpload(ctx) {
  const { plan, errors } = await resolve(ctx)
  if (errors.length) return { ok: false, errors }

  const manifest = readManifest(ctx.manifestPath)
  const results = []

  for (const e of plan) {
    let entry = manifest.entries.find(x => x.code === e.code)
    if (!entry) { entry = mergeEntry(undefined, e); manifest.entries.push(entry) }

    if (entry.upload?.verified && entry.upload.objectPath === e.objectPath) {
      results.push({ code: e.code, state: 'already-verified' })
      ctx.log(`  = ${e.code} already uploaded and verified`)
      continue
    }

    // D1/D3: the path is deterministic, so anything already there is OURS.
    const pre = await reconcile(ctx, entry)
    if (pre.state === 'verified') {
      entry.upload = { verified: true, objectPath: e.objectPath, bytes: pre.size, adopted: true }
      entry.rollback = describeRollback(entry)
      writeManifestAtomic(ctx.manifestPath, manifest)      // checkpoint
      results.push({ code: e.code, state: 'adopted' })
      ctx.log(`  + ${e.code} existing object reconciled and adopted — no re-upload`)
      continue
    }
    if (pre.state === 'mismatch') {
      entry.upload = { verified: false, objectPath: e.objectPath, error: pre.why }
      writeManifestAtomic(ctx.manifestPath, manifest)
      results.push({ code: e.code, state: 'corrupt', why: pre.why })
      return {
        ok: false, results, manifest,
        errors: [`${e.code}: an object exists at ${e.objectPath} but does not match the source (${pre.why}). ` +
                 'Refusing to overwrite a private object. Inspect it, remove it deliberately, then retry.'],
      }
    }

    const r = await ctx.fetchImpl(`${ctx.supabaseUrl}/storage/v1/object/${BUCKET}/${e.objectPath}`, {
      method: 'POST',
      headers: {
        apikey: ctx.serviceKey, Authorization: `Bearer ${ctx.serviceKey}`,
        'Content-Type': 'video/mp4', 'x-upsert': 'false',
      },
      body: readFileSync(e.source),
    })
    if (!r.ok) {
      results.push({ code: e.code, state: 'failed', status: r.status })
      writeManifestAtomic(ctx.manifestPath, manifest)       // keep earlier progress
      return { ok: false, results, manifest, errors: [`${e.code}: upload failed HTTP ${r.status}`] }
    }

    const post = await reconcile(ctx, entry)
    entry.upload = post.state === 'verified'
      ? { verified: true, objectPath: e.objectPath, bytes: post.size }
      : { verified: false, objectPath: e.objectPath, error: post.why ?? 'verification unavailable' }
    entry.rollback = describeRollback(entry)
    writeManifestAtomic(ctx.manifestPath, manifest)         // checkpoint per entry

    results.push({ code: e.code, state: entry.upload.verified ? 'uploaded' : 'unverified' })
    ctx.log(`  ${entry.upload.verified ? '✓' : '!'} ${e.code} ${e.objectPath}`)
    if (!entry.upload.verified) {
      return {
        ok: false, results, manifest,
        errors: [`${e.code}: uploaded but could not be verified (${entry.upload.error}). ` +
                 'Re-run upload — the deterministic path lets it reconcile instead of re-uploading.'],
      }
    }
  }

  return { ok: true, results, manifest }
}

// ── apply ──────────────────────────────────────────────────────────────────

export async function cmdApply(ctx) {
  const { plan, errors } = await resolve(ctx)
  if (errors.length) return { ok: false, errors }

  const manifest = readManifest(ctx.manifestPath)
  const results = []

  for (const e of plan) {
    const entry = manifest.entries.find(x => x.code === e.code)
    if (!entry) return { ok: false, results, manifest, errors: [`${e.code}: not in the manifest — run plan first`] }
    if (!entry.upload?.verified || entry.upload.objectPath !== e.objectPath) {
      return { ok: false, results, manifest, errors: [`${e.code}: no verified upload — run upload first`] }
    }
    if (entry.executed) { results.push({ code: e.code, state: 'already-applied' }); continue }

    // Phase 6: identities re-read immediately before this write.
    const rv = await revalidate(ctx, entry)
    if (!rv.ok) {
      writeManifestAtomic(ctx.manifestPath, manifest)
      return { ok: false, results, manifest, errors: [`${e.code}: ${rv.why}`] }
    }

    if (rv.intro) {
      // D4: an Introduction exists NOW. Whether we planned CREATE or REPLACE,
      // what executes is a REPLACE, and the manifest must say so. Its current
      // media becomes the frozen baseline if we never captured one.
      if (!entry.baseline) {
        entry.baseline = {
          captured: true, capturedAt: null,
          lessonId: rv.intro.id, objectPath: rv.intro.video_object_path ?? null,
        }
      }
      // `video_source` is deliberately absent: migration 054 derives it from
      // the object path. Writing it is a 428C9, and restating it is redundant.
      const r = await ctx.rest(`lessons?id=eq.${rv.intro.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(assertWritablePayload(
          { video_object_path: e.objectPath }, `${e.code} REPLACE`,
        )),
      })
      if (!r.ok) {
        writeManifestAtomic(ctx.manifestPath, manifest)
        return { ok: false, results, manifest, errors: [`${e.code}: PATCH failed HTTP ${r.status}`] }
      }
      entry.executed = {
        operation: 'REPLACE',
        lessonId: rv.intro.id,
        createdByThisRelease: false,
        objectPath: e.objectPath,
        plannedOperation: entry.plannedOperation,
      }
      entry.lessonId = rv.intro.id
      entry.rollback = describeRollback(entry)
      writeManifestAtomic(ctx.manifestPath, manifest)
      results.push({ code: e.code, state: 'replaced', lessonId: rv.intro.id })
      ctx.log(`  ✓ ${e.code} replaced media on lesson ${rv.intro.id}`)
      continue
    }

    const r = await ctx.rest('lessons', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(assertWritablePayload({
        module_id: entry.moduleId,
        slug: LESSON_SLUG,
        title: LESSON_TITLE,
        order_index: INTRO_ORDER,
        is_preview: false,
        video_object_path: e.objectPath,
        // video_source omitted on purpose — derived by migration 054.
      }, `${e.code} CREATE`)),
    })
    if (!r.ok) {
      writeManifestAtomic(ctx.manifestPath, manifest)
      return { ok: false, results, manifest, errors: [`${e.code}: INSERT failed HTTP ${r.status} ${r.text.slice(0, 120)}`] }
    }
    const created = r.rows[0]?.id ?? null
    entry.executed = {
      operation: 'CREATE',
      lessonId: created,
      createdByThisRelease: true,
      objectPath: e.objectPath,
      plannedOperation: entry.plannedOperation,
    }
    entry.lessonId = created
    entry.rollback = describeRollback(entry)
    writeManifestAtomic(ctx.manifestPath, manifest)
    results.push({ code: e.code, state: 'created', lessonId: created })
    ctx.log(`  ✓ ${e.code} created lesson ${created}`)
  }

  return { ok: true, results, manifest }
}

// ── verify ─────────────────────────────────────────────────────────────────

export async function cmdVerify(ctx) {
  const manifest = readManifest(ctx.manifestPath)
  const checks = []
  const add = (code, name, pass, detail = '') => checks.push({ code, name, pass, detail })

  for (const entry of manifest.entries) {
    const id = entry.executed?.lessonId ?? entry.lessonId
    if (!id) { add(entry.code, 'lesson recorded', false, 'no lesson id'); continue }

    const l = (await ctx.rest(
      `lessons?select=id,module_id,slug,title,order_index,video_object_path,video_source,is_preview&id=eq.${id}`)).rows[0]
    if (!l) { add(entry.code, 'lesson exists', false); continue }

    add(entry.code, 'object path matches manifest', l.video_object_path === entry.objectPath)
    add(entry.code, 'media source is protected', l.video_source === 'protected')
    add(entry.code, 'is_preview is false', l.is_preview === false)
    add(entry.code, 'owning module unchanged', l.module_id === entry.moduleId)

    const pub = await ctx.fetchImpl(
      `${ctx.supabaseUrl}/storage/v1/object/public/${BUCKET}/${entry.objectPath}`, { method: 'HEAD' })
    add(entry.code, 'public URL refused', !pub.ok, `HTTP ${pub.status}`)
  }

  const all = (await ctx.rest('lessons?select=id,module_id,slug,title')).rows
  const per = new Map()
  for (const l of all) if (isIntroLesson(l)) per.set(l.module_id, (per.get(l.module_id) ?? 0) + 1)
  const dupes = [...per].filter(([, n]) => n > 1)
  add('ALL', 'no duplicate Introduction', dupes.length === 0, JSON.stringify(dupes))

  const failed = checks.filter(c => !c.pass)
  for (const c of checks) ctx.log(`  ${c.pass ? '✓' : '✗'} ${c.code} ${c.name} ${c.detail}`)
  return { ok: failed.length === 0, checks, failed }
}

// ── rollback ───────────────────────────────────────────────────────────────

export async function cmdRollback(ctx) {
  const manifest = readManifest(ctx.manifestPath)
  const results = []

  for (const entry of [...manifest.entries].reverse()) {
    if (!entry.executed) { results.push({ code: entry.code, state: 'nothing-to-undo' }); continue }
    const ex = entry.executed

    const live = (await ctx.rest(
      `lessons?select=id,module_id,slug,title,video_object_path&id=eq.${ex.lessonId}`)).rows[0]
    if (!live) {
      results.push({ code: entry.code, state: 'refused', why: 'lesson no longer exists' })
      continue
    }

    // Someone else has moved the media since we wrote it: we cannot tell what
    // the correct state is, so we refuse rather than guess.
    if (live.video_object_path !== ex.objectPath) {
      results.push({
        code: entry.code, state: 'refused',
        why: `lesson media changed since apply (${live.video_object_path} != ${ex.objectPath})`,
      })
      continue
    }

    if (ex.operation === 'REPLACE' || !ex.createdByThisRelease) {
      // D4: never delete a lesson we did not create — restore its media only.
      if (!entry.baseline?.captured) {
        results.push({ code: entry.code, state: 'refused', why: 'no frozen baseline to restore' })
        continue
      }
      const r = await ctx.rest(`lessons?id=eq.${ex.lessonId}`, {
        method: 'PATCH',
        body: JSON.stringify(assertWritablePayload(
          { video_object_path: entry.baseline.objectPath }, `${entry.code} ROLLBACK`,
        )),
      })
      if (!r.ok) { results.push({ code: entry.code, state: 'failed', why: `HTTP ${r.status}` }); continue }
      entry.executed = null
      entry.rollback = describeRollback(entry)
      writeManifestAtomic(ctx.manifestPath, manifest)
      results.push({ code: entry.code, state: 'restored', objectPath: entry.baseline.objectPath })
      ctx.log(`  ✓ ${entry.code} media restored to ${entry.baseline.objectPath}`)
      continue
    }

    // A lesson this release created. Learner activity outranks tidiness.
    const prog = await ctx.rest(
      `lesson_progress?select=id&lesson_id=eq.${ex.lessonId}&limit=1`, { headers: { Prefer: 'count=exact' } })
    const m = /\/(\d+)$/.exec(prog.headers?.get?.('content-range') ?? '')
    const count = m ? Number(m[1]) : (prog.rows.length > 0 ? prog.rows.length : -1)
    if (count !== 0) {
      results.push({ code: entry.code, state: 'kept', why: `${count} progress row(s) — deleting would erase learner activity` })
      ctx.log(`  · ${entry.code} KEPT — ${count} progress row(s)`)
      continue
    }

    const r = await ctx.rest(`lessons?id=eq.${ex.lessonId}`, { method: 'DELETE' })
    if (!r.ok) { results.push({ code: entry.code, state: 'failed', why: `HTTP ${r.status}` }); continue }
    entry.executed = null
    entry.lessonId = null
    entry.rollback = describeRollback(entry)
    writeManifestAtomic(ctx.manifestPath, manifest)
    results.push({ code: entry.code, state: 'deleted' })
    ctx.log(`  ✓ ${entry.code} created lesson removed (no progress)`)
  }

  return { ok: true, results, manifest }
}

export const COMMANDS = { plan: cmdPlan, upload: cmdUpload, apply: cmdApply, verify: cmdVerify, rollback: cmdRollback }
