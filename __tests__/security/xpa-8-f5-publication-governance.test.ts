// @vitest-environment node
/**
 * XPA-8 F-5 — withdrawal containment and publication governance.
 *
 * ── WHAT HAPPENED, THREE TIMES ────────────────────────────────────────────
 *
 * Two courses withdrawn by ruling were re-published on 29 August 2026, fourteen
 * seconds apart. It was the third recurrence of the same failure.
 *
 * The MECHANISM was provable. `courses` carries no `updated_at` trigger — the
 * only trigger on the table is `courses_code_immutable` (028), which guards
 * `code` — and the corrective REST patches behind 045 and 048 changed
 * `is_published` while leaving `updated_at` untouched. So millisecond-precision
 * timestamps could only have come from the admin action's explicit
 * `new Date().toISOString()`. Both rows were written through the admin form.
 *
 * The ACTOR was not provable. `audit_log` held six rows all-time, every one an
 * `entitlement.granted`. Publication was the only control of that consequence
 * that left no trace, so production simply did not retain the evidence.
 *
 * ── WHAT THIS SUITE DEFENDS ───────────────────────────────────────────────
 *
 *   Track 1  migration 049 restores the state and is scoped, guarded and
 *            non-destructive — and does NOT redesign the RLS contract
 *   Track 3  every publication TRANSITION is audited, on both write paths,
 *            and a new course is not born published
 *   Track 4  preservation checks on growing tables use a frozen floor, so they
 *            detect deletion rather than detecting growth
 *
 * ── WHAT THIS SUITE DELIBERATELY DOES NOT ASSERT ──────────────────────────
 *
 * `lessons_visible`, `modules_visible` and `module_has_preview_lesson` still
 * admit a preview lesson without consulting its course's publication state.
 * That is the CAUSE, F-5 addressed an INSTANCE of it, and the redesign is
 * reserved as migration 050 with its own phase — it changes a policy that has
 * already caused one platform-wide 42P17 outage. Asserting the fixed behaviour
 * here would make this suite fail against the system as it actually is.
 *
 * Migration 046 is permanently withdrawn and must never exist.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

// `lib/admin/publication-audit.ts` opens with `import 'server-only'`, a Next.js
// build-time guard with no Node resolution. Stubbing it lets the real module
// load; the guard itself is asserted below.
vi.mock('server-only', () => ({}))

const { logAuditEvent } = vi.hoisted(() => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/audit/log', () => ({ logAuditEvent }))

const { recordPublicationTransition } = await import('@/lib/admin/publication-audit')

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const blank = (m: string) => m.replace(/[^\n]/g, ' ')

/**
 * Blank comments while preserving length and line structure.
 *
 * Not optional. A B-2.1 assertion once passed against a comment that quoted the
 * very line it was checking had been removed, and a regression-proof regex once
 * matched prose in a migration header. Every absence assertion below reads code,
 * never prose.
 */
const stripJs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank)
const stripSql = (s: string) => s.replace(/--[^\n]*/g, blank)

const MIGRATIONS = join('supabase', 'migrations')
const M049 = '049_xpa8_containment_restore_withdrawal.sql'
const EDIT = 'app/(admin)/admin/courses/[id]/edit/actions.ts'
const NEW  = 'app/(admin)/admin/courses/new/actions.ts'
const FORM = 'app/(admin)/admin/courses/new/NewCourseForm.tsx'
const XPA6A = 'scripts/security/verify-xpa-6a.mjs'

