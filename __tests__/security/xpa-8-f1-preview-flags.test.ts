// @vitest-environment node
/**
 * XPA-8 F-1 — the blanket preview flags on C2-F2.
 *
 * ── WHAT WAS FOUND ────────────────────────────────────────────────────────
 *
 * All 20 lessons of `mesurer-l-experience-client` carried is_preview = true,
 * and every other course carried zero. The audit ruled out every mechanical
 * cause — the column defaults false, no seed or bulk script writes it, and
 * migration 035's guard correctly declined to re-fire — and established that
 * they were authored in the admin editor: one 21-minute session, video upload
 * timestamps matching created_at, 19/20 slugs matching autoSlug(title).
 *
 * The checkbox is correctly labelled, defaults unchecked, and the form
 * unmounts between lessons, so each flag was an individual deliberate tick.
 * Deliberate, but the PURPOSE could not be proven — so the disposition was a
 * product ruling, not an engineering deduction.
 *
 * ── WHY THEY WERE CLEARED ─────────────────────────────────────────────────
 *
 * They bought nothing and risked something:
 *
 *   • no UX depended on them — the catalogue lists every lesson of every
 *     course from public_course_lessons regardless, and the GRATUIT badge is
 *     `is_preview || FREE_ACCESS_MODE`, which in pilot mode is true for all
 *     six courses (measured: 0 lock icons anywhere)
 *   • they delivered no sample — no lesson has a body, the media route
 *     refuses an unentitled caller, and the learn page bounces anonymous
 *   • `lessons.content` IS anon-readable on a preview row, so the moment B-2
 *     writes bodies, 20 lessons' full text becomes public with no further
 *     change
 *
 * ── THE VERIFIER ──────────────────────────────────────────────────────────
 *
 * verify-xpa-6a asserted "preview count is 0" and "anon reads are
 * DENIED_EMPTY" — the state on the day 035 ran, encoded as though it were the
 * rule. It went red for a legitimate editorial change and stayed red. It is
 * now re-based on the invariant, and it was NOT simply made green: run against
 * the un-remediated database it still failed, on three substantive checks.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const has = (rel: string) => existsSync(join(ROOT, rel))
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripSql = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/--[^\n]*/g, blank)
const stripJs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank)

const M043 = has('supabase/migrations/043_clear_unintended_preview_flags.sql')
  ? read('supabase/migrations/043_clear_unintended_preview_flags.sql') : ''
const V6A = read('scripts/security/verify-xpa-6a.mjs')

