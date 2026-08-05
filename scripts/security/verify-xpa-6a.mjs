#!/usr/bin/env node
/**
 * XPA-6A production verification.
 *
 * Run AFTER applying migrations 035 and 036:
 *   node scripts/security/verify-xpa-6a.mjs
 *
 * ── THE BUG THIS SCRIPT EXISTS TO NOT REPEAT ───────────────────────────────
 *
 * The first post-035 probe scored "denied" as `status >= 400`. Migration 035
 * had left every content policy recursive, so each read returned 500 / 42P17 —
 * and the probe reported PASS for "anonymous callers are refused". The tables
 * were not protected; they were unreadable by everyone, including admins and
 * legitimately enrolled learners.
 *
 * DENIED and BROKEN are different results. A check that cannot tell them apart
 * is not a security check. So `classify()` below names three outcomes, and only
 * one of them is a denial:
 *
 *   EXPECTED_DENIAL  42501            -> no privilege at all; unreachable
 *   DENIED_EMPTY     200, zero rows   -> reachable, RLS returned nothing
 *   ALLOWED          200 with rows    -> the policy ran and said yes
 *   BROKEN           5xx, 42P17, 57014 -> the policy did not run
 *
 * BROKEN is never a pass, whichever answer was wanted.
 *
 * Boundary probes use the PUBLIC ANON KEY or a real learner JWT, so results
 * reflect what those callers actually get. Two throwaway accounts are created
 * and deleted in a finally block — "registration grants no access" and "admin
 * access still works" cannot be proven by reading SQL.
 */
import { readFileSync } from 'node:fs'

const env = {}
try {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* fall through to process.env */ }

const U = env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SVC = env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY

if (!U || !ANON || !SVC) {
  console.error('✗ NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are required.')
  process.exitCode = 1
  process.exit()
}

const results = []
const pad = (s, n) => String(s).padEnd(n)

function record(label, detail, pass) {
  results.push({ label, pass })
  console.log(`  ${pass ? '✓' : '✗'} ${pad(label, 54)} ${detail}`)
}

/**
 * EXPECTED_DENIAL | DENIED_EMPTY | ALLOWED | BROKEN.
 *
 * XPA-6B split the old single DENIED into two, because the platform now denies
 * in two structurally different ways and conflating them hides real faults:
 *
 *   EXPECTED_DENIAL  42501 — no table privilege at all. The caller cannot
 *                    reach the object. This is how `entitlements` is protected:
 *                    commercial authorization data with no app-role grant.
 *   DENIED_EMPTY     200 with zero rows. The caller may reach the object and
 *                    RLS returned nothing. This is how content is protected.
 *
 * Asking for the wrong one is a real failure. A content table that starts
 * answering 42501 has lost its grant; an entitlements table that starts
 * answering "200, 0 rows" has gained one.
 */
function classify({ status, code, total }) {
  if (status >= 500) return 'BROKEN'
  if (code === '42P17' || code === '57014') return 'BROKEN'
  if (status === 401 || status === 403) return code === '42501' ? 'EXPECTED_DENIAL' : 'BROKEN'
  if (status >= 400) return 'BROKEN'
  return total > 0 ? 'ALLOWED' : 'DENIED_EMPTY'
}

async function rest(path, { key = ANON, jwt = null, method = 'GET', body, count = true } = {}) {
  const headers = {
    apikey: key,
    Authorization: `Bearer ${jwt ?? key}`,
    'Content-Type': 'application/json',
  }
  if (count) headers.Prefer = 'count=exact'
  const r = await fetch(`${U}/rest/v1/${path}`, { method, headers, body })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  const cr = r.headers.get('content-range')
  return {
    status: r.status,
    code: json?.code,
    total: cr ? Number(cr.split('/')[1]) : (Array.isArray(json) ? json.length : 0),
    json,
    message: (json?.message ?? '').slice(0, 80),
  }
}

const adm = (p, method, body) =>
  fetch(`${U}/auth/v1${p}`, {
    method,
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })

