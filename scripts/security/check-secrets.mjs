#!/usr/bin/env node
/**
 * Secret scanner (SEC-3).
 *
 * Fails if a credential is present in tracked files, or was committed at any
 * point in git history. Catches the mistake that most often precedes an
 * identity incident: a service-role key or provider API key pushed to a repo.
 *
 * Run:  npm run scan:secrets
 * Exit 0 = clean, exit 1 = a credential was found.
 *
 * Scope note: this checks committed content only. Runtime configuration lives
 * in Vercel/Supabase and is out of scope here.
 */

import { execFileSync } from 'node:child_process'

/**
 * Credential SHAPES, not variable names. Matching the shape avoids the noise of
 * flagging every mention of `SUPABASE_SERVICE_ROLE_KEY` in docs and .env.example,
 * while still catching a real key.
 */
const SECRET_PATTERNS = [
  { name: 'JWT (Supabase anon/service_role key)', re: 'eyJhbGciOiJ[A-Za-z0-9_-]{20,}' },
  { name: 'Anthropic API key',                    re: 'sk-ant-[A-Za-z0-9_-]{20,}' },
  { name: 'OpenAI-style API key',                 re: 'sk-[A-Za-z0-9]{32,}' },
  { name: 'Resend API key',                       re: 're_[A-Za-z0-9]{24,}' },
  { name: 'Stripe live secret key',               re: 'sk_live_[A-Za-z0-9]{20,}' },
  { name: 'Generic AWS access key id',            re: 'AKIA[0-9A-Z]{16}' },
  { name: 'Private key block',                    re: '-----BEGIN [A-Z ]*PRIVATE KEY-----' },
]

// Documentation and lockfiles legitimately contain key-shaped strings
// (integrity hashes, redacted examples), so they are excluded from the scan.
const EXCLUDES = [":!*.md", ":!package-lock.json", ":!scripts/security/check-secrets.mjs"]

let failed = 0

/**
 * Run git with an argument array — no shell, so regex metacharacters and quotes
 * in the patterns cannot be mangled by shell parsing.
 */
function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (e) {
    // git grep / git log exit 1 when there are no matches — success for us.
    if (e.status === 1) return ''
    throw new Error(`git ${args.slice(0, 2).join(' ')} failed (status ${e.status})`)
  }
}

// ── 1. Tracked working-tree files ────────────────────────────────────────────
console.log('Scanning tracked files…')
for (const { name, re } of SECRET_PATTERNS) {
  // `-e` is required: patterns beginning with '-' (e.g. the PRIVATE KEY block)
  // are otherwise parsed as command-line options.
  const out = git(['grep', '-nE', '-e', re, '--', '.', ...EXCLUDES])
  if (out.trim()) {
    console.error(`✗ ${name} found in tracked files:`)
    console.error(out.trim().split('\n').map(l => `    ${l.slice(0, 160)}`).join('\n'))
    failed++
  }
}

// ── 2. Any env file that should never be committed ───────────────────────────
const trackedEnv = git(['ls-files'])
  .split('\n')
  .filter(f => /(^|\/)\.env($|\.)/.test(f) && !f.endsWith('.env.example'))
if (trackedEnv.length > 0) {
  console.error('✗ Environment file(s) committed to the repository:')
  trackedEnv.forEach(f => console.error(`    ${f}`))
  failed++
}

// ── 3. Git history ───────────────────────────────────────────────────────────
// A secret removed in a later commit is still exposed in history and must be
// rotated, so scan every blob ever committed.
console.log('Scanning git history…')
for (const { name, re } of SECRET_PATTERNS) {
  const out = git(['log', '--all', '--oneline', `-G${re}`, '--', '.', ...EXCLUDES])
  if (out.trim()) {
    const commits = out
      .split('\n')
      .filter(l => /^[0-9a-f]{7,}\s/.test(l))
      .slice(0, 5)
    console.error(`✗ ${name} appears in git history (rotate the credential):`)
    commits.forEach(c => console.error(`    ${c}`))
    failed++
  }
}

if (failed > 0) {
  console.error(
    `\n${failed} secret finding(s).\n` +
    'A credential in the repository must be treated as compromised: rotate it first,\n' +
    'then remove it from history. Removing it without rotating is not a fix.'
  )
  process.exit(1)
}

console.log(`✓ No credentials found — ${SECRET_PATTERNS.length} patterns checked across tracked files and history.`)
