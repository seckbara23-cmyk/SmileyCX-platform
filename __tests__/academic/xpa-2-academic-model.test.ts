// @vitest-environment node
/**
 * XPA-2 — academic model (catalogues, course codes, learning paths).
 *
 * These tests read the MIGRATION FILES, not a live database: migrations here
 * are applied by an operator, so the files are the artefact under review. That
 * makes the suite runnable in CI with no database and still able to prove the
 * properties that matter — additive-only schema, immutable codes, and a seed
 * that matches the V4 source document exactly.
 *
 * The path/course matrix is re-derived from the migration and cross-checked
 * against V4 §8 transcribed independently below. If either drifts, the test
 * fails — which is the point: the seed must not quietly diverge from the
 * ratified architecture.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/**
 * Blank out SQL comments while preserving offsets.
 *
 * Structural assertions must run against EXECUTABLE SQL only. Each migration
 * ends with a commented-out ROLLBACK block that legitimately contains
 * `drop column`, `update ... set`, etc. Scanning raw text would flag those
 * comments as destructive statements — the same trap the RLS linter hit.
 */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, m => ' '.repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
}

const SCHEMA_RAW   = read('supabase/migrations/028_academic_model.sql')
const SEED_RAW     = read('supabase/migrations/029_seed_catalogues_paths.sql')
const BACKFILL_RAW = read('supabase/migrations/030_backfill_course_codes.sql')

const SCHEMA   = stripSqlComments(SCHEMA_RAW)
const SEED     = stripSqlComments(SEED_RAW)
const BACKFILL = stripSqlComments(BACKFILL_RAW)

/** Parse `('PM-CONS', 'C1-F1', 1, true),` rows out of the seed. */
function parsePathCourses(): { path: string; code: string; position: number; socle: boolean }[] {
  const block = SEED.slice(
    SEED.indexOf('insert into public.learning_path_courses'),
    SEED.indexOf('on conflict (path_code, course_code)')
  )
  return [...block.matchAll(/\('(PM-[A-Z]+|SEC-[A-Z]+)',\s*'(C\d-F\d)',\s*(\d+),\s*(true|false)\)/g)]
    .map(m => ({ path: m[1], code: m[2], position: Number(m[3]), socle: m[4] === 'true' }))
}

/**
 * V4 §8 "Matrice de correspondance formations × parcours métier",
 * transcribed independently from the seed. C1-F1 is "tous les parcours".
 */
const V4_MATRIX: Record<string, string[]> = {
  'C1-F2': ['PM-CONS', 'PM-OPT', 'PM-COM'],
  'C1-F3': ['PM-CONS', 'PM-DIG'],
  'C2-F1': ['PM-MAN', 'PM-RH'],
  'C2-F2': ['PM-MAN', 'PM-QVC', 'PM-PRO'],
  'C2-F3': ['PM-MAN', 'PM-QVC', 'PM-PRO'],
  'C2-F4': ['PM-CONS', 'PM-OPT', 'PM-COM', 'PM-QVC'],
  'C2-F5': ['PM-MAN', 'PM-RH', 'PM-DIR'],
  'C3-F1': ['PM-QVC', 'PM-PRO'],
  'C3-F2': ['PM-PRO'],
  'C3-F3': ['PM-PRO'],
  'C3-F4': ['PM-COM', 'PM-PRO'],
  'C3-F5': ['PM-RH', 'PM-DIR'],
  'C3-F6': ['PM-DIG', 'PM-DIR'],
  'C3-F7': ['PM-DIG', 'PM-DIR'],
  'C3-F8': ['PM-DIR'],
}

const PROFESSIONAL = ['PM-CONS','PM-OPT','PM-COM','PM-MAN','PM-QVC','PM-RH','PM-DIG','PM-PRO','PM-DIR']
const SECTOR       = ['SEC-TEL','SEC-BQA','SEC-LOG','SEC-COM','SEC-SAN','SEC-ADM']

// ── Additive-only guarantees ────────────────────────────────────────────────

