// @vitest-environment node
/**
 * MEDIA-INTRO-03 — the Introduction release tool, driven against mocks.
 *
 * MEDIA-INTRO-02's code audit found four defects in the release tooling. All
 * four were failures of RECOVERY rather than of the happy path, which is
 * exactly the class of bug a once-through manual test never sees:
 *
 *   D1  the manifest was written once, after the loop, with process.exit
 *       inside it — a failure on item 4 discarded the record of items 1-3
 *       while their uploaded objects still existed, so a retry re-uploaded
 *       them under fresh names and orphaned the originals.
 *   D2  `plan` recomputed `previousObjectPath` from live data, so running it
 *       after `apply` overwrote the rollback target with the newly applied
 *       path and silently turned rollback into a no-op.
 *   D3  an object could exist while verification failed, and the retry
 *       re-POSTed the same path with x-upsert:false, which storage refuses —
 *       the release could not move forward at all.
 *   D4  the manifest recorded the PLANNED operation while apply branched on
 *       live state, so an Introduction created by an administrator in between
 *       would be updated as a REPLACE and then DELETED by rollback.
 *
 * Every test below drives the real exported functions with an injected fetch
 * over an in-memory database and object store. No network, no child process
 * for the engine, and no production write is reachable from this file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  createContext, cmdPlan, cmdUpload, cmdApply, cmdVerify, cmdRollback,
  objectPathFor, writeManifestAtomic, readManifest,
} from '../../scripts/media/intro-release-core.mjs'

// ── the world: an in-memory PostgREST + object store ───────────────────────

const COURSE_A = '11111111-1111-4111-8111-111111111111'  // has an Introduction
const COURSE_B = '22222222-2222-4222-8222-222222222222'  // has none
const COURSE_C = '33333333-3333-4333-8333-333333333333'  // has none
const MOD_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const MOD_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const MOD_C = 'cccccccc-0000-4000-8000-000000000003'
const INTRO_A = 'dddddddd-0000-4000-8000-000000000004'
const OLD_OBJECT = 'video/legacy-original-object.mp4'

interface World {
  courses: Record<string, unknown>[]
  modules: Record<string, unknown>[]
  lessons: Record<string, unknown>[]
  progress: Record<string, unknown>[]
  storage: Map<string, { bytes: number; type: string; body: Buffer }>
  calls: string[]
  /** object path whose upload should fail */
  failUpload: string | null
  /** object path whose info lookup should fail (transient verification outage) */
  failInfo: string | null
  /** course code whose lesson INSERT should fail */
  failInsert: string | null
  /** make an upload succeed remotely but then crash before the checkpoint */
  crashAfterUpload: string | null
  nextId: number
}

function makeWorld(): World {
  return {
    courses: [
      { id: COURSE_A, code: 'T1-F1', slug: 'course-a', title: 'Course A', title_fr: null, is_published: true },
      { id: COURSE_B, code: 'T1-F2', slug: 'course-b', title: 'Course B', title_fr: null, is_published: true },
      { id: COURSE_C, code: 'T1-F3', slug: 'course-c', title: 'Course C', title_fr: null, is_published: true },
    ],
    modules: [
      { id: MOD_A, course_id: COURSE_A, slug: 'm1', title: 'A M1', order_index: 1 },
      { id: MOD_B, course_id: COURSE_B, slug: 'm1', title: 'B M1', order_index: 1 },
      { id: MOD_C, course_id: COURSE_C, slug: 'm1', title: 'C M1', order_index: 1 },
    ],
    lessons: [
      { id: INTRO_A, module_id: MOD_A, slug: 'introduction', title: 'Introduction', order_index: 1,
        video_object_path: OLD_OBJECT, video_source: 'protected', is_preview: false },
      { id: 'e0000000-0000-4000-8000-000000000011', module_id: MOD_A, slug: 'l1', title: 'Leçon 1', order_index: 2,
        video_object_path: 'video/a-l1.mp4', video_source: 'protected', is_preview: false },
      { id: 'e0000000-0000-4000-8000-000000000012', module_id: MOD_B, slug: 'l1', title: 'Leçon 1', order_index: 1,
        video_object_path: 'video/b-l1.mp4', video_source: 'protected', is_preview: false },
      { id: 'e0000000-0000-4000-8000-000000000013', module_id: MOD_C, slug: 'l1', title: 'Leçon 1', order_index: 1,
        video_object_path: 'video/c-l1.mp4', video_source: 'protected', is_preview: false },
    ],
    progress: [],
    storage: new Map(),
    calls: [],
    failUpload: null, failInfo: null, failInsert: null, crashAfterUpload: null,
    nextId: 100,
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
  arrayBuffer: async () => new ArrayBuffer(0),
})

