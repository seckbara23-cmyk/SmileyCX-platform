// @vitest-environment node
/**
 * F-5.2 — publication accountability.
 *
 * ── WHAT THIS SUITE CAN AND CANNOT PROVE ──────────────────────────────────
 *
 * It runs under vitest with NO database. It therefore cannot fire a trigger,
 * cannot observe a row landing in `audit_log`, and cannot prove that a direct
 * SQL publication is recorded. Every assertion below reads SOURCE TEXT.
 *
 * That distinction is the whole reason F-5.2 exists. The existing F-5 suite
 * (`xpa-8-f5-publication-governance.test.ts`) is 28 assertions of exactly this
 * kind, and on 2026-09-05 it was 28/28 green while production republished two
 * courses with no audit record at all. A file-reading test cannot see
 * production. Pretending otherwise is how the gap survived four recurrences.
 *
 * So this suite proves the CONTRACT — that the migration says the right things
 * and the application fails closed — and it asserts, as its final act, that the
 * runtime proof exists somewhere else and is runnable:
 * `scripts/security/verify-publication-governance.mjs`.
 *
 * Static here, runtime there, and neither pretending to be the other.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const has  = (p: string) => existsSync(join(ROOT, p))

const blank = (m: string) => m.replace(/[^\n]/g, ' ')
/** Blank SQL comments, preserving line count so offsets still mean something. */
const stripSql = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/--[^\n]*/g, blank)
const stripJs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank)
   .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))

const MIGRATIONS = join('supabase', 'migrations')
const M053    = 'supabase/migrations/053_publication_accountability.sql'
const M052    = 'supabase/migrations/052_quiz1b_activate_randomization.sql'
const EDIT    = 'app/(admin)/admin/courses/[id]/edit/actions.ts'
const NEWC    = 'app/(admin)/admin/courses/new/actions.ts'
const VERIFY  = 'scripts/security/verify-publication-governance.mjs'
const MANIFEST = 'scripts/security/publication-manifest.json'
const QUIZPAGE = 'app/(learn)/learn/[courseSlug]/[moduleId]/quiz/page.tsx'
const MEDIA    = 'app/api/media/lesson/[lessonId]/[kind]/route.ts'
const QUIZACT  = 'app/actions/quiz.ts'