describe('XPA-2 — schema is strictly additive', () => {
  const migrations = [SCHEMA, SEED, BACKFILL]

  it('drops no table and no column', () => {
    for (const m of migrations) {
      expect(m).not.toMatch(/drop\s+table(?!\s+if\s+exists\s+public\.(catalogues|course_codes|learning_path)) /i)
      expect(m).not.toMatch(/drop\s+column/i)
    }
  })

  it('adds only ONE column to courses, and it is nullable', () => {
    const adds = [...SCHEMA.matchAll(/alter table public\.courses\s+add column if not exists (\w+)/gi)]
    expect(adds.map(a => a[1])).toEqual(['code'])
    // No NOT NULL / DEFAULT on the added column — existing rows stay valid.
    expect(SCHEMA).toMatch(/add column if not exists code text;/)
  })

  it('never renames a slug or a title', () => {
    // Parse the assigned columns out of each `update public.courses ... set ...`
    // SET clause. A naive regex would match `where slug = ...`, which is a read,
    // not a rename — the distinction is the whole point of this assertion.
    const assignedColumns: string[] = []
    for (const m of migrations) {
      for (const stmt of m.matchAll(/update\s+public\.courses\s+set\s+([\s\S]*?)(?:\bwhere\b|;)/gi)) {
        for (const assign of stmt[1].matchAll(/(\w+)\s*=/g)) {
          assignedColumns.push(assign[1].toLowerCase())
        }
      }
    }
    expect(assignedColumns.length).toBeGreaterThan(0)   // the backfill does write
    expect(assignedColumns).not.toContain('slug')
    expect(assignedColumns).not.toContain('title')
    expect(assignedColumns).not.toContain('title_fr')
    expect(assignedColumns).not.toContain('id')
    // Only the code (and its bookkeeping timestamp) may be written.
    expect([...new Set(assignedColumns)].sort()).toEqual(['code', 'updated_at'])

    for (const m of migrations) expect(m).not.toMatch(/rename\s+(column|to)/i)
  })

  it('never rebuilds course ids and never deletes courses', () => {
    for (const m of migrations) {
      expect(m).not.toMatch(/update\s+public\.courses[\s\S]{0,200}?set[\s\S]{0,100}?\bid\s*=/i)
      expect(m).not.toMatch(/delete\s+from\s+public\.courses/i)
      expect(m).not.toMatch(/truncate/i)
    }
  })

  it('touches no existing table other than adding courses.code', () => {
    const altered = [...SCHEMA.matchAll(/alter table public\.(\w+)/gi)].map(m => m[1])
    const newTables = ['catalogues', 'course_codes', 'learning_paths', 'learning_path_courses']
    for (const t of altered) {
      expect([...newTables, 'courses']).toContain(t)
    }
  })
})

// ── Immutability ────────────────────────────────────────────────────────────

describe('XPA-2 — course codes are immutable', () => {
  it('a trigger blocks changing or clearing an assigned course code', () => {
    expect(SCHEMA).toMatch(/enforce_course_code_immutable/)
    expect(SCHEMA).toMatch(/OLD\.code is not null and NEW\.code is distinct from OLD\.code/)
    expect(SCHEMA).toMatch(/create trigger courses_code_immutable\s+before update on public\.courses/)
  })

  it('a registry code can never be renamed', () => {
    expect(SCHEMA).toMatch(/course_codes\.code is permanent/)
    expect(SCHEMA).toMatch(/enforce_course_code_registry_permanence/)
  })

  it('a registry code can never be deleted, so it can never be reused', () => {
    expect(SCHEMA).toMatch(/TG_OP = 'DELETE'/)
    expect(SCHEMA).toMatch(/never reused/i)
    expect(SCHEMA).toMatch(/before update or delete on public\.course_codes/)
  })

  it('one code maps to at most one course', () => {
    expect(SCHEMA).toMatch(/courses_code_unique unique \(code\)/)
  })

  it('the backfill refuses to reassign an already-coded course', () => {
    expect(BACKFILL).toMatch(/refusing to reassign/)
    expect(BACKFILL).toMatch(/and code is null/)
  })
})

// ── Seed fidelity to V4 ─────────────────────────────────────────────────────