const bin = (status: number, buf: Buffer) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => buf.toString('latin1'),
  arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
})

/** A deliberate crash, thrown from inside the engine's fetch boundary. */
class Crash extends Error {}

function makeFetch(w: World) {
  return async (url: string, init: Record<string, any> = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const u = new URL(url)
    w.calls.push(`${method} ${u.pathname}${u.search}`)

    // ── storage ──
    let m = /^\/storage\/v1\/object\/info\/[^/]+\/(.+)$/.exec(u.pathname)
    if (m) {
      const path = decodeURIComponent(m[1])
      if (w.failInfo === path) return json(500, { error: 'transient' })
      const o = w.storage.get(path)
      return o ? json(200, { size: o.bytes, mimetype: o.type }) : json(404, { error: 'not found' })
    }
    m = /^\/storage\/v1\/object\/public\/[^/]+\/(.+)$/.exec(u.pathname)
    if (m) return json(400, { error: 'Bucket is not public' })

    m = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(u.pathname)
    if (m) {
      const path = decodeURIComponent(m[2])
      if (method === 'POST') {
        if (w.failUpload === path) return json(500, { error: 'upload failed' })
        if (w.storage.has(path) && init.headers?.['x-upsert'] === 'false') {
          return json(409, { error: 'The resource already exists' })
        }
        const body: Buffer = init.body
        w.storage.set(path, { bytes: body.length, type: 'video/mp4', body })
        if (w.crashAfterUpload === path) throw new Crash(`crash after uploading ${path}`)
        return json(200, { Key: path })
      }
      const o = w.storage.get(path)
      return o ? bin(200, o.body) : json(404, { error: 'not found' })
    }

    // ── PostgREST ──
    m = /^\/rest\/v1\/([a-z_]+)$/.exec(u.pathname)
    if (!m) return json(404, { error: `unhandled ${u.pathname}` })
    const table = m[1]
    const rows: Record<string, unknown>[] =
      table === 'courses' ? w.courses :
      table === 'modules' ? w.modules :
      table === 'lessons' ? w.lessons :
      table === 'lesson_progress' ? w.progress : []

    const filters: [string, string][] = []
    for (const [k, v] of u.searchParams) {
      if (['select', 'order', 'limit', 'offset'].includes(k)) continue
      if (v.startsWith('eq.')) filters.push([k, v.slice(3)])
    }
    const match = (r: Record<string, unknown>) => filters.every(([k, v]) => String(r[k]) === v)

    if (method === 'GET') {
      const out = rows.filter(match)
      return json(200, out, { 'content-range': `0-${Math.max(out.length - 1, 0)}/${out.length}` })
    }
    if (method === 'POST') {
      const body = JSON.parse(init.body)
      const course = w.modules.find(x => x.id === body.module_id)?.course_id
      const code = w.courses.find(c => c.id === course)?.code
      if (w.failInsert === code) return json(500, { error: 'insert failed' })
      if (table === 'lessons' &&
          w.lessons.some(l => l.module_id === body.module_id && l.slug === body.slug)) {
        return json(409, { code: '23505', message: 'duplicate key value violates unique constraint' })
      }
      const row = { id: `f0000000-0000-4000-8000-${String(w.nextId++).padStart(12, '0')}`, ...body }
      rows.push(row)
      return json(201, [row])
    }
    if (method === 'PATCH') {
      const body = JSON.parse(init.body)
      const hit = rows.filter(match)
      for (const r of hit) Object.assign(r, body)
      return json(200, hit)
    }
    if (method === 'DELETE') {
      for (const r of rows.filter(match)) rows.splice(rows.indexOf(r), 1)
      return json(204, undefined)
    }
    return json(405, { error: 'method not allowed' })
  }
}

