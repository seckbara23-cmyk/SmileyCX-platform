// @vitest-environment node
/**
 * CAT-ARCH-02 — the V8 registry, and the order V8 asks the learner to see.
 *
 * ── WHAT THIS SLICE IS ────────────────────────────────────────────────────
 *
 * Migration 057 is DATA ONLY. It creates nothing, drops nothing, grants
 * nothing, and writes exactly one table: `public.course_codes`. Under owner
 * rulings R1–R4 it
 *
 *   R1   renames C1-F3's registry label to the LMS name V8 ratifies,
 *   R2   sets C2 display order to F4, F1, F2, F5 with F3/F6 appended,
 *   R3   registers C3-F9 (unproduced, no invented prose),
 *   R4a  registers C1-F4 at position 1, shifting F1->2, F2->3, F3->4,
 *
 * and deliberately does NOT do R4b — `donnez-envie-a-vos-clients-de-revenir`
 * is not assigned C1-F4, because that assignment is irreversible (028's
 * `courses_code_immutable`) and belongs to the owner in the Admin form.
 *
 * ── WHAT IS PROVEN HERE, AND WHAT IS NOT ──────────────────────────────────
 *
 * These assertions read migration SOURCE TEXT. They prove the migration says
 * what the rulings say, and — more usefully — that it says nothing else: the
 * statement parser below rejects a write to any table other than the registry,
 * which is how "no course, no lesson, no entitlement" is guaranteed rather
 * than hoped for.
 *
 * What source text CANNOT prove is behaviour against real data. That is proven
 * by the offline PGlite harness (scratchpad, not committed), which applies 028,
 * 031 and the real 056 to the live production corpus, applies 057, and then
 * checks the registry, the public projection, the fingerprints, the WC-2
 * grants, the DELETE refusal and the documented rollback — plus 24 mutants of
 * 057, every one of which is caught.
 *
 * The visible-order claim is asserted twice over: once here as the exact
 * string the migration must demand, and once inside the migration itself,
 * which reads it back through 056's view and refuses to commit on anything
 * else.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const MIG = 'supabase/migrations/057_v8_registry_reorder.sql'
const RAW = read(MIG)
/** Comments blanked, so a comment can never satisfy an assertion. */
const SQL = RAW.replace(/--[^\n]*/g, '')
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')
const files = () => readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql'))

/** The order V8 requires, and the only order this migration may produce. */
const EXPECTED_POSITIONS =
  "'C1-F1@2,C1-F2@3,C1-F3@4,C1-F4@1,'"
