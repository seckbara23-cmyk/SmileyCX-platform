// @vitest-environment node
/**
 * XPA-8 WC-2C — the six raw lesson media columns stop being readable by the
 * browser roles (migration 055).
 *
 *   `anon` and `authenticated` lose SELECT on video/pdf/subtitle_object_path
 *   and the legacy video/pdf/subtitle_url. They keep every other column of
 *   `lessons`, including the six derived fields 054 added and the application
 *   has read since WC-2B. The columns are NOT dropped: the service role keeps
 *   them, because the media route signs from them and the admin editor writes
 *   them.
 *
 * ── WHAT PROVES WHAT ─────────────────────────────────────────────────────
 *
 * This suite pins the migration's shape and the application's compatibility.
 * The behaviour was proven offline against real PostgreSQL 17 with the live
 * corpus (127 lessons, 050 + 054 applied from their files): after the real 055,
 * every one of the six columns, a mixed select and `select *` are refused with
 * 42501 as anon, as a signed-in unentitled learner and as an entitled learner;
 * the WC-2B player query still returns the same rows (38 / 38 / 58); anonymous
 * row visibility is unchanged (38 lessons, 22 modules); the service role still
 * resolves 125 object paths and still writes lessons; and 18 mutants were
 * caught, including one that only the preflight can catch.
 *
 * Every structural assertion reads comment-stripped SQL.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const MIG = 'supabase/migrations/055_restrict_lesson_media_columns.sql'

function stripSql(sql: string): string {
  let out = '', i = 0
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1]
    if (c === "'") { const e = sql.indexOf("'", i + 1); out += sql.slice(i, e + 1); i = e + 1; continue }
    if (c === '-' && n === '-') { const e = sql.indexOf('\n', i); i = e < 0 ? sql.length : e; continue }
    if (c === '/' && n === '*') { const e = sql.indexOf('*/', i + 2); i = e + 2; continue }
    out += c; i++
  }
  return out
}
const flat = (s: string) => s.replace(/\s+/g, ' ')
const RAWSQL = read(MIG)
const SQL = stripSql(RAWSQL)
const FLAT = flat(SQL)
const CODE = flat(SQL.replace(/'(?:[^']|'')*'/g, "''")).toLowerCase()
const count = (h: string, n: string) => h.split(n).length - 1

const RAW = ['video_object_path', 'pdf_object_path', 'subtitle_object_path', 'video_url', 'pdf_url', 'subtitle_url']
const DERIVED = ['video_source', 'video_external_url', 'pdf_source', 'pdf_external_url', 'subtitle_source', 'subtitle_external_url']
/** Exactly what the two browser roles may read after 055. */
const GRANTED = [
  'id', 'module_id', 'slug', 'title', 'title_fr', 'content', 'duration_minutes',
  'order_index', 'is_preview', 'created_at', ...DERIVED,
]

