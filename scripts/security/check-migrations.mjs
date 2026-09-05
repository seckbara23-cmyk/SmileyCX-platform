#!/usr/bin/env node
/**
 * Migration / RLS safety linter (SEC-3).
 *
 * Catches the class of defect that produced SEC-1 finding F-2: a write policy
 * (UPDATE / INSERT / ALL) written with only a USING clause. PostgreSQL then
 * reuses USING as WITH CHECK — but a USING expression typically constrains ROW
 * OWNERSHIP, not COLUMN VALUES, so the row owner can freely rewrite privileged
 * columns. That is exactly how `platform_role` became self-escalatable.
 *
 * It also catches a defect class that reaches production a different way: a
 * PL/pgSQL RAISE whose format string and argument list disagree. Postgres
 * rejects that at COMPILE time (42601 "too many parameters specified for
 * RAISE"), so the whole migration fails to run — but nothing in this repository
 * parses PL/pgSQL, so it was previously invisible until an operator pasted the
 * file into the SQL editor. QUIZ-1B migration 052 failed exactly this way.
 *
 * Run:  npm run lint:sql
 * Exit 0 = no NEW findings, exit 1 = a new risky policy or dangerous statement.
 *
 * Ratchet: findings already recorded in rls-lint-baseline.json are reported as
 * known debt and do not fail the build. Anything new fails. Remove entries from
 * the baseline as they are fixed — the file is a to-do list, not an exemption.
 *
 * One-off suppression (for a genuinely intentional case), on the line before:
 *   -- rls-lint-ignore: <reason>
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE            = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR  = 'supabase/migrations'
const BASELINE_PATH   = join(HERE, 'rls-lint-baseline.json')

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Blank out SQL comments while preserving length and newlines, so match offsets
 * still map to original line numbers — and so `-- rls-lint-ignore`, which is
 * itself a comment, remains findable in the original text.
 *
 * Necessary because these migrations carry commented-out ROLLBACK blocks by
 * convention; without masking, that example SQL is parsed as live statements.
 */
function maskSqlComments(sql) {
  const blank = m => m.replace(/[^\n]/g, ' ')
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/--[^\n]*/g, blank)
}

/** True when the two lines preceding `index` carry a suppression marker. */
function isSuppressed(originalSql, index) {
  const preceding = originalSql.slice(0, index).split('\n').slice(-3).join('\n')
  return /rls-lint-ignore/i.test(preceding)
}

function lineOf(sql, index) {
  return sql.slice(0, index).split('\n').length
}

// ── Rules ────────────────────────────────────────────────────────────────────

/** A policy that can write rows (UPDATE / INSERT / ALL) must declare WITH CHECK. */
function findWritePoliciesWithoutCheck(masked, original, file) {
  const findings = []
  const re = /create\s+policy\s+"([^"]+)"[\s\S]*?;/gi
  let m
  while ((m = re.exec(masked)) !== null) {
    const stmt = m[0]
    const name = m[1]
    const forClause = /\bfor\s+(update|insert|all|select|delete)\b/i.exec(stmt)
    const command = forClause ? forClause[1].toLowerCase() : 'all' // FOR defaults to ALL
    if (!['update', 'insert', 'all'].includes(command)) continue
    if (/\bwith\s+check\b/i.test(stmt)) continue
    if (isSuppressed(original, m.index)) continue

    findings.push({
      id:      `${file}::${name}`,
      file,
      line:    lineOf(original, m.index),
      message: `policy "${name}" (FOR ${command.toUpperCase()}) has no WITH CHECK`,
      detail:
        'PostgreSQL reuses USING as WITH CHECK, which constrains row ownership but NOT\n' +
        '    column values — the pattern behind SEC-1 finding F-2. Add an explicit WITH CHECK.',
    })
  }
  return findings
}

/** Statements that would silently weaken or disable row-level security. */
function findRlsDisablers(masked, original, file) {
  const findings = []
  const patterns = [
    { re: /alter\s+table\s+([^\s;]+)\s+disable\s+row\s+level\s+security/gi, what: 'DISABLE ROW LEVEL SECURITY' },
    { re: /create\s+policy\s+"([^"]+)"[^;]*using\s*\(\s*true\s*\)[^;]*;/gi,  what: 'policy with USING (true)' },
    { re: /grant\s+all\s+on\s+([^\s;]+)\s+to\s+(anon|public)\b/gi,           what: 'GRANT ALL to anon/public' },
  ]
  for (const { re, what } of patterns) {
    let m
    while ((m = re.exec(masked)) !== null) {
      if (isSuppressed(original, m.index)) continue
      findings.push({
        id:      `${file}::${what}::${m[1] ?? ''}`,
        file,
        line:    lineOf(original, m.index),
        message: `dangerous statement — ${what}${m[1] ? ` (${m[1]})` : ''}`,
        detail:  'This broadens access at the database layer. Confirm it is intentional.',
      })
    }
  }
  return findings
}