async function signIn(email, password) {
  const r = await fetch(`${U}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return (await r.json()).access_token ?? null
}

async function rpcHasAccess(jwt, courseId) {
  const r = await fetch(`${U}/rest/v1/rpc/has_course_access`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_course_id: courseId }),
  })
  return (await r.text()).trim()
}

const PW = 'Vq4#zTn8!pLr2Wd6'
const LEARNER = 'xpa6a-verify-learner-delete-me@xpclient-academy.com'
const ADMIN = 'xpa6a-verify-admin-delete-me@xpclient-academy.com'
const CONTENT = ['modules', 'lessons', 'quizzes', 'quiz_questions']

let learnerId = null
let adminId = null
let enrollmentId = null
let entitlementId = null

try {
  console.log('\n── 1. Anonymous reads of protected content ─────────────────────')
  for (const t of CONTENT) {
    const r = await rest(`${t}?select=id&limit=5`)
    const verdict = classify(r)
    record(`anon ${t}`, `${verdict} (${r.status}${r.code ? ' ' + r.code : ''}, ${r.total} rows) ${r.message}`,
      verdict === 'DENIED_EMPTY')
  }

  console.log('\n── 2. correct_answer confidentiality ───────────────────────────')
  const ca = await rest('quiz_questions?select=id,correct_answer&limit=5')
  record('anon quiz_questions.correct_answer',
    `${classify(ca)} (${ca.status}${ca.code ? ' ' + ca.code : ''}, ${ca.total} rows)`,
    classify(ca) === 'DENIED_EMPTY')

  console.log('\n── 3. Public discovery still available ─────────────────────────')
  const courses = await rest('courses?select=id,slug&limit=100')
  record('anon courses (catalogue)', `${classify(courses)} (${courses.total} rows)`,
    classify(courses) === 'ALLOWED')
  const courseId = courses.json?.[0]?.id

  console.log('\n── 4. Privilege matrix: commercial data is unreachable ─────────')
  const la = await rest('legal_acceptances?select=id&limit=1')
  record('anon legal_acceptances', `${classify(la)} (${la.status} ${la.code ?? ''})`,
    classify(la) === 'EXPECTED_DENIAL')

  // XPA-6B: `entitlements` carries provenance, timing and revocation detail.
  // NO app role holds any privilege on it, so 42501 is the correct answer for
  // reads and writes alike — not "200 with zero rows".
  const entAnon = await rest('entitlements?select=id&limit=1')
  record('anon entitlements (base table)',
    `${classify(entAnon)} (${entAnon.status} ${entAnon.code ?? ''})`,
    classify(entAnon) === 'EXPECTED_DENIAL')

  for (const [verb, opts] of [
    ['INSERT', { method: 'POST', count: false, body: JSON.stringify({
      user_id: '00000000-0000-0000-0000-000000000000',
      course_id: '00000000-0000-0000-0000-000000000000', source: 'MANUAL_ADMIN' }) }],
    ['UPDATE', { method: 'PATCH', count: false, body: JSON.stringify({ status: 'ACTIVE' }) }],
    ['DELETE', { method: 'DELETE', count: false }],
  ]) {
    const r = await rest('entitlements?id=eq.00000000-0000-0000-0000-000000000000', opts)
    record(`anon entitlements ${verb}`, `${r.status} ${r.code ?? ''}`,
      r.status === 401 && r.code === '42501')
  }

  const viewAnon = await rest('my_course_access?select=course_id&limit=1')
  record('anon my_course_access',
    `${classify(viewAnon)} (${viewAnon.status} ${viewAnon.code ?? ''})`,
    classify(viewAnon) === 'EXPECTED_DENIAL')

  console.log('\n── 5. Verified learner, NO enrollment ──────────────────────────')
  const list = await (await adm('/admin/users?per_page=200', 'GET')).json()
  for (const u of list.users ?? []) {
    if (u.email === LEARNER || u.email === ADMIN) await adm(`/admin/users/${u.id}`, 'DELETE')
  }
  learnerId = (await (await adm('/admin/users', 'POST', {
    email: LEARNER, password: PW, email_confirm: true,
  })).json()).id
  const learnerJwt = await signIn(LEARNER, PW)
  record('learner signed in', learnerJwt ? 'session issued' : 'NO SESSION', Boolean(learnerJwt))

  for (const t of CONTENT) {
    const r = await rest(`${t}?select=id&limit=5`, { jwt: learnerJwt })
    const verdict = classify(r)
    record(`learner ${t}`, `${verdict} (${r.status}${r.code ? ' ' + r.code : ''}, ${r.total} rows)`,
      verdict === 'DENIED_EMPTY')
  }
  record('has_course_access() un-enrolled', await rpcHasAccess(learnerJwt, courseId),
    (await rpcHasAccess(learnerJwt, courseId)) === 'false')

  const laSel = await rest('legal_acceptances?select=id&limit=1', { jwt: learnerJwt })
  record('learner reads own legal_acceptances', `${laSel.status}, ${laSel.total} rows`,
    laSel.status === 200 && laSel.total === 0)
  const laIns = await rest('legal_acceptances', {
    jwt: learnerJwt, method: 'POST', count: false,
    body: JSON.stringify({ user_id: learnerId, document: 'terms', version: 'probe' }),
  })
  record('learner INSERT legal_acceptances', `${laIns.status} ${laIns.code ?? ''}`, laIns.status === 403)

  const esc = await rest(`profiles?id=eq.${learnerId}`, {
    jwt: learnerJwt, method: 'PATCH', count: false,
    body: JSON.stringify({ account_status: 'suspended' }),
  })
  record('learner self-sets account_status', `${esc.status} ${esc.code ?? ''}`, esc.status === 403)

  // ── XPA-6B: an ENROLLMENT alone must grant nothing (Q-L) ──────────────
  // Given first, so the entitlement test below cannot be confused for it.
  const enrol = await rest('enrollments', {
    key: SVC, method: 'POST', count: false,
    body: JSON.stringify({ user_id: learnerId, course_id: courseId, status: 'active' }),
  })
  const createdEnrol = await rest(`enrollments?user_id=eq.${learnerId}&select=id`, { key: SVC })
  enrollmentId = createdEnrol.json?.[0]?.id
  record('temporary enrollment created', String(enrol.status), enrol.status < 300)
  record('enrollment alone grants NO access', await rpcHasAccess(learnerJwt, courseId),
    (await rpcHasAccess(learnerJwt, courseId)) === 'false')

  console.log('\n── 6. Same learner WITH an active entitlement ──────────────────')
  // A seam that denies everyone is broken, not secure. This is the half that
  // proves the seam still GRANTS.
  const grant = await rest('entitlements', {
    key: SVC, method: 'POST', count: false,
    body: JSON.stringify({
      user_id: learnerId, course_id: courseId, source: 'MANUAL_ADMIN', status: 'ACTIVE',
    }),
  })
  const createdEnt = await rest(`entitlements?user_id=eq.${learnerId}&select=id`, { key: SVC })
  entitlementId = createdEnt.json?.[0]?.id
  record('temporary entitlement created', String(grant.status), grant.status < 300)
  record('has_course_access() entitled', await rpcHasAccess(learnerJwt, courseId),
    (await rpcHasAccess(learnerJwt, courseId)) === 'true')

  const entitledLessons = await rest('lessons?select=id&limit=5', { jwt: learnerJwt })
  record('entitled learner reads lessons',
    `${classify(entitledLessons)} (${entitledLessons.total} rows)`,
    classify(entitledLessons) === 'ALLOWED')

  // The learner-safe view answers, and carries nothing it should not.
  const mine = await rest('my_course_access?select=*', { jwt: learnerJwt })
  record('learner reads my_course_access',
    `${classify(mine)} (${mine.total} rows)`, classify(mine) === 'ALLOWED')
  const leaked = Object.keys(mine.json?.[0] ?? {}).filter(k =>
    ['source', 'granted_by', 'granted_reason', 'external_ref', 'starts_at',
     'expires_at', 'revoked_at', 'revoked_reason', 'status', 'user_id'].includes(k))
  record('my_course_access leaks no commercial data',
    leaked.length ? `LEAKED: ${leaked.join(', ')}` : 'safe columns only', leaked.length === 0)

  // And the base table stays unreachable even for an entitled learner.
  const entLearner = await rest('entitlements?select=id&limit=1', { jwt: learnerJwt })
  record('entitled learner CANNOT read entitlements',
    `${classify(entLearner)} (${entLearner.status} ${entLearner.code ?? ''})`,
    classify(entLearner) === 'EXPECTED_DENIAL')

  // Suspension revokes access immediately, with no job in the loop.
  await rest(`entitlements?id=eq.${entitlementId}`, {
    key: SVC, method: 'PATCH', count: false, body: JSON.stringify({ status: 'SUSPENDED' }),
  })
  record('suspension removes access at once', await rpcHasAccess(learnerJwt, courseId),
    (await rpcHasAccess(learnerJwt, courseId)) === 'false')

  await rest(`entitlements?id=eq.${entitlementId}`, {
    key: SVC, method: 'PATCH', count: false, body: JSON.stringify({ status: 'ACTIVE' }),
  })
  record('reinstatement restores access', await rpcHasAccess(learnerJwt, courseId),
    (await rpcHasAccess(learnerJwt, courseId)) === 'true')

  // Expiry with no materialisation run: the row stays ACTIVE and access stops.
  await rest(`entitlements?id=eq.${entitlementId}`, {
    key: SVC, method: 'PATCH', count: false,
    body: JSON.stringify({ expires_at: new Date(Date.now() - 1000).toISOString() }),
  })
  record('expiry removes access without a cron job', await rpcHasAccess(learnerJwt, courseId),
    (await rpcHasAccess(learnerJwt, courseId)) === 'false')
  const stillActive = await rest(
    `entitlements?id=eq.${entitlementId}&status=eq.ACTIVE&select=id`, { key: SVC })
  record('expired row was NOT mutated to grant access',
    `${stillActive.total} row(s) still ACTIVE`, stillActive.total === 1)

  // Learning history survives revocation.
  await rest(`entitlements?id=eq.${entitlementId}`, {
    key: SVC, method: 'PATCH', count: false,
    body: JSON.stringify({ status: 'REVOKED', revoked_at: new Date().toISOString() }),
  })
  const enrolAfterRevoke = await rest(
    `enrollments?user_id=eq.${learnerId}&select=id`, { key: SVC })
  record('revocation preserves the enrollment',
    `${enrolAfterRevoke.total} enrollment(s) intact`, enrolAfterRevoke.total === 1)

  console.log('\n── 7. Platform admin arm ───────────────────────────────────────')
  adminId = (await (await adm('/admin/users', 'POST', {
    email: ADMIN, password: PW, email_confirm: true,
  })).json()).id
  await rest(`profiles?id=eq.${adminId}`, {
    key: SVC, method: 'PATCH', count: false, body: JSON.stringify({ platform_role: 'super_admin' }),
  })
  const adminJwt = await signIn(ADMIN, PW)
  for (const t of CONTENT) {
    const r = await rest(`${t}?select=id&limit=5`, { jwt: adminJwt })
    record(`super_admin ${t}`, `${classify(r)} (${r.total} rows)`, classify(r) === 'ALLOWED')
  }

  console.log('\n── 8. Prior phases intact ──────────────────────────────────────')
  for (const [label, path, want] of [
    ['ai_sessions', 'ai_sessions?select=id&limit=1', 11],
    ['ai_turns', 'ai_turns?select=id&limit=1', 36],
    ['unpublished voice personas', 'ai_scenarios?select=id&is_published=eq.false', 4],
  ]) {
    const r = await rest(path, { key: SVC })
    record(label, `${r.total} (want ${want})`, r.total === want)
  }
  const pvs = await rest('public_voice_scenarios?select=id')
  record('anon public_voice_scenarios', `${classify(pvs)} (${pvs.total} rows)`,
    classify(pvs) === 'ALLOWED' && pvs.total === 1)
  for (const t of ['ai_scenarios', 'course_codes', 'catalogues', 'learning_paths']) {
    const r = await rest(`${t}?select=id&limit=1`)
    record(`anon ${t} stays private`, `${r.status} ${r.code ?? ''}`, r.status >= 400 && r.status < 500)
  }

  const prev = await rest('lessons?select=id&is_preview=eq.true', { key: SVC })
  const all = await rest('lessons?select=id&limit=1', { key: SVC })
  record('preview lessons', `${prev.total} of ${all.total}`, prev.total === 0 && all.total > 0)
} finally {
  console.log('\n── Cleanup ─────────────────────────────────────────────────────')
  if (entitlementId) {
    const d = await rest(`entitlements?id=eq.${entitlementId}`, { key: SVC, method: 'DELETE', count: false })
    console.log(`  temporary entitlement deleted: ${d.status}`)
  }
  if (enrollmentId) {
    const d = await rest(`enrollments?id=eq.${enrollmentId}`, { key: SVC, method: 'DELETE', count: false })
    console.log(`  temporary enrollment deleted: ${d.status}`)
  }
  for (const [label, id] of [['learner', learnerId], ['admin', adminId]]) {
    if (id) console.log(`  ${label} deleted: ${(await adm(`/admin/users/${id}`, 'DELETE')).status}`)
  }
  const after = await (await adm('/admin/users?per_page=200', 'GET')).json()
  const leftovers = (after.users ?? []).filter(u => /xpa6a-verify/.test(u.email ?? ''))
  const enrolAfter = await rest('enrollments?select=id', { key: SVC })
  const entAfter = await rest('entitlements?select=id', { key: SVC })
  console.log(`  leftover probe accounts: ${leftovers.length}`)
  console.log(`  enrollments remaining:   ${enrolAfter.total}`)
  console.log(`  entitlements remaining:  ${entAfter.total}`)

  const failed = results.filter(r => !r.pass)
  console.log('')
  if (failed.length === 0 && leftovers.length === 0) {
    console.log(`✓ XPA-6A PASS — ${results.length} checks, 0 failures.`)
  } else {
    console.log(`✗ XPA-6A FAIL — ${failed.length} of ${results.length} checks failed:`)
    for (const f of failed) console.log(`    ${f.label}`)
    if (leftovers.length) console.log(`    ${leftovers.length} probe account(s) NOT cleaned up`)
    process.exitCode = 1
  }
}
