#!/usr/bin/env node
/**
 * XPA-6C production verification — commercial business evaluation / trial access.
 *
 *   node scripts/security/verify-xpa-6c.mjs
 *
 * ── WHAT IS UNDER TEST ────────────────────────────────────────────────────
 *
 * A `BUSINESS_EVALUATION` entitlement is a TIME-LIMITED trial for a prospective
 * corporate customer. Its defining characteristic is an expiry nobody can
 * escape, so most of this script is about the window: before it, inside it,
 * after it, and cut short.
 *
 * Everything runs as a REAL learner with a REAL JWT. Outcomes are classified,
 * never inferred from a status code alone:
 *
 *   ALLOWED               rows came back
 *   DENIED_EMPTY          reachable, RLS returned nothing
 *   REFUSED_BY_PRIVILEGE  42501 — no grant on the object
 *   BROKEN                anything else — never a pass, whichever way
 *
 * ── CLEANUP ───────────────────────────────────────────────────────────────
 *
 * Fixture-scoped, following the correction made to verify-xpa-6d.mjs. Production
 * holds real entitlements and enrollments, so "the table is empty" is not a
 * cleanliness test — every fixture is looked up by the id THIS RUN created.
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

function classify({ status, code, total }) {
  if (status >= 500) return 'BROKEN'
  if (code === '42P17' || code === '57014') return 'BROKEN'
  if (code === '42501') return 'REFUSED_BY_PRIVILEGE'
  if (status === 401 || status === 403) return 'BROKEN'
  if (status >= 400) return `BROKEN:${status}:${code ?? '?'}`
  return total > 0 ? 'ALLOWED' : 'DENIED_EMPTY'
}

async function rest(path, { key = ANON, jwt = null, method = 'GET', body } = {}) {
  const headers = {
    apikey: key,
    Authorization: `Bearer ${jwt ?? key}`,
    'Content-Type': 'application/json',
    Prefer: method === 'POST' ? 'return=representation' : 'count=exact',
  }
  const r = await fetch(`${U}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  const cr = r.headers.get('content-range')
  return {
    status: r.status,
    code: json?.code,
    total: cr ? Number(cr.split('/')[1]) : (Array.isArray(json) ? json.length : 0),
    json,
  }
}

const adm = (p, method, body) => fetch(`${U}/auth/v1${p}`, {
  method,
  headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
})

const PW = 'Vq4#zTn8!pLr2Wd6'
const EVALUATOR = 'xpa6c-verify-evaluator-delete-me@xpclient-academy.com'
const ENROL_ONLY = 'xpa6c-verify-enrolonly-delete-me@xpclient-academy.com'
const DAY = 86_400_000
const iso = (ms) => new Date(Date.now() + ms).toISOString()

let evaluatorId = null, enrolOnlyId = null
let entId = null, enrId = null, otherEnrId = null

try {
  const course = (await rest('courses?select=id,slug&is_published=eq.true&limit=1', { key: SVC })).json[0]
  const CID = course.id

  const existing = await (await adm('/admin/users?per_page=200', 'GET')).json()
  for (const u of existing.users ?? []) {
    if (/xpa6c-verify/.test(u.email ?? '')) await adm(`/admin/users/${u.id}`, 'DELETE')
  }
  evaluatorId = (await (await adm('/admin/users', 'POST', {
    email: EVALUATOR, password: PW, email_confirm: true,
  })).json()).id
  const jwt = (await (await fetch(`${U}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EVALUATOR, password: PW }),
  })).json()).access_token

  const acc = async () => (await (await fetch(`${U}/rest/v1/rpc/has_course_access`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_course_id: CID }),
  })).text()).trim()

  const content = async () => classify(await rest(`modules?select=id&course_id=eq.${CID}`, { jwt }))

  // Re-shape the single evaluation entitlement between states.
  const setEval = async (patch) => {
    await rest(`entitlements?id=eq.${entId}`, { key: SVC, method: 'PATCH', body: patch })
  }

  console.log(`\n── course under test: ${course.slug}`)

  // ══ 1. No evaluation ═══════════════════════════════════════════════════
  console.log('\n── 1. No evaluation ────────────────────────────────────────────')
  record('no entitlement -> has_course_access false', await acc(), (await acc()) === 'false')
  record('no entitlement -> content unreadable', await content(), (await content()) === 'DENIED_EMPTY')

  // ══ 2. Mandatory expiry is enforced by the DATABASE ════════════════════
  console.log('\n── 2. A perpetual evaluation is impossible ─────────────────────')
  const perpetual = await rest('entitlements', { key: SVC, method: 'POST', body: {
    user_id: evaluatorId, course_id: CID, source: 'BUSINESS_EVALUATION', status: 'ACTIVE', expires_at: null,
  } })
  record('BUSINESS_EVALUATION without expiry is refused',
    `${perpetual.status} ${perpetual.code ?? ''}`,
    perpetual.status >= 400 && perpetual.status < 500)

  // ══ 3. Future window — not started ═════════════════════════════════════
  console.log('\n── 3. Before the window opens ──────────────────────────────────')
  const created = await rest('entitlements', { key: SVC, method: 'POST', body: {
    user_id: evaluatorId, course_id: CID, source: 'BUSINESS_EVALUATION', status: 'ACTIVE',
    starts_at: iso(3 * DAY), expires_at: iso(30 * DAY),
    granted_reason: 'XPA-6C verification — prospect trial', external_ref: 'XPA6C-VERIFY-PROSPECT',
  } })
  entId = created.json?.[0]?.id
  record('evaluation created with mandatory expiry', `${created.status} ${String(entId ?? '').slice(0, 8)}…`, Boolean(entId))
  record('before starts_at -> no access', await acc(), (await acc()) === 'false')
  record('before starts_at -> content unreadable', await content(), (await content()) === 'DENIED_EMPTY')

  // ══ 4. Active window ═══════════════════════════════════════════════════
  console.log('\n── 4. Inside the window ────────────────────────────────────────')
  await setEval({ starts_at: iso(-1 * DAY) })
  record('active evaluation -> access', await acc(), (await acc()) === 'true')
  record('active evaluation -> content readable', await content(), (await content()) === 'ALLOWED')

  const view = await rest('my_course_access?select=*', { jwt })
  const cols = Object.keys(view.json?.[0] ?? {})
  record('learner-safe view leaks no commercial detail', cols.join(','),
    cols.length > 0 && !cols.some(c => ['source', 'granted_by', 'granted_reason', 'external_ref', 'expires_at'].includes(c)))

  // ══ 5. Learner containment ═════════════════════════════════════════════
  console.log('\n── 5. The evaluator cannot touch the entitlement ───────────────')
  const readEnt = await rest('entitlements?select=id&limit=1', { jwt })
  record('cannot read the entitlements table',
    `${classify(readEnt)} (${readEnt.status} ${readEnt.code ?? ''})`,
    classify(readEnt) === 'REFUSED_BY_PRIVILEGE')

  const snapshot = async () => JSON.stringify((await rest(
    `entitlements?id=eq.${entId}&select=status,source,starts_at,expires_at,revoked_at`, { key: SVC })).json)

  for (const [label, patch] of [
    ['extend the expiry',        { expires_at: iso(3650 * DAY) }],
    ['change the source',        { source: 'MANUAL_ADMIN' }],
    ['change the status',        { status: 'ACTIVE' }],
  ]) {
    const before = await snapshot()
    const r = await rest(`entitlements?id=eq.${entId}`, { jwt, method: 'PATCH', body: patch })
    const after = await snapshot()
    record(`cannot ${label}`, `${r.status} ${r.code ?? ''}`, r.code === '42501')
    record(`  …and the row is unchanged`, before === after ? 'byte-identical' : 'MUTATED', before === after)
  }

  const selfGrant = await rest('entitlements', { jwt, method: 'POST', body: {
    user_id: evaluatorId, course_id: CID, source: 'BUSINESS_EVALUATION', status: 'ACTIVE', expires_at: iso(DAY),
  } })
  record('cannot self-grant an evaluation', `${selfGrant.status} ${selfGrant.code ?? ''}`, selfGrant.code === '42501')

  // ══ 6. XPA-6D still holds for an entitled evaluator ════════════════════
  console.log('\n── 6. Answer-key protection is unaffected by the source ────────')
  const qk = await rest('quiz_questions?select=id,correct_answer&limit=1', { jwt })
  const xk = await rest('exercise_items?select=id,correct_category_id&limit=1', { jwt })
  record('correct_answer refused', `${qk.status} ${qk.code ?? ''}`, qk.code === '42501')
  record('correct_category_id refused', `${xk.status} ${xk.code ?? ''}`, xk.code === '42501')

  // ══ 7. Academic enrollment does not extend the trial ═══════════════════
  console.log('\n── 7. An enrollment cannot outlive the evaluation ──────────────')
  const enr = await rest('enrollments', { key: SVC, method: 'POST', body: {
    user_id: evaluatorId, course_id: CID, payment_id: null, status: 'active' } })
  enrId = enr.json?.[0]?.id
  record('active evaluation + enrollment -> access', await acc(), (await acc()) === 'true')

  await setEval({ expires_at: iso(-1 * DAY) })
  const enrStill = await rest(`enrollments?id=eq.${enrId}&status=eq.active&select=id`, { key: SVC })
  record('expired evaluation -> access DENIED', await acc(), (await acc()) === 'false')
  record('  …while the enrollment is still active', `${enrStill.total} active row(s)`, enrStill.total === 1)
  record('expired -> content unreadable', await content(), (await content()) === 'DENIED_EMPTY')

  const stillActive = await rest(`entitlements?id=eq.${entId}&status=eq.ACTIVE&select=id`, { key: SVC })
  record('expiry needed no job — row still ACTIVE, unmutated',
    `${stillActive.total} row(s)`, stillActive.total === 1)

  // ══ 8. Early revocation ════════════════════════════════════════════════
  console.log('\n── 8. Revoked early ────────────────────────────────────────────')
  await setEval({ expires_at: iso(30 * DAY), starts_at: iso(-1 * DAY) })
  record('reinstated window -> access returns', await acc(), (await acc()) === 'true')
  await setEval({ status: 'REVOKED', revoked_at: new Date().toISOString() })
  record('revoked before expiry -> access DENIED', await acc(), (await acc()) === 'false')
  record('revoked -> content unreadable', await content(), (await content()) === 'DENIED_EMPTY')

  // ══ 9. Enrollment-only actor ═══════════════════════════════════════════
  console.log('\n── 9. Enrollment-only learner ──────────────────────────────────')
  enrolOnlyId = (await (await adm('/admin/users', 'POST', {
    email: ENROL_ONLY, password: PW, email_confirm: true })).json()).id
  const jwt2 = (await (await fetch(`${U}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ENROL_ONLY, password: PW }),
  })).json()).access_token
  otherEnrId = (await rest('enrollments', { key: SVC, method: 'POST', body: {
    user_id: enrolOnlyId, course_id: CID, payment_id: null, status: 'active' } })).json[0].id
  const a2 = (await (await fetch(`${U}/rest/v1/rpc/has_course_access`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${jwt2}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_course_id: CID }) })).text()).trim()
  const c2 = classify(await rest(`modules?select=id&course_id=eq.${CID}`, { jwt: jwt2 }))
  record('enrollment alone -> no access', a2, a2 === 'false')
  record('enrollment alone -> content unreadable', c2, c2 === 'DENIED_EMPTY')

  const otherEval = await rest(`entitlements?select=id&user_id=eq.${evaluatorId}`, { jwt: jwt2 })
  record('cannot read another learner\'s evaluation',
    `${classify(otherEval)} (${otherEval.status} ${otherEval.code ?? ''})`,
    classify(otherEval) === 'REFUSED_BY_PRIVILEGE')
} finally {
  console.log('\n── Cleanup ─────────────────────────────────────────────────────')
  const gone = async (path, id) =>
    id ? (await rest(`${path}?id=eq.${id}&select=id`, { key: SVC })).total === 0 : true

  if (enrId) await rest(`enrollments?id=eq.${enrId}`, { key: SVC, method: 'DELETE' })
  if (otherEnrId) await rest(`enrollments?id=eq.${otherEnrId}`, { key: SVC, method: 'DELETE' })
  if (entId) await rest(`entitlements?id=eq.${entId}`, { key: SVC, method: 'DELETE' })
  for (const [label, id] of [['evaluator', evaluatorId], ['enrol-only', enrolOnlyId]]) {
    if (id) console.log(`  ${label} deleted: ${(await adm(`/admin/users/${id}`, 'DELETE')).status}`)
  }

  const leftovers = []
  if (!(await gone('entitlements', entId))) leftovers.push(`entitlement ${entId}`)
  if (!(await gone('enrollments', enrId))) leftovers.push(`enrollment ${enrId}`)
  if (!(await gone('enrollments', otherEnrId))) leftovers.push(`enrollment ${otherEnrId}`)

  const users = await (await adm('/admin/users?per_page=200', 'GET')).json()
  const strays = (users.users ?? []).filter(u => /xpa6c-verify/.test(u.email ?? ''))

  const entAll = await rest('entitlements?select=id', { key: SVC })
  const enrAll = await rest('enrollments?select=id', { key: SVC })
  console.log(`  this run's fixtures left:   ${leftovers.length}${leftovers.length ? ' — ' + leftovers.join(', ') : ''}`)
  console.log(`  leftover probe accounts:    ${strays.length}`)
  console.log(`  (real rows, informational)  entitlements=${entAll.total} enrollments=${enrAll.total}`)

  const dirty = leftovers.length > 0 || strays.length !== 0
  const failed = results.filter(r => !r.pass)
  console.log('')
  if (failed.length === 0 && !dirty) {
    console.log(`✓ XPA-6C PASS — ${results.length} checks, 0 failures.`)
  } else {
    console.log(`✗ XPA-6C FAIL — ${failed.length} of ${results.length} checks failed:`)
    for (const f of failed) console.log(`    ${f.label}`)
    if (dirty) console.log('    synthetic fixtures were NOT fully cleaned up')
    process.exitCode = 1
  }
}
