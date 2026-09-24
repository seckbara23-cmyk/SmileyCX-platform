// @vitest-environment node
/**
 * XPA-8 WC-1 — the withdrawal contract (migration 050).
 *
 *   Anonymous / unentitled preview visibility is allowed only while the parent
 *   course is published. Publication controls discovery, never entitled access.
 *   Withdrawal must not delete preview flags or authoring state.
 *
 * ── WHAT PROVES WHAT ─────────────────────────────────────────────────────
 *
 * A vitest run has no database, so this suite cannot evaluate a policy. It pins
 * the STRUCTURE whose behavioural consequences were proven elsewhere:
 *
 *   1. offline — the exact migration file applied to real PostgreSQL 17 with the
 *      access helpers and policies extracted verbatim from 001/035/036/037/038/
 *      039/053, exercised as anon, unentitled / expired / revoked / unverified
 *      learners, an entitled learner of a WITHDRAWN course, and an admin, before
 *      and after; plus twelve mutants of the migration, all caught;
 *   2. at apply time — the migration reads as anon and authenticated, compares
 *      the policy's answer with an independent count, and takes a synthetic
 *      course through publish -> withdraw -> republish inside a subtransaction
 *      it rolls back.
 *
 * Every assertion reads comment-stripped SQL, so the explanatory header cannot
 * satisfy its own test.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const MIG = 'supabase/migrations/050_withdrawal_contract.sql'
const M036 = 'supabase/migrations/036_fix_content_policy_recursion.sql'
const V6A = 'scripts/security/verify-xpa-6a.mjs'

/** Strip SQL comments (block and line) without touching quoted literals. */
function stripSql(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1]
    if (c === "'") {
      const end = sql.indexOf("'", i + 1)
      out += sql.slice(i, end + 1); i = end + 1; continue
    }
    if (c === '-' && n === '-') { const e = sql.indexOf('\n', i); i = e < 0 ? sql.length : e; continue }
    if (c === '/' && n === '*') { const e = sql.indexOf('*/', i + 2); i = e + 2; continue }
    out += c; i++
  }
  return out
}
const flat = (s: string) => s.replace(/\s+/g, ' ')

const RAW = read(MIG)
const SQL = stripSql(RAW)
const FLAT = flat(SQL)