/**
 * A RAISE whose placeholder count does not match its argument count.
 *
 * This needs literal-aware scanning rather than the shared comment mask: the
 * format string is itself a quoted literal, and migrations carry commented-out
 * ROLLBACK blocks whose RAISE statements must NOT be linted. Newlines are
 * preserved while stripping, so reported line numbers match the original file.
 */
function stripCommentsLiteralAware (sql) {
  let out = '', inStr = false
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], n = sql[i + 1]
    if (inStr) {
      out += c
      if (c === "'") { if (n === "'") { out += n; i++ } else inStr = false }
      continue
    }
    if (c === "'") { inStr = true; out += c; continue }
    if (c === '-' && n === '-') { while (i < sql.length && sql[i] !== '\n') i++; out += '\n'; continue }
    out += c
  }
  return out
}

/** Read a single-quoted literal at i, handling '' escapes. */
function readLiteral (sql, i) {
  let v = ''
  i++
  while (i < sql.length) {
    if (sql[i] === "'") {
      if (sql[i + 1] === "'") { v += "'"; i += 2; continue }
      return { value: v, end: i + 1 }
    }
    v += sql[i++]
  }
  return { value: v, end: i }
}

/** Count % placeholders, treating %% as an escaped literal percent. */
function countPlaceholders (s) {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '%') continue
    if (s[i + 1] === '%') { i++; continue }
    n++
  }
  return n
}

/** Split the argument list following the format string, up to the closing ';'. */
function readRaiseArgs (sql, i) {
  let depth = 0, cur = '', args = []
  while (i < sql.length) {
    const c = sql[i]
    if (c === "'") { const r = readLiteral(sql, i); cur += 'x'; i = r.end; continue }
    if (c === '(') depth++
    if (c === ')') depth--
    if (c === ';' && depth === 0) { if (cur.trim()) args.push(cur.trim()); return args }
    if (c === ',' && depth === 0) { if (cur.trim()) args.push(cur.trim()); cur = ''; i++; continue }
    cur += c
    i++
  }
  return args
}

function findRaiseArityMismatches (_masked, original, file) {
  const sql = stripCommentsLiteralAware(original)
  const findings = []
  const re = /\braise\s+(exception|notice|warning|info|log|debug)\s*/gi
  let m
  while ((m = re.exec(sql)) !== null) {
    let i = m.index + m[0].length
    while (i < sql.length && /\s/.test(sql[i])) i++
    if (sql[i] !== "'") continue          // RAISE USING, or a bare re-raise
    const lit = readLiteral(sql, i)
    let j = lit.end
    while (j < sql.length && /\s/.test(sql[j])) j++
    const args = sql[j] === ',' ? readRaiseArgs(sql, j + 1) : []
    const holes = countPlaceholders(lit.value)
    if (holes === args.length) continue
    if (isSuppressed(original, m.index)) continue
    const line = sql.slice(0, m.index).split('\n').length
    findings.push({
      id:      `${file}::raise-arity::${line}`,
      file,
      line,
      message: `RAISE has ${holes} placeholder(s) but ${args.length} argument(s)`,
      detail:
        'PostgreSQL rejects this at COMPILE time (42601), so the ENTIRE migration\n' +
        '    fails to run. Add or remove a % in the format string, or fix the argument\n' +
        `    list. Message: ${JSON.stringify(lit.value.slice(0, 90))}`,
    })
  }
  return findings
}
// ── Run ──────────────────────────────────────────────────────────────────────

const baseline = existsSync(BASELINE_PATH)
  ? new Set(JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).known ?? [])
  : new Set()

const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()

const all = []
for (const file of files) {
  const original = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
  const masked   = maskSqlComments(original)
  all.push(
    ...findWritePoliciesWithoutCheck(masked, original, file),
    ...findRlsDisablers(masked, original, file),
    ...findRaiseArityMismatches(masked, original, file),
  )
}

const fresh = all.filter(f => !baseline.has(f.id))
const known = all.filter(f =>  baseline.has(f.id))

for (const f of fresh) {
  console.error(`✗ ${f.file}:${f.line} — ${f.message}\n    ${f.detail}`)
}

if (known.length > 0) {
  console.warn(`\n⚠ ${known.length} known finding(s) carried in the baseline (tracked debt, not failing the build):`)
  for (const f of known) console.warn(`    ${f.file}:${f.line} — ${f.message}`)
}

// A baseline entry that no longer matches anything means the issue was fixed —
// prompt for its removal so the ratchet keeps tightening.
const stale = [...baseline].filter(id => !all.some(f => f.id === id))
if (stale.length > 0) {
  console.warn(`\n⚠ ${stale.length} stale baseline entr(y/ies) — fixed, please remove from rls-lint-baseline.json:`)
  for (const id of stale) console.warn(`    ${id}`)
}

if (fresh.length > 0) {
  console.error(`\n${fresh.length} NEW RLS/migration issue(s) across ${files.length} migrations.`)
  process.exit(1)
}

console.log(
  `✓ No new RLS/migration issues — ${files.length} migrations scanned` +
  (known.length ? `, ${known.length} known finding(s) in baseline.` : '.')
)
