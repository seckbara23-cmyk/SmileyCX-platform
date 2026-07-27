#!/usr/bin/env node
/**
 * Provision administration-portal account(s) (CX-AUTH-1).
 *
 * Creates every account listed in ADMIN_OWNER_EMAILS and sends each a
 * password-setup email. Each holder chooses their own password through
 * Supabase's recovery flow.
 *
 * NO PASSWORD IS EVER GENERATED, PRINTED, STORED, OR COMMITTED by this script.
 *
 * Usage:
 *   node scripts/auth/provision-owner.mjs            # dry run — shows what it would do
 *   node scripts/auth/provision-owner.mjs --confirm  # actually create + email
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY and ADMIN_OWNER_EMAILS (read from
 * .env.local when present, or from the real environment).
 *
 * Idempotent: if the account already exists it is NOT recreated; the script
 * only (re)sends the password-setup email.
 */
import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

// Load .env.local when present (npm does not do this; Next.js does).
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#') || !t.includes('=')) continue
    const i = t.indexOf('=')
    const key = t.slice(0, i).trim()
    if (process.env[key] === undefined) {
      process.env[key] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    }
  }
}

const url     = process.env.NEXT_PUBLIC_SUPABASE_URL
const service = process.env.SUPABASE_SERVICE_ROLE_KEY
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://smiley-cx-platform.vercel.app'
const confirm = process.argv.includes('--confirm')

// ADMIN_OWNER_EMAILS is a comma-separated allowlist; provision every address.
const owners = (process.env.ADMIN_OWNER_EMAILS ?? '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean)

function fail(msg) { console.error(`✗ ${msg}`); process.exitCode = 1 }

if (!url || !service) { fail('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.'); process.exit(1) }
if (owners.length === 0) { fail('ADMIN_OWNER_EMAILS is not set (comma-separated list).'); process.exit(1) }

const invalid = owners.filter(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
if (invalid.length) { fail(`Invalid address(es) in ADMIN_OWNER_EMAILS: ${invalid.join(', ')}`); process.exit(1) }

console.log(`Administrator address(es) : ${owners.join(', ')}`)
console.log(`Password redirect         : ${siteUrl}/auth/callback?next=/reset-password&type=recovery`)

if (!confirm) {
  console.log('\n• DRY RUN — nothing was created and no email was sent.')
  console.log('  Re-run with --confirm to provision the account(s).')
  console.log('  Verify the address(es) above are EXACTLY correct first: this sends real email.')
  process.exit(0)
}

const admin = createClient(url, service, { auth: { persistSession: false } })

// Fetch the user list once; reuse across every address.
const { data: list, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
if (listErr) { fail(`Could not list users: ${listErr.message}`); process.exit(1) }

for (const owner of owners) {
  console.log(`\n— ${owner}`)

  const existing = list.users.find(u => (u.email ?? '').toLowerCase() === owner)

  if (existing) {
    console.log(`  • Account already exists (id ${existing.id}) — not recreating.`)
  } else {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: owner,
      email_confirm: true,   // the holder sets the password via the recovery link below
    })
    if (createErr) { fail(`  Could not create ${owner}: ${createErr.message}`); continue }
    console.log(`  ✓ Created account (id ${created.user.id}).`)

    // Ensure the profile row exists so requirePlatformAdmin() resolves.
    const { error: profileErr } = await admin
      .from('profiles')
      .upsert({ id: created.user.id, email: owner, platform_role: 'super_admin' }, { onConflict: 'id' })
    if (profileErr) console.warn(`  ⚠ Profile upsert warning: ${profileErr.message}`)
    else console.log('  ✓ Profile row ensured (platform_role=super_admin).')
  }

  // Send the password-setup email — the holder chooses their own password.
  const { error: linkErr } = await admin.auth.resetPasswordForEmail(owner, {
    redirectTo: `${siteUrl}/auth/callback?next=/reset-password&type=recovery`,
  })
  if (linkErr) { fail(`  Could not send password-setup email to ${owner}: ${linkErr.message}`); continue }
  console.log('  ✓ Password-setup email sent.')
}

console.log('\nDone. No password was generated, printed, or stored.')
