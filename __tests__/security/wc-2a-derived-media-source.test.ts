// @vitest-environment node
/**
 * XPA-8 WC-2A — browser-safe derived media fields (migration 054).
 *
 *   The browser must learn WHAT KIND of asset a lesson has, never WHERE it is
 *   stored. 054 adds generated `*_source` ('protected' | 'external' | NULL) and
 *   `*_external_url` fields and changes nothing else: no grant, no policy, no
 *   row. Restricting the raw columns is 055, deployed only after the
 *   application reads these fields.
 *
 * ── WHAT PROVES WHAT ─────────────────────────────────────────────────────
 *
 * A vitest run has no database. This suite pins the STRUCTURE and the exact
 * classification rules, and re-evaluates the migration's own adversarial
 * fixture table in JavaScript using the regular expressions extracted from the
 * file — a fast mirror, not the authority. The authority is PostgreSQL:
 *
 *   1. offline — the exact file applied to PostgreSQL 17 (PGlite) with the
 *      production policies (050 applied from its file), the 041 constraint and
 *      the 053 recorder extracted verbatim, against a synthetic corpus and the
 *      live production corpus read GET-only; the learn player's, media route's
 *      and admin editor's exact selects replayed before and after; 23 mutants
 *      of the migration, all caught;
 *   2. at apply time — the migration fingerprints grants, policies, lessons,
 *      modules, courses and buckets, proves agreement with resolveAssetSource()
 *      on every live row, asserts no internal location in any external field,
 *      and runs the 47-case fixture through the real generated columns inside a
 *      subtransaction it rolls back.
 *
 * Every structural assertion reads comment-stripped SQL.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { resolveAssetSource } from '@/lib/media/paths'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const MIG = 'supabase/migrations/054_lesson_media_derived_source.sql'
const KINDS = ['video', 'pdf', 'subtitle'] as const
const DERIVED = KINDS.flatMap(k => [`${k}_source`, `${k}_external_url`])

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
/** Statements only: every string literal blanked, so messages cannot match. */
const CODE = flat(SQL.replace(/'(?:[^']|'')*'/g, "''")).toLowerCase()
const count = (hay: string, needle: string) => hay.split(needle).length - 1