const VISIBLE_AFTER = 'C1-F1,C1-F2,C1-F3,C2-F4,C2-F1,C2-F2,C2-F5'
const VISIBLE_BEFORE = 'C1-F1,C1-F2,C1-F3,C2-F1,C2-F2,C2-F4,C2-F5'

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-ARCH-02 — 057 exists, alone, as one transaction', () => {
  it('057 is exactly this migration; 054/055/056 intact; 046 withdrawn; 051 reserved', () => {
    const f = files()
    expect(f.filter(x => x.startsWith('057'))).toEqual(['057_v8_registry_reorder.sql'])
    expect(f.filter(x => x.startsWith('056'))).toEqual(['056_catalogue_display_order.sql'])
    expect(f.filter(x => x.startsWith('055'))).toEqual(['055_restrict_lesson_media_columns.sql'])
    expect(f.filter(x => x.startsWith('054'))).toEqual(['054_lesson_media_derived_source.sql'])
    expect(f.filter(x => x.startsWith('046'))).toEqual([])
    expect(f.filter(x => x.startsWith('051'))).toEqual([])
    expect(f.filter(x => parseInt(x, 10) > 57)).toEqual([])
    const nums = f.map(x => /^(\d{3})_/.exec(x)?.[1]).filter(Boolean).map(Number)
    expect(Math.max(...nums)).toBe(57)
    expect(new Set(nums).size).toBe(nums.length)
  })

  it('the three migrations this slice depends on are byte-identical', () => {
    // 057 is only correct if 054/055 still withhold the media columns and 056
    // still defines the projection and the deferrable constraint.
    const blob = (p: string) =>
      execFileSync('git', ['hash-object', p], { cwd: ROOT, encoding: 'utf8' }).trim()
    expect(blob('supabase/migrations/054_lesson_media_derived_source.sql'))
      .toBe('b0cdf55a28d05d82af4ca16c1be388bdc327bb55')
    expect(blob('supabase/migrations/055_restrict_lesson_media_columns.sql'))
      .toBe('4d1337e104d6049cc097eacd5d384c6f39102a72')
    expect(blob('supabase/migrations/056_catalogue_display_order.sql'))
      .toBe('c95391b85128e076360268a35fdff2d4910de5fd')
  })

  it('runs as ONE repeatable-read transaction', () => {
    expect((SQL.match(/begin isolation level repeatable read;/g) ?? []).length).toBe(1)
    expect(SQL.match(/(^|\s)begin;/g)).toBeNull()
    expect((SQL.match(/^commit;/gm) ?? []).length).toBe(1)
    expect(SQL.indexOf('begin isolation level repeatable read;')).toBeLessThan(SQL.indexOf('commit;'))
  })

  it('is marked not applied, and carries an operator step and a rollback', () => {
    expect(RAW).toMatch(/NOT APPLIED AT AUTHORING TIME/)
    expect(RAW).toMatch(/OPERATOR STEP/)
    expect(RAW).toMatch(/ROLLBACK — PARTIAL BY DESIGN/)
    // The rollback must be honest that the two inserts can never be undone.
    expect(RAW).toMatch(/CANNOT be removed once this migration commits/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-ARCH-02 — 057 writes the registry and NOTHING else', () => {
  /**
   * Every data-modifying statement in the executable SQL, with the table it
   * targets. This is the assertion that makes "no course / lesson / path /
   * entitlement / certificate is touched" a proof rather than a claim: any new
   * write to any other table fails the next test, whatever it is.
   */
  const writes = () => {
    const out: { verb: string; table: string }[] = []
    for (const m of SQL.matchAll(/\b(insert\s+into|update|delete\s+from|truncate)\s+(?:only\s+)?([a-z_]+\.[a-z_]+|[a-z_]+)/gi)) {
      const verb = m[1].toLowerCase().replace(/\s+/g, ' ')
      out.push({ verb, table: m[2].toLowerCase() })
    }
    return out
  }

  it('every write targets public.course_codes — no other table is written', () => {
    const w = writes()
    expect(w.length).toBeGreaterThan(0)
    for (const { verb, table } of w) {
      expect(table, `${verb} ${table} is outside this slice`).toBe('public.course_codes')
    }
  })

  it('writes are exactly: one title update, one insert of two codes, two repositions', () => {
    const w = writes()
    expect(w.filter(x => x.verb === 'insert into')).toHaveLength(1)
    expect(w.filter(x => x.verb === 'update')).toHaveLength(3)
    expect(w.filter(x => x.verb.startsWith('delete'))).toHaveLength(0)
    expect(w.filter(x => x.verb === 'truncate')).toHaveLength(0)
  })

  it('names no learner-state or content table in a write', () => {
    for (const t of ['courses', 'modules', 'lessons', 'learning_paths', 'learning_path_courses',
                     'catalogues', 'entitlements', 'enrollments', 'lesson_progress',
                     'certificates', 'quiz_questions', 'quiz_attempts', 'audit_log']) {
      expect(SQL, `writes public.${t}`)
        .not.toMatch(new RegExp(`(insert\\s+into|update|delete\\s+from|truncate)\\s+public\\.${t}\\b`, 'i'))
    }
  })

  it('creates, alters and drops nothing, and grants nothing', () => {
    // The one CREATE permitted is the temp snapshot table, which ON COMMIT DROPs.
    const creates = [...SQL.matchAll(/create\s+(\w+)/gi)].map(m => m[1].toLowerCase())
    expect(creates).toEqual(['temp'])
    expect(SQL).toMatch(/create temp table cat_arch_02_before on commit drop/)
    expect(SQL).not.toMatch(/\balter\s+table\b/i)
    expect(SQL).not.toMatch(/\bdrop\s+(table|view|column|constraint|trigger|policy|function)\b/i)
    expect(SQL, 'a data migration must not move a privilege').not.toMatch(/^\s*(grant|revoke)\b/im)
  })

  it('touches no publication flag and no preview flag', () => {
    expect(SQL).not.toMatch(/set[^;]*\bis_published\s*=/i)
    expect(SQL).not.toMatch(/set[^;]*\bis_preview\s*=/i)
    // is_published/is_preview may only appear inside READ predicates.
    for (const m of SQL.matchAll(/\bis_(published|preview)\b/g)) {
      const around = SQL.slice(Math.max(0, m.index! - 60), m.index! + 20)
      expect(around, `is_${m[1]} used in a write`).not.toMatch(/\bset\b[^;]*$/i)
    }
  })

  it('mentions no storage, media or answer-key column at all', () => {
    for (const col of ['video_url', 'pdf_url', 'subtitle_url', 'correct_answer',
                       'storage.', 'bucket']) {
      expect(SQL, `057 names ${col}`).not.toContain(col)
    }
    // The three object-path columns appear ONLY inside the WC-2 privilege guard.
    for (const col of ['video_object_path', 'pdf_object_path', 'subtitle_object_path']) {
      for (const m of SQL.matchAll(new RegExp(col, 'g'))) {
        expect(SQL.slice(Math.max(0, m.index! - 90), m.index!),
          `${col} outside a privilege check`).toMatch(/has_column_privilege\(/)
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-ARCH-02 — the rulings, exactly as approved', () => {
  it('R1: C1-F3 takes the V8 LMS name, and only the registry label moves', () => {
    expect(SQL).toMatch(
      /update public\.course_codes\s+set canonical_title = 'Communiquer avec les clients sur les canaux digitaux',\s+updated_at\s+= now\(\)\s+where code = 'C1-F3';/)
    // The course row's own title is never written (already covered by the write
    // parser; asserted again on the literal, because this is the specific
    // mistake R1 invites).
    expect(SQL).not.toMatch(/update public\.courses[\s\S]{0,120}title/i)
    // And the migration refuses to start unless it is renaming FROM the V4 label.
    expect(SQL).toMatch(/expected the V4 label; R1 was ruled against that value/)
  })

  it('R3 + R4a: exactly two codes are registered, with no invented prose', () => {
    const ins = SQL.slice(SQL.indexOf('insert into public.course_codes'))
    const rows = [...ins.matchAll(/\('(C\d-F\d)', '(C\d)', '([^']*(?:''[^']*)*)',\s*(null|'[^']*'),\s*(null|'[^']*'),\s*(\d+), '(\w+)'\)/g)]
    expect(rows).toHaveLength(2)
    expect(rows.map(r => [r[1], r[2], r[3], r[4], r[5], Number(r[6]), r[7]])).toEqual([
      ['C1-F4', 'C1', 'Donnez envie à vos clients de revenir', 'null', 'null', 1, 'undecided'],
      ['C3-F9', 'C3', 'Symétrie des attentions & expérience collaborateur', 'null', 'null', 9, 'undecided'],
    ])
  })

  it('R2 + R4a: the position updates are exactly the ruled values', () => {
    expect(SQL).toMatch(/\(values \('C1-F1', 2\), \('C1-F2', 3\), \('C1-F3', 4\)\) as v\(code, position\)/)
    expect(SQL).toMatch(/\(values \('C2-F4', 1\), \('C2-F1', 2\), \('C2-F2', 3\),\s+\('C2-F5', 4\), \('C2-F3', 5\), \('C2-F6', 6\)\) as v\(code, position\)/)
    // C3's existing eight codes are not repositioned — only F9 is appended.
    expect(SQL).not.toMatch(/'C3-F[1-8]',\s*\d+\)/)
  })

  it('R4b is NOT performed: no code is assigned to the eighth course', () => {
    // The slug may appear only in a read predicate or an assertion message.
    const slug = 'donnez-envie-a-vos-clients-de-revenir'
    expect(SQL).toContain(slug)
    for (const m of SQL.matchAll(new RegExp(slug, 'g'))) {
      const before = SQL.slice(Math.max(0, m.index! - 200), m.index!)
      expect(before, 'the eighth course appears in a write').not.toMatch(/update\s+public\.courses[\s\S]*$/i)
    }
    expect(SQL).not.toMatch(/set\s+code\s*=/i)
    expect(SQL).not.toMatch(/update public\.courses/i)
    // And it is proven at apply time, on the row itself.
    expect(SQL).toMatch(/the eighth course row changed/)
    expect(SQL).toMatch(/and code is null/)
    expect(RAW).toMatch(/R4b/)
  })

  it('R4c is NOT performed: the publication manifest is untouched', () => {
    expect(SQL).not.toMatch(/manifest/i)
    // The manifest still records 7 approved courses; 057 is not the change that
    // updates it (separate PR, per the ruling).
    const manifest = JSON.parse(read('scripts/security/publication-manifest.json'))
    expect(manifest.approved_state).toHaveLength(7)
  })

  it('no launch status is invented and nothing is retired', () => {
    // `'launch'` and `'retired'` DO appear — inside read predicates that abort if
    // either has been applied. What must not exist is a write to `status`.
    expect(SQL).not.toMatch(/set[^;]*status\s*=/i)
    for (const lit of ["'launch'", "'retired'"]) {
      for (const m of SQL.matchAll(new RegExp(lit, 'g'))) {
        expect(SQL.slice(Math.max(0, m.index! - 40), m.index!),
          `${lit} outside a read predicate`).toMatch(/status\s*=\s*$|where\s+$|status\s+=\s+$/)
      }
    }
    expect(SQL).toMatch(/a launch status was invented while D-Q1 is still open/)
    expect(SQL).toMatch(/this migration retires nothing/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-ARCH-02 — what the migration refuses to commit on', () => {
  it('preflight: 056 applied, registry closed, exact pre-V8 state, no re-apply', () => {
    expect(SQL).toMatch(/migration 056 is not applied/)
    expect(SQL).toMatch(/condeferrable and condeferred/)
    expect(SQL).toMatch(/the registry is not closed/)
    expect(SQL).toMatch(/the registry is not in the audited pre-V8 state/)
    expect(SQL).toMatch(/refusing to re-apply/)
    // The exact audited starting positions, so a registry someone already
    // edited cannot be silently overwritten.
    expect(SQL).toMatch(/'C1-F1@1,C1-F2@2,C1-F3@3,'/)
    expect(SQL).toMatch(/'C2-F1@1,C2-F2@2,C2-F3@3,C2-F4@4,C2-F5@5,C2-F6@6,'/)
  })

  it('asserts the exact 19-code end state and per-catalogue contiguity', () => {
    expect(SQL).toMatch(/expected 19 \(was %\)/)
    expect(SQL).toMatch(new RegExp(EXPECTED_POSITIONS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    expect(SQL).toMatch(/'C2-F1@2,C2-F2@3,C2-F3@5,C2-F4@1,C2-F5@4,C2-F6@6,'/)
    expect(SQL).toMatch(/'C3-F1@1,C3-F2@2,C3-F3@3,C3-F4@4,C3-F5@5,C3-F6@6,C3-F7@7,C3-F8@8,C3-F9@9'/)
    expect(SQL).toMatch(/is not 1\.\.%/)
  })

  it('asserts the visible catalogue before AND after, through 056s own view', () => {
    expect(SQL).toContain(`'${VISIBLE_BEFORE}'`)
    expect(SQL).toContain(`'${VISIBLE_AFTER}'`)
    expect(SQL).toMatch(/from public\.public_catalogue_courses/)
    expect(SQL).toMatch(/the catalogue did not start from the audited order/)
    expect(SQL).toMatch(/Fondations unchanged until R4b/)
    // Fondations must not move, asserted directly as well as via the string.
    expect(SQL).toMatch(/C1-F4 entered the public catalogue/)
    expect(SQL).toMatch(/C3-F9 entered the public catalogue/)
    expect(SQL).toMatch(/expected 7 published coded course\(s\)/)
  })

  it('fingerprints every governed table it promises not to change', () => {
    for (const [col, tbl] of [['courses_md5', 'courses'], ['modules_md5', 'modules'],
                              ['lessons_md5', 'lessons'], ['paths_md5', 'learning_paths'],
                              ['membership_md5', 'learning_path_courses'],
                              ['catalogues_md5', 'catalogues'],
                              ['entitlements_md5', 'entitlements'],
                              ['enrollments_md5', 'enrollments'],
                              ['progress_md5', 'lesson_progress'],
                              ['certificates_md5', 'certificates']]) {
      expect(SQL, `no ${col} snapshot`).toContain(col)
      expect(SQL, `${tbl} is never read for the fingerprint`).toMatch(new RegExp(`from public\\.${tbl}\\b`))
    }
    // The eighth course gets its own fingerprint, so R4b has a dedicated proof.
    expect(SQL).toContain('eighth_course_md5')
    expect(SQL).toMatch(/if v_now is distinct from b\.courses_md5/)
    expect(SQL).toMatch(/if v_now is distinct from b\.entitlements_md5/)
    expect(SQL).toMatch(/if v_now is distinct from b\.certificates_md5/)
  })

  it('re-asserts the WC-2 and registry boundaries for both browser roles', () => {
    expect(SQL).toMatch(/foreach v_role in array array\['anon', 'authenticated'\] loop/)
    expect(SQL).toMatch(/regained SELECT on a raw lesson media column — WC-2 must stay closed/)
    expect(SQL).toMatch(/can read course_codes — the registry must stay closed/)
    expect(SQL).toMatch(/lost SELECT on the public projection/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-ARCH-02 — the application is not part of this slice', () => {
  it('the reader still resolves order through the 056 projection, unchanged', () => {
    const reader = read('lib/queries/catalogue.ts')
    expect(reader).toMatch(/\.from\('public_catalogue_courses'\)/)
    expect(reader).toMatch(/\.order\('catalogue_code'\)\s*\n\s*\.order\('position'\)/)
    // No new definition of catalogue order may appear in application code: the
    // order is data, and 057 is the change. Comments stripped — the file
    // legitimately explains the V8 case in prose.
    const code = reader.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toMatch(/C[123]-F\d/)
    expect(code).not.toMatch(/\.order\('code'\)/)
  })

  it('no application file hardcodes the V8 order', () => {
    for (const f of ['app/(public)/courses/page.tsx',
                     'app/(public)/courses/content.ts',
                     'lib/queries/catalogue.ts',
                     'app/(admin)/admin/catalogue/page.tsx']) {
      const s = read(f).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
      expect(s, `${f} hardcodes a V8 code`).not.toMatch(/'C[123]-F\d'/)
    }
  })

  it('the admin catalogue page still orders by the registry position', () => {
    const admin = read('app/(admin)/admin/catalogue/page.tsx')
    expect(admin).toMatch(/from\('course_codes'\)[\s\S]{0,120}\.order\('position'\)/)
  })
})
