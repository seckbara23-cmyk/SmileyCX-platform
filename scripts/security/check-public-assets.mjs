#!/usr/bin/env node
/**
 * Public-asset guard (XPA-1, decision register D-Q5).
 *
 * Everything tracked under `public/` is served to anyone on the internet, with
 * no authentication and no route handler in between. Internal source material
 * must never end up there.
 *
 * XPA-0 found `public/images/Certificate of Completion.pptx` tracked and LIVE in
 * production (HTTP 200) — an editable certificate template, publicly
 * downloadable, referenced by no code. It was not put there deliberately; it
 * simply followed the design assets in.
 *
 * This guard fails the build when a sensitive source format is tracked under
 * `public/`. It uses a BASELINE (same ratchet pattern as the RLS linter): known
 * entries are reported but do not fail, so CI stays green while the relocation
 * is scheduled — and anything NEW fails immediately.
 *
 * Usage:  npm run scan:public-assets
 * Exit 0 = clean or baseline-only · exit 1 = a new sensitive asset appeared.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

const BASELINE_PATH = 'scripts/security/public-assets-baseline.json'

/** Formats that are source material, never a legitimate public web asset. */
const BLOCKED_EXTENSIONS = [
  '.pptx', '.ppt',      // presentation sources (certificate templates, decks)
  '.docx', '.doc',      // documents
  '.xlsx', '.xls',      // spreadsheets
  '.key', '.numbers', '.pages',
  '.psd', '.ai', '.sketch', '.fig',   // design sources
  '.pdf',               // allowlist genuine learner downloads in the baseline
]

function tracked(dir) {
  try {
    return execFileSync('git', ['ls-files', '--', dir], { encoding: 'utf8' })
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

const baseline = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  : { known: [], allowed: [] }

const known   = new Set(baseline.known ?? [])
const allowed = new Set(baseline.allowed ?? [])

const offenders = tracked('public').filter(f => {
  const lower = f.toLowerCase()
  if (allowed.has(f)) return false
  return BLOCKED_EXTENSIONS.some(ext => lower.endsWith(ext))
})

const carried = offenders.filter(f => known.has(f))
const fresh   = offenders.filter(f => !known.has(f))

if (carried.length) {
  console.warn(`⚠ ${carried.length} known sensitive asset(s) under public/ (tracked debt, not failing the build):`)
  for (const f of carried) console.warn(`    ${f}`)
  console.warn('  Scheduled for relocation to docs/source-material/ — see docs/xpa-decision-register.md (D-Q5).')
}

// Warn when a baseline entry no longer exists: it was fixed and should be removed.
const stale = [...known].filter(f => !offenders.includes(f))
if (stale.length) {
  console.warn(`⚠ ${stale.length} baseline entr(y/ies) no longer present — remove them from ${BASELINE_PATH}:`)
  for (const f of stale) console.warn(`    ${f}`)
}

if (fresh.length) {
  console.error(
    `\n✗ PUBLIC ASSET GUARD FAILED — ${fresh.length} sensitive source file(s) newly tracked under public/:\n` +
    fresh.map(f => `    ${f}`).join('\n') +
    '\n\n  Anything under public/ is served to the internet without authentication.\n' +
    '  Source material belongs in docs/source-material/ (or a git-ignored private\n' +
    '  directory when confidential). If this file IS a genuine learner download,\n' +
    `  add it to "allowed" in ${BASELINE_PATH} with a justification.\n`
  )
  process.exitCode = 1
} else {
  console.log(`✓ No new sensitive source files under public/ — ${BLOCKED_EXTENSIONS.length} formats checked.`)
  process.exitCode = 0
}