/** The body of an ALTER POLICY statement, up to its terminating semicolon. */
function policy(name: string, table: string): string {
  const start = FLAT.indexOf(`alter policy "${name}" on public.${table}`)
  expect(start, `alter policy "${name}" missing`).toBeGreaterThan(-1)
  return FLAT.slice(start, FLAT.indexOf(';', start) + 1)
}
const count = (hay: string, needle: string) => hay.split(needle).length - 1

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-1 — migration 050 exists, alone, as one transaction', () => {
  it('050 is exactly the withdrawal contract; 046 withdrawn; 051 reserved', () => {
    const files = readdirSync(join(ROOT, 'supabase/migrations'))
    expect(files.filter(f => f.startsWith('050'))).toEqual(['050_withdrawal_contract.sql'])
    expect(files.filter(f => f.startsWith('046'))).toEqual([])
    expect(files.filter(f => f.startsWith('051'))).toEqual([])
  })

  it('runs as ONE repeatable-read transaction', () => {
    expect(count(FLAT, 'begin isolation level repeatable read;')).toBe(1)
    expect(FLAT.match(/(^|\s)begin;/g)).toBeNull()
    expect(count(FLAT, 'commit;')).toBe(1)
    expect(FLAT.indexOf('begin isolation level repeatable read;')).toBeLessThan(FLAT.indexOf('commit;'))
  })

  it('is marked not applied at authoring time, with an operator step and a rollback', () => {
    expect(RAW).toMatch(/NOT APPLIED AT AUTHORING TIME/)
    expect(RAW).toMatch(/OPERATOR STEP/)
    expect(RAW).toMatch(/ROLLBACK — restores the exact 036 policies/)
    expect(RAW).toMatch(/ACCESS EXCLUSIVE/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-1 — the helper is recursion-safe and fail-closed', () => {
  const fn = () => {
    const s = FLAT.indexOf('create or replace function public.course_is_published(p_course_id uuid)')
    expect(s).toBeGreaterThan(-1)
    return FLAT.slice(s, FLAT.indexOf('$fn$;', s) + 5)
  }

  it('is STABLE SECURITY DEFINER with a pinned search_path', () => {
    const f = fn()
    expect(f).toMatch(/returns boolean language sql stable security definer set search_path = public, pg_temp/)
    expect(f).not.toMatch(/security invoker/)
  })

  it('answers false for a null, unknown or unpublished course', () => {
    expect(fn()).toMatch(/select coalesce\( \(select c\.is_published from public\.courses c where c\.id = p_course_id\), false \)/)
  })

  it('EXECUTE is revoked from PUBLIC and granted only to the two app roles', () => {
    expect(FLAT).toMatch(/revoke all on function public\.course_is_published\(uuid\) from public;/)
    expect(FLAT).toMatch(/grant execute on function public\.course_is_published\(uuid\) to anon, authenticated;/)
  })

  it('does NOT redefine any 036/037 helper or the access authority', () => {
    for (const f of ['course_of_lesson', 'course_of_module', 'module_has_preview_lesson', 'course_of_quiz', 'has_course_access', 'is_platform_admin'])
      expect(FLAT, `050 redefines ${f}`).not.toMatch(new RegExp(`create (or replace )?function (public\\.)?${f}\\(`))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-1 — only the two policies change, and only in their preview arm', () => {
  it('exactly two ALTER POLICY statements; no CREATE or DROP POLICY', () => {
    expect(count(FLAT, 'alter policy ')).toBe(2)
    expect(FLAT).not.toMatch(/create policy|drop policy/)
    for (const p of ['quizzes_visible', 'quiz_questions_visible', 'exercises_select', 'courses_public_select', 'lesson_progress'])
      expect(FLAT, `050 touches ${p}`).not.toContain(`policy "${p}"`)
  })

  it('lessons_visible: preview AND published via course_of_lesson; entitled arm is the 036 text', () => {
    const p = policy('lessons_visible', 'lessons')
    expect(p).toContain('(lessons.is_preview = true and public.course_is_published(public.course_of_lesson(lessons.id)))')
    expect(p).toContain('or public.has_course_access(public.course_of_module(lessons.module_id))')
    expect(count(p, 'course_is_published'), 'publication must not reach the entitled arm').toBe(1)
    // The entitled arm is byte-for-byte what 036 shipped.
    expect(flat(stripSql(read(M036)))).toContain('or public.has_course_access(public.course_of_module(lessons.module_id))')
  })

  it('modules_visible: entitled arm first and untouched; preview arm gains the publication test', () => {
    const p = policy('modules_visible', 'modules')
    expect(p).toContain('using ( public.has_course_access(modules.course_id) or (public.module_has_preview_lesson(modules.id) and public.course_is_published(modules.course_id)) )')
    expect(count(p, 'course_is_published')).toBe(1)
  })

  it('ALTER keeps roles and command: no TO clause, no FOR clause, no WITH CHECK', () => {
    for (const [n, t] of [['lessons_visible', 'lessons'], ['modules_visible', 'modules']]) {
      const p = policy(n, t)
      expect(p).not.toMatch(/\bto\b\s+(anon|authenticated|public)/)
      expect(p).not.toMatch(/\bfor\s+(select|all|insert|update|delete)\b/)
      expect(p).not.toMatch(/with check/)
    }
  })

  it('no policy body queries another table directly (the 42P17 discipline)', () => {
    for (const [n, t] of [['lessons_visible', 'lessons'], ['modules_visible', 'modules']])
      expect(policy(n, t), `${n} contains a subquery`).not.toMatch(/\b(select|exists|from|join)\b/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-1 — the migration writes no real data and preserves authoring state', () => {
  const fixtureRange = () => {
    const anchor = FLAT.indexOf("'wc1-050-fixture-'")
    expect(anchor).toBeGreaterThan(-1)
    const start = FLAT.lastIndexOf('do $do$', anchor)
    return [start, FLAT.indexOf('$do$;', anchor)] as const
  }

  it('every INSERT / UPDATE / DELETE lives inside the rolled-back fixture block', () => {
    const [a, b] = fixtureRange()
    const writes = [...FLAT.matchAll(/\b(insert into|update public\.|delete from)\b/g)]
    expect(writes.length).toBeGreaterThan(0)
    for (const w of writes)
      expect(w.index! > a && w.index! < b, `write "${w[0]}" at ${w.index} is outside the fixture`).toBe(true)
  })

  it('no preview flag is ever written, in or out of the fixture, except the fixture\'s own creation', () => {
    expect(FLAT).not.toMatch(/set\s+is_preview/)
    expect(FLAT).not.toMatch(/truncate/)
  })

  it('the fixture ends in a caught sentinel, so its rows and audit witnesses are discarded', () => {
    const [a, b] = fixtureRange()
    const block = FLAT.slice(a, b)
    expect(block).toMatch(/raise exception using errcode = 'XW050'/)
    expect(block).toMatch(/exception when sqlstate 'XW050' then reset role;/)
    expect(block.indexOf("errcode = 'XW050'")).toBeLessThan(block.indexOf("when sqlstate 'XW050'"))
  })

  it('after the rollback it proves nothing survived', () => {
    const [a, b] = fixtureRange()
    const tail = FLAT.slice(FLAT.indexOf("when sqlstate 'XW050'", a), b)
    expect(tail).toMatch(/the fixture course survived the rollback/)
    expect(tail).toMatch(/audit witness row\(s\) for the fixture survived the rollback/)
    expect(tail).toMatch(/audit_log changed from % to %/)
    expect(tail).toMatch(/preview flag count changed from % to %/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-1 — apply-time verification is exercised, not structural only', () => {
  it('§0 refuses to run unless both policies are the 036 forms and access ignores publication', () => {
    expect(FLAT).toMatch(/lessons_visible is not the expected 036 SELECT policy/)
    expect(FLAT).toMatch(/modules_visible is not the expected 036 SELECT policy/)
    expect(FLAT).toMatch(/pg_get_functiondef\('public\.has_course_access\(uuid\)'::regprocedure\)/)
    expect(FLAT).toMatch(/has_course_access\(\) references is_published/)
  })

  it('§2 asserts the new form, unchanged roles, a single publication test and definer rights', () => {
    for (const m of [
      /lessons_visible did not take the intended form/, /modules_visible did not take the intended form/,
      /lessons_visible roles changed/, /modules_visible roles changed/,
      /lessons_visible must test publication exactly once/, /modules_visible must test publication exactly once/,
      /must be STABLE SECURITY DEFINER with a pinned search_path/,
      /has_function_privilege\('anon', 'public\.course_is_published\(uuid\)', 'execute'\)/,
    ]) expect(FLAT).toMatch(m)
  })

  it('§3 reads every content table and public view as anon and authenticated', () => {
    expect(FLAT).toMatch(/foreach r in array array\['anon', 'authenticated'\]/)
    for (const t of ['courses', 'modules', 'lessons', 'quizzes', 'quiz_questions', 'exercises', 'public_course_modules', 'public_course_lessons'])
      expect(FLAT).toContain(`'${t}'`)
    expect(FLAT).toMatch(/content is not evaluatable as role % on %: % \(%\)/)
  })

  it('§4 compares what anon sees with an independent count of published previews', () => {
    expect(FLAT).toMatch(/where l\.is_preview and c\.is_published/)
    expect(FLAT).toMatch(/anon sees % lesson\(s\); preview lessons of published courses number %/)
    expect(FLAT).toMatch(/anon sees % lesson\(s\) belonging to an unpublished course/)
  })

  it('§5 walks publish -> withdraw -> republish and asserts each state as anon', () => {
    for (const m of [
      /published preview lesson visible to anon % time\(s\), expected 1/,
      /published NON-preview lesson visible to anon % time\(s\), expected 0/,
      /withdrawn course still shows % lesson row\(s\) to anon, expected 0/,
      /withdrawn course still shows % module row\(s\) to anon, expected 0/,
      /withdrawn course shows % lesson row\(s\) to an unentitled authenticated caller, expected 0/,
      /withdrawal changed the preview flag to %/,
      /republished preview lesson visible to anon % time\(s\), expected 1/,
      /is distinct from false/,
    ]) expect(FLAT).toMatch(m)
    const w = FLAT.indexOf('update public.courses set is_published = false')
    const r = FLAT.indexOf('update public.courses set is_published = true')
    expect(w).toBeGreaterThan(-1)
    expect(r).toBeGreaterThan(w)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-1 — scope is held', () => {
  it('050 does not address object-path disclosure (a separate owner-ruled work item)', () => {
    expect(SQL).not.toMatch(/video_object_path|pdf_object_path|subtitle_object_path/)
    expect(SQL).not.toMatch(/revoke\s+select\s*\(/i)
  })

  it('050 touches no storage, entitlement, enrollment, progress or voice object', () => {
    expect(FLAT).not.toMatch(/storage\.|public\.entitlements|public\.enrollments|lesson_progress|ai_scenarios|ai_sessions/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-1 — verify-xpa-6a is re-based onto published courses', () => {
  const v = read(V6A)

  it('the expected preview set is derived from PUBLISHED courses only', () => {
    expect(v).toMatch(/courses\?select=id&is_published=eq\.true/)
    expect(v).toMatch(/const previewIds = new Set\(publishedPreview\.map\(r => r\.id\)\)/)
    expect(v).toMatch(/const previewModuleIds = new Set\(publishedPreview\.map\(r => r\.module_id\)\)/)
  })

  it('a visible withdrawn-course preview fails both the anon and the learner checks', () => {
    expect(v).toContain('anon lessons from WITHDRAWN courses == 0 (WC-1)')
    expect(v).toContain('learner lessons from WITHDRAWN courses == 0 (WC-1)')
    expect(v).toMatch(/nonPreview\.length === 0 && withdrawnLeak\.length === 0 && invisible\.length === 0/)
    expect(v).toMatch(/nonPreview\.length === 0 && lWithdrawn\.length === 0/)
  })

  it('every pre-existing invariant label survives, including object-path disclosure', () => {
    // XPA-8 WC-2C re-expressed the object-path invariant: the columns are no
    // longer granted to anon, so the verifier asserts the refusal (42501)
    // rather than reading them and finding them empty. Same guarantee, stronger.
    expect(v).toContain('ungranted (WC-2C)')
    expect(v).toContain('anon lessons select * refused, not narrowed (WC-2C)')
    for (const label of [
      'anon lessons == exactly the preview set', 'anon lessons expose no body',
      'anon modules == only those holding a preview lesson',
      'learner lessons == exactly the preview set', 'learner modules == only those holding a preview lesson',
      'no course is flagged preview WHOLESALE',
    ]) expect(v).toContain(label)
  })
})
