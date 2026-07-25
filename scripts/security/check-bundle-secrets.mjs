#!/usr/bin/env node
/**
 * Client-bundle secret scanner (SEC-3).
 *
 * Automates the manual grep performed in SEC-1 and SEC-2: anything server-only
 * that reaches `.next/static` has been shipped to every visitor's browser.
 *
 * Run after `npm run build`:  node scripts/security/check-bundle-secrets.mjs
 * Exit 0 = clean, exit 1 = a secret or server-only artefact leaked.
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const BUNDLE_DIR = '.next/static'

/**
 * Patterns that must never appear in a client bundle.
 * Each is either a server-only env var name, a live credential shape, or a
 * server-only code artefact.
 */
const FORBIDDEN = [
  // ── Server-only environment variable names ────────────────────────────────
  { name: 'SUPABASE_SERVICE_ROLE_KEY', re: /SUPABASE_SERVICE_ROLE_KEY/ },
  { name: 'ANTHROPIC_API_KEY',         re: /ANTHROPIC_API_KEY/ },
  { name: 'ELEVENLABS_API_KEY',        re: /ELEVENLABS_API_KEY/ },
  { name: 'RESEND_API_KEY',            re: /RESEND_API_KEY/ },
  { name: 'ADMIN_EMAIL / ADMIN_USERNAME', re: /ADMIN_(EMAIL|USERNAME)/ },
  { name: 'STRIPE_SECRET_KEY',         re: /STRIPE_SECRET_KEY/ },

  // ── Live credential shapes (a real key, not just its name) ────────────────
  { name: 'Anthropic key value',   re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'Resend key value',      re: /\bre_[A-Za-z0-9]{24,}/ },
  { name: 'Stripe live key value', re: /\bsk_live_[A-Za-z0-9]{20,}/ },
  { name: 'Supabase service_role JWT', re: /"role"\s*:\s*"service_role"/ },

  // ── Server-only code artefacts ────────────────────────────────────────────
  // The audit helper writes with the service-role client; it must stay server-side.
  { name: 'audit helper (logAuditEvent)', re: /logAuditEvent/ },
  // Public self-registration must not exist anywhere (SEC-2 / F-1).
  { name: 'client registration call', re: /auth\/v1\/signup/ },
]

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, acc)
    else acc.push(full)
  }
  return acc
}

if (!existsSync(BUNDLE_DIR)) {
  console.error(`✗ ${BUNDLE_DIR} not found — run \`npm run build\` first.`)
  process.exit(1)
}

const files = walk(BUNDLE_DIR).filter(f => /\.(js|mjs|css|json|txt|map)$/.test(f))
const findings = []

for (const file of files) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue // binary or unreadable — nothing to scan
  }
  for (const { name, re } of FORBIDDEN) {
    if (re.test(text)) findings.push({ file, name })
  }
}

if (findings.length > 0) {
  console.error('✗ SECURITY: server-only material found in the client bundle\n')
  for (const f of findings) console.error(`  ${f.name}\n    → ${f.file}`)
  console.error('\nA secret in .next/static is shipped to every visitor. Fix before merging.')
  process.exit(1)
}

console.log(`✓ Client bundle clean — scanned ${files.length} files against ${FORBIDDEN.length} patterns.`)