// ── fixtures on disk ───────────────────────────────────────────────────────

let dir: string
let sourceDir: string
let manifestPath: string
let targets: { code: string; file: string; courseId: string; sha256: string }[]
let w: World
let ctx: ReturnType<typeof createContext>

const FILES = [
  { code: 'T1-F1', file: 'T1_F1_Intro.mp4', courseId: COURSE_A, body: 'intro-one-contents' },
  { code: 'T1-F2', file: 'T1_F2_Intro.mp4', courseId: COURSE_B, body: 'intro-two-contents' },
  { code: 'T1-F3', file: 'T1_F3_Intro.mp4', courseId: COURSE_C, body: 'intro-three-contents' },
]

function build(overrides: Record<string, unknown> = {}) {
  w = makeWorld()
  ctx = createContext({
    supabaseUrl: 'https://fixture.supabase.co',
    serviceKey: 'fixture-service-key-not-real',
    fetchImpl: makeFetch(w) as never,
    sourceDir, manifestPath, targets,
    ...overrides,
  })
  return { w, ctx }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'media-intro-03-'))
  sourceDir = join(dir, 'incoming media')
  manifestPath = join(dir, 'manifest.json')
  require('node:fs').mkdirSync(sourceDir, { recursive: true })
  targets = FILES.map(f => {
    writeFileSync(join(sourceDir, f.file), f.body, 'utf8')
    return {
      code: f.code, file: f.file, courseId: f.courseId,
      sha256: createHash('sha256').update(Buffer.from(f.body, 'utf8')).digest('hex'),
    }
  })
  build()
})

afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const read = () => readManifest(manifestPath)
const entry = (code: string) => read().entries.find((e: Record<string, unknown>) => e.code === code)!

