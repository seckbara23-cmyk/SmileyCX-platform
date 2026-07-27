#!/usr/bin/env node
/**
 * CX-AUTH-1A — one-time administrator password rotation.
 *
 * Resets the passwords of the two XP Client Academy administrators through the
 * official Supabase Admin API (auth.admin.updateUserById). It does NOT touch
 * auth.users in SQL — that would bypass Supabase's own password hashing and
 * session invalidation.
 *
 * This is a MAINTENANCE UTILITY ONLY. It changes no authentication logic, no
 * middleware, no authorization, and no ADMIN_OWNER_EMAILS allowlist.
 *
 * ── Secrets handling ──────────────────────────────────────────────────────
 * Passwords are read from the environment and are NEVER printed, logged,
 * written to disk, echoed on failure, or committed. Error messages from
 * Supabase are surfaced, but the values themselves never appear in output.
 * The service-role key is server-side only and is never sent to a browser.
 *
 * Usage:
 *   SECKBARA_NEW_PASSWORD='…' MARIEME_NEW_PASSWORD='…' \
 *     node scripts/change-admin-passwords.mjs
 *
 * Exit codes: 0 = both updated, 1 = any failure.
 */
import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

// Load .env.local when present (npm does not do this; Next.js does). Real
// environment variables always win, so an explicit inline value overrides the file.
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

// SUPABASE_URL is the documented name for this utility; the rest of the
// repository uses NEXT_PUBLIC_SUPABASE_URL, so accept that as a fallback
// rather than requiring a duplicate variable.
const url     = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const service = process.env.SUPABASE_SERVICE_ROLE_KEY

/** email → the environment variable holding its new password */
const TARGETS = [
  { email: 'seckbara23@gmail.com',  envVar: 'SECKBARA_NEW_PASSWORD' },
  { email: 'mariemeify@gmail.com',  envVar: 'MARIEME_NEW_PASSWORD'  },
]

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

// ── Preconditions ──────────────────────────────────────────────────────────

if (!url)     fail('SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) is not set.')
if (!service) fail('SUPABASE_SERVICE_ROLE_KEY is not set.')

// Fail before contacting Supabase if either password is missing, so a partial
// rotation can never happen: both are required up front.
const missing = TARGETS.filter(t => !(process.env[t.envVar] ?? '').length)
if (missing.length) {
  fail(`Missing required password variable(s): ${missing.map(t => t.envVar).join(', ')}`)
}

// Fail fast with a clear message rather than an opaque API error. Supabase's
// default minimum is 6 characters; this only checks length, never content.
const tooShort = TARGETS.filter(t => (process.env[t.envVar] ?? '').length < 8)
if (tooShort.length) {
  fail(`Password too short (minimum 8 characters): ${tooShort.map(t => t.envVar).join(', ')}`)
}

// ── Locate each account, then update it ────────────────────────────────────

const admin = createClient(url, service, { auth: { persistSession: false } })

// There is no getUserByEmail in supabase-js v2; page through listUsers.
async function findUserByEmail(email) {
  const target = email.toLowerCase()
  const perPage = 1000
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage })
    if (error) throw new Error(`could not list users: ${error.message}`)

    const hit = data.users.find(u => (u.email ?? '').toLowerCase() === target)
    if (hit) return hit
    if (data.users.length < perPage) return null   // last page reached
  }
  return null
}

let failed = false

for (const { email, envVar } of TARGETS) {
  try {
    const user = await findUserByEmail(email)
    if (!user) {
      console.error(`✗ ${email} — no such account`)
      failed = true
      continue
    }

    const { error } = await admin.auth.admin.updateUserById(user.id, {
      password: process.env[envVar],
    })

    if (error) {
      // Surface Supabase's reason, never the password value.
      console.error(`✗ ${email} — ${error.message}`)
      failed = true
      continue
    }

    console.log(`✓ ${email} updated`)
  } catch (err) {
    console.error(`✗ ${email} — ${err instanceof Error ? err.message : String(err)}`)
    failed = true
  }
}

process.exit(failed ? 1 : 0)