/** The generated expression of one derived column, whitespace-collapsed. */
function expr(col: string): string {
  const m = new RegExp(`add column ${col} text generated always as \\( (case .*? end) \\) stored`).exec(FLAT)
  expect(m, `${col} is not a generated stored text column`).not.toBeNull()
  return m![1]
}

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-2A — migration 054 exists, alone, as one transaction', () => {
  it('054 is exactly this migration; 055 does not exist; 046 withdrawn; 051 reserved', () => {
    const files = readdirSync(join(ROOT, 'supabase/migrations'))
    expect(files.filter(f => f.startsWith('054'))).toEqual(['054_lesson_media_derived_source.sql'])
    expect(files.filter(f => f.startsWith('055')), '055 (the grant restriction) must not ship with 054').toEqual([])
    expect(files.filter(f => f.startsWith('046'))).toEqual([])
    expect(files.filter(f => f.startsWith('051'))).toEqual([])
  })

  it('runs as ONE repeatable-read transaction', () => {
    expect(count(FLAT, 'begin isolation level repeatable read;')).toBe(1)
    expect(FLAT.match(/(^|\s)begin;/g)).toBeNull()
    expect(count(FLAT, 'commit;')).toBe(1)
    expect(FLAT.indexOf('begin isolation level repeatable read;')).toBeLessThan(FLAT.indexOf('commit;'))
  })

  it('is marked not applied, carries an operator step and a commented rollback', () => {
    expect(RAW).toMatch(/NOT APPLIED AT AUTHORING TIME/)
    expect(RAW).toMatch(/OPERATOR STEP/)
    expect(RAW).toMatch(/ACCESS\s+(--\s+)?EXCLUSIVE lock/)
    expect(RAW).toMatch(/-- ROLLBACK — removes the six derived fields/)
    expect(RAW).toMatch(/Do NOT apply 055 until the compatible application release is deployed/)
    expect(SQL, 'the rollback must stay commented out').not.toMatch(/drop column/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-2A — additive only: no grant, policy, function or data change', () => {
  it('no GRANT or REVOKE statement of any kind', () => {
    expect(CODE).not.toMatch(/\b(grant|revoke)\s+(select|insert|update|delete|all|usage|execute|references|trigger)\b/)
  })

  it('no policy, function, trigger or view is created, altered or dropped', () => {
    expect(CODE).not.toMatch(/\b(create|alter|drop)\s+policy\b/)
    expect(CODE).not.toMatch(/\bcreate\s+(or\s+replace\s+)?(function|trigger|view)\b/)
    expect(CODE).not.toMatch(/\bdrop\s+(column|table|function|policy|view|trigger|constraint)\b/)
    expect(CODE).not.toMatch(/\bsecurity\s+definer\b/)
  })

  it('exactly one ALTER TABLE, on public.lessons, and it only adds the six derived columns', () => {
    const alters = [...CODE.matchAll(/\balter table ([a-z_.]+)/g)].map(m => m[1])
    expect(alters).toEqual(['public.lessons'])
    const start = CODE.indexOf('alter table public.lessons')
    const stmt = CODE.slice(start, CODE.indexOf(';', start))
    const added = [...stmt.matchAll(/add column ([a-z_]+) text generated always as \(/g)].map(m => m[1])
    expect(added).toEqual(DERIVED)
    expect(count(stmt, ' stored')).toBe(6)
    expect(stmt).not.toMatch(/\b(alter column|add constraint|rename|owner to|enable|disable|set (schema|default|not null)|drop)\b/)
  })

  it('writes happen only inside the rolled-back fixture, and never to raw media, flags or buckets', () => {
    const fxStart = CODE.indexOf("v_slug constant text := ")
    const fxEnd = CODE.indexOf("when sqlstate '' then null; end;")
    expect(fxStart).toBeGreaterThan(0)
    expect(fxEnd).toBeGreaterThan(fxStart)

    const writes = [...CODE.matchAll(/\b(insert into|update|delete from|truncate)\s+([a-z_.]+)/g)]
    expect(writes.length).toBeGreaterThan(0)
    for (const w of writes) {
      expect(w.index!, `${w[0]} outside the fixture`).toBeGreaterThan(fxStart)
      expect(w.index!, `${w[0]} outside the fixture`).toBeLessThan(fxEnd)
    }
    expect(writes.map(w => `${w[1]} ${w[2]}`).sort()).toEqual([
      'insert into public.courses', 'insert into public.lessons', 'insert into public.lessons',
      'insert into public.modules', 'update public.lessons', 'update public.lessons',
    ])
    for (const u of CODE.matchAll(/\bupdate public\.lessons set ([a-z_]+)/g))
      expect(u[1], 'the fixture may only toggle an object path').toBe('video_object_path')
    expect(CODE).not.toMatch(/delete from|truncate|update storage|insert into storage|storage\.objects/)
  })

  it('the fixture course is created UNPUBLISHED', () => {
    expect(FLAT).toMatch(/insert into public\.courses \(slug, title, description, is_published\) values \(v_slug, 'WC-2A 054 fixture', '[^']*', false\)/)
  })

  it('touches no certificate, entitlement, enrollment, progress or voice object', () => {
    expect(CODE).not.toMatch(/certificates|entitlements|enrollments|lesson_progress|ai_scenarios|ai_sessions|course-videos/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-2A — the classification rules, pinned exactly', () => {
  const INTERNAL = `'supabase|storage(/|\\\\|%(25)*2f)+v1'`
  const EXTERNAL = `'^https?://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}([/?#][-a-z0-9._~:/?#@!$&''()*+,;=%]*)?$'`

  it('*_source: path wins, then empty, then INTERNAL, then clean external, else NULL', () => {
    expect(expr('video_source')).toBe(
      "case when coalesce(video_object_path, '') <> '' then 'protected' " +
      "when coalesce(video_url, '') = '' then null " +
      `when video_url ~* ${INTERNAL} then 'protected' ` +
      `when length(video_url) <= 2048 and video_url ~* ${EXTERNAL} then 'external' ` +
      'else null end')
  })

  it('*_external_url: the raw URL only on the external branch; NULL everywhere else', () => {
    expect(expr('video_external_url')).toBe(
      "case when coalesce(video_object_path, '') <> '' then null " +
      "when coalesce(video_url, '') = '' then null " +
      `when video_url ~* ${INTERNAL} then null ` +
      `when length(video_url) <= 2048 and video_url ~* ${EXTERNAL} then video_url ` +
      'else null end')
    expect(count(expr('video_external_url'), 'then video_url')).toBe(1)
  })

  it('the three kinds carry the identical rule, each reading only its own columns', () => {
    for (const suffix of ['_source', '_external_url']) {
      const ref = expr(`video${suffix}`).replace(/video_/g, 'K_')
      for (const k of ['pdf', 'subtitle']) {
        const e = expr(`${k}${suffix}`)
        expect(e.replace(new RegExp(`${k}_`, 'g'), 'K_'), `${k}${suffix} differs from video`).toBe(ref)
        for (const other of KINDS.filter(o => o !== k))
          expect(e, `${k}${suffix} reads ${other} columns`).not.toContain(`${other}_`)
      }
    }
  })

  it('fail-closed shape of the external pattern: http(s) only, anchored, no port, no userinfo, no whitespace', () => {
    expect(EXTERNAL.startsWith("'^https?://")).toBe(true)
    expect(EXTERNAL.endsWith(")?$'")).toBe(true)
    expect(EXTERNAL).not.toMatch(/:\[0-9\]/)                   // no port
    expect(EXTERNAL.slice(0, EXTERNAL.indexOf('[a-z]{2,63}'))).not.toContain('@') // no userinfo in the host
    expect(EXTERNAL).not.toMatch(/\\s| /)                       // no whitespace class or literal space
    expect(EXTERNAL).toMatch(/\[a-z\]\{2,63\}/)                 // alphabetic TLD: no IP literal, no localhost
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-2A — apply-time verification is present and exercises the real columns', () => {
  it('preflight refuses a re-apply instead of skipping', () => {
    expect(FLAT).toMatch(/derived column\(s\) already exist, refusing to re-apply/)
    expect(CODE).not.toMatch(/add column if not exists/)
  })

  it('fingerprints grants, policies, lessons, modules, courses and storage buckets before and after', () => {
    expect(FLAT).toMatch(/create temp table wc2a_054_before on commit drop as/)
    for (const k of ['table_acl', 'column_acl', 'lessons_policies', 'lessons_md5', 'modules_md5', 'courses_md5', 'buckets_md5', 'n_lessons', 'n_preview', 'n_audit'])
      expect(FLAT, `snapshot lacks ${k}`).toContain(` as ${k}`)
    expect(FLAT).toMatch(/the table ACL of public\.lessons changed/)
    expect(FLAT).toMatch(/a column privilege on public\.lessons changed/)
    expect(FLAT).toMatch(/derived column\(s\) carry their own column-level grant/)
    expect(FLAT).toMatch(/lost SELECT on lessons\.% — that is 055, not 054/)
    expect(FLAT).toMatch(/existing lesson data changed/)
    expect(FLAT).toMatch(/storage bucket configuration changed/)
  })

  it('proves generated-ness, own-column dependencies and identical rules from the catalog', () => {
    expect(FLAT).toMatch(/a\.attgenerated = 's'/)
    expect(FLAT).toMatch(/must depend on exactly its own raw columns/)
    expect(FLAT).toMatch(/rule differs from the video rule/)
  })

  it('checks agreement with resolveAssetSource() on the live corpus, and the leakage invariant', () => {
    expect(FLAT).toMatch(/agree with resolveAssetSource, % withheld, % unexplained/)
    expect(FLAT).toMatch(/external field value\(s\) disclose an internal location/)
  })

  it('the fixture is rolled back through a caught sentinel and proven gone', () => {
    expect(count(FLAT, "raise exception using errcode = 'XW054'")).toBe(1)
    expect(count(FLAT, "when sqlstate 'XW054' then")).toBe(1)
    expect(FLAT).toMatch(/the fixture course survived the rollback/)
    expect(FLAT).toMatch(/audit_log changed across the rolled-back fixture/)
    expect(FLAT).toMatch(/when sqlstate '428C9'/)
    expect(FLAT).toMatch(/adding a path did not re-derive to protected/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-2A — the fixture table, re-evaluated with the rules extracted from the file', () => {
  const unq = (s: string) => s.replace(/''/g, "'")
  function sqlValue(e: string): string | null {
    e = e.trim()
    let m: RegExpExecArray | null
    if (/^null(::text)?$/.test(e)) return null
    if ((m = /^'((?:[^']|'')*)'$/.exec(e))) return unq(m[1])
    if ((m = /^'((?:[^']|'')*)' \|\| chr\((\d+)\)$/.exec(e))) return unq(m[1]) + String.fromCharCode(Number(m[2]))
    if ((m = /^'((?:[^']|'')*)' \|\| repeat\('(.)', (\d+)\)$/.exec(e))) return unq(m[1]) + m[2].repeat(Number(m[3]))
    throw new Error(`unparsed fixture value: ${e}`)
  }

  const rows = SQL.split('\n').flatMap(line => {
    const m = /^\s*\('(C\d\d [^']*)',\s*(null(?:::text)?|'(?:[^']|'')*'),\s*(.+?),\s*(null(?:::text)?|'[a-z]+'),\s*(true|false)\),?\s*$/.exec(line)
    return m ? [{ label: m[1], path: sqlValue(m[2]), url: sqlValue(m[3]), source: sqlValue(m[4]), external: m[5] === 'true' }] : []
  })

  // The same rule, built from the migration's own text. Extracted lazily, so a
  // mutated rule fails an assertion instead of failing to load the suite.
  const rule = () => {
    const v = /add column video_source text generated always as \( (case .*? end) \) stored/.exec(FLAT)?.[1] ?? ''
    const i = /when video_url ~\* '((?:[^']|'')*)' then 'protected'/.exec(v)
    const e = /and video_url ~\* '((?:[^']|'')*)' then 'external'/.exec(v)
    const c = /length\(video_url\) <= (\d+)/.exec(v)
    expect(i, 'case-insensitive INTERNAL rule not found in video_source').not.toBeNull()
    expect(e, 'case-insensitive EXTERNAL rule not found in video_source').not.toBeNull()
    expect(c, 'length cap not found in video_source').not.toBeNull()
    return { internal: new RegExp(unq(i![1]), 'i'), external: new RegExp(unq(e![1]), 'i'), cap: Number(c![1]) }
  }
  const classify = (path: string | null, url: string | null): [string | null, string | null] => {
    const { internal, external, cap } = rule()
    if ((path ?? '') !== '') return ['protected', null]
    if ((url ?? '') === '') return [null, null]
    if (internal.test(url!)) return ['protected', null]
    if (url!.length <= cap && external.test(url!)) return ['external', url]
    return [null, null]
  }

  it('the migration asserts all 47 cases, and the count it checks matches the table', () => {
    expect(rows).toHaveLength(47)
    expect(new Set(rows.map(r => r.label.slice(0, 3))).size).toBe(47)
    expect(FLAT).toMatch(/if v_i <> 47 then/)
  })

  it('the table carries every adversarial class the owner ruled on', () => {
    const labels = rows.map(r => r.label.slice(0, 3))
    for (const c of ['C04', 'C05', 'C14', 'C15', 'C16', 'C17', 'C18', 'C19', 'C20', 'C21', 'C22', 'C23', 'C24',
                     'C25', 'C26', 'C27', 'C28', 'C29', 'C30', 'C31', 'C32', 'C33', 'C34', 'C35', 'C36', 'C37',
                     'C42', 'C44', 'C46', 'C47'])
      expect(labels, `fixture case ${c} missing`).toContain(c)
  })

  it('every case classifies as the table expects', () => {
    for (const r of rows) {
      const [source, ext] = classify(r.path, r.url)
      expect(source, r.label).toBe(r.source)
      expect(ext, r.label).toBe(r.external ? r.url : null)
    }
  })

  it('no Supabase or storage location can ever be classified external', () => {
    for (const r of rows.filter(r => r.url && /supabase|storage(\/|\\|%(25)*2f)+v1/i.test(r.url)))
      expect(classify(null, r.url)[0], r.label).not.toBe('external')
  })

  it('agrees with resolveAssetSource() except where a URL-only value is withheld fail-closed', () => {
    for (const r of rows) {
      const ref = resolveAssetSource(r.path, r.url)
      const [source, ext] = classify(r.path, r.url)
      if (ref?.kind === 'external' && source !== 'external') {
        expect((r.path ?? '') === '' && ext === null, `${r.label} diverges without being withheld`).toBe(true)
        continue
      }
      expect(source, r.label).toBe(ref?.kind ?? null)
      expect(ext, r.label).toBe(ref?.kind === 'external' ? ref.url : null)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-2A — application boundary', () => {
  it('the SQL reference restates resolveAssetSource(): path first, then URL', () => {
    const src = read('lib/media/paths.ts')
    expect(src).toMatch(/if \(objectPath\) return \{ kind: 'protected', path: objectPath \}\n\s+if \(legacyUrl\) return \{ kind: 'external', url: legacyUrl \}/)
    expect(FLAT).toMatch(/when coalesce\(%1\$I, ''\) <> '' then 'protected' when coalesce\(%2\$I, ''\) <> '' then 'external' end/)
  })

  it('no writer sets a derived field: the admin save action writes raw columns only', () => {
    const actions = read('app/(admin)/admin/modules/[id]/edit/actions.ts')
    for (const d of DERIVED) expect(actions, `actions.ts writes ${d}`).not.toContain(d)
  })

  it('WC-2A ships no application reader yet (the WC-2B release changes this deliberately)', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const p = `${dir}/${name}`
        if (statSync(join(ROOT, p)).isDirectory()) { walk(p); continue }
        if (!/\.(ts|tsx|js|mjs)$/.test(name)) continue
        const s = read(p)
        if (DERIVED.some(d => s.includes(d))) offenders.push(p)
      }
    }
    for (const d of ['app', 'components', 'lib', 'types']) walk(d)
    expect(offenders).toEqual([])
  })
})
