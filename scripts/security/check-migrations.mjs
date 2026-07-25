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
