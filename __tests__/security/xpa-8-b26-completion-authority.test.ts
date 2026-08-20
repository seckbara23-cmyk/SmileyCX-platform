// @vitest-environment node
/**
 * XPA-8 B-2.6 — who is allowed to say a lesson is complete.
 *
 * ── THE TWO DEFECTS ───────────────────────────────────────────────────────
 *
 * B-2.6 was raised as "completion is tied to a mechanism disabled by operating
 * mode": `LessonNavigation` hid the completion control whenever
 * `PLATFORM_MODE=pilot`. Real, but presentational — the mode rendered a button
 * or it did not, and no writer, policy or table has ever contained mode logic.
 *
 * The audit found the larger defect underneath. Completion had no ACCESS
 * control at all: the browser upserted `lesson_progress` with the learner's own
 * JWT and RLS enforced `user_id = auth.uid()` and nothing else. Four of six
 * production fixtures wrote successfully with `has_course_access() = false`.
 * With no assessment gating any published course, that made self-asserted
 * progress the entire certificate requirement.
 *
 * ── WHY THIS SUITE EXECUTES THE CODE RATHER THAN GREPPING IT ──────────────
 *
 * A source match proves a line exists, not that it decides anything. The A–F
 * matrix below runs `recordLessonCompletion` against a mocked access seam and a
 * mocked admin client, and asserts on whether a row was actually written. The
 * same matrix is proved against the real database by
 * `scripts/security/verify-xpa-8-b26.mjs`, which is where the RLS half is
 * checked; this file proves the application half without needing production.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripJs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank)
// Migration headers discuss the very things the policies must NOT contain
// ("no `is_published` test"), so an absence assertion has to read the SQL and
// not the prose. Length is preserved so slice offsets still line up.
const stripSql = (s: string) => s.replace(/--[^\n]*/g, blank)

// `lib/learn/completion.ts` opens with `import 'server-only'`, a Next.js
// build-time guard with no Node resolution. Stubbing it lets the real module
// load; the guard itself is asserted below.
vi.mock('server-only', () => ({}))

const LESSON  = '11111111-2222-4333-8444-555555555555'
const MODULE  = '22222222-3333-4444-8555-666666666666'
const COURSE  = '33333333-4444-4555-8666-777777777777'
const OTHER   = '44444444-5555-4666-8777-888888888888'
const LEARNER = '55555555-6666-4777-8888-999999999999'

interface Row { data: unknown; error: unknown }

const state: {
  lesson:   Row
  module:   Row
  existing: Row
  access:   { allowed: boolean; reason?: string; userId?: string; courseId?: string }
  upsertError: unknown
  upserts:  Array<Record<string, unknown>>
  audits:   Array<Record<string, unknown>>
  tables:   string[]
} = {
  lesson:   { data: { id: LESSON, module_id: MODULE }, error: null },
  module:   { data: { id: MODULE, course_id: COURSE }, error: null },
  existing: { data: null, error: null },
  access:   { allowed: true, userId: LEARNER, courseId: COURSE },
  upsertError: null,
  upserts:  [],
  audits:   [],
  tables:   [],
}

// A chainable stub shaped like the bits of postgrest-js the module touches.
const makeFrom = (table: string) => {
  state.tables.push(table)
  const result =
    table === 'lessons' ? state.lesson :
    table === 'modules' ? state.module :
    state.existing

  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.eq = () => chain
  chain.maybeSingle = async () => result
  chain.upsert = async (payload: Record<string, unknown>) => {
    state.upserts.push(payload)
    return { error: state.upsertError }
  }
  return chain
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: (t: string) => makeFrom(t) }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: LEARNER, email: 'l@x.test' } } }) },
  }),
}))
vi.mock('@/lib/auth/course-access', () => ({
  resolveCourseAccessById: async () => state.access,
}))
vi.mock('@/lib/audit/log', () => ({
  logAuditEvent: async (e: Record<string, unknown>) => { state.audits.push(e) },
}))

const { recordLessonCompletion } = await import('@/lib/learn/completion')

beforeEach(() => {
  state.lesson   = { data: { id: LESSON, module_id: MODULE }, error: null }
  state.module   = { data: { id: MODULE, course_id: COURSE }, error: null }
  state.existing = { data: null, error: null }
  state.access   = { allowed: true, userId: LEARNER, courseId: COURSE }
  state.upsertError = null
  state.upserts = []
  state.audits  = []
  state.tables  = []
})

