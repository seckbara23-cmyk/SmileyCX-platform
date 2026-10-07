// @vitest-environment node
/**
 * CAT-ARCH-01 — the V8 catalogue display-order foundation (migration 056).
 *
 *   V8 separates two things the public catalogue currently conflates: the
 *   permanent academic CODE (C1-F1) and the POSITION a learner sees it in.
 *   `course_codes.position` has always meant display order, but the registry is
 *   closed to `anon` (D-Q5: publishing it would publish the roadmap), so the
 *   public read path could only ever sort by code.
 *
 *   056 adds `public_catalogue_courses` — published courses only, positions
 *   re-ranked 1..N so a gap cannot betray an unproduced code — and a DEFERRABLE
 *   unique constraint so CAT-ARCH-02 can reorder a catalogue atomically.
 *
 * ── WHAT THIS SLICE MUST NOT DO ──────────────────────────────────────────
 *
 * Change a single row. No position moves, no code is registered, no course is
 * published, nothing is renamed. The visible order is identical afterwards —
 * the migration refuses to commit if it would not be. The V8 reorder itself is
 * CAT-ARCH-02, under owner rulings R1–R4.
 *
 * ── WHAT PROVES WHAT ─────────────────────────────────────────────────────
 *
 * A vitest run has no database, so this suite pins the STRUCTURE and the read
 * path. The behaviour was proven offline against real PostgreSQL 17 (PGlite)
 * with the live registry (3 catalogues, 17 codes, 8 courses) seeded in: the
 * projection equals the published coded courses, is contiguous per catalogue,
 * hides a withdrawn course by re-ranking rather than leaving a gap, follows a
 * deferred atomic reorder, still refuses a genuine duplicate position, and
 * leaves anon refused (42501) on course_codes, catalogues, learning_paths,
 * learning_path_courses and the WC-2 raw media columns. 14 mutants, all caught.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const MIG = 'supabase/migrations/056_catalogue_display_order.sql'
const READER = 'lib/queries/catalogue.ts'

/** Strip SQL comments without touching quoted literals. */
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
/** Statements only: every string literal blanked, so a message cannot match. */
const CODE = flat(SQL.replace(/'(?:[^']|'')*'/g, "''")).toLowerCase()
const count = (h: string, n: string) => h.split(n).length - 1

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-ARCH-01 — migration 056 exists, alone, as one transaction', () => {
  it('056 is exactly this migration; 057 is the V8 data slice; WC-2 untouched', () => {
    const files = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql'))
    expect(files.filter(f => f.startsWith('056'))).toEqual(['056_catalogue_display_order.sql'])
    // CAT-ARCH-02 added 057. It is DATA ONLY: it must not redefine the view or
    // the constraint this slice created, which is what 056 owns.
    expect(files.filter(f => f.startsWith('057'))).toEqual(['057_v8_registry_reorder.sql'])
    // PAY-1 later authored 058 (payment provider foundation).
    expect(files.filter(f => f.startsWith('058'))).toEqual(['058_payment_provider_foundation.sql'])
    expect(files).toHaveLength(56)
    const m057 = read('supabase/migrations/057_v8_registry_reorder.sql').replace(/--[^\n]*/g, '')
    expect(m057, '057 redefines the projection').not.toMatch(/create\s+(or replace\s+)?view/i)
    expect(m057, '057 alters the position constraint').not.toMatch(/alter table/i)
    expect(m057, '057 moves a grant').not.toMatch(/^\s*(grant|revoke)\b/im)
    // 058 grants and revokes — but only on public.payments. What 056 owns is
    // the projection, the position constraint and the closed registry, and
    // 058 must leave all three exactly as it found them.
    const m058 = read('supabase/migrations/058_payment_provider_foundation.sql').replace(/--[^\n]*/g, '')
    expect(m058, '058 redefines the projection').not.toMatch(/create\s+(or replace\s+)?view/i)
    expect(m058, '058 touches the position constraint')
      .not.toMatch(/course_codes_catalogue_position_unique/i)
    expect(m058, '058 touches public_catalogue_courses').not.toMatch(/public_catalogue_courses/i)
    for (const stmt of m058.match(/^\s*(grant|revoke)[\s\S]*?;/gim) ?? []) {
      expect(stmt, '058 grants or revokes on something other than payments')
        .toMatch(/on public\.payments\b/i)
    }
  })

  it('runs as ONE repeatable-read transaction', () => {
    expect(count(FLAT, 'begin isolation level repeatable read;')).toBe(1)
    expect(FLAT.match(/(^|\s)begin;/g)).toBeNull()
    expect(count(FLAT, 'commit;')).toBe(1)
    expect(FLAT.indexOf('begin isolation level repeatable read;')).toBeLessThan(FLAT.indexOf('commit;'))
  })

  it('is marked not applied, with an operator step and a commented rollback', () => {
    expect(RAWSQL).toMatch(/NOT APPLIED AT AUTHORING TIME/)
    expect(RAWSQL).toMatch(/OPERATOR STEP/)
    expect(RAWSQL).toMatch(/-- ROLLBACK — removes both objects/)
    expect(SQL, 'the rollback must stay commented out').not.toMatch(/drop view/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-ARCH-01 — the public projection', () => {
  it('selects only the three relationship columns', () => {
    expect(CODE).toMatch(/create view public\.public_catalogue_courses as select cc\.catalogue_code, cc\.code as course_code,/)
    for (const forbidden of ['canonical_title', 'objective', 'targets', 'cc.status', 'note', 'price', 'cover_url', 'description'])
      expect(CODE, `the projection exposes ${forbidden}`).not.toContain(forbidden)
  })

  it('publishes only published courses', () => {
    expect(CODE).toMatch(/join public\.courses c on c\.code = cc\.code and c\.is_published = true;/)
    expect(CODE, 'an outer join would admit unproduced codes').not.toMatch(/left join public\.courses/)
  })

  it('re-ranks position per catalogue instead of publishing the stored one', () => {
    expect(CODE).toMatch(/row_number\(\) over \( partition by cc\.catalogue_code order by cc\.position, cc\.code \) as position/)
    // The whole point of V8: order comes from position, never from the code.
    expect(CODE).not.toMatch(/order by cc\.code \) as position/)
  })

  it('is granted to the browser roles, and the registry is not', () => {
    expect(CODE).toContain('grant select on public.public_catalogue_courses to anon, authenticated;')
    for (const t of ['course_codes', 'catalogues', 'learning_paths', 'learning_path_courses'])
      expect(CODE, `056 grants ${t}`).not.toMatch(new RegExp(`grant [a-z ()]*on public\\.${t}`))
    expect(CODE).toContain('revoke all on public.course_codes from anon, authenticated;')
    expect(CODE).toContain('revoke all on public.catalogues from anon, authenticated;')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-ARCH-01 — the deferrable position constraint', () => {
  it('is UNIQUE (catalogue_code, position) DEFERRABLE INITIALLY DEFERRED', () => {
    expect(CODE).toMatch(/alter table public\.course_codes add constraint course_codes_catalogue_position_unique unique \(catalogue_code, position\) deferrable initially deferred;/)
  })

  it('the migration asserts that deferrability from the catalog', () => {
    expect(FLAT).toMatch(/contype = 'u' and condeferrable and condeferred/)
    expect(FLAT).toMatch(/is not DEFERRABLE INITIALLY DEFERRED/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-ARCH-01 — the data freeze', () => {
  it('writes nothing at all: no INSERT, UPDATE, DELETE or TRUNCATE anywhere', () => {
    expect(CODE).not.toMatch(/\b(insert into|update|delete from|truncate)\b/)
  })

  it('registers no code, renames nothing, assigns nothing', () => {
    for (const t of ['c1-f4', 'c3-f9', 'donnez', 'canonical_title =', 'set position'])
      expect(CODE, `056 performs CAT-ARCH-02 work: ${t}`).not.toContain(t)
  })

  it('touches no course, lesson, publication, preview, entitlement or certificate object', () => {
    expect(CODE).not.toMatch(/\balter table public\.(courses|lessons|modules|entitlements|enrollments|certificates)\b/)
    expect(CODE).not.toMatch(/is_published\s*=\s*true where|is_preview|entitlements|enrollments|certificates|lesson_progress/)
    expect(CODE).not.toMatch(/\b(create|alter|drop)\s+policy\b/)
    expect(CODE).not.toMatch(/storage\.|_object_path|video_url|pdf_url/)
  })

  it('creates only a transient snapshot, dropped at commit', () => {
    expect(count(CODE, 'create temp table cat_arch_01_before')).toBe(1)
    expect(count(CODE, 'on commit drop')).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-ARCH-01 — apply-time verification', () => {
  it('refuses unless its prerequisites hold', () => {
    expect(FLAT).toMatch(/required object\(s\) missing/)
    expect(FLAT).toMatch(/public\.courses\.code \(028\) is missing/)
    expect(FLAT).toMatch(/anon already holds SELECT on course_codes; the registry is not closed/)
    expect(FLAT).toMatch(/pair\(s\) are duplicated; fix the registry before constraining it/)
    expect(FLAT).toMatch(/already exists; refusing to re-apply/)
  })

  it('asserts the projection shape, its privileges and the WC-2 precondition', () => {
    expect(FLAT).toMatch(/expected catalogue_code,course_code,position/)
    expect(FLAT).toMatch(/forbidden column\(s\) in the public projection/)
    expect(FLAT).toMatch(/cannot read the public projection/)
    expect(FLAT).toMatch(/can read course_codes — the registry must stay closed/)
    expect(FLAT).toMatch(/regained SELECT on a raw lesson media column — WC-2 must stay closed/)
  })

  it('asserts published-only, no unproduced code, and contiguity', () => {
    expect(FLAT).toMatch(/unpublished course\(s\) leaked into the projection/)
    expect(FLAT).toMatch(/unproduced registry code\(s\) leaked into the projection/)
    expect(FLAT).toMatch(/is not re-ranked 1\.\.%/)
  })

  it('refuses to change the order a learner already sees', () => {
    expect(FLAT).toMatch(/the visible catalogue order would change/)
    expect(FLAT).toMatch(/CAT-ARCH-01 must be order-neutral; reordering is CAT-ARCH-02/)
  })

  it('fingerprints everything it promises not to write', () => {
    for (const k of ['course_codes_md5', 'catalogues_md5', 'courses_md5', 'paths_md5', 'membership_md5', 'lessons_md5', 'order_by_code'])
      expect(FLAT, `snapshot lacks ${k}`).toContain(` as ${k}`)
    expect(FLAT).toMatch(/course_codes changed — this migration must not touch a single position/)
    expect(FLAT).toMatch(/course data or publication state changed/)
    expect(FLAT).toMatch(/lesson data changed/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-ARCH-01 — WC-2 and the registry are untouched', () => {
  /** Git blob hash of the committed content (LF), so the pin is byte-exact. */
  const blobSha = (p: string) => {
    const b = Buffer.from(read(p), 'utf8')
    return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex')
  }

  it('054 is byte-identical', () => {
    expect(blobSha('supabase/migrations/054_lesson_media_derived_source.sql'))
      .toBe('b0cdf55a28d05d82af4ca16c1be388bdc327bb55')
  })

  it('055 is byte-identical', () => {
    expect(blobSha('supabase/migrations/055_restrict_lesson_media_columns.sql'))
      .toBe('4d1337e104d6049cc097eacd5d384c6f39102a72')
  })

  it('056 grants nothing on lessons and mentions no raw media column', () => {
    expect(CODE).not.toMatch(/on public\.lessons to/)
    for (const c of ['video_object_path', 'pdf_object_path', 'subtitle_object_path', 'subtitle_url'])
      expect(CODE).not.toContain(c)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-ARCH-01 — the public read path', () => {
  const src = read(READER)

  it('orders the catalogue by the projection, not by the academic code', () => {
    expect(src).toMatch(/\.from\('public_catalogue_courses'\)/)
    expect(src).toMatch(/\.select\('catalogue_code, course_code, position'\)/)
    const fn = src.slice(src.indexOf('export async function getPublishedCoursesByCatalogue'))
    expect(fn.slice(0, fn.indexOf('\n}'))).not.toMatch(/\.order\('code'\)/)
  })

  it('still reads course content from courses, published only', () => {
    const fn = src.slice(src.indexOf('export async function getPublishedCoursesByCatalogue'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).toMatch(/\.select\('id, code, slug, title, description, level, duration_hours, cover_url'\)/)
    expect(body).toMatch(/\.eq\('is_published', true\)/)
  })

  it('never reads the registry directly', () => {
    for (const t of ['course_codes', 'catalogues', 'learning_paths', 'learning_path_courses'])
      expect(src, `the public reader touches ${t}`).not.toMatch(new RegExp(`\\.from\\('${t}'\\)`))
  })

  it('introduces no academic code into a public URL', () => {
    expect(src).toMatch(/export function pathHref/)
    expect(src).not.toMatch(/\/courses\/\$\{[^}]*code/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-ARCH-01 — the read path behaves (mocked client)', () => {
  // `vi.mock` is hoisted above every const in this file, so the fixture it
  // reads has to be hoisted with it.
  const fx = vi.hoisted(() => ({
    viewRows:   [] as { catalogue_code: string; course_code: string; position: number }[],
    courseRows: [] as { id: string; code: string; slug: string }[],
    asked:      [] as string[],
  }))

  vi.mock('@supabase/supabase-js', () => ({
    createClient: () => ({
      from: (table: string) => {
        fx.asked.push(table)
        const c: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in', 'order', 'not', 'limit']) c[m] = () => c
        // Thenable: the reader awaits the builder itself, as supabase-js allows.
        c.then = (resolve: (v: { data: unknown }) => unknown) =>
          resolve({ data: table === 'public_catalogue_courses' ? fx.viewRows : fx.courseRows })
        return c
      },
    }),
  }))

  const set = (view: typeof fx.viewRows, courses: typeof fx.courseRows) => {
    fx.viewRows.splice(0, fx.viewRows.length, ...view)
    fx.courseRows.splice(0, fx.courseRows.length, ...courses)
  }
  beforeEach(() => { set([], []); fx.asked.length = 0 })

  const load = async () => (await import('@/lib/queries/catalogue')).getPublishedCoursesByCatalogue()

  it('groups by catalogue and orders by the projection, even against code order', () => {
    // The V8 case: C1-F4 first, although its code sorts last.
    set([
      { catalogue_code: 'C1', course_code: 'C1-F4', position: 1 },
      { catalogue_code: 'C1', course_code: 'C1-F1', position: 2 },
      { catalogue_code: 'C1', course_code: 'C1-F2', position: 3 },
    ], [
      { id: '1', code: 'C1-F1', slug: 'fondamentaux-experience' },
      { id: '2', code: 'C1-F2', slug: 'fondamentaux-service' },
      { id: '4', code: 'C1-F4', slug: 'donnez-envie' },
    ])
    return load().then(map => {
      expect(map.get('C1')?.map(c => c.code)).toEqual(['C1-F4', 'C1-F1', 'C1-F2'])
    })
  })

  it('reads the projection and courses — never the registry', () => {
    set([{ catalogue_code: 'C1', course_code: 'C1-F1', position: 1 }], [{ id: '1', code: 'C1-F1', slug: 's' }])
    return load().then(() => {
      expect(fx.asked).toContain('public_catalogue_courses')
      expect(fx.asked).toContain('courses')
      for (const t of ['course_codes', 'catalogues', 'learning_paths', 'learning_path_courses'])
        expect(fx.asked).not.toContain(t)
    })
  })

  it('drops a course RLS withholds rather than rendering a hole', () => {
    set([
      { catalogue_code: 'C2', course_code: 'C2-F1', position: 1 },
      { catalogue_code: 'C2', course_code: 'C2-F9', position: 2 },
    ], [{ id: '1', code: 'C2-F1', slug: 's' }])
    return load().then(map => {
      expect(map.get('C2')?.map(c => c.code)).toEqual(['C2-F1'])
    })
  })

  it('an empty projection yields an empty map and asks for no courses', () => {
    set([], [])
    return load().then(map => {
      expect(map.size).toBe(0)
      expect(fx.asked).toEqual(['public_catalogue_courses'])
    })
  })

  it('keeps catalogues separate', () => {
    set([
      { catalogue_code: 'C1', course_code: 'C1-F1', position: 1 },
      { catalogue_code: 'C2', course_code: 'C2-F4', position: 1 },
    ], [
      { id: '1', code: 'C1-F1', slug: 'a' },
      { id: '2', code: 'C2-F4', slug: 'b' },
    ])
    return load().then(map => {
      expect([...map.keys()].sort()).toEqual(['C1', 'C2'])
      expect(map.get('C2')?.map(c => c.code)).toEqual(['C2-F4'])
    })
  })
})
