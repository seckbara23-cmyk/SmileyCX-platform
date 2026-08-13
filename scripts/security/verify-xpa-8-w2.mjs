#!/usr/bin/env node
/**
 * XPA-8 W2 production verification — the legacy `/app/[orgSlug]` surface is retired.
 *
 *   node scripts/security/verify-xpa-8-w2.mjs
 *
 * ── WHY THIS PROBE USES REAL SESSION COOKIES ───────────────────────────────
 *
 * `/app` sits behind the middleware's AUTH_REQUIRED list, so an anonymous
 * request only ever proves that the middleware is awake — it never reaches the
 * page. Every interesting branch of the retirement handler is behind a login.
 *
 * So the cookies are not hand-rolled. This script builds a `createServerClient`
 * from the SAME `@supabase/ssr` the application uses, hands it a cookie jar,
 * and lets the library write the session exactly as it would in a browser —
 * name, chunking and encoding included. Guessing the cookie format would test
 * my guess; this tests the app.
 *
 * ── WHAT "RETIRED" HAS TO MEAN ─────────────────────────────────────────────
 *
 * Not merely "the old screens are gone". The replacement must not become a new
 * information leak, so the checks below insist that the response is INDIFFERENT
 * to the slug:
 *
 *   • a real organization's slug and an invented one must be indistinguishable
 *     — otherwise the retired route is an existence oracle telling any learner
 *     which companies are customers;
 *   • a member of org A asking for org B's URL must land where a member of
 *     nothing lands;
 *   • no destination may sit under /app, or the redirect loops.
 *
 * Fixtures (two organizations, one membership, one throwaway learner) are
 * created and removed by id in the finally block. Nothing global is asserted
 * empty — other work may legitimately be in flight.
 */
import { readFileSync } from 'node:fs'
import { createServerClient } from '@supabase/ssr'

const env = {}
try {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* fall through to process.env */ }

const SB = env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SVC = env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
const SITE = process.env.SITE_URL ?? 'https://www.xpclient-academy.com'

if (!SB || !ANON || !SVC) {
  console.error('Missing Supabase configuration.')
  process.exit(1)
}