// ═══════════════════════════════════════════════════════════════════════════
// THE A–F MATRIX — the audit's six fixtures, as executable assertions
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.6 — the A–F access matrix', () => {
  // The access seam is the single input that decides. These fixtures set it to
  // exactly what `resolveCourseAccessById` returns for each real-world case;
  // that the seam itself classifies them correctly is XPA-6B's suite and is
  // re-proved end to end against production by verify-xpa-8-b26.mjs.
  const CASES = [
    { id: 'A', label: 'entitlement + enrollment', access: { allowed: true,  userId: LEARNER }, allow: true },
    { id: 'B', label: 'entitlement, no enrollment', access: { allowed: true,  userId: LEARNER }, allow: true },
    { id: 'C', label: 'enrollment only',           access: { allowed: false, reason: 'not_entitled' }, allow: false },
    { id: 'D', label: 'expired entitlement',       access: { allowed: false, reason: 'access_ended' }, allow: false },
    { id: 'E', label: 'revoked entitlement',       access: { allowed: false, reason: 'access_ended' }, allow: false },
    { id: 'F', label: 'neither',                   access: { allowed: false, reason: 'not_entitled' }, allow: false },
  ] as const

  for (const c of CASES) {
    it(`${c.id} — ${c.label} → ${c.allow ? 'ALLOWED' : 'DENIED'}`, async () => {
      state.access = { ...c.access }
      const r = await recordLessonCompletion(LESSON, COURSE)

      expect(r.ok).toBe(c.allow)
      expect(state.upserts.length, c.allow ? 'no row was written' : 'a row was written anyway')
        .toBe(c.allow ? 1 : 0)
      if (!c.allow) expect(r.reason).toBe(c.access.reason)
    })
  }

  it('C, D, E and F are refused for an ACCESS reason, never "not found"', async () => {
    // Reporting a missing lesson for an access failure would be a lie the
    // learner cannot act on, and would hide the denial from the audit log.
    for (const reason of ['not_entitled', 'access_ended', 'account_inactive', 'email_unverified']) {
      state.access = { allowed: false, reason }
      const r = await recordLessonCompletion(LESSON, COURSE)
      expect(r.reason).toBe(reason)
      expect(r.reason).not.toBe('lesson_not_found')
    }
  })

  it('every refusal is audited, and no success is', async () => {
    state.access = { allowed: false, reason: 'not_entitled' }
    await recordLessonCompletion(LESSON, COURSE)
    expect(state.audits).toHaveLength(1)
    expect(state.audits[0]).toMatchObject({
      eventType: 'progress.completion_denied',
      outcome:   'failure',
      reason:    'not_entitled',
    })

    state.audits = []
    state.access = { allowed: true, userId: LEARNER }
    await recordLessonCompletion(LESSON, COURSE)
    expect(state.audits, 'a finished course would write ~17 rows of noise').toHaveLength(0)
  })

  it('enrollment is never consulted — it is a transcript, not a key (Q-L)', async () => {
    await recordLessonCompletion(LESSON, COURSE)
    expect(state.tables).not.toContain('enrollments')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// CROSS-USER AND CROSS-COURSE
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.6 — a caller cannot choose the subject or the course', () => {
  it('the written user_id comes from the verified session, never from input', async () => {
    await recordLessonCompletion(LESSON, COURSE)
    expect(state.upserts[0]).toMatchObject({ user_id: LEARNER, lesson_id: LESSON })
  })

  it('there is no userId parameter to forge', () => {
    // Two parameters: lessonId, expectedCourseId. A third would be the whole
    // impersonation vector, since the write runs with the service role.
    expect(recordLessonCompletion.length).toBe(2)
    const src = stripJs(read('lib/learn/completion.ts'))
    expect(src).not.toMatch(/function recordLessonCompletion\([^)]*userId/)
  })

  it('a lesson belonging to another course is refused, and nothing is written', async () => {
    const r = await recordLessonCompletion(LESSON, OTHER) // lesson lives in COURSE
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('course_mismatch')
    expect(state.upserts).toHaveLength(0)
  })

  it('the course is resolved from the LESSON, not from the claim', async () => {
    // The lesson really belongs to OTHER; the caller claims COURSE. If the
    // claim were trusted, this would be authorized against COURSE and written.
    // The reported courseId proves which one the server actually derived.
    state.module = { data: { id: MODULE, course_id: OTHER }, error: null }
    state.access = { allowed: true, userId: LEARNER }

    const r = await recordLessonCompletion(LESSON, COURSE)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('course_mismatch')
    expect(r.courseId, 'the claim was trusted over the lesson').toBe(OTHER)
    expect(state.upserts).toHaveLength(0)
  })

  it('the voice path passes no claim, and is authorized on the derived course', async () => {
    // `expectedCourseId: null` skips the match check — there is no independent
    // claim to check — but NOT the access check.
    state.module = { data: { id: MODULE, course_id: OTHER }, error: null }
    state.access = { allowed: false, reason: 'not_entitled' }

    const r = await recordLessonCompletion(LESSON, null)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('not_entitled')
    expect(state.upserts).toHaveLength(0)
  })

  it('a missing lesson or orphaned module is "not found", not a silent success', async () => {
    state.lesson = { data: null, error: null }
    expect((await recordLessonCompletion(LESSON, COURSE)).reason).toBe('lesson_not_found')

    state.lesson = { data: { id: LESSON, module_id: MODULE }, error: null }
    state.module = { data: null, error: null }
    expect((await recordLessonCompletion(LESSON, COURSE)).reason).toBe('lesson_not_found')
    expect(state.upserts).toHaveLength(0)
  })

  it('a lookup FAILURE is distinguished from a missing row', async () => {
    // The same lesson W3 taught: swallowing `error` turns a broken database
    // into a confident "no such lesson".
    state.lesson = { data: null, error: { message: 'connection reset' } }
    expect((await recordLessonCompletion(LESSON, COURSE)).reason).toBe('write_failed')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// IDEMPOTENCY
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.6 — idempotency', () => {
  it('an already-complete lesson writes nothing and reports `already`', async () => {
    state.existing = { data: { id: 'p1', is_completed: true }, error: null }
    const r = await recordLessonCompletion(LESSON, COURSE)
    expect(r).toMatchObject({ ok: true, already: true })
    expect(state.upserts, 'a replay rewrote the row').toHaveLength(0)
  })

  it('completed_at is never moved by a replay', async () => {
    // Re-watching a lesson must not silently change the date a certificate was
    // earned. The short-circuit above is what guarantees it.
    state.existing = { data: { id: 'p1', is_completed: true }, error: null }
    await recordLessonCompletion(LESSON, COURSE)
    await recordLessonCompletion(LESSON, COURSE)
    expect(state.upserts).toHaveLength(0)
  })

  it('an incomplete existing row is completed, not duplicated', async () => {
    state.existing = { data: { id: 'p1', is_completed: false }, error: null }
    const r = await recordLessonCompletion(LESSON, COURSE)
    expect(r.ok).toBe(true)
    expect(state.upserts).toHaveLength(1)
    expect(state.upserts[0]).toMatchObject({ is_completed: true })
  })

  it('the write is an upsert on the existing UNIQUE(user_id, lesson_id)', () => {
    expect(stripJs(read('lib/learn/completion.ts'))).toContain("onConflict: 'user_id,lesson_id'")
    expect(read('supabase/schema.sql')).toMatch(/UNIQUE\(user_id, lesson_id\)/)
  })

  it('nothing here can reset or downgrade progress', () => {
    const src = stripJs(read('lib/learn/completion.ts'))
    expect(src).not.toMatch(/is_completed:\s*false/)
    expect(src).not.toMatch(/\.delete\(\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// PUBLICATION IS NOT AN ACCESS AUTHORITY
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.6 — publication controls DISCOVERY, never ACCESS', () => {
  it('completion does not consult is_published', () => {
    // The audit flagged "a learner completed a lesson of a WITHDRAWN course".
    // The fix is that the ENTITLEMENT check refuses them — not a publication
    // test, which would confiscate a withdrawn course from a learner who
    // legitimately holds it (the ratified rule, migrations 035 and 037).
    expect(stripJs(read('lib/learn/completion.ts'))).not.toContain('is_published')
  })

  it('an entitled learner may still finish a withdrawn course', async () => {
    state.access = { allowed: true, userId: LEARNER }
    const r = await recordLessonCompletion(LESSON, COURSE)
    expect(r.ok).toBe(true)
    expect(state.upserts).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// MODE INDEPENDENCE — the defect B-2.6 was actually raised for
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.6 — PLATFORM_MODE is not an academic authority', () => {
  const NAV    = stripJs(read('components/lms/LessonNavigation.tsx'))
  const PLAYER = stripJs(read('app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'))

  it('the completion control no longer depends on pilot mode', () => {
    // stripJs matters: the commit quotes the removed line in a comment
    // explaining the change, and a raw match passes on the prose.
    expect(NAV, 'the PLATFORM_MODE gate on completion is back').not.toMatch(/pilotMode/)
    expect(NAV).toMatch(/canComplete/)
  })

  it('the gate is IDENTITY, and identity is what the player passes', () => {
    expect(PLAYER).toMatch(/canComplete=\{userId !== null\}/)
  })

  it('no completion writer contains mode logic', () => {
    for (const f of ['lib/learn/completion.ts', 'app/actions/progress.ts']) {
      const s = stripJs(read(f))
      expect(s, `${f} consults the operating mode`).not.toMatch(/PILOT_MODE|PLATFORM_MODE|pilotMode/)
    }
  })

  it('the "progress is saved" caption follows persistence, not mode', () => {
    expect(NAV).toMatch(/canComplete && \([\s\S]{0,220}?sauvegard/)
  })

  it('unrelated mode behaviour is left alone', () => {
    // The sidebar's pilot links, the voice block's anonymous id and the quiz
    // gate are all still mode-driven. B-2.6 changed completion, not the mode.
    expect(stripJs(read('components/lms/LessonSidebar.tsx'))).toMatch(/pilotMode/)
    expect(PLAYER).toMatch(/nextIsBlocked\s*=\s*!PILOT_MODE/)
    expect(PLAYER).toMatch(/VoicePracticeBlock[\s\S]{0,80}?pilotMode=\{PILOT_MODE\}/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE BROWSER NO LONGER WRITES
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.6 — completion is server-authoritative', () => {
  const PLAYER = stripJs(read('app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'))

  it('no client component mutates lesson_progress directly', () => {
    for (const f of [
      'app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx',
      'components/lms/LessonNavigation.tsx',
      'components/lms/LessonSidebar.tsx',
      'components/ai/VoicePracticeBlock.tsx',
    ]) {
      const s = stripJs(read(f))
      expect(s, `${f} writes lesson_progress from the browser`)
        .not.toMatch(/lesson_progress'\)[\s\S]{0,120}?\.(upsert|insert|update|delete)\(/)
    }
  })

  it('the player still READS its own progress — the record is not hidden', () => {
    expect(PLAYER).toMatch(/from\('lesson_progress'\)[\s\S]{0,60}?select/)
  })

  it('completion goes through the server action', () => {
    expect(PLAYER).toMatch(/import \{ completeLesson \} from '@\/app\/actions\/progress'/)
    expect(PLAYER).toMatch(/await completeLesson\(lesson\.id, courseId\)/)
  })

  it('the action exposes exactly one endpoint', () => {
    // Every export of a 'use server' module is callable over HTTP. A second,
    // laxer variant would be a second, laxer way in.
    const src = stripJs(read('app/actions/progress.ts'))
    expect(src).toMatch(/^'use server'/)
    const exported = [...src.matchAll(/export\s+async\s+function\s+(\w+)/g)].map(m => m[1])
    expect(exported).toEqual(['completeLesson'])
    expect(src, 'a non-function export from a use-server module')
      .not.toMatch(/export\s+(const|let|var|class)\s/)
  })

  it('the shared authority is server-only, so it cannot be imported by a client', () => {
    expect(read('lib/learn/completion.ts')).toMatch(/^import 'server-only'/m)
  })

  it('the input is validated before anything touches the database', () => {
    const src = stripJs(read('app/actions/progress.ts'))
    expect(src).toMatch(/LessonCompleteSchema\.safeParse/)
    expect(src).toMatch(/if \(!parsed\.success\) return \{ ok: false, reason: 'invalid_input' \}/)
  })

  it('a malformed payload is refused without a lookup', async () => {
    const { completeLesson } = await import('@/app/actions/progress')
    const r = await completeLesson('not-a-uuid', COURSE)
    expect(r).toEqual({ ok: false, reason: 'invalid_input' })
    expect(state.tables).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ONE WRITER, SHARED WITH VOICE
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.6 — video and voice share one authority', () => {
  const PRACTICE = stripJs(read('app/actions/ai-practice.ts'))

  it('the voice path routes through the same function', () => {
    expect(PRACTICE).toMatch(/recordLessonCompletion\(lessonId, null\)/)
  })

  it('voice no longer upserts lesson_progress on its own', () => {
    expect(PRACTICE).not.toMatch(/from\('lesson_progress'\)/)
  })

  it('voice still resolves the lesson from the SCENARIO, never client input', () => {
    const fn = PRACTICE.slice(PRACTICE.indexOf('async function markVoiceLessonComplete'))
    expect(fn).toMatch(/from\('ai_scenarios'\)[\s\S]{0,160}?select\('lesson_id'\)/)
    expect(PRACTICE).not.toMatch(/markVoiceLessonComplete\([^)]*lessonId/)
  })

  it('a refused voice completion is non-fatal — the conversation is not lost', () => {
    const fn = PRACTICE.slice(PRACTICE.indexOf('async function markVoiceLessonComplete'))
    // Window is generous because stripJs leaves the explanatory comment behind
    // as whitespace rather than removing its length.
    expect(fn).toMatch(/if \(!result\.ok\)[\s\S]{0,400}?return/)
    expect(fn).toMatch(/log\.warn/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE VIDEO PATH IS PRESERVED, AND UNGATED BY NEW PEDAGOGY
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.6 — video completion behaviour is preserved', () => {
  const PLAYER = stripJs(read('app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'))

  it('both video completion events survive', () => {
    expect(PLAYER).toContain('handleVideoEnded')
    expect(PLAYER).toContain('handleVideoTimeUpdate')
    expect(PLAYER).toMatch(/duration - currentTime <= 2/)
  })

  it('video and the manual button funnel through the SAME markComplete', () => {
    expect(PLAYER).toMatch(/onMarkComplete=\{\(\) => markComplete\(false\)\}/)
    expect(PLAYER).toMatch(/markComplete\(true\)/)  // timeupdate, auto-advance suppressed
    expect(PLAYER).toMatch(/markComplete\(false\)/) // ended
  })

  it('no watch-time threshold, DRM or anti-cheating rule was introduced', () => {
    // B-2.6 is not the phase that decides whether 80%, 90% or 100% is required.
    const src = stripJs(read('lib/learn/completion.ts'))
    expect(src).not.toMatch(/watched_seconds|watchTime|threshold|percentWatched/)
  })

  it('the auto-advance countdown still fires on completion', () => {
    expect(PLAYER).toMatch(/setJustCompleted\(true\)/)
    expect(PLAYER).toMatch(/showAutoAdvance/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// OPTIMISTIC UI MUST NOT OUTLIVE A REFUSAL
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.6 — the UI tells the truth about what was recorded', () => {
  const PLAYER = stripJs(read('app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'))

  it('a refused completion rolls the optimistic state back', () => {
    const fn = PLAYER.slice(PLAYER.indexOf('async function markComplete'))
    expect(fn).toMatch(/if \(result\.ok\) return/)
    expect(fn).toMatch(/setCompleted\(false\)/)
    expect(fn).toMatch(/setJustCompleted\(false\)/)
    expect(fn).toMatch(/updateProgress\(snapshot\)/)
    expect(fn).toMatch(/autoCompletedRef\.current = false/)
  })

  it('the learner is told, rather than left with a silently reverted tick', () => {
    expect(PLAYER).toMatch(/setCompletionError\(/)
    expect(read('app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'))
      .toMatch(/Votre accès à cette formation n’est plus actif/)
  })

  it('the notice clears when navigating to another lesson', () => {
    expect(PLAYER).toMatch(/setVoiceScenario\(null\)[\s\S]{0,80}?setCompletionError\(null\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE DATABASE BOUNDARY (migration 044) — SHAPE ONLY; APPLICATION IS OPERATOR
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.6 — migration 044 closes the direct-API path', () => {
  const M = read('supabase/migrations/044_lesson_progress_access_boundary.sql')

  it('exists and is marked as not yet applied', () => {
    expect(M).toMatch(/NOT YET APPLIED TO PRODUCTION/)
    expect(M).toMatch(/OPERATOR STEP/)
  })

  it('splits the FOR ALL policy by command', () => {
    expect(M).toMatch(/drop policy if exists "progress_own"/)
    for (const p of ['progress_select_own', 'progress_insert_own',
                     'progress_update_own', 'progress_delete_own']) {
      expect(M).toContain(p)
    }
  })

  it('gates WRITES on the access seam', () => {
    // stripSql throughout: the header explains at length what the policies do,
    // and a positive match on that prose would pass for a file whose SQL says
    // nothing of the kind.
    const sql = stripSql(M)
    for (const [from, to] of [
      ['create policy "progress_insert_own"', 'create policy "progress_update_own"'],
      ['create policy "progress_update_own"', 'create policy "progress_delete_own"'],
    ]) {
      const body = sql.slice(sql.indexOf(from), sql.indexOf(to))
      expect(body, `${from} does not consult the access seam`)
        .toMatch(/has_course_access\(public\.course_of_lesson\(lesson_id\)\)/)
      expect(body).toMatch(/user_id = auth\.uid\(\)/)
    }
  })

  it('does NOT gate READS — an expired learner keeps their transcript', () => {
    const sql = stripSql(M)
    const select = sql.slice(sql.indexOf('create policy "progress_select_own"'),
                             sql.indexOf('create policy "progress_insert_own"'))
    expect(select, 'reads were gated on access; the record must be retained')
      .not.toMatch(/has_course_access/)
    expect(M).toMatch(/sont conservés/)
  })

  it('REUSES 036\'s lesson→course helper rather than redefining it', () => {
    // Redefining it would make a progress migration capable of changing content
    // visibility: 036's lessons_visible/quizzes_visible and 038's
    // exercises_select all depend on this function.
    expect(stripSql(M), '044 redeclares course_of_lesson')
      .not.toMatch(/create or replace function public\.course_of_lesson/)
    expect(stripSql(M)).toMatch(/has_course_access\(public\.course_of_lesson\(lesson_id\)\)/)
    // …and refuses to install if the dependency is absent.
    expect(stripSql(M)).toMatch(/to_regprocedure\('public\.course_of_lesson\(uuid\)'\) is null/)
    expect(stripSql(M)).toMatch(/to_regprocedure\('public\.has_course_access\(uuid\)'\) is null/)
  })

  it('the helper it depends on is SECURITY DEFINER, so no policy recursion', () => {
    // Migration 036 had to repair 42P17 when policies queried each other.
    const src = read('supabase/migrations/036_fix_content_policy_recursion.sql')
    const fn = src.slice(src.indexOf('create or replace function public.course_of_lesson'))
    expect(fn).toMatch(/security definer/)
    expect(fn).toMatch(/set search_path = public/)
    expect(M).toMatch(/42P17|recursion/)
  })

  it('follows 038, which already gates a policy through the same pair', () => {
    expect(read('supabase/migrations/038_answer_key_protection.sql'))
      .toMatch(/has_course_access\(public\.course_of_lesson\(/)
  })

  it('carries no is_published arm', () => {
    // Matched on ONE line's worth: the ratified sentence wraps across a `--`
    // comment break in the file, so the full phrase never appears contiguously.
    expect(M).toMatch(/publication controls DISCOVERY/i)
    expect(M).toMatch(/never ACCESS/)
    const sql = stripSql(M)
    const policies = sql.slice(sql.indexOf('create policy "progress_select_own"'))
    expect(policies, 'a publication test crept into the policies').not.toMatch(/is_published/)
  })

  it('self-verifies rather than reporting a success that did not happen', () => {
    expect(M).toMatch(/raise exception/)
    expect(M).toMatch(/expected 4 lesson_progress policies/)
  })

  it('records the ordering constraint — code first, migration second', () => {
    expect(M).toMatch(/apply AFTER the application change is live/)
  })

  it('never amends an applied migration', () => {
    expect(M).toMatch(/Forward-only/i)
    // 001 still carries the original policy, untouched.
    expect(read('supabase/migrations/001_phase_a_rls_fix.sql'))
      .toMatch(/CREATE POLICY "progress_own"/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE CERTIFICATE BOUNDARY — MEASURED, NOT REDESIGNED
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.6 — the certificate gate is untouched', () => {
  const CERT = read('app/(platform)/certificate/[courseSlug]/page.tsx')

  it('still reads the same input: completed lesson_progress rows', () => {
    // XPA-8 B-2.3A moved the read into the shared eligibility resolver. The
    // INPUT is unchanged — completed lesson_progress rows — which is the whole
    // of B-2.6's interest here.
    expect(CERT).toMatch(/resolveCertificateEligibility/)
    const assess = read('lib/learn/assessment.ts')
    expect(assess).toMatch(/from\('lesson_progress'\)/)
    expect(assess).toMatch(/\.eq\('is_completed', true\)/)
  })

  it('B-2.6 changed WHO can create that input, not what the gate does with it', () => {
    // Assessment policy and certificate eligibility remain B-2.3's.
    expect(CERT).not.toContain('completeLesson')
    expect(CERT).not.toContain('recordLessonCompletion')
  })
})