// ═══════════════════════════════════════════════════════════════════════════
// THE REMEDIATION IS SCOPED, NOT A BLANKET RESET
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 F-1 — migration 043 clears only what it should', () => {
  it('the migration exists', () => {
    expect(M043.length).toBeGreaterThan(0)
  })

  it('it is scoped to C2-F2, not to every lesson', () => {
    const sql = stripSql(M043)
    expect(sql).toContain("slug = 'mesurer-l-experience-client'")
    expect(sql).toMatch(/m\.course_id = v_course_id/)
    // 035 warned that an unconditional reset destroys later editorial work.
    expect(sql, 'an unconditional blanket reset would erase future previews')
      .not.toMatch(/update public\.lessons\s+set is_preview = false\s*;/)
  })

  it('it refuses rather than guesses when the course is missing', () => {
    expect(stripSql(M043)).toMatch(/raise exception[\s\S]{0,90}refusing to guess/i)
  })

  it('it verifies its own outcome', () => {
    const sql = stripSql(M043)
    expect(sql).toMatch(/expected to clear % flag\(s\), cleared %/)
    expect(sql).toMatch(/preview flag\(s\) survived on C2-F2/)
  })

  it('it does NOT remove the preview feature', () => {
    const sql = stripSql(M043)
    // The policy arm must survive: designating a preview stays possible.
    expect(sql).not.toMatch(/drop policy[\s\S]{0,60}lessons_visible/i)
    // It READS `is_preview = true` to find the rows to clear, which is the
    // point; what it must never do is SET one.
    expect(sql, '043 sets a preview flag').not.toMatch(/set\s+is_preview\s*=\s*true/i)
    // The sentence wraps across comment lines; match one line's worth.
    expect(read('supabase/migrations/043_clear_unintended_preview_flags.sql'))
      .toMatch(/preview FEATURE/)
  })

  it('it touches nothing outside is_preview', () => {
    const sql = stripSql(M043)
    for (const forbidden of ['content', 'video_object_path', 'entitlements', 'storage.',
                             'drop table', 'delete from']) {
      expect(sql.toLowerCase(), `043 touches ${forbidden}`).not.toContain(forbidden.toLowerCase())
    }
  })

  it('it records why, since the flags were deliberate', () => {
    const raw = read('supabase/migrations/043_clear_unintended_preview_flags.sql')
    expect(raw).toMatch(/individual, deliberate tick/i)
    expect(raw).toMatch(/could not be proven/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE VERIFIER ASSERTS AN INVARIANT, NOT A SNAPSHOT
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 F-1 — verify-xpa-6a re-based', () => {
  it('the snapshot assertion is gone', () => {
    const js = stripJs(V6A)
    expect(js, 'still asserts the preview count is zero')
      .not.toMatch(/prev\.total === 0 && all\.total > 0/)
    expect(js, 'still demands DENIED_EMPTY for anon lessons')
      .not.toMatch(/record\(`anon \$\{t\}`[\s\S]{0,200}CONTENT/)
  })

  it('it asserts anon sees exactly the preview set', () => {
    expect(V6A).toContain('anon lessons == exactly the preview set')
    expect(V6A).toContain('learner lessons == exactly the preview set')
    expect(stripJs(V6A)).toMatch(/nonPreview\.length === 0/)
  })

  it('it asserts a preview row leaks no body and no object path', () => {
    expect(V6A).toContain('anon lessons expose no body')
    expect(V6A).toContain('anon lessons expose no object path')
    expect(V6A).toContain('learner lessons expose no body or object path')
  })

  it('it catches a whole course flagged wholesale — the 035 pattern', () => {
    expect(V6A).toContain('no course is flagged preview WHOLESALE')
    expect(stripJs(V6A)).toMatch(/totals\[cid\] === n/)
  })

  it('modules are allowed only when they hold a preview lesson', () => {
    expect(V6A).toContain('anon modules == only those holding a preview lesson')
    expect(V6A).toContain('learner modules == only those holding a preview lesson')
  })

  it('a run that records nothing can no longer report PASS', () => {
    // It printed "PASS — 0 checks, 0 failures" after throwing early. That is
    // worse than a failure: it looks like evidence.
    const js = stripJs(V6A)
    expect(js).toMatch(/results\.length === 0/)
    expect(V6A).toContain('INCONCLUSIVE')
    const inconclusiveAt = V6A.indexOf('INCONCLUSIVE')
    const passAt = V6A.indexOf('XPA-6A PASS')
    expect(inconclusiveAt).toBeGreaterThan(-1)
    expect(inconclusiveAt, 'the zero-check guard must precede the PASS branch').toBeLessThan(passAt)
  })

  it('the reasoning is written down where the next reader will look', () => {
    expect(V6A).toMatch(/THE COUNT ON THAT DAY/)
    expect(V6A).toMatch(/permanently-red check is not a signal/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// NOTHING ELSE MOVED
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 F-1 stayed in its lane', () => {
  it('the preview policy arm is untouched', () => {
    // 001 introduced it, 036 rewrote it; F-1 changes neither.
    expect(read('supabase/migrations/036_fix_content_policy_recursion.sql'))
      .toMatch(/lessons\.is_preview = true/)
    expect(M043).not.toMatch(/create policy/i)
  })

  it('the admin editor still offers the preview checkbox', () => {
    const editor = read('app/(admin)/admin/modules/[id]/edit/LessonEditor.tsx')
    expect(editor).toContain('Leçon en aperçu libre')
    expect(editor).toMatch(/setIsPreview\(e\.target\.checked\)/)
    // …and still defaults to unchecked for a new lesson.
    expect(editor).toMatch(/useState\(lesson\?\.is_preview \?\? false\)/)
  })

  it('F-2 protected delivery is untouched', () => {
    const route = stripJs(read('app/api/media/lesson/[lessonId]/[kind]/route.ts'))
    expect(route).toContain('resolveCourseAccessById')
    expect(route, 'is_preview became a delivery authority').not.toContain('is_preview')
  })

  it('B-2 and the other excluded items are not touched', () => {
    const sql = stripSql(M043)
    for (const forbidden of ['quizzes', 'quiz_questions', 'ai_scenarios', 'payments',
                             'course-videos', 'certificates']) {
      expect(sql.toLowerCase(), `043 touches ${forbidden}`).not.toContain(forbidden)
    }
  })
})
