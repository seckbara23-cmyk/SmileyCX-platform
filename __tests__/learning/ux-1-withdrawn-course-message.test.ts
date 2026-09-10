// @vitest-environment node
/**
 * UX-1 — a withdrawn / unavailable formation must not be reported as a missing
 * lesson.
 *
 * Marième's correction: a learner reaching a formation that is not available
 * was told
 *
 *     "Leçon introuvable."
 *
 * which is wrong twice over. It blames the lesson for a course-level condition,
 * and it reads as a broken link rather than an unavailable formation.
 *
 * ── WHY THAT MESSAGE WAS ALWAYS THE WRONG ONE ────────────────────────────────
 *
 * `resolveLesson()` in the player never fails to find a lesson when the course
 * has one: an unknown lessonId falls back to the module's first lesson, and an
 * unknown moduleId falls back to the first module that has lessons. So the
 * `!lesson` branch is NOT reachable by a bad URL. It is reached only when NO
 * lesson could be read at all — a withdrawn course whose row RLS hides, a
 * module/lesson read that returned nothing, or a course with no lessons yet.
 *
 * Every one of those is "this formation is not available right now".
 *
 * ── WHY WITHDRAWN AND NONEXISTENT SHARE ONE MESSAGE ──────────────────────────
 *
 * `courses_public_select` (migration 001) is
 *
 *     USING (is_published = true OR is_platform_admin())
 *
 * so a withdrawn course is invisible to every learner, exactly like a slug that
 * never existed. Distinguishing them in the UI would report publication state to
 * someone the database has decided may not see it. They are deliberately
 * indistinguishable, and one honest message covers both.
 *
 * ── WHAT THIS SUITE PROVES BY READING SOURCE, AND WHY ────────────────────────
 *
 * The lesson player is a client component and `resolveLesson` is a closure
 * inside it. A vitest run has no DOM, so the player's assertions read source and
 * say so. `denialMessage` and `resolveCourseAccess` are ordinary functions and
 * are tested BEHAVIOURALLY against the real implementations.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

/** Blank out comments while preserving offsets, so a comment can never satisfy its own test. */
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripComments = (s: string) =>
  s
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank) // JSX {/* ... */}
    .replace(/\/\*[\s\S]*?\*\//g, blank)           // /* ... */
    .replace(/\/\/[^\n]*/g, blank)                 // // ...

/**
 * The player's `!lesson` branch, whitespace-normalised.
 *
 * Comments are blanked to spaces (offsets preserved), so the branch is sliced to
 * the end of its block rather than to a fixed width — otherwise a long
 * explanatory comment inside the branch would push the rendered JSX out of view.
 */
const unavailableBranch = (src: string) => {
  const start = src.indexOf('if (!lesson)')
  const rest = src.slice(start)
  const end = rest.indexOf('\n  }')
  return rest.slice(0, end === -1 ? 2000 : end).replace(/\s+/g, ' ')
}

const PLAYER = 'app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'
const LAYOUT = 'app/(learn)/learn/[courseSlug]/layout.tsx'
const ACCESS = 'lib/auth/course-access.ts'

/** The owner-approved learner-facing wording. Changing it is a product decision. */
const APPROVED = 'Cette formation est temporairement indisponible.'

// ── supabase stub, for the behavioural half ──────────────────────────────────

interface Fixture { course?: unknown; user?: unknown; access?: unknown }
let fixture: Fixture = {}

function makeClient() {
  const build = (table: string) => {
    const rowsFor = () => {
      if (table === 'courses')          return fixture.course ?? null
      if (table === 'my_course_access') return fixture.access ?? null
      if (table === 'profiles')         return { platform_role: 'learner', account_status: 'active' }
      return null
    }
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit']) chain[m] = () => chain
    chain.maybeSingle = async () => ({ data: rowsFor(), error: null })
    chain.single      = async () => ({ data: rowsFor(), error: null })
    return chain
  }
  return {
    from: (table: string) => build(table),
    auth: { getUser: async () => ({ data: { user: fixture.user ?? null } }) },
  }
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => makeClient() }))

beforeEach(() => { fixture = {} })

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE NAMED REGRESSION — must never be deleted or renamed
// ═══════════════════════════════════════════════════════════════════════════