// ══════════════════════════════════════════════════════════════════════════
describe('F-5.2 — publication remains POSSIBLE (accountability, not prohibition)', () => {
  const sql = () => stripSql(read(M053))

  it('1. every recorder is an AFTER trigger, so it cannot veto a write', () => {
    const s = sql()
    for (const op of ['update', 'insert', 'delete'])
      expect(s, `the ${op} recorder must be AFTER`).toMatch(new RegExp(`after ${op} on public\\.courses`, 'i'))
    // A BEFORE trigger on courses could return NULL and silently swallow the
    // write. The absence of one is the structural guarantee.
    expect(s).not.toMatch(/before (update|insert|delete) on public\.courses/i)
  })

  it('2. the recorder never raises on the publication path', () => {
    // The ONLY exception handler is the attribution parser, and its only raise
    // is a re-raise of cancel/shutdown. Nothing rejects a publication.
    const s = sql()
    const fn = s.slice(s.indexOf('function public.audit_course_publication'), s.indexOf('$fn$;'))
    expect(fn).not.toMatch(/raise exception/i)
  })

  it('3. no course is hard-coded, and no publication state is written', () => {
    const s = sql()
    expect(s, 'F-5.2 must not restore or pin any publication state')
      .not.toMatch(/update\s+public\.courses/i)
    expect(s).not.toMatch(/set\s+is_published/i)
    for (const slug of ['mesurer-l-experience-client', 'developper-une-culture-client'])
      expect(s, `${slug} must not be hard-coded`).not.toContain(slug)
  })

  it('4. no preview flag is cleared — owner-managed per the 2026-09-06 ruling', () => {
    const s = sql()
    expect(s).not.toMatch(/is_preview/i)
    expect(s).not.toMatch(/update\s+public\.lessons/i)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('F-5.2 — transitions are audited by the DATABASE, not only the app', () => {
  const sql = () => stripSql(read(M053))

  it('5. the recorder writes to audit_log on every transition', () => {
    const s = sql()
    expect(s).toMatch(/insert into public\.audit_log/i)
    expect(s).toContain("'course.publication_observed'")
    expect(s).toContain("'db_trigger'")
  })

  it('6. it fires on the VALUE changing, not on the column being assigned', () => {
    // The admin form posts is_published on every save, so `update of` would
    // fire on a title edit; worse, it fires on assignment rather than change.
    const s = sql()
    expect(s).toMatch(/when \(old\.is_published is distinct from new\.is_published\)/i)
    expect(s).not.toMatch(/update of is_published/i)
  })

  it('7. birth-as-published and destruction-of-published are both recorded', () => {
    const s = sql()
    expect(s).toMatch(/after insert on public\.courses[\s\S]{0,120}when \(new\.is_published is true\)/i)
    expect(s).toMatch(/after delete on public\.courses[\s\S]{0,120}when \(old\.is_published is true\)/i)
  })

  it('8. the audit insert has NO exception handler — a swallowed witness is the defect', () => {
    const s = sql()
    const fn = s.slice(s.indexOf('function public.audit_course_publication'), s.indexOf('$fn$;'))
    const ins = fn.indexOf('insert into public.audit_log')
    expect(ins).toBeGreaterThan(-1)
    // Exactly one `exception` block in the body, and it sits BEFORE the insert:
    // it guards claim PARSING only.
    expect((fn.match(/\bexception\b/g) ?? []).length).toBe(1)
    expect(fn.indexOf('exception')).toBeLessThan(ins)
  })

  it('9. it uses a DISTINCT event type so app-level counts keep their meaning', () => {
    const s = sql()
    expect(s).toContain('course.publication_observed')
    for (const t of ['course.published', 'course.unpublished'])
      expect(s, `${t} belongs to the application row, not the trigger`).not.toContain(`'${t}'`)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('F-5.2 — a direct DB transition cannot bypass the recorder', () => {
  const sql = () => stripSql(read(M053))

  it('10. all three recorders are ENABLE ALWAYS', () => {
    // Without this, `set session_replication_role = replica` — one line for a
    // superuser — silently disables every trigger on the table.
    const s = sql()
    for (const t of ['update', 'insert', 'delete'])
      expect(s).toMatch(new RegExp(`enable always trigger courses_audit_publication_${t}`, 'i'))
    expect((s.match(/enable always trigger/gi) ?? []).length).toBe(3)
  })

  it('11. no role is exempted', () => {
    const s = sql()
    const fn = s.slice(s.indexOf('function public.audit_course_publication'), s.indexOf('$fn$;'))
    // 027's role guard is the anti-pattern here: a recorder that lets
    // service_role/postgres past records nothing on the paths that matter most.
    expect(fn).not.toMatch(/current_user\s+in\s*\(/i)
    expect(fn).not.toMatch(/session_user\s+in\s*\(/i)
  })

  it('12. SECURITY DEFINER with a pinned search_path, or audit_log RLS refuses it', () => {
    const s = sql()
    expect(s).toMatch(/create or replace function public\.audit_course_publication\(\)[\s\S]{0,200}security definer/i)
    // pg_temp LAST, so a temp table cannot shadow the audit target.
    expect(s).toMatch(/set search_path = public, pg_temp/i)
  })

  it('13. the SECURITY DEFINER function is not attachable by other roles', () => {
    const s = sql()
    expect(s).toMatch(/revoke all on function public\.audit_course_publication\(\) from public/i)
  })

  it('14. an outside-readable probe exists and is RELATION-scoped', () => {
    const s = sql()
    expect(s).toMatch(/create or replace function public\.publication_governance_installed\(\)/i)
    // Name-scoped would miss rename-and-recreate: CREATE TABLE ... LIKE does
    // not copy triggers.
    expect(s).toMatch(/tgrelid = 'public\.courses'::regclass/i)
    expect(s, 'must require ENABLE ALWAYS, not merely present').toMatch(/tgenabled = 'A'/i)
  })

  it('15. the migration installs no policy and no table grant', () => {
    const s = sql()
    expect(s, '050 owns the RLS phase; 053 must not touch policies').not.toMatch(/create policy|drop policy/i)
    expect(s).not.toMatch(/grant .* on table/i)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('F-5.2 — the Admin action fails CLOSED', () => {
  const src = () => stripJs(read(EDIT))

  it('16. the prior-state lookup error is captured, not discarded', () => {
    const s = src()
    expect(s).toMatch(/const \{ data: prior, error: priorError \} = await supabase/)
  })

  it('17. an unreadable prior state BLOCKS the write', () => {
    const s = src()
    const guard  = s.indexOf('if (priorError)')
    const update = s.indexOf('.update({')
    expect(guard).toBeGreaterThan(-1)
    expect(update).toBeGreaterThan(-1)
    expect(guard, 'the guard must precede the UPDATE').toBeLessThan(update)
    expect(s.slice(guard, update)).toMatch(/throw new Error/)
  })

  it('18. a missing course row also blocks the write', () => {
    const s = src()
    const guard = s.indexOf('if (!prior)')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(s.indexOf('.update({'))
    expect(s.slice(guard, s.indexOf('.update({'))).toMatch(/throw new Error/)
  })

  it('19. the fail-open shape is gone', () => {
    const s = src()
    expect(s, 'a falsy prior must no longer silently mean "nothing changed"')
      .not.toContain('!!prior && prior.is_published !== is_published')
    expect(s).toContain('const publicationChanged = prior.is_published !== is_published')
  })

  it('20. refusals are logged as an AUDIT GAP, not swallowed', () => {
    const s = src()
    expect((s.match(/AUDIT GAP/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(s).toMatch(/log\.error/)
  })

  it('21. normal Admin publication still works — the happy path is untouched', () => {
    const s = src()
    // Still one UPDATE, still audited on transition, still redirects.
    expect(s).toMatch(/\.from\('courses'\)[\s\S]{0,80}\.update\(\{/)
    expect(s).toMatch(/if \(publicationChanged\)/)
    expect((s.match(/recordPublicationTransition\(\{/g) ?? []).length).toBe(2)
    expect(s).toMatch(/redirect\('\/admin\/courses'\)/)
    // No new gate on ordinary edits: only the prior-state read can refuse.
    expect(s).not.toMatch(/if \(is_published\)[\s\S]{0,60}throw/)
  })

  it('22. createCourse performs no prior-state read, so it has no fail-open to close', () => {
    const s = stripJs(read(NEWC))
    expect(s).not.toContain('error: priorError')
    expect(s).toMatch(/recordPublicationTransition/)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('F-5.2 — boundaries this release must not have moved', () => {
  it('23. entitlement remains the access authority in the grader', () => {
    const a = stripJs(read(QUIZACT))
    expect(a).toMatch(/resolveCourseAccessById\(context\.courseId\)/)
    expect(a).toMatch(/if \(!access\.allowed \|\| !access\.userId\)/)
  })

  it('24. protected media still re-authorizes on entitlement, and preview buys nothing', () => {
    const m = stripJs(read(MEDIA))
    expect(m).toMatch(/resolveCourseAccessById\(resolvedCourseId\)/)
    expect(m).toMatch(/if \(!access\.allowed\)/)
    // is_preview must never appear in the media authorization path.
    expect(m, 'preview status must not weaken protected-media authorization')
      .not.toContain('is_preview')
  })

  it('25. QUIZ-1B randomisation wiring is untouched', () => {
    const s = stripJs(read(QUIZPAGE))
    expect(s).toMatch(/orderQuestions\(questions, !!quiz\?\.randomize_questions, shuffleSeed\)/)
    expect(s).toMatch(/randomize_options/)
  })

  it('26. QUIZ-1B formative copy is untouched', () => {
    const s = stripJs(read(QUIZPAGE))
    expect(s).toContain('? <>Bravo&nbsp;! Vous avez r&eacute;ussi cet exercice.</>')
    expect(s).toContain(': <>Bravo&nbsp;! Vous avez valid&eacute; ce module.</>')
  })

  it('27. migration 052 is byte-untouched in its load-bearing parts', () => {
    const s = read(M052)
    expect(s).toContain("'70bbc2a8-9c34-4607-88a3-7ce328ea9e7e'")
    expect(s).toMatch(/and\s+randomize_questions = false/)
    expect(s).toMatch(/get diagnostics v_rows = row_count/)
    expect(s).toMatch(/\(a FINAL EXAM, course_id %\)/)
  })

  it('28. no mode flag became an authority anywhere F-5.2 edits', () => {
    for (const f of [EDIT, NEWC]) {
      const s = stripJs(read(f))
      for (const t of ['PLATFORM_MODE', 'PILOT_MODE', 'FREE_ACCESS_MODE'])
        expect(s, `${f} reads ${t}`).not.toContain(t)
    }
  })

  it('29. F-5.2 touches no Voice/AI, payments, final-exam or PDF surface', () => {
    const s = stripSql(read(M053))
    for (const t of ['ai_sessions', 'ai_scenarios', 'payments', 'requires_final_exam',
                     'quiz_attempts', 'quizzes', 'pdf_object_path', 'entitlements', 'enrollments'])
      expect(s, `053 references ${t}`).not.toContain(t)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// The two record families. One normal Admin publish writes up to TWO rows:
// the DATABASE WITNESS (course.publication_observed, migration 053) proves the
// transition happened on any write path; the APPLICATION EVENT
// (course.published / course.unpublished) carries the human. They are not two
// transitions, and neither substitutes for the other.
// ══════════════════════════════════════════════════════════════════════════
describe('F-5.2 — witness and application events are distinct and non-substitutable', () => {
  const sql = () => stripSql(read(M053))
  const ver = () => read(VERIFY)

  it('37. the two families are intentionally distinct event types', () => {
    const s = sql()
    expect(s, 'the witness must have its own event type').toContain('course.publication_observed')
    // If the trigger reused the application event types, every count and every
    // report that filters on them would silently double.
    for (const t of ['course.published', 'course.unpublished'])
      expect(s, `${t} belongs to the application row`).not.toContain(`'${t}'`)
  })

  it('38. the application writer still owns the human attribution path', () => {
    const pub = stripJs(read('lib/admin/publication-audit.ts'))
    expect(pub).toMatch(/course\.published/)
    expect(pub).toMatch(/course\.unpublished/)
    expect(pub).toMatch(/actorId/)
    expect(pub).toMatch(/actorEmail/)
    // And it is untouched by F-5.2: the trigger complements it, never replaces it.
    expect(pub).not.toContain('publication_observed')
  })

  it('39. the verifier separates the families rather than pooling them', () => {
    const v = ver()
    expect(v).toMatch(/const WITNESS = 'course\.publication_observed'/)
    expect(v).toMatch(/const APP_EVENTS = \[/)
    expect(v, 'witness and application rows must be bucketed separately').toMatch(/witnessBy/)
    expect(v).toMatch(/appBy/)
  })

  it('40. transitions are counted from WITNESSES only, so a pair is not two', () => {
    const v = ver()
    // The drift branch keys on the witness bucket. If it keyed on a pooled
    // array, one Admin publish (two rows) would read as two transitions.
    expect(v).toMatch(/const w = witnessBy\[o\.id\] \?\? \[\]/)
    expect(v).toMatch(/if \(w\.length > 0\)/)
    expect(v, 'a pooled existence check would confuse the families')
      .not.toMatch(/const explained = \(evByCourse/)
  })

  it('41. a missing APPLICATION row does not erase the witness', () => {
    const v = ver()
    // Witness present + no application row is still ACCOUNTED; the loss is
    // attribution, not the record of the transition.
    expect(v).toMatch(/DRIFT — ACCOUNTED/)
    expect(v).toMatch(/no application row — attribution unavailable/)
  })

  it('42. a missing WITNESS is a governance failure even with an application row', () => {
    const v = ver()
    expect(v).toMatch(/DRIFT — NO WITNESS/)
    // It must be recorded via rec(..., false) — a FAILURE — not note().
    // Sliced on a fixed window rather than to the next brace: the call spans
    // template literals whose `${...}` braces would truncate it.
    const i = v.indexOf('DRIFT — NO WITNESS')
    expect(i).toBeGreaterThan(-1)
    const call = v.slice(Math.max(0, i - 40), i + 400)
    expect(call, 'NO WITNESS must be reported through rec(), not note()').toMatch(/rec\(/)
    expect(call, 'NO WITNESS must be recorded as a failure').toMatch(/,\s*false\)/)
    expect(call, 'NO WITNESS must not be downgraded to a notice').not.toMatch(/note\(/)
  })

  it('43. actor attribution is never inferred from current_user or session_user', () => {
    const s = sql()
    const fn = s.slice(s.indexOf('function public.audit_course_publication'), s.indexOf('$fn$;'))
    // actor_id / actor_email come ONLY from the JWT. Under SECURITY DEFINER,
    // current_user is the function OWNER on every path, so inferring a human
    // from it would attribute every out-of-band write to postgres — a false
    // record, which is worse than an honestly unattributed one.
    expect(fn).toMatch(/v_actor\s*:=\s*nullif\(v_claims ->> 'sub', ''\)::uuid/)
    expect(fn).toMatch(/v_email\s*:=\s*nullif\(v_claims ->> 'email', ''\)/)
    // session_user / current_user appear ONLY inside metadata, as labelled
    // facts, never as the actor columns.
    const values = fn.slice(fn.indexOf('values ('))
    const meta = values.slice(values.indexOf('jsonb_build_object'))
    const beforeMeta = values.slice(0, values.indexOf('jsonb_build_object'))
    expect(beforeMeta, 'actor columns must not read session_user').not.toContain('session_user')
    expect(beforeMeta, 'actor columns must not read current_user').not.toContain('current_user')
    expect(meta).toContain("'sessionUser'")
    expect(meta).toContain("'definerUser'")
  })

  it('44. an unattributed write is labelled as such, not guessed', () => {
    const s = sql()
    const fn = s.slice(s.indexOf('function public.audit_course_publication'), s.indexOf('$fn$;'))
    expect(fn).toMatch(/v_src\s+text\s*:=\s*'unattributed'/)
    expect(fn).toMatch(/case when v_actor is not null then 'admin' else 'system' end/)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// Emergency recovery. A half-disabled witness is the F-5 failure wearing a
// fix's clothes: publication continues, the record stops, and two of three
// triggers still show up in pg_trigger to reassure anyone who glances.
// ══════════════════════════════════════════════════════════════════════════
describe('F-5.2 — emergency recovery never leaves a partially disabled control', () => {
  const raw = () => read(M053)

  it('45. disabling a single recorder is NOT offered as a recovery path', () => {
    const r = raw()
    // The only permitted mentions of DISABLE TRIGGER are in the bypass analysis,
    // which describes it as an ATTACK. It must never appear as an instruction.
    const lines = r.split(/\r?\n/).filter(l => /disable trigger/i.test(l))
    for (const l of lines) {
      expect(l, `DISABLE TRIGGER offered as an operator action: ${l.trim()}`)
        .toMatch(/DISABLE TRIGGER, DROP TRIGGER|neither DISABLE TRIGGER nor/)
    }
    // Specifically, the old one-liner must be gone.
    expect(r).not.toMatch(/alter table public\.courses disable trigger courses_audit_publication_update;/)
  })

  it('46. the documented recovery order is repair, then FULL rollback', () => {
    const r = raw()
    expect(r).toMatch(/RECOVERY ORDER/)
    expect(r).toMatch(/A\. REPAIR THE WRITE PATH/)
    expect(r).toMatch(/B\. If F-5\.2 ITSELF is defective/)
    expect(r).toMatch(/C\. DO NOT disable a single recorder/)
    const a = r.indexOf('A. REPAIR THE WRITE PATH')
    const b = r.indexOf('B. If F-5.2 ITSELF is defective')
    const c = r.indexOf('C. DO NOT disable a single recorder')
    expect(a).toBeLessThan(b)
    expect(b).toBeLessThan(c)
  })

  it('47. the rollback is all-or-nothing and says why', () => {
    const r = raw()
    // All three recorders and both functions, so the probe goes false and the
    // verifier fails loudly rather than the gap being forgotten.
    for (const t of ['update', 'insert', 'delete'])
      expect(r).toMatch(new RegExp(`drop trigger if exists courses_audit_publication_${t} on public\\.courses;`))
    expect(r).toMatch(/drop function if exists public\.audit_course_publication\(\);/)
    expect(r).toMatch(/drop function if exists public\.publication_governance_installed\(\);/)
    expect(r).toMatch(/Run it WHOLE/)
  })
})
// ══════════════════════════════════════════════════════════════════════════
describe('F-5.2 — migration numbering governance holds', () => {
  const files = () => readdirSync(join(ROOT, MIGRATIONS)).filter(f => f.endsWith('.sql'))

  it('30. 046 stays withdrawn; 050 and 051 stay reserved', () => {
    const f = files()
    expect(f.filter(x => x.startsWith('046')), '046 must never exist').toEqual([])
    expect(f.filter(x => x.startsWith('050')), '050 is reserved for the withdrawal-contract RLS phase').toEqual([])
    expect(f.filter(x => x.startsWith('051')), '051 is reserved for voice lexicon hardening').toEqual([])
  })

  it('31. 052 and 053 each exist exactly once, and 053 is the highest', () => {
    const f = files()
    expect(f.filter(x => x.startsWith('052'))).toHaveLength(1)
    expect(f.filter(x => x.startsWith('053'))).toHaveLength(1)
    const nums = f.map(x => /^(\d{3})_/.exec(x)?.[1]).filter(Boolean).map(Number)
    expect(Math.max(...nums)).toBe(53)
    expect(new Set(nums).size).toBe(nums.length)
  })

  it('32. 053 is transactional, forward-only and marked NOT APPLIED', () => {
    const raw = read(M053)
    const s = stripSql(raw)
    expect(s).toMatch(/^begin;/m)
    expect(s).toMatch(/^commit;/m)
    expect(raw).toMatch(/NOT APPLIED AT AUTHORING TIME/)
    expect(raw, 'a corrective without a documented rollback is not reversible')
      .toMatch(/ROLLBACK/)
    expect(raw).toMatch(/drop trigger if exists courses_audit_publication_update/)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('F-5.2 — the runtime proof lives outside vitest', () => {
  it('33. the standing verifier and its approved manifest exist', () => {
    expect(has(VERIFY),
      'every database assertion above is STATIC; the verifier is where they get a runtime proof').toBe(true)
    expect(has(MANIFEST), 'a verifier with no approved state proves nothing').toBe(true)
  })

  it('34. the verifier reaches what static analysis cannot', () => {
    const v = read(VERIFY)
    expect(v, 'a live DISABLE TRIGGER is only catchable by asking the database')
      .toMatch(/publication_governance_installed/)
    expect(v, 'drift with no explaining event is the F-5 shape and must FAIL').toMatch(/UNACCOUNTED/)
    expect(v, 'drift the audit explains is legitimate owner work and must NOT fail').toMatch(/ACCOUNTED/)
    expect(v, 'a verifier that recorded nothing must not report PASS').toMatch(/INCONCLUSIVE/)
    expect(v, 'must be read-only').toMatch(/method: 'GET'/)
    for (const w of ['.insert(', '.update(', '.delete(', 'method: \'DELETE\'', 'method: \'PATCH\''])
      expect(v, `the verifier must not ${w}`).not.toContain(w)
  })

  it('35. the manifest is a RULING, and encodes TODAY not migration 049', () => {
    const m = JSON.parse(read(MANIFEST))
    expect(m.approved_by, 'someone must own the approved state').toBeTruthy()
    expect(m.ruling).toBeTruthy()
    expect(Array.isArray(m.approved_state)).toBe(true)
    // The owner ruled the 2026-09-05 publications legitimate. Encoding 049's
    // 5-published state would make the verifier demand a restoration the owner
    // has explicitly refused.
    const published = m.approved_state.filter((c: { is_published: boolean }) => c.is_published)
    expect(published).toHaveLength(m.approved_state.length)
    for (const slug of ['mesurer-l-experience-client', 'developper-une-culture-client']) {
      const c = m.approved_state.find((x: { slug: string }) => x.slug === slug)
      expect(c, `${slug} must be in the approved state`).toBeTruthy()
      expect(c.is_published, `${slug} was ruled legitimately published`).toBe(true)
    }
  })

  it('36. this suite does not claim any trigger fires', () => {
    // A deliberate, load-bearing absence. Every 053 assertion above reads TEXT.
    // If a later test here promises runtime behaviour, that is the moment to
    // stop and put it in the verifier instead.
    expect(true).toBe(true)
  })
})
