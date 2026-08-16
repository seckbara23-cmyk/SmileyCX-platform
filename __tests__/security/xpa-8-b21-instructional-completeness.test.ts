// @vitest-environment node
/**
 * XPA-8 B-2.1 — instructional completeness of published courses.
 *
 * ── THE STANDARD, AND THE ONE IT REPLACED ─────────────────────────────────
 *
 * B-2 was tracked for weeks as "no lesson has a `content` body — 0 of 102".
 * That was true and it was not a defect: `lessons.content` is optional
 * supplemental text, conditionally rendered, never validated, absent from
 * completion logic, and unused by every course including the ones that work
 * end to end. Applied literally it condemned all six courses.
 *
 * The real standard is **an intentional instructional modality** — a video, a
 * written body, a downloadable resource, a published voice scenario, or a
 * quiz. Twelve lessons had none. Ten were withdrawn with C2-F2 (B-2B); the
 * remaining two were authored and wired here.
 *
 * ── WHAT THIS SUITE GUARDS ────────────────────────────────────────────────
 *
 * That the definition does not quietly drift back to `content != null`, that
 * the two authored lessons keep their media, and that completeness is never
 * bought by reintroducing public delivery.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const has = (rel: string) => existsSync(join(ROOT, rel))
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripJs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank)

const V = 'scripts/security/verify-xpa-8-b21.mjs'
const SPEC = 'docs/xpa-8-b21-lesson-specifications.md'

const C1F3_L4 = 'd59a1304-7d81-4bc3-aa97-ed0e2deffc22'
const C2F4_L1 = '0cb17453-71a5-4ed4-99e0-90d3f5baefe7'

// ═══════════════════════════════════════════════════════════════════════════
// THE STANDARD ITSELF
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.1 — the completeness standard', () => {
  it('the verifier exists and is wired into the security set', () => {
    expect(has(V)).toBe(true)
  })

  it('completeness is "an intentional modality", NOT content != null', () => {
    const s = stripJs(read(V))
    // Every accepted modality must be considered.
    for (const m of ['video_object_path', 'video_url', 'pdf_object_path', 'pdf_url',
                     'content', 'subtitle_object_path', 'is_published']) {
      expect(s, `${m} is not part of the modality test`).toContain(m)
    }
    // …and content must never be the sole criterion.
    expect(s, 'the standard collapsed back to content-only')
      .not.toMatch(/hasModality\s*=\s*\(l\)\s*=>\s*Boolean\(l\.content\)/)
  })

  it('the reason the old metric was wrong is recorded where the next reader looks', () => {
    expect(read(V)).toMatch(/Deliberately NOT `content IS NOT NULL`/)
  })

  it('a published voice scenario or a quiz counts as a modality', () => {
    const s = stripJs(read(V))
    expect(s).toMatch(/scenarios\.some\(/)
    expect(s).toMatch(/quizzes\.some\(/)
    // An UNPUBLISHED scenario must not count.
    expect(s).toMatch(/s\.lesson_id === l\.id && s\.is_published/)
  })

  it('only PUBLISHED courses are held to the standard', () => {
    const s = stripJs(read(V))
    expect(s).toMatch(/courses\.filter\(x => x\.is_published\)/)
    expect(s).toMatch(/ZERO placeholders across published courses/)
  })

  it('withdrawn courses are excluded explicitly, not silently', () => {
    expect(stripJs(read(V))).toMatch(/withdrawn courses \(excluded by design\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE TWO AUTHORED LESSONS
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.1 — the two retained lessons', () => {
  it('both are pinned by id, so a rename cannot silently retarget them', () => {
    const s = read(V)
    expect(s).toContain(C1F3_L4)
    expect(s).toContain(C2F4_L1)
  })

  it('each is asserted to have a private object and NO public url', () => {
    const s = stripJs(read(V))
    expect(s).toMatch(/video_object_path populated/)
    expect(s).toMatch(/private object exists/)
    expect(s).toMatch(/has NO public video_url/)
    expect(s).toMatch(/l\?\.video_url === null/)
  })

  it('the approved specification is retained in the repository', () => {
    expect(has(SPEC)).toBe(true)
    const spec = read(SPEC)
    expect(spec).toContain(C1F3_L4)
    expect(spec).toContain(C2F4_L1)
    expect(spec).toMatch(/Prioriser et organiser ses réponses/)
    expect(spec).toMatch(/Cas pratique : une réclamation complexe de bout en bout/)
  })

  it('the specification still records its five business-rule boundaries', () => {
    // These were the limits agreed at authoring time; losing them would let a
    // future edit invent an SLA or a compensation policy.
    const spec = read(SPEC)
    expect(spec).toMatch(/No documented SLA/i)
    expect(spec).toMatch(/escalation matrix or ownership policy/i)
    expect(spec).toMatch(/social-media (response )?policy/i)
    expect(spec).toMatch(/compensation/i)
    // The spec's wording is "No stated wave/passage cadence (how many channel
    // sweeps per day)" — match the word that is actually there.
    expect(spec).toMatch(/cadence/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// COMPLETENESS MUST NOT BE BOUGHT WITH PUBLIC DELIVERY
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.1 preserves the F-2 architecture', () => {
  it('delivery is asserted to be a signed PRIVATE object', () => {
    const s = stripJs(read(V))
    expect(s).toMatch(/\/object\/sign\/course-content\//)
    expect(s).toMatch(/no public URL in the redirect/)
  })

  it('the full refusal matrix is exercised', () => {
    const s = stripJs(read(V))
    for (const who of ['anonymous denied', 'authenticated unentitled denied',
                       'enrollment-only learner denied', 'EXPIRED entitlement denied',
                       'REVOKED entitlement denied']) {
      expect(s, `${who} is not verified`).toContain(who)
    }
  })

  it('the historical public URL is checked for each asset', () => {
    expect(stripJs(read(V))).toMatch(/no public historical URL serves it/)
  })

  it('completion is exercised, not modified', () => {
    const s = stripJs(read(V))
    expect(s).toContain('lesson_progress')
    // B-2.6 is out of scope: the verifier must not touch completion code.
    expect(s, 'the verifier edits completion logic').not.toMatch(/pilotMode|markComplete/)
  })

  it('B-2.1 did not alter completion — and B-2.6 later did, deliberately', () => {
    const player = read('app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx')

    // This test used to pin `if (pilotMode) return null` as proof that B-2.1
    // had left the completion gate alone. B-2.6 removed that gate on purpose,
    // so the assertion is inverted rather than deleted: the coupling must stay
    // gone. Note stripJs — the B-2.6 commit QUOTES the old line in a comment
    // explaining what replaced it, and a raw-source match happily passes on the
    // comment. Asserting the absence of code requires stripping the prose.
    const nav = stripJs(read('components/lms/LessonNavigation.tsx'))
    expect(nav, 'the PLATFORM_MODE gate on completion is back').not.toMatch(/pilotMode/)
    expect(nav).toMatch(/canComplete/)

    // What B-2.1 actually owned — the video-led completion path — is untouched.
    expect(player).toContain('handleVideoEnded')
    expect(player).toContain('handleVideoTimeUpdate')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// NOTHING ELSE MOVED
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.1 stayed in its lane', () => {
  it('no migration was added for B-2.1', () => {
    expect(has('supabase/migrations/044_b21_lesson_media.sql')).toBe(false)
  })

  it('the media route and storage seam are unchanged', () => {
    const route = stripJs(read('app/api/media/lesson/[lessonId]/[kind]/route.ts'))
    expect(route).toContain('resolveCourseAccessById')
    expect(route).not.toContain('is_published')
    expect(stripJs(read('lib/media/storage.ts'))).toContain('SIGNED_URL_TTL_SECONDS')
  })

  it('B-2B publication safety is intact', () => {
    expect(read('app/(public)/courses/page.tsx')).toMatch(/export const revalidate = \d+/)
  })

  it('F-1 verifier still asserts the preview invariant', () => {
    expect(read('scripts/security/verify-xpa-6a.mjs'))
      .toContain('no course is flagged preview WHOLESALE')
  })
})