describe('XPA-2 — catalogues and course codes match V4', () => {
  it('seeds exactly the three catalogues', () => {
    for (const c of ['C1', 'C2', 'C3']) expect(SEED).toContain(`('${c}',`)
    expect(SEED).toMatch(/'Fondations'/)
    expect(SEED).toMatch(/'Intermédiaire'/)
    expect(SEED).toMatch(/'Avancé'/)
  })

  it('seeds all 17 course codes (16 in §9.1 + C2-F6 from §10)', () => {
    const codes = [...SEED.matchAll(/\('(C\d-F\d)', 'C\d',/g)].map(m => m[1])
    expect(new Set(codes).size).toBe(17)
    for (const c of ['C1-F1','C1-F2','C1-F3']) expect(codes).toContain(c)
    for (let i = 1; i <= 6; i++) expect(codes).toContain(`C2-F${i}`)
    for (let i = 1; i <= 8; i++) expect(codes).toContain(`C3-F${i}`)
  })

  it('marks ONLY C2-F6 as backlog, and invents no launch status', () => {
    // Parse the course_codes block row by row: each row ends `, N, 'status')`.
    // The catalogues insert also ends with `on conflict (code) do update`, so
    // the terminator must be located AFTER the course_codes insert begins.
    const start = SEED.indexOf('insert into public.course_codes')
    const block = SEED.slice(start, SEED.indexOf('on conflict (code) do update', start))
    const rows = [...block.matchAll(/\('(C\d-F\d)', 'C\d',[\s\S]*?,\s*\d+,\s*'(\w+)'\)/g)]
      .map(m => ({ code: m[1], status: m[2] }))

    expect(rows).toHaveLength(17)
    expect(rows.filter(r => r.status === 'backlog').map(r => r.code)).toEqual(['C2-F6'])
    // D-Q1 is open: nothing may be declared 'launch' until the source arrives.
    expect(rows.filter(r => r.status === 'launch')).toHaveLength(0)
    expect(rows.filter(r => r.status === 'undecided')).toHaveLength(16)
  })

  it('re-running the seed cannot clobber a launch decision', () => {
    // The ON CONFLICT update list must not include `status`. Asserted against
    // the executable SQL, plus the intent comment in the raw file.
    const start = SEED.indexOf('on conflict (code) do update', SEED.indexOf('insert into public.course_codes'))
    const upsert = SEED.slice(start, start + 400)
    expect(upsert).not.toMatch(/\bstatus\s*=/)
    expect(SEED_RAW).toMatch(/status deliberately NOT overwritten/)
  })
})

describe('XPA-2 — the fifteen learning paths', () => {
  it('seeds 9 professional + 6 sector paths', () => {
    for (const p of PROFESSIONAL) expect(SEED).toContain(`('${p}', 'professional'`)
    for (const p of SECTOR)       expect(SEED).toContain(`('${p}', 'sector'`)
    expect(PROFESSIONAL.length + SECTOR.length).toBe(15)
  })

  it('asserts the 15-path count inside the migration itself', () => {
    expect(SEED).toMatch(/n_paths <> 15/)
  })

  it('creates no path beyond the V4 set', () => {
    const seeded = new Set(
      [...SEED.matchAll(/\('((?:PM|SEC)-[A-Z]+)', '(?:professional|sector)'/g)].map(m => m[1])
    )
    expect([...seeded].sort()).toEqual([...PROFESSIONAL, ...SECTOR].sort())
  })
})

describe('XPA-2 — C1-F1 is first in every path', () => {
  const rows = parsePathCourses()

  it('every path starts with C1-F1 at position 1', () => {
    const paths = [...new Set(rows.map(r => r.path))]
    expect(paths.length).toBe(15)
    for (const p of paths) {
      const first = rows.find(r => r.path === p && r.position === 1)
      expect(first, `path ${p} has no position 1`).toBeTruthy()
      expect(first!.code, `path ${p} does not start with C1-F1`).toBe('C1-F1')
    }
  })

  it('C1-F1 is flagged as socle everywhere', () => {
    for (const r of rows.filter(r => r.code === 'C1-F1')) {
      expect(r.socle, `${r.path} C1-F1 not flagged socle`).toBe(true)
    }
  })

  it('the migration enforces this itself, not only the test', () => {
    expect(SEED).toMatch(/do not start with C1-F1 at position 1/)
  })
})

describe('XPA-2 — path/course matrix matches V4 §8 exactly', () => {
  const rows = parsePathCourses()

  it('C1-F1 belongs to all 15 paths (socle commun)', () => {
    const paths = rows.filter(r => r.code === 'C1-F1').map(r => r.path)
    expect(new Set(paths).size).toBe(15)
  })

  it.each(Object.entries(V4_MATRIX))(
    '%s is recommended by exactly the V4-listed professional paths',
    (code, expectedPaths) => {
      const actual = rows
        .filter(r => r.code === code && r.path.startsWith('PM-'))
        .map(r => r.path)
        .sort()
      expect(actual).toEqual([...expectedPaths].sort())
    }
  )

  it('C2-F6 (backlog) appears in no path', () => {
    expect(rows.some(r => r.code === 'C2-F6')).toBe(false)
  })

  it('positions are contiguous and unique within each path', () => {
    for (const p of [...new Set(rows.map(r => r.path))]) {
      const positions = rows.filter(r => r.path === p).map(r => r.position).sort((a, b) => a - b)
      expect(positions).toEqual(Array.from({ length: positions.length }, (_, i) => i + 1))
    }
  })

  it('every sector path carries the C1-F1 + C1-F2 socle commun', () => {
    for (const p of SECTOR) {
      const socle = rows.filter(r => r.path === p && r.socle).map(r => r.code).sort()
      expect(socle).toEqual(['C1-F1', 'C1-F2'])
    }
  })
})

// ── Backfill ────────────────────────────────────────────────────────────────

describe('XPA-2 — backfill mapping', () => {
  it('maps exactly the six existing courses, by slug', () => {
    const pairs = [...BACKFILL.matchAll(/\('(C\d-F\d)',\s*'([a-z0-9-]+)'/g)].map(m => [m[1], m[2]])
    expect(pairs).toHaveLength(6)
    expect(Object.fromEntries(pairs)).toEqual({
      'C1-F1': 'les-fondamentaux-de-l-experience-client',
      'C1-F2': 'les-fondamentaux-du-service-client',
      'C1-F3': 'communiquer-avec-les-clients-sur-les-canaux-digitaux',
      'C2-F1': 'manager-une-equipe-orientee-client',
      'C2-F2': 'mesurer-l-experience-client',
      'C2-F4': 'gerer-les-reclamations-et-transformer-l-insatisfaction-en-opportunite',
    })
  })

  it('invents no mapping for unproduced courses', () => {
    for (const absent of ['C2-F3', 'C2-F5', 'C2-F6', 'C3-F1', 'C3-F8']) {
      expect(BACKFILL).not.toMatch(new RegExp(`\\('${absent}',\\s*'[a-z]`))
    }
  })

  it('records the ratified provenance of the C1-F3 mapping', () => {
    expect(BACKFILL).toMatch(/D-Q2/)
  })
})

// ── Untouched subsystems ────────────────────────────────────────────────────

describe('XPA-2 — nothing outside the academic model changed', () => {
  it('adds no policy on any pre-existing table', () => {
    const policies = [...SCHEMA.matchAll(/create policy "[^"]+"\s+on public\.(\w+)/gi)].map(m => m[1])
    const allowed = ['catalogues', 'course_codes', 'learning_paths', 'learning_path_courses']
    for (const t of policies) expect(allowed).toContain(t)
  })

  it('every new write policy has an explicit WITH CHECK', () => {
    const forAll = [...SCHEMA.matchAll(/create policy "[^"]+"\s+on public\.\w+ for all[\s\S]*?with check/gi)]
    expect(forAll.length).toBe(4)
  })

  it('does not touch auth, RLS helpers, payments, quizzes or voice', () => {
    for (const m of [SCHEMA, SEED, BACKFILL]) {
      for (const forbidden of [
        'auth.users', 'profiles', 'platform_role', 'payments', 'enrollments',
        'lesson_progress', 'certificates', 'quiz_attempts', 'ai_scenarios', 'ai_sessions',
      ]) {
        expect(m, `${forbidden} referenced in a migration`).not.toMatch(
          new RegExp(`(alter|drop|update|delete from|insert into)\\s+(public\\.)?${forbidden}\\b`, 'i')
        )
      }
    }
  })

  /**
   * The historical migration ledger (001–027) must never be edited.
   *
   * This originally asserted that NO migration file was dirty. That was true
   * while XPA-2 was the working set, but it is not the actual invariant: a
   * later phase legitimately editing its OWN migration before committing —
   * XPA-5A correcting 034, for instance — would trip it. Pinning the real rule
   * keeps the guard meaningful instead of merely noisy.
   */
  it('migrations 001-027 are never modified', () => {
    const changed = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'supabase/migrations'], {
      cwd: ROOT, encoding: 'utf8',
    }).split('\n').filter(Boolean)

    const historical = changed.filter(f => {
      const n = Number(/(\d{3})_/.exec(f)?.[1] ?? NaN)
      return Number.isFinite(n) && n <= 27
    })
    expect(historical, 'a historical migration was edited').toEqual([])
  }, 15_000)
})

describe('XPA-2 — admin catalogue page is read-only', () => {
  const page = read('app/(admin)/admin/catalogue/page.tsx')

  it('requires platform admin server-side', () => {
    expect(page).toMatch(/await requirePlatformAdmin\(\)/)
  })

  it('performs no writes', () => {
    expect(page).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/)
  })

  it('surfaces missing content without inventing courses', () => {
    expect(page).toMatch(/Formations codifiées sans contenu/)
    expect(page).toMatch(/non produite/)
  })

  it('degrades gracefully when the migrations are not yet applied', () => {
    expect(page).toMatch(/Modèle académique non initialisé/)
  })
})