let pass = 0
const failures = []
const record = (label, detail, ok) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(54)} ${detail}`)
  if (ok) pass++
  else failures.push(`${label} — ${detail}`)
}

const rest = async (path, { method = 'GET', body, prefer } = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json',
      Prefer: prefer ?? 'count=exact',
    },
    body,
  })
  const t = await r.text()
  let j = null
  try { j = JSON.parse(t) } catch { /* non-JSON */ }
  return { status: r.status, rows: Array.isArray(j) ? j : (j ? [j] : []), raw: t }
}

const admin = (path, method, body) => fetch(`${SB}/auth/v1${path}`, {
  method,
  headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
})

const PW = 'Kx7#mQr4!vTs9Ld2'
const STAMP = process.env.W2_STAMP ?? String(process.hrtime.bigint()).slice(-9)
const LEARNER = `xpa8w2-verify-${STAMP}-delete-me@xpclient-academy.com`
const SLUG_A = `xpa8w2-fixture-a-${STAMP}`
const SLUG_B = `xpa8w2-fixture-b-${STAMP}`

let learnerId = null
let orgAId = null
let orgBId = null
let membershipId = null

/** Sign in through @supabase/ssr and return the cookie header it produced. */
async function sessionCookies(email, password) {
  const jar = new Map()
  const client = createServerClient(SB, ANON, {
    cookies: {
      get: (name) => jar.get(name),
      set: (name, value) => { jar.set(name, value) },
      remove: (name) => { jar.delete(name) },
    },
  })
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error || !data?.session) return { header: null, jar }
  return {
    header: [...jar.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '),
    jar,
  }
}

/** Request a path without following redirects; report what actually happened. */
async function hit(path, cookieHeader) {
  const r = await fetch(SITE + path, {
    redirect: 'manual',
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  })
  const location = r.headers.get('location') ?? ''
  let markers = []
  let bytes = 0
  if (r.status === 200) {
    const body = await r.text()
    bytes = body.length
    for (const m of ['OrgSwitcher', 'Journeys', 'Touchpoints', 'Action Plans', 'SmileyCX']) {
      if (new RegExp(m, 'i').test(body)) markers.push(m)
    }
  }
  // Normalise the origin away so same-target comparisons are meaningful.
  const target = location.replace(/^https?:\/\/[^/]+/, '')
  return { status: r.status, target, markers, bytes }
}

try {
  console.log(`\nXPA-8 W2 — legacy /app surface retirement, verified against ${SITE}`)
  console.log(`Fixture stamp: ${STAMP}`)

  console.log('\n── 1. Fixtures ─────────────────────────────────────────────────')
  const created = await admin('/admin/users', 'POST', {
    email: LEARNER, password: PW, email_confirm: true,
  })
  learnerId = (await created.json()).id
  record('throwaway learner created', learnerId ? learnerId.slice(0, 8) : 'FAILED', Boolean(learnerId))

  const orgs = await rest('organizations', {
    method: 'POST',
    prefer: 'return=representation',
    body: JSON.stringify([
      { name: 'XPA8W2 Fixture A', slug: SLUG_A },
      { name: 'XPA8W2 Fixture B', slug: SLUG_B },
    ]),
  })
  orgAId = orgs.rows.find(o => o.slug === SLUG_A)?.id ?? null
  orgBId = orgs.rows.find(o => o.slug === SLUG_B)?.id ?? null
  record('two fixture organizations created', `${orgAId ? 'A' : '—'} ${orgBId ? 'B' : '—'}`,
    Boolean(orgAId && orgBId))

  const mem = await rest('organization_memberships', {
    method: 'POST',
    prefer: 'return=representation',
    body: JSON.stringify({ org_id: orgAId, user_id: learnerId, role: 'org_admin', status: 'ACTIVE' }),
  })
  membershipId = mem.rows[0]?.id ?? null
  record('learner is an ACTIVE org_admin of A', membershipId ? 'membership created' : mem.raw.slice(0, 60),
    Boolean(membershipId))

  const { header: learnerCookies, jar } = await sessionCookies(LEARNER, PW)
  record('learner session cookies issued', jar.size ? `${jar.size} cookie(s)` : 'NONE', Boolean(learnerCookies))

  console.log('\n── 2. Anonymous callers never reach the handler ────────────────')
  for (const p of ['/app', '/app/orgs', `/app/${SLUG_A}`, `/app/${SLUG_A}/dashboard`]) {
    const r = await hit(p, null)
    record(`anon ${p}`, `${r.status} -> ${r.target}`,
      r.status >= 300 && r.status < 400 && r.target.startsWith('/login'))
  }

  console.log('\n── 3. The legacy product is gone for a real learner ────────────')
  const LEGACY = [
    '/app', '/app/orgs', '/app/onboarding',
    `/app/${SLUG_A}`, `/app/${SLUG_A}/dashboard`, `/app/${SLUG_A}/journeys`,
    `/app/${SLUG_A}/feedback`, `/app/${SLUG_A}/actions`, `/app/${SLUG_A}/settings`,
  ]
  const results = {}
  for (const p of LEGACY) {
    const r = await hit(p, learnerCookies)
    results[p] = r
    record(`learner ${p}`, `${r.status} -> ${r.target}${r.markers.length ? ' ⚠ ' + r.markers : ''}`,
      r.status >= 300 && r.status < 400 && r.target === '/dashboard' && r.markers.length === 0)
  }

  console.log('\n── 4. No legacy screen renders anywhere ────────────────────────')
  const anyMarkers = Object.entries(results).filter(([, r]) => r.markers.length > 0)
  record('no SmileyCX/OrgSwitcher/Journeys markers', `${anyMarkers.length} page(s) with markers`,
    anyMarkers.length === 0)
  const any200 = Object.entries(results).filter(([, r]) => r.status === 200)
  record('no legacy route returns a rendered page', `${any200.length} page(s) returned 200`,
    any200.length === 0)

  console.log('\n── 5. The slug is not an existence oracle ──────────────────────')
  const real = await hit(`/app/${SLUG_A}`, learnerCookies)
  const foreign = await hit(`/app/${SLUG_B}`, learnerCookies)
  const invented = await hit(`/app/definitely-not-an-org-${STAMP}`, learnerCookies)
  record('member of A -> A', `${real.status} ${real.target}`, real.target === '/dashboard')
  record('member of A -> B (foreign org)', `${foreign.status} ${foreign.target}`,
    foreign.target === '/dashboard')
  record('member of A -> invented slug', `${invented.status} ${invented.target}`,
    invented.target === '/dashboard')
  record('real and invented slugs are INDISTINGUISHABLE',
    `${real.status}/${real.target} vs ${invented.status}/${invented.target}`,
    real.status === invented.status && real.target === invented.target)
  record('org A and org B are INDISTINGUISHABLE',
    `${real.status}/${real.target} vs ${foreign.status}/${foreign.target}`,
    real.status === foreign.status && real.target === foreign.target)

  console.log('\n── 6. Hostile slugs fail safely ────────────────────────────────')
  for (const [label, p] of [
    ['open redirect (//evil.com)', '/app//evil.com'],
    ['absolute URL as slug', '/app/https:/evil.com'],
    ['path traversal', '/app/../admin/organizations'],
    ['deep nesting', `/app/${SLUG_B}/dashboard/extra/segments`],
  ]) {
    const r = await hit(p, learnerCookies)
    const offsite = /^https?:\/\//i.test(r.target) && !r.target.includes('xpclient-academy.com')
    record(label, `${r.status} -> ${r.target || '(none)'}`,
      !offsite && !r.target.startsWith('//') && r.markers.length === 0)
  }

  console.log('\n── 7. No redirect loop ─────────────────────────────────────────')
  for (const [label, p] of [['/app', '/app'], [`/app/${SLUG_A}`, `/app/${SLUG_A}`]]) {
    let cur = p
    const chain = [cur]
    let looped = false
    for (let i = 0; i < 6; i++) {
      const r = await hit(cur, learnerCookies)
      if (r.status < 300 || r.status >= 400 || !r.target) break
      if (chain.includes(r.target)) { looped = true; chain.push(r.target); break }
      chain.push(r.target)
      cur = r.target
      if (!cur.startsWith('/')) break
    }
    record(`${label} settles without looping`, chain.join(' -> '),
      !looped && !chain.slice(1).some(c => c.startsWith('/app')))
  }

  console.log('\n── 8. The replacement surface still works ──────────────────────')
  const adminPage = await hit('/admin/organizations', learnerCookies)
  record('non-admin learner cannot reach /admin/organizations',
    `${adminPage.status} -> ${adminPage.target}`,
    adminPage.status >= 300 && adminPage.status < 400 && !adminPage.target.startsWith('/admin'))
  const dash = await hit('/dashboard', learnerCookies)
  record('the redirect target itself is reachable', `${dash.status}`,
    dash.status === 200 || (dash.status >= 300 && dash.status < 400))

  console.log('\n── 9. Organization data was not exposed to the learner ─────────')
  const asLearner = await fetch(`${SB}/rest/v1/organizations?select=id,slug`, {
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${(await (await fetch(`${SB}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: ANON, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: LEARNER, password: PW }),
      })).json()).access_token}`,
      Prefer: 'count=exact',
    },
  })
  const seen = await asLearner.json()
  const slugs = Array.isArray(seen) ? seen.map(o => o.slug) : []
  record('learner sees only the org they belong to',
    `${slugs.length} org(s): ${slugs.join(', ') || 'none'}`,
    slugs.length === 1 && slugs[0] === SLUG_A)
  record('learner cannot see the foreign organization',
    slugs.includes(SLUG_B) ? 'ORG B VISIBLE' : 'org B hidden',
    !slugs.includes(SLUG_B))
} finally {
  console.log('\n── Cleanup (fixture-scoped, by id) ─────────────────────────────')
  if (membershipId) {
    const d = await rest(`organization_memberships?id=eq.${membershipId}`, { method: 'DELETE', prefer: 'count=exact' })
    console.log(`  membership deleted: ${d.status}`)
  }
  for (const [label, id] of [['org A', orgAId], ['org B', orgBId]]) {
    if (!id) continue
    const d = await rest(`organizations?id=eq.${id}`, { method: 'DELETE', prefer: 'count=exact' })
    console.log(`  ${label} deleted: ${d.status}`)
  }
  if (learnerId) {
    const d = await admin(`/admin/users/${learnerId}`, 'DELETE')
    console.log(`  learner deleted: ${d.status}`)
  }
  const strayOrgs = await rest(`organizations?slug=in.(${SLUG_A},${SLUG_B})&select=id`)
  const strayUsers = await rest(`profiles?id=eq.${learnerId ?? '00000000-0000-0000-0000-000000000000'}&select=id`)
  console.log(`  strays — organizations: ${strayOrgs.rows.length}, profile: ${strayUsers.rows.length}`)

  console.log('\n────────────────────────────────────────────────────────────────')
  if (failures.length === 0) {
    console.log(`✓ XPA-8 W2 PASS — ${pass} checks, 0 failures.\n`)
  } else {
    console.log(`✗ XPA-8 W2 FAIL — ${failures.length} of ${pass + failures.length} checks failed:`)
    for (const f of failures) console.log(`    ${f}`)
    console.log('')
    process.exitCode = 1
  }
}