// ═══════════════════════════════════════════════════════════════════════════
describe('MEDIA-INTRO-03 · D1 durable manifest checkpoints', () => {
  it('a partial UPLOAD failure keeps every earlier success on disk', async () => {
    await cmdPlan(ctx)
    w.failUpload = objectPathFor('T1-F3', targets[2].sha256)

    const r = await cmdUpload(ctx)
    expect(r.ok).toBe(false)

    // The two that succeeded are recorded, not lost with the process.
    expect(entry('T1-F1').upload.verified).toBe(true)
    expect(entry('T1-F2').upload.verified).toBe(true)
    expect(entry('T1-F3').upload?.verified ?? false).toBe(false)
  })

  it('a partial APPLY failure keeps every earlier success on disk', async () => {
    await cmdPlan(ctx)
    await cmdUpload(ctx)
    w.failInsert = 'T1-F3'

    const r = await cmdApply(ctx)
    expect(r.ok).toBe(false)

    expect(entry('T1-F1').executed.operation).toBe('REPLACE')
    expect(entry('T1-F2').executed.operation).toBe('CREATE')
    expect(entry('T1-F3').executed).toBeNull()
  })

  it('the manifest is written atomically and is never left truncated', async () => {
    await cmdPlan(ctx)
    // A real crash mid-write would leave the .tmp, never a half-written target.
    writeManifestAtomic(manifestPath, { version: 2, entries: [{ code: 'X' }] })
    expect(existsSync(`${manifestPath}.tmp`)).toBe(false)
    expect(() => JSON.parse(readFileSync(manifestPath, 'utf8'))).not.toThrow()
  })

  it('a crash BETWEEN the remote upload and the checkpoint cannot create a duplicate', async () => {
    await cmdPlan(ctx)
    const path2 = objectPathFor('T1-F2', targets[1].sha256)
    w.crashAfterUpload = path2

    await expect(cmdUpload(ctx)).rejects.toThrow(/crash after uploading/)

    // The object is in storage but the manifest never heard about it.
    expect(w.storage.has(path2)).toBe(true)
    expect(entry('T1-F2').upload?.verified ?? false).toBe(false)

    // Retry: the path is deterministic, so it reconciles instead of re-uploading.
    w.crashAfterUpload = null
    const uploadsBefore = w.calls.filter(c => c.startsWith('POST /storage')).length
    const r = await cmdUpload(ctx)
    expect(r.ok).toBe(true)
    expect(r.results.find(x => x.code === 'T1-F2')!.state).toBe('adopted')

    // Exactly one object per source — no orphan, no second name.
    expect(w.storage.size).toBe(3)
    expect([...w.storage.keys()].filter(k => k.includes('t1f2'))).toHaveLength(1)
    expect(w.calls.filter(c => c === `POST /storage/v1/object/course-content/${path2}`)).toHaveLength(1)
    expect(w.calls.filter(c => c.startsWith('POST /storage')).length).toBeGreaterThanOrEqual(uploadsBefore)
  })

  it('a retry resumes from the checkpoint and does not re-upload what is done', async () => {
    await cmdPlan(ctx)
    w.failUpload = objectPathFor('T1-F3', targets[2].sha256)
    await cmdUpload(ctx)

    const firstPosts = w.calls.filter(c => c.startsWith('POST /storage')).length
    w.failUpload = null
    const r = await cmdUpload(ctx)
    expect(r.ok).toBe(true)
    expect(r.results.find(x => x.code === 'T1-F1')!.state).toBe('already-verified')
    expect(r.results.find(x => x.code === 'T1-F3')!.state).toBe('uploaded')

    // One further POST only: the retried entry. Not three.
    expect(w.calls.filter(c => c.startsWith('POST /storage')).length).toBe(firstPosts + 1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('MEDIA-INTRO-03 · D2 immutable rollback baseline', () => {
  it('plan captures the original object path for the course that already has one', async () => {
    await cmdPlan(ctx)
    expect(entry('T1-F1').baseline).toMatchObject({ captured: true, lessonId: INTRO_A, objectPath: OLD_OBJECT })
    expect(entry('T1-F2').baseline).toBeNull()
  })

  it('re-running PLAN after APPLY does not overwrite the baseline', async () => {
    await cmdPlan(ctx)
    await cmdUpload(ctx)
    await cmdApply(ctx)

    const applied = objectPathFor('T1-F1', targets[0].sha256)
    expect(w.lessons.find(l => l.id === INTRO_A)!.video_object_path).toBe(applied)

    await cmdPlan(ctx)   // the exact sequence that destroyed it before

    expect(entry('T1-F1').baseline.objectPath).toBe(OLD_OBJECT)
    expect(entry('T1-F1').baseline.objectPath).not.toBe(applied)
    expect(entry('T1-F1').executed.operation).toBe('REPLACE')
  })

  it('rollback after a re-plan restores the ORIGINAL path, not the uploaded one', async () => {
    await cmdPlan(ctx)
    await cmdUpload(ctx)
    await cmdApply(ctx)
    await cmdPlan(ctx)
    const r = await cmdRollback(ctx)

    expect(r.results.find(x => x.code === 'T1-F1')!.state).toBe('restored')
    expect(w.lessons.find(l => l.id === INTRO_A)!.video_object_path).toBe(OLD_OBJECT)
  })

  it('rollback REFUSES when the lesson media changed under it', async () => {
    await cmdPlan(ctx)
    await cmdUpload(ctx)
    await cmdApply(ctx)

    // Somebody else repointed the lesson after we applied.
    w.lessons.find(l => l.id === INTRO_A)!.video_object_path = 'video/someone-elses-choice.mp4'

    const r = await cmdRollback(ctx)
    const row = r.results.find(x => x.code === 'T1-F1')!
    expect(row.state).toBe('refused')
    expect(row.why).toMatch(/changed since apply/)
    expect(w.lessons.find(l => l.id === INTRO_A)!.video_object_path).toBe('video/someone-elses-choice.mp4')
  })

  it('storage objects are never deleted by rollback', async () => {
    await cmdPlan(ctx)
    await cmdUpload(ctx)
    await cmdApply(ctx)
    const before = w.storage.size
    await cmdRollback(ctx)
    expect(w.storage.size).toBe(before)
    expect(w.calls.some(c => c.startsWith('DELETE /storage'))).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('MEDIA-INTRO-03 · D3 recoverable upload verification', () => {
  it('a transient verification outage is recoverable on retry, without re-uploading', async () => {
    await cmdPlan(ctx)
    const p1 = objectPathFor('T1-F1', targets[0].sha256)
    w.failInfo = p1

    const first = await cmdUpload(ctx)
    expect(first.ok).toBe(false)
    expect(entry('T1-F1').upload.verified).toBe(false)
    expect(w.storage.has(p1)).toBe(true)     // the bytes DID land

    w.failInfo = null
    const second = await cmdUpload(ctx)
    expect(second.ok).toBe(true)
    expect(second.results.find(x => x.code === 'T1-F1')!.state).toBe('adopted')
    expect(entry('T1-F1').upload.verified).toBe(true)
    // One POST for that path across both runs — the old code re-POSTed and 409'd.
    expect(w.calls.filter(c => c === `POST /storage/v1/object/course-content/${p1}`)).toHaveLength(1)
  })

  it('a MISMATCHED existing object is refused, never silently overwritten', async () => {
    await cmdPlan(ctx)
    const p1 = objectPathFor('T1-F1', targets[0].sha256)
    w.storage.set(p1, { bytes: 999999, type: 'video/mp4', body: Buffer.from('wrong') })

    const r = await cmdUpload(ctx)
    expect(r.ok).toBe(false)
    expect(r.errors![0]).toMatch(/does not match the source/)
    expect(w.storage.get(p1)!.bytes).toBe(999999)        // untouched
    expect(w.calls.some(c => c === `POST /storage/v1/object/course-content/${p1}`)).toBe(false)
  })

  it('deep verification re-hashes the stored bytes', async () => {
    build({ deepVerify: true })
    await cmdPlan(ctx)
    const r = await cmdUpload(ctx)
    expect(r.ok).toBe(true)
    expect(w.calls.some(c => c.startsWith('GET /storage/v1/object/course-content/'))).toBe(true)
  })

  it('apply refuses to run on an unverified upload', async () => {
    await cmdPlan(ctx)
    const r = await cmdApply(ctx)
    expect(r.ok).toBe(false)
    expect(r.errors![0]).toMatch(/no verified upload/)
    expect(w.lessons.filter(l => l.slug === 'introduction')).toHaveLength(1)  // nothing created
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('MEDIA-INTRO-03 · D4 executed-operation authority', () => {
  it('records CREATE vs REPLACE as ACTUALLY executed', async () => {
    await cmdPlan(ctx)
    await cmdUpload(ctx)
    await cmdApply(ctx)

    expect(entry('T1-F1').plannedOperation).toBe('REPLACE')
    expect(entry('T1-F1').executed).toMatchObject({ operation: 'REPLACE', createdByThisRelease: false })
    expect(entry('T1-F2').plannedOperation).toBe('CREATE')
    expect(entry('T1-F2').executed).toMatchObject({ operation: 'CREATE', createdByThisRelease: true })
  })

  it('a CONCURRENT admin Introduction turns a planned CREATE into a recorded REPLACE', async () => {
    await cmdPlan(ctx)
    await cmdUpload(ctx)
    expect(entry('T1-F2').plannedOperation).toBe('CREATE')

    // An administrator adds one between plan and apply, with their own video.
    const adminLesson = {
      id: '99999999-0000-4000-8000-000000000099', module_id: MOD_B,
      slug: 'introduction', title: 'Introduction', order_index: 0,
      video_object_path: 'video/admin-made-this.mp4', video_source: 'protected', is_preview: false,
    }
    w.lessons.push(adminLesson)

    const r = await cmdApply(ctx)
    expect(r.ok).toBe(true)

    const e = entry('T1-F2')
    expect(e.executed.operation).toBe('REPLACE')
    expect(e.executed.createdByThisRelease).toBe(false)
    expect(e.executed.lessonId).toBe(adminLesson.id)
    expect(e.executed.plannedOperation).toBe('CREATE')      // the disagreement is recorded
    // The admin's original media is now the frozen rollback baseline.
    expect(e.baseline).toMatchObject({ captured: true, objectPath: 'video/admin-made-this.mp4' })
    // And no duplicate was created.
    expect(w.lessons.filter(l => l.module_id === MOD_B && l.slug === 'introduction')).toHaveLength(1)
  })

  it("rollback RESTORES, never deletes, an admin-created lesson", async () => {
    await cmdPlan(ctx)
    await cmdUpload(ctx)
    w.lessons.push({
      id: '99999999-0000-4000-8000-000000000099', module_id: MOD_B,
      slug: 'introduction', title: 'Introduction', order_index: 0,
      video_object_path: 'video/admin-made-this.mp4', video_source: 'protected', is_preview: false,
    })
    await cmdApply(ctx)

    const r = await cmdRollback(ctx)
    expect(r.results.find(x => x.code === 'T1-F2')!.state).toBe('restored')

    const still = w.lessons.find(l => l.id === '99999999-0000-4000-8000-000000000099')
    expect(still, 'the administrator lesson was deleted').toBeTruthy()
    expect(still!.video_object_path).toBe('video/admin-made-this.mp4')
  })

  it('rollback DELETES a lesson this release created, when it has no progress', async () => {
    await cmdPlan(ctx)
    await cmdUpload(ctx)
    await cmdApply(ctx)
    const created = entry('T1-F2').executed.lessonId

    const r = await cmdRollback(ctx)
    expect(r.results.find(x => x.code === 'T1-F2')!.state).toBe('deleted')
    expect(w.lessons.find(l => l.id === created)).toBeUndefined()
  })

  it('rollback KEEPS a created lesson that a learner has already watched', async () => {
    await cmdPlan(ctx)
    await cmdUpload(ctx)
    await cmdApply(ctx)
    const created = entry('T1-F2').executed.lessonId as string
    w.progress.push({ id: 'p1', lesson_id: created, user_id: 'u1', is_completed: true })

    const r = await cmdRollback(ctx)
    const row = r.results.find(x => x.code === 'T1-F2')!
    expect(row.state).toBe('kept')
    expect(row.why).toMatch(/progress row/)
    expect(w.lessons.find(l => l.id === created)).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('MEDIA-INTRO-03 · identity guards and idempotency', () => {
  it('identities are re-read immediately before each write', async () => {
    await cmdPlan(ctx)
    await cmdUpload(ctx)
    const before = w.calls.length
    await cmdApply(ctx)
    const perEntry = w.calls.slice(before).filter(c => c.startsWith('GET /rest/v1/courses?') && c.includes('code=eq.'))
    expect(perEntry.length).toBe(3)        // one revalidation per target
  })

  it('apply REFUSES when the owning module changed after planning', async () => {
    await cmdPlan(ctx)
    await cmdUpload(ctx)
    // A new module is inserted ahead of the one we planned against.
    w.modules.push({ id: 'ffffffff-0000-4000-8000-000000000009', course_id: COURSE_B, slug: 'm0', title: 'B M0', order_index: 0 })

    const r = await cmdApply(ctx)
    expect(r.ok).toBe(false)
    expect(r.errors![0]).toMatch(/first module of T1-F2 changed/)
    expect(w.lessons.filter(l => l.module_id === MOD_B && l.slug === 'introduction')).toHaveLength(0)
  })

  it('apply REFUSES when a course id no longer matches its code', async () => {
    await cmdPlan(ctx)
    await cmdUpload(ctx)
    w.courses.find(c => c.code === 'T1-F2')!.id = 'deadbeef-0000-4000-8000-000000000000'

    const r = await cmdApply(ctx)
    expect(r.ok).toBe(false)
    expect(r.errors!.join(' ')).toMatch(/no longer exists|changed/)
  })

  it('running the whole lifecycle TWICE changes nothing the second time', async () => {
    await cmdPlan(ctx); await cmdUpload(ctx); await cmdApply(ctx)
    const lessonsAfter = JSON.stringify(w.lessons)
    const storageAfter = [...w.storage.keys()].sort()
    const manifestAfter = readFileSync(manifestPath, 'utf8')

    await cmdPlan(ctx); await cmdUpload(ctx); await cmdApply(ctx)

    expect(JSON.stringify(w.lessons)).toBe(lessonsAfter)
    expect([...w.storage.keys()].sort()).toEqual(storageAfter)
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestAfter)
    expect(w.lessons.filter(l => l.slug === 'introduction')).toHaveLength(3)
  })

  it('verify passes after a clean apply and proves the object stays private', async () => {
    await cmdPlan(ctx); await cmdUpload(ctx); await cmdApply(ctx)
    const v = await cmdVerify(ctx)
    expect(v.ok).toBe(true)
    expect(v.checks.some(c => c.name === 'public URL refused' && c.pass)).toBe(true)
    expect(v.checks.some(c => c.name === 'is_preview is false' && c.pass)).toBe(true)
    expect(v.checks.find(c => c.name === 'no duplicate Introduction')!.pass).toBe(true)
  })

  it('every created lesson is protected, unlisted as preview, and ordered first', async () => {
    await cmdPlan(ctx); await cmdUpload(ctx); await cmdApply(ctx)
    for (const code of ['T1-F2', 'T1-F3']) {
      const id = entry(code).executed.lessonId
      const l = w.lessons.find(x => x.id === id)!
      expect(l.video_source).toBe('protected')
      expect(l.is_preview).toBe(false)
      expect(l.order_index).toBe(0)
      expect(l.slug).toBe('introduction')
      expect(String(l.video_object_path)).toMatch(/^video\/intro-/)
    }
  })

  it('no existing instructional lesson is modified by the release', async () => {
    const before = JSON.stringify(w.lessons.filter(l => l.slug === 'l1'))
    await cmdPlan(ctx); await cmdUpload(ctx); await cmdApply(ctx)
    expect(JSON.stringify(w.lessons.filter(l => l.slug === 'l1'))).toBe(before)
  })

  it('a source whose hash does not match its target is refused before any write', async () => {
    writeFileSync(join(sourceDir, 'T1_F2_Intro.mp4'), 'tampered', 'utf8')
    const r = await cmdPlan(ctx)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/SHA-256 mismatch/)
    const up = await cmdUpload(ctx)
    expect(up.ok).toBe(false)
    expect(w.storage.size).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('MEDIA-INTRO-03 · CLI write guards', () => {
  const SCRIPT = join(process.cwd(), 'scripts/media/intro-release.mjs')

  /** Run the CLI with a deliberately unreachable project so no real call can land. */
  function cli(args: string[]) {
    const base = { ...process.env }
    base.NEXT_PUBLIC_SUPABASE_URL = 'https://fixture-ref.supabase.co'
    base.SUPABASE_SERVICE_ROLE_KEY = 'fixture-service-key-not-real'
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: base, encoding: 'utf8' })
    return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') }
  }

  for (const mode of ['upload', 'apply', 'rollback']) {
    it(`${mode} without --approved exits 1 before touching anything`, () => {
      const r = cli([mode])
      expect(r.code).toBe(1)
      expect(r.out).toMatch(/NOT_AUTHORIZED/)
    })

    it(`${mode} with --approved but no --project-ref exits 1`, () => {
      const r = cli([mode, '--approved'])
      expect(r.code).toBe(1)
      expect(r.out).toMatch(/PROJECT_REF_REQUIRED/)
    })

    it(`${mode} with the WRONG --project-ref exits 1`, () => {
      const r = cli([mode, '--approved', '--project-ref=some-other-project'])
      expect(r.code).toBe(1)
      expect(r.out).toMatch(/PROJECT_REF_MISMATCH/)
      expect(r.out).toContain('fixture-ref')
    })
  }

  it('an unknown mode exits 1', () => {
    expect(cli(['destroy-everything']).code).toBe(1)
  })

  it('the guards never print the service key', () => {
    for (const args of [['upload'], ['apply', '--approved'], ['rollback', '--approved', '--project-ref=x']]) {
      expect(cli(args).out).not.toContain('fixture-service-key-not-real')
    }
  })
})