// ══════════════════════════════════════════════════════════════════════════
describe('XPA-8 F-5 Track 1 — migration 049 restores state without redesigning it', () => {
  const sql = () => stripSql(read(join(MIGRATIONS, M049)))

  it('exists and runs as a single transaction', () => {
    const raw = read(join(MIGRATIONS, M049))
    expect(raw).toMatch(/^begin;/m)
    expect(raw).toMatch(/^commit;/m)
  })

  it('writes exactly two UPDATEs and nothing else', () => {
    const s = sql()
    expect((s.match(/^\s*update\s/gim) ?? []).length).toBe(2)
    expect(s).not.toMatch(/^\s*(insert into|delete from|truncate)/im)
  })

  it('contains no DDL — a data corrective may not change structure', () => {
    expect(sql()).not.toMatch(/^\s*(create|drop|alter)\s+(policy|function|table|trigger|view|index)/im)
  })

  it('targets C2-F2 by code and culture-client by slug, each cross-checked by uuid', () => {
    const s = sql()
    expect(s).toMatch(/where code = 'C2-F2'/)
    expect(s).toMatch(/developper-une-culture-client/)
    expect(s).toContain('3731d5cc-7245-4fc7-9ddf-a10b9215d6cc')
    expect(s).toContain('caaeff66-9095-4cf3-9294-e08188522e3a')
    // A key that resolves to an unexpected course must abort, not proceed.
    expect(s).toMatch(/v_c2f2 <> c_c2f2[\s\S]{0,240}raise exception/)
    expect(s).toMatch(/v_cult <> c_cult[\s\S]{0,240}raise exception/)
  })

  it('is idempotent — both UPDATEs are guarded on the value they change', () => {
    const s = sql()
    expect(s).toMatch(/update public\.courses[\s\S]{0,200}and\s+is_published;/)
    expect(s).toMatch(/update public\.lessons[\s\S]{0,300}and\s+l\.is_preview;/)
  })

  it('never writes updated_at, so the forensic evidence survives the restoration', () => {
    const s = sql()
    const updates = s.slice(s.indexOf('update public.courses'))
    expect(updates).not.toMatch(/set[\s\S]{0,200}updated_at\s*=/)
    // And it asserts the preservation rather than assuming it.
    expect(s).toMatch(/updated_at from public\.courses where id = v_c2f2\) <> v_c2f2_upd/)
    expect(s).toMatch(/updated_at from public\.courses where id = v_cult\) <> v_cult_upd/)
  })

  it('asserts the end state: 7 courses, 5 published, 0 preview flags on the target', () => {
    const s = sql()
    expect(s).toMatch(/v_courses <> 7[\s\S]{0,200}raise exception/)
    expect(s).toMatch(/v_published <> 5[\s\S]{0,200}raise exception/)
    expect(s).toMatch(/m\.course_id = v_cult and l\.is_preview\) <> 0/)
  })

  it('proves nothing was destroyed, including the learner record', () => {
    const s = sql()
    for (const t of ['entitlements', 'enrollments', 'lesson_progress'])
      expect(s, `${t} must be count-checked`).toMatch(new RegExp(`count\\(\\*\\) from public\\.${t}\\)`))
    expect(s).toMatch(/module count changed/)
    expect(s).toMatch(/lesson count changed/)
    expect(s).toMatch(/media references changed/)
  })

  it('does NOT touch the withdrawal RLS contract — that is reserved for 050', () => {
    const s = sql()
    for (const policy of ['lessons_visible', 'modules_visible', 'module_has_preview_lesson'])
      expect(s, `049 must not redefine ${policy}`).not.toContain(policy)
  })

  it('migration 046 does not exist and 050 has not been created', () => {
    const files = readdirSync(join(ROOT, MIGRATIONS))
    expect(files.filter(f => f.startsWith('046'))).toEqual([])
    expect(files.filter(f => f.startsWith('050'))).toEqual([])
    expect(files.filter(f => f.startsWith('049'))).toEqual([M049])
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('XPA-8 F-5 Track 3 — publication transitions are audited', () => {
  const BASE = {
    courseId: 'c0ffee00-0000-4000-8000-000000000001',
    courseTitle: 'Mesurer',
    courseSlug: 'mesurer',
    actorId: 'a0a0a0a0-0000-4000-8000-000000000002',
    actorEmail: 'operator@example.test',
    outcome: 'success' as const,
  }
  beforeEach(() => logAuditEvent.mockClear())

  it('withdrawn → published emits course.published carrying BOTH states', async () => {
    await recordPublicationTransition({ ...BASE, previousIsPublished: false, newIsPublished: true })
    const e = logAuditEvent.mock.calls[0][0]
    expect(e.eventType).toBe('course.published')
    expect(e.actorType).toBe('admin')
    expect(e.actorId).toBe(BASE.actorId)
    expect(e.actorEmail).toBe(BASE.actorEmail)
    expect(e.method).toBe('admin_panel')
    expect(e.outcome).toBe('success')
    expect(e.metadata.courseId).toBe(BASE.courseId)
    expect(e.metadata.previousIsPublished).toBe(false)
    expect(e.metadata.newIsPublished).toBe(true)
    expect(e.metadata.source).toBe('admin_course_form')
  })

  it('published → withdrawn emits course.unpublished', async () => {
    await recordPublicationTransition({ ...BASE, previousIsPublished: true, newIsPublished: false })
    const e = logAuditEvent.mock.calls[0][0]
    expect(e.eventType).toBe('course.unpublished')
    expect(e.metadata.previousIsPublished).toBe(true)
    expect(e.metadata.newIsPublished).toBe(false)
  })

  it('a create-as-published is distinguishable by a null previous state', async () => {
    await recordPublicationTransition({ ...BASE, previousIsPublished: null, newIsPublished: true })
    const e = logAuditEvent.mock.calls[0][0]
    expect(e.eventType).toBe('course.published')
    expect(e.metadata.previousIsPublished).toBeNull()
  })

  it('a REFUSED transition is recorded as a failure with its reason', async () => {
    await recordPublicationTransition({
      ...BASE, previousIsPublished: false, newIsPublished: true,
      outcome: 'failure', reason: 'constraint violated',
    })
    const e = logAuditEvent.mock.calls[0][0]
    expect(e.outcome).toBe('failure')
    expect(e.reason).toBe('constraint violated')
  })

  it('carries no secret — audit records outlive the accounts they describe', async () => {
    await recordPublicationTransition({ ...BASE, previousIsPublished: false, newIsPublished: true })
    const blob = JSON.stringify(logAuditEvent.mock.calls[0][0])
    for (const s of ['service_role', 'apikey', 'password', 'Bearer', 'SUPABASE_SERVICE_ROLE_KEY'])
      expect(blob).not.toContain(s)
  })

  it('both event types are declared, so call sites stay honest', () => {
    const src = read('lib/audit/log.ts')
    expect(src).toMatch(/\|\s*'course\.published'/)
    expect(src).toMatch(/\|\s*'course\.unpublished'/)
  })

  it('the helper is server-only and NOT exported from a use-server module', () => {
    // Every export of a `'use server'` module is a callable HTTP endpoint.
    const src = read('lib/admin/publication-audit.ts')
    expect(src).toMatch(/^import 'server-only'/m)
    expect(src).not.toMatch(/^'use server'/m)
  })

  it('updateCourse reads the PRIOR state from the row, not from the form', () => {
    const src = stripJs(read(EDIT))
    // F-5.2 widened the destructuring to CAPTURE the lookup error. The intent
    // this test guards - prior state comes from the ROW, never the form - is
    // unchanged; only the shape of the destructuring moved.
    expect(src).toMatch(/const \{ data: prior, error: priorError \}[\s\S]{0,220}\.select\('is_published, slug'\)/)
    // This line used to pin `!!prior && prior.is_published !== is_published`.
    // That expression WAS the fail-open: a failed lookup became `prior = null`,
    // which became 'nothing changed', and the UPDATE proceeded with no audit -
    // the defect behind the unattributable 2026-09-05 republication. Pinning it
    // would make this suite assert the bug. It now pins the fail-closed form,
    // which is strictly stronger: prior is proven non-null before it is read.
    expect(src).toMatch(/publicationChanged\s*=\s*prior\.is_published !== is_published/)
    expect(src).toMatch(/if \(priorError\)[\s\S]{0,400}throw new Error/)
  })

  it('updateCourse audits both the success and the refusal path, transitions only', () => {
    const src = stripJs(read(EDIT))
    expect((src.match(/recordPublicationTransition\(\{/g) ?? []).length).toBe(2)
    expect(src).toMatch(/if \(publicationChanged\)[\s\S]{0,420}recordPublicationTransition/)
    expect(src).toMatch(/outcome:\s*'failure'/)
    expect(src).toMatch(/outcome:\s*'success'/)
  })

  it('createCourse audits a course created published', () => {
    const src = stripJs(read(NEW))
    expect(src).toMatch(/if \(is_published\)[\s\S]{0,420}recordPublicationTransition/)
    expect(src).toMatch(/previousIsPublished:\s*null/)
  })

  it('neither write path touches the withdrawal RLS contract or preview flags', () => {
    for (const f of ['lib/admin/publication-audit.ts', EDIT, NEW]) {
      const src = stripJs(read(f))
      for (const forbidden of ['lessons_visible', 'modules_visible', 'module_has_preview_lesson', 'is_preview'])
        expect(src, `${f} references ${forbidden}`).not.toContain(forbidden)
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('XPA-8 F-5 Track 3 — a new course is not born published', () => {
  it('the NEW-course checkbox is not defaultChecked', () => {
    const box = /<input[^>]*name="is_published"[^>]*>/.exec(read(FORM))
    expect(box, 'the publication control must still exist').not.toBeNull()
    expect(box![0]).not.toMatch(/defaultChecked/)
  })

  it('the EDIT form keeps its existing semantics — it reflects the current state', () => {
    // Preserved deliberately: because it renders unticked for a withdrawn
    // course, an unrelated edit cannot accidentally republish. Re-publishing
    // required ticking the box, which is why F-5 is a governance gap and not an
    // application defect.
    const box = /<input[^>]*name="is_published"[^>]*>/.exec(read('app/(admin)/admin/courses/[id]/edit/page.tsx'))
    expect(box![0]).toMatch(/defaultChecked=\{course\.is_published\}/)
  })

  it('no automatic republishing was introduced on either path', () => {
    for (const f of [EDIT, NEW]) {
      const src = stripJs(read(f))
      expect(src).toMatch(/is_published\s*=\s*formData\.get\('is_published'\) === 'on'/)
      expect(src, `${f} must not hardcode publication`).not.toMatch(/is_published:\s*true/)
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('XPA-8 F-5 Track 4 — preservation checks detect deletion, not growth', () => {
  const src = () => stripJs(read(XPA6A))

  it('ai_sessions and ai_turns use a frozen floor, not an exact count', () => {
    const s = src()
    expect(s).toMatch(/PRESERVE_FLOOR\s*=\s*\{\s*sessions:\s*11,\s*turns:\s*36\s*\}/)
    expect(s).toMatch(/'ai_sessions'[\s\S]{0,90}PRESERVE_FLOOR\.sessions,\s*'min'/)
    expect(s).toMatch(/'ai_turns'[\s\S]{0,90}PRESERVE_FLOOR\.turns,\s*'min'/)
    expect(s).toMatch(/mode === 'min' \? r\.total >= want : r\.total === want/)
  })

  it('the floor is NOT re-pinned to the totals observed after the pilot session', () => {
    // 12 and 40 were the live totals when this was written. Re-pinning a
    // preservation check to present reality is exactly how it stops detecting
    // deletion, so those values must not appear as the baseline.
    const s = src()
    expect(s).not.toMatch(/PRESERVE_FLOOR\s*=\s*\{\s*sessions:\s*12/)
    expect(s).not.toMatch(/turns:\s*40\s*\}/)
  })

  it('the persona roster keeps EXACT equality — a fifth is as much a finding as a lost fourth', () => {
    expect(src()).toMatch(/'unpublished voice personas'[\s\S]{0,110}4,\s*'exact'/)
  })

  it('no isolation or access assertion was weakened to accommodate the change', () => {
    const s = src()
    // The private-table refusals and the anon boundary are untouched.
    expect(s).toMatch(/anon \$\{t\} stays private[\s\S]{0,120}r\.status >= 400 && r\.status < 500/)
    expect(s).toMatch(/classify\(pvs\) === 'ALLOWED' && pvs\.total === 1/)
    // Nothing in the verifier may have been relaxed into an unconditional pass.
    expect(s).not.toMatch(/record\([^)]*,\s*true\s*\)/)
  })
})