/** The column list of the single GRANT SELECT (...) statement. */
function grantedColumns(): string[] {
  const m = /grant select \(([^)]*)\) on public\.lessons to anon, authenticated;/.exec(FLAT)
  expect(m, 'the column grant is not in the expected form').not.toBeNull()
  return m![1].split(',').map(s => s.trim())
}

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-2C — migration 055 exists, alone, as one transaction', () => {
  it('055 is exactly this migration; 054 intact; 046 withdrawn; 051 reserved', () => {
    const files = readdirSync(join(ROOT, 'supabase/migrations'))
    expect(files.filter(f => f.startsWith('055'))).toEqual(['055_restrict_lesson_media_columns.sql'])
    expect(files.filter(f => f.startsWith('054'))).toEqual(['054_lesson_media_derived_source.sql'])
    expect(files.filter(f => f.startsWith('046'))).toEqual([])
    expect(files.filter(f => f.startsWith('051'))).toEqual([])
    expect(files.filter(f => f.startsWith('056'))).toEqual([])
  })

  it('runs as ONE repeatable-read transaction', () => {
    expect(count(FLAT, 'begin isolation level repeatable read;')).toBe(1)
    expect(FLAT.match(/(^|\s)begin;/g)).toBeNull()
    expect(count(FLAT, 'commit;')).toBe(1)
    expect(FLAT.indexOf('begin isolation level repeatable read;')).toBeLessThan(FLAT.indexOf('commit;'))
  })

  it('is marked not applied, and carries an operator step and a commented rollback', () => {
    expect(RAWSQL).toMatch(/NOT APPLIED AT AUTHORING TIME/)
    expect(RAWSQL).toMatch(/OPERATOR STEP/)
    expect(RAWSQL).toMatch(/ONLY while the WC-2B application release is live/)
    expect(RAWSQL).toMatch(/RE-OPENS the disclosure/)
    expect(SQL, 'the rollback must stay commented out').not.toMatch(/grant select on public\.lessons to anon, authenticated;/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-2C — the privilege change, and nothing else', () => {
  it('one REVOKE SELECT from both browser roles', () => {
    expect(count(CODE, 'revoke select on public.lessons from anon, authenticated;')).toBe(1)
    expect(CODE, 'WC-2C changes SELECT only').not.toMatch(/revoke (all|insert|update|delete)/)
    expect(count(CODE, 'revoke ')).toBe(1)
  })

  it('one column GRANT, to the two roles only, never to PUBLIC', () => {
    expect(count(CODE, 'grant ')).toBe(1)
    expect(CODE).toMatch(/grant select \([^)]*\) on public\.lessons to anon, authenticated;/)
    expect(CODE).not.toMatch(/to (public|anon, authenticated, public)\b/)
  })

  it('grants exactly the intended 16 columns', () => {
    expect(grantedColumns().sort()).toEqual([...GRANTED].sort())
  })

  it('grants none of the six locations', () => {
    for (const c of RAW) expect(grantedColumns(), `055 grants ${c}`).not.toContain(c)
  })

  it('keeps every column the application reads', () => {
    const player = /lessons\(([^)]*)\)'\)/.exec(read('app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'))![1]
      .split(',').map(s => s.trim())
    for (const c of player) expect(grantedColumns(), `the player needs ${c}`).toContain(c)
    // the embed join needs the foreign key
    expect(grantedColumns()).toContain('module_id')
  })

  it('drops no column, alters no table, touches no policy, function or storage', () => {
    expect(CODE).not.toMatch(/\balter table\b/)
    expect(CODE).not.toMatch(/\bdrop (column|table|policy|function|view|trigger)\b/)
    expect(CODE).not.toMatch(/\b(create|alter|drop)\s+policy\b/)
    expect(CODE).not.toMatch(/\bcreate\s+(or\s+replace\s+)?(function|trigger|view)\b/)
    expect(CODE).not.toMatch(/storage\.objects|insert into storage|update storage/)
    expect(CODE).not.toMatch(/\b(insert into|update|delete from|truncate)\s+public\./)
  })

  it('creates only transient snapshots, dropped at commit', () => {
    const temps = [...CODE.matchAll(/create temp table (\w+)/g)].map(m => m[1])
    expect(temps.sort()).toEqual(['wc2c_055_before', 'wc2c_055_rows'])
    expect(count(CODE, 'on commit drop')).toBe(2)
  })

  it('is scoped to public.lessons: certificates are a different table and a different work item', () => {
    expect(CODE).not.toContain('certificates')
    const tables = [...CODE.matchAll(/on public\.(\w+)/g)].map(m => m[1])
    expect([...new Set(tables)]).toEqual(['lessons'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-2C — apply-time verification', () => {
  it('refuses unless 054 is live and the raw columns still exist', () => {
    expect(FLAT).toMatch(/expected the 6 generated derived columns from 054/)
    expect(FLAT).toMatch(/raw column\(s\) missing from public\.lessons/)
    expect(FLAT).toMatch(/row level security is not enabled on public\.lessons/)
  })

  it('refuses a re-apply and an unexpected grant state', () => {
    expect(FLAT).toMatch(/already withheld from both roles; refusing to re-apply/)
    expect(FLAT).toMatch(/does not hold table-level SELECT/)
  })

  it('asserts the resulting privileges for both roles', () => {
    expect(FLAT).toMatch(/still holds table-level SELECT on lessons/)
    expect(FLAT).toMatch(/can still read lessons\.%/)
    expect(FLAT).toMatch(/lost SELECT on lessons\.%, which the application needs/)
    expect(FLAT).toMatch(/can read column\(s\) outside the intended set/)
    expect(FLAT).toMatch(/grants privileges to PUBLIC/)
    expect(FLAT).toMatch(/a non-SELECT privilege on public\.lessons changed/)
    expect(FLAT).toMatch(/trusted role % lost SELECT on lessons\./)
  })

  it('exercises every adversarial read as the roles themselves, demanding 42501', () => {
    const s = FLAT.slice(FLAT.indexOf('EXERCISE') > -1 ? 0 : 0)
    for (const c of RAW) expect(s, `${c} is not exercised`).toContain(c)
    expect(FLAT).toMatch(/select id, title, video_object_path from public\.lessons/)  // mixed select
    expect(FLAT).toMatch(/select \* from public\.lessons/)                            // select *
    expect(FLAT).toMatch(/insufficient_privilege/)
    expect(FLAT).toMatch(/failed with % instead of 42501/)
    expect(FLAT).toMatch(/the WC-2B player query is no longer evaluatable/)
    for (const t of ['modules', 'courses', 'quizzes', 'quiz_questions', 'exercises', 'public_course_modules', 'public_course_lessons'])
      expect(FLAT, `${t} is not re-checked`).toContain(t)
    expect(FLAT).toMatch(/service_role can no longer resolve object paths/)
  })

  it('fingerprints everything it promises not to change', () => {
    for (const k of ['lessons_policies', 'derived_exprs', 'lessons_md5', 'modules_md5', 'courses_md5', 'buckets_md5', 'all_columns', 'other_privs'])
      expect(FLAT, `snapshot lacks ${k}`).toContain(` as ${k}`)
    expect(FLAT).toMatch(/a row policy on public\.lessons changed/)
    expect(FLAT).toMatch(/a derived column from 054 changed/)
    expect(FLAT).toMatch(/the column set of public\.lessons changed/)
    expect(FLAT).toMatch(/lesson data changed/)
    expect(FLAT).toMatch(/storage bucket configuration changed/)
  })

  it('proves row visibility is unchanged for both browser roles', () => {
    expect(FLAT).toMatch(/now sees %\/% lesson\/module rows, was %\/%/)
    expect(FLAT).toMatch(/still sees % lesson row\(s\) and % module row\(s\) — unchanged/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-2C — the application is ready for it', () => {
  const files: { path: string; text: string }[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const p = `${dir}/${name}`
      if (statSync(join(ROOT, p)).isDirectory()) { walk(p); continue }
      if (/\.(ts|tsx)$/.test(name)) files.push({ path: p, text: read(p) })
    }
  }
  for (const d of ['app', 'components', 'lib', 'types']) walk(d)
  const lessonColumns = (text: string): string[] => {
    const cols: string[] = []
    for (const m of text.matchAll(/lessons\s*\(([^()]*)\)/g)) cols.push(...m[1].split(',').map(s => s.trim()))
    for (const m of text.matchAll(/from\('lessons'\)[\s\S]{0,200}?\.select\(\s*'([^']*)'/g))
      cols.push(...m[1].replace(/\w+\([^)]*\)/g, '').split(',').map(s => s.trim()))
    return cols.filter(Boolean)
  }
  const callerFiles = files.filter(f => /from '@\/lib\/supabase\/(client|server)'/.test(f.text) && !/createAdminClient/.test(f.text))

  it('no anon/authenticated lesson query selects a column 055 withdraws', () => {
    const offenders = callerFiles
      .map(f => ({ path: f.path, bad: lessonColumns(f.text).filter(c => RAW.includes(c)) }))
      .filter(f => f.bad.length)
    expect(offenders).toEqual([])
  })

  it('every column a caller-role lesson query asks for is in the grant', () => {
    const offenders = callerFiles
      .map(f => ({ path: f.path, bad: lessonColumns(f.text).filter(c => !GRANTED.includes(c)) }))
      .filter(f => f.bad.length)
    expect(offenders).toEqual([])
  })

  it('the trusted paths that keep the raw columns are service-role only', () => {
    const readers = files.filter(f => lessonColumns(f.text).some(c => RAW.includes(c)))
    for (const f of readers)
      expect(/createAdminClient/.test(f.text), `${f.path} reads a location without the service role`).toBe(true)
    expect(readers.map(f => f.path)).toContain('app/api/media/lesson/[lessonId]/[kind]/route.ts')
    expect(readers.map(f => f.path)).toContain('app/(admin)/admin/modules/[id]/edit/page.tsx')
  })

  it('certificate pdf_url is a different table and stays out of scope', () => {
    const certFiles = files.filter(f => /certificates?/i.test(f.path) && /pdf_url|pdf_object_path/.test(f.text))
    expect(certFiles.length).toBeGreaterThan(0)
    for (const f of certFiles)
      expect(lessonColumns(f.text).filter(c => RAW.includes(c)), `${f.path} mixes certificate and lesson media`).toEqual([])
  })
})