describe('UX-1 — an unavailable formation says so', () => {
  it('UX-1: the player no longer reports a course-level condition as a missing lesson', () => {
    const src = stripComments(read(PLAYER))
    expect(src).not.toMatch(/Leçon introuvable/)
    expect(src).toContain(APPROVED)
  })

  it('UX-1: the approved wording is what the !lesson branch actually renders', () => {
    const src = stripComments(read(PLAYER))
    // Anchor on the branch itself, so moving the string elsewhere in the file
    // does not satisfy this test.
    expect(unavailableBranch(src)).toContain(APPROVED)
  })

  it('UX-1: the access seam gives the same wording when the course row is unreadable', async () => {
    const { denialMessage } = await import('@/lib/auth/course-access')
    expect(denialMessage('course_not_found').body).toBe(APPROVED)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. A WITHDRAWN COURSE REACHES THAT MESSAGE — behavioural
// ═══════════════════════════════════════════════════════════════════════════

describe('UX-1 — withdrawn formation classification', () => {
  it('a withdrawn course (row hidden by RLS) resolves to course_not_found', async () => {
    const { resolveCourseAccess } = await import('@/lib/auth/course-access')
    // Withdrawn: courses_public_select hides the row, so the select returns null
    // exactly as it does for a slug that never existed.
    fixture = { course: null, user: { id: 'u1', email_confirmed_at: '2026-01-01' } }
    const access = await resolveCourseAccess('developper-une-culture-client')
    expect(access.allowed).toBe(false)
    expect(access.reason).toBe('course_not_found')
  })

  it('and that reason renders the approved message, not a not-found message', async () => {
    const { denialMessage } = await import('@/lib/auth/course-access')
    const { title, body } = denialMessage('course_not_found')
    expect(body).toBe(APPROVED)
    expect(body).not.toMatch(/introuvable/)
    expect(title).not.toMatch(/introuvable/)
  })

  it('the message does not claim the formation is gone permanently', async () => {
    const { denialMessage } = await import('@/lib/auth/course-access')
    const { body } = denialMessage('course_not_found')
    expect(body).toMatch(/temporairement/)
    expect(body).not.toMatch(/n’existe pas|n'existe pas|supprimé/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. A GENUINELY INVALID LESSON IS NOT MISCLASSIFIED
// ═══════════════════════════════════════════════════════════════════════════

describe('UX-1 — an invalid lesson URL is not reported as an unavailable formation', () => {
  it('an exact lessonId match still wins before any fallback', () => {
    const src = stripComments(read(PLAYER))
    const fn = src.slice(src.indexOf('function resolveLesson'))
    const body = fn.slice(0, fn.indexOf('\n  }'))
    const exactMatch = body.indexOf('les.id === lessonId')
    const fallback   = body.indexOf('firstWithLesson')
    expect(exactMatch).toBeGreaterThan(-1)
    expect(fallback).toBeGreaterThan(-1)
    // The exact match must be attempted FIRST; otherwise every deep link would
    // silently land on lesson one.
    expect(exactMatch).toBeLessThan(fallback)
  })

  it('an unknown lessonId falls back to a real lesson rather than the unavailable branch', () => {
    const src = stripComments(read(PLAYER))
    const fn = src.slice(src.indexOf('function resolveLesson'))
    // The module-level fallback: unknown lesson inside a known module.
    expect(fn.slice(0, 900)).toContain('if (mod.lessons[0])')
  })

  it('an empty leading module does not make a populated course look unavailable', () => {
    const src = stripComments(read(PLAYER))
    const fn = src.slice(src.indexOf('function resolveLesson'))
    // Must SCAN for a module that has lessons, not index blindly into the first.
    expect(fn).toMatch(/sorted\.find\(\s*m\s*=>\s*m\.lessons\.length\s*>\s*0\s*\)/)
    expect(fn.slice(0, 1200)).not.toMatch(/setLesson\(sorted\[0\]\.lessons\[0\]\)/)
  })

  it('resolveLesson is total over any non-empty course: the fallback covers every module', () => {
    // A faithful reading of the shipped control flow: exact match -> module
    // first lesson -> first module that has one. The property that matters is
    // that a course with ANY lesson always yields a lesson.
    const src = stripComments(read(PLAYER))
    const fn = src.slice(src.indexOf('function resolveLesson'))
    const guarded = /const firstWithLesson = sorted\.find/.test(fn)
      && /if \(firstWithLesson\)/.test(fn)
    expect(guarded).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. NOTHING PROTECTED LEAKS THROUGH THE UNAVAILABLE STATE
// ═══════════════════════════════════════════════════════════════════════════

describe('UX-1 — the unavailable state exposes nothing', () => {
  it('the !lesson branch renders only the message and a public link', () => {
    const src = stripComments(read(PLAYER))
    const branch = unavailableBranch(src)
    // No course metadata, no media, no answer keys, no entitlement detail.
    for (const forbidden of [
      'lesson.title', 'lesson.content', 'videoSrc', 'pdfSrc', 'subtitle',
      'video_object_path', 'pdf_object_path', 'correct', 'answer',
      'has_access', 'entitlement', 'is_published', 'code',
    ]) {
      expect(branch).not.toContain(forbidden)
    }
    // The only navigation offered is the public catalogue.
    expect(branch).toContain('href="/courses"')
  })

  it('the message itself carries no course identity or internal code', async () => {
    const { denialMessage } = await import('@/lib/auth/course-access')
    const { title, body } = denialMessage('course_not_found')
    expect(`${title} ${body}`).not.toMatch(/C\d-F\d|PM-|SEC-|slug|id/i)
  })

  it('UX-1 changed copy only — the access decision is untouched', () => {
    const src = stripComments(read(ACCESS))
    // has_course_access() remains the seam; no publication arm was introduced
    // into the TypeScript mirror, and no check was removed.
    expect(src).toContain("from('my_course_access')")
    expect(src).toContain("reason: 'not_authenticated'")
    expect(src).toContain("reason: 'email_unverified'")
    expect(src).toContain("reason: 'account_inactive'")
    expect(src).toContain("data?.access_ended ? 'access_ended' : 'not_entitled'")
    expect(src).not.toMatch(/is_published/)
  })

  it('the layout still gates every learning route on resolveCourseAccess', () => {
    const src = stripComments(read(LAYOUT))
    expect(src).toContain('resolveCourseAccess(params.courseSlug)')
    expect(src).toContain('if (access.allowed) return <>{children}</>')
    expect(src).toContain("access.reason === 'not_authenticated'")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE NORMAL JOURNEY IS UNCHANGED
// ═══════════════════════════════════════════════════════════════════════════

describe('UX-1 — published-course learner journey unchanged', () => {
  it('an entitled learner on a readable course is still allowed', async () => {
    const { resolveCourseAccess } = await import('@/lib/auth/course-access')
    fixture = {
      course: { id: 'course-1' },
      user:   { id: 'u1', email_confirmed_at: '2026-01-01' },
      access: { has_access: true, access_ended: false },
    }
    const access = await resolveCourseAccess('les-fondamentaux-de-l-experience-client')
    expect(access.allowed).toBe(true)
    expect(access.reason).toBeUndefined()
    expect(access.courseId).toBe('course-1')
  })

  it('every other denial keeps its own distinct message — copy was not blanket-changed', async () => {
    const { denialMessage } = await import('@/lib/auth/course-access')
    const reasons = [
      'not_authenticated', 'email_unverified', 'account_inactive',
      'access_ended', 'not_entitled',
    ] as const
    for (const r of reasons) {
      expect(denialMessage(r).body).not.toBe(APPROVED)
      expect(denialMessage(r).body.length).toBeGreaterThan(0)
    }
    // All six messages remain distinct from one another.
    const bodies = [...reasons, 'course_not_found' as const].map(r => denialMessage(r).body)
    expect(new Set(bodies).size).toBe(bodies.length)
  })

  it('an ended access is still told its access ended, not that the course is unavailable', async () => {
    const { denialMessage } = await import('@/lib/auth/course-access')
    expect(denialMessage('access_ended').body).toMatch(/accès/)
    expect(denialMessage('access_ended').body).not.toBe(APPROVED)
  })

  it('the player still renders the loading state before deciding anything', () => {
    const src = stripComments(read(PLAYER))
    const loadingAt = src.indexOf('if (loading)')
    const lessonAt  = src.indexOf('if (!lesson)')
    expect(loadingAt).toBeGreaterThan(-1)
    // Loading must be checked FIRST, or a slow read would flash "unavailable".
    expect(loadingAt).toBeLessThan(lessonAt)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. NO MIGRATION, NO ACCESS CHANGE
// ═══════════════════════════════════════════════════════════════════════════

describe('UX-1 — release invariants', () => {
  it('is a presentation-only change: no migration is introduced', () => {
    const { readdirSync } = require('fs') as typeof import('fs')
    const migrations = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql'))
    expect(migrations.length).toBe(50)
    // 050 stays reserved for the withdrawal-contract RLS phase; UX-1 does not take it.
    expect(migrations.some(f => f.startsWith('050_'))).toBe(false)
  })
})
