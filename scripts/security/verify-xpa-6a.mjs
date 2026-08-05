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
 *   DENIED   401/403 with 42501, or 200 with zero rows  -> the policy ran and said no
 *   ALLOWED  200 with rows                              -> the policy ran and said yes
 *   BROKEN   5xx, 42P17 (recursion), 57014 (timeout)    -> the policy did not run
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

/** DENIED | ALLOWED | BROKEN — see the header. */
function classify({ status, code, total }) {
  if (status >= 500) return 'BROKEN'
  if (code === '42P17' || code === '57014') return 'BROKEN'
  if (status === 401 || status === 403) return code === '42501' ? 'DENIED' : 'BROKEN'
  if (status >= 400) return 'BROKEN'
  return total > 0 ? 'ALLOWED' : 'DENIED'
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

try {
  console.log('\n── 1. Anonymous reads of protected content ─────────────────────')
  for (const t of CONTENT) {
    const r = await rest(`${t}?select=id&limit=5`)
    const verdict = classify(r)
    record(`anon ${t}`, `${verdict} (${r.status}${r.code ? ' ' + r.code : ''}, ${r.total} rows) ${r.message}`,
      verdict === 'DENIED')
  }

  console.log('\n── 2. correct_answer confidentiality ───────────────────────────')
  const ca = await rest('quiz_questions?select=id,correct_answer&limit=5')
  record('anon quiz_questions.correct_answer',
    `${classify(ca)} (${ca.status}${ca.code ? ' ' + ca.code : ''}, ${ca.total} rows)`,
    classify(ca) === 'DENIED')

  console.log('\n── 3. Public discovery still available ─────────────────────────')
  const courses = await rest('courses?select=id,slug&limit=100')
  record('anon courses (catalogue)', `${classify(courses)} (${courses.total} rows)`,
    classify(courses) === 'ALLOWED')
  const courseId = courses.json?.[0]?.id

  console.log('\n── 4. legal_acceptances privilege matrix ───────────────────────')
  const la = await rest('legal_acceptances?select=id&limit=1')
  record('anon legal_acceptances', `${la.status} ${la.code ?? ''}`, la.status === 401 && la.code === '42501')

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
      verdict === 'DENIED')
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

  console.log('\n── 6. Same learner WITH an active enrollment ───────────────────')
  // A seam that denies everyone is broken, not secure. XPA-6B depends on this
  // arm actually returning true.
  const enrol = await rest('enrollments', {
    key: SVC, method: 'POST', count: false,
    body: JSON.stringify({ user_id: learnerId, course_id: courseId, status: 'active' }),
  })
  const created = await rest(`enrollments?user_id=eq.${learnerId}&select=id`, { key: SVC })
  enrollmentId = created.json?.[0]?.id
  record('temporary enrollment created', String(enrol.status), enrol.status < 300)
  record('has_course_access() enrolled', await rpcHasAccess(learnerJwt, courseId),
    (await rpcHasAccess(learnerJwt, courseId)) === 'true')

  const enrolledLessons = await rest('lessons?select=id&limit=5', { jwt: learnerJwt })
  record('enrolled learner reads lessons',
    `${classify(enrolledLessons)} (${enrolledLessons.total} rows)`,
    classify(enrolledLessons) === 'ALLOWED')

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
  console.log(`  leftover probe accounts: ${leftovers.length}`)
  console.log(`  enrollments remaining:   ${enrolAfter.total}`)

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
