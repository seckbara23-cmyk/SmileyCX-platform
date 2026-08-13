#!/usr/bin/env node
/**
 * XPA-7 production verification — B2B organizations and corporate licensing.
 *
 *   node scripts/security/verify-xpa-7.mjs   (run AFTER migration 040)
 *
 * ── WHAT IS UNDER TEST ────────────────────────────────────────────────────
 *
 * Two things, and they pull in opposite directions:
 *
 *   ISOLATION   organization A must be invisible and unmanageable to anyone in
 *               organization B. This phase created the first boundary in this
 *               platform where one customer's data sits beside another's.
 *
 *   AUTHORITY   membership must grant NOTHING. A corporate licence opens a
 *               course; belonging to the company that bought it does not.
 *
 * The defect this phase closed is the intersection of the two: migration 004
 * let any authenticated learner self-join any organization as a viewer, which
 * made isolation a function of nobody trying.
 *
 * Outcomes are classified rather than inferred from status codes, and every
 * write probe is bracketed by a read so "it errored" is never mistaken for
 * "nothing changed". Cleanup is fixture-scoped: production holds real
 * entitlements, so "the table is empty" is not a cleanliness test.
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
  console.log(`  ${pass ? '✓' : '✗'} ${pad(label, 56)} ${detail}`)
}

function classify({ status, code, total }) {
  if (status >= 500) return 'BROKEN'
  if (code === '42501') return 'REFUSED_BY_PRIVILEGE'
  if (code === '42P17' || code === '57014') return 'BROKEN'
  if (status === 401 || status === 403) return 'BROKEN'
  if (status >= 400) return `BROKEN:${status}:${code ?? '?'}`
  return total > 0 ? 'ALLOWED' : 'DENIED_EMPTY'
}

async function rest(path, { key = ANON, jwt = null, method = 'GET', body } = {}) {
  const headers = {
    apikey: key, Authorization: `Bearer ${jwt ?? key}`, 'Content-Type': 'application/json',
    Prefer: method === 'POST' ? 'return=representation' : 'count=exact',
  }
  const r = await fetch(`${U}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text()
  let j = null
  try { j = JSON.parse(t) } catch {}
  const cr = r.headers.get('content-range')
  return {
    status: r.status, code: j?.code, json: j,
    total: cr ? Number(cr.split('/')[1]) : (Array.isArray(j) ? j.length : 0),
  }
}

const adm = (p, method, body) => fetch(`${U}/auth/v1${p}`, {
  method,
  headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
})

const PW = 'Vq4#zTn8!pLr2Wd6'
const DAY = 86_400_000
const iso = (ms) => new Date(Date.now() + ms).toISOString()

const users = []       // { tag, id, jwt }
const orgs = []        // ids
const memberships = [] // ids
const ents = []        // ids
const enrols = []      // ids

async function makeUser(tag) {
  const email = `xpa7-verify-${tag}-delete-me@xpclient-academy.com`
  const list = await (await adm('/admin/users?per_page=200', 'GET')).json()
  for (const u of list.users ?? []) if (u.email === email) await adm(`/admin/users/${u.id}`, 'DELETE')
  const id = (await (await adm('/admin/users', 'POST', { email, password: PW, email_confirm: true })).json()).id
  const jwt = (await (await fetch(`${U}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  })).json()).access_token
  users.push({ tag, id, jwt })
  return { id, jwt }
}

try {
  const course = (await rest('courses?select=id,slug&is_published=eq.true&limit=1', { key: SVC })).json[0]
  const CID = course.id

  // ── Fixtures: two organizations, three people ─────────────────────────
  const orgA = (await rest('organizations', { key: SVC, method: 'POST', body: {
    name: 'XPA-7 Verify Org A', slug: 'xpa7-verify-org-a' } })).json[0]
  const orgB = (await rest('organizations', { key: SVC, method: 'POST', body: {
    name: 'XPA-7 Verify Org B', slug: 'xpa7-verify-org-b' } })).json[0]
  orgs.push(orgA.id, orgB.id)

  const adminA = await makeUser('admin-a')
  const memberA = await makeUser('member-a')
  const adminB = await makeUser('admin-b')

  const mk = async (org, user, role, status = 'ACTIVE') => {
    const r = await rest('organization_memberships', { key: SVC, method: 'POST', body: {
      org_id: org, user_id: user, role, status } })
    if (r.json?.[0]?.id) memberships.push(r.json[0].id)
    return r.json?.[0]
  }
  const mAdminA = await mk(orgA.id, adminA.id, 'org_admin')
  const mMemberA = await mk(orgA.id, memberA.id, 'viewer')
  await mk(orgB.id, adminB.id, 'org_admin')

  const acc = async (jwt) => (await (await fetch(`${U}/rest/v1/rpc/has_course_access`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_course_id: CID }),
  })).text()).trim()
  const content = async (jwt) => classify(await rest(`modules?select=id&course_id=eq.${CID}`, { jwt }))

  // ══ 1. Isolation ═══════════════════════════════════════════════════════
  console.log('\n── 1. Organization isolation ───────────────────────────────────')

  const aSees = await rest('organizations?select=id,name', { jwt: adminA.jwt })
  const aIds = (aSees.json ?? []).map(o => o.id)
  record('org A admin sees exactly their own organization',
    `${aSees.total} row(s)`, aSees.total === 1 && aIds[0] === orgA.id)

  const bLeak = await rest(`organizations?select=id&id=eq.${orgB.id}`, { jwt: adminA.jwt })
  record('org A admin CANNOT see org B',
    `${classify(bLeak)} (${bLeak.total} rows)`, classify(bLeak) === 'DENIED_EMPTY')

  const beforeName = (await rest(`organizations?id=eq.${orgB.id}&select=name`, { key: SVC })).json[0].name
  const hijack = await rest(`organizations?id=eq.${orgB.id}`, {
    jwt: adminA.jwt, method: 'PATCH', body: { name: 'HIJACKED BY A' } })
  const afterName = (await rest(`organizations?id=eq.${orgB.id}&select=name`, { key: SVC })).json[0].name
  record('org A admin CANNOT rename org B',
    `${hijack.status} ${hijack.code ?? ''}`, beforeName === afterName)

  const crossAdd = await rest('organization_memberships', { jwt: adminA.jwt, method: 'POST', body: {
    org_id: orgB.id, user_id: memberA.id, role: 'viewer', status: 'ACTIVE' } })
  const bMembers = await rest(`organization_memberships?org_id=eq.${orgB.id}&select=id`, { key: SVC })
  record('org A admin CANNOT add a member to org B',
    `${crossAdd.status} ${crossAdd.code ?? ''}, org B has ${bMembers.total}`,
    crossAdd.status >= 400 && bMembers.total === 1)

  const bMemberLeak = await rest(`organization_memberships?org_id=eq.${orgB.id}&select=id`, { jwt: adminA.jwt })
  record('org A admin CANNOT read org B membership',
    `${classify(bMemberLeak)} (${bMemberLeak.total} rows)`, classify(bMemberLeak) === 'DENIED_EMPTY')

  // ══ 2. The closed self-join defect ═════════════════════════════════════
  console.log('\n── 2. The self-join defect stays closed ────────────────────────')
  const outsider = await makeUser('outsider')
  const before = (await rest('organization_memberships?select=id', { key: SVC })).total
  const selfJoin = await rest('organization_memberships', { jwt: outsider.jwt, method: 'POST', body: {
    org_id: orgA.id, user_id: outsider.id, role: 'viewer', status: 'ACTIVE' } })
  const after = (await rest('organization_memberships?select=id', { key: SVC })).total
  record('an outsider CANNOT self-join an organization',
    `${selfJoin.status} ${selfJoin.code ?? ''}, rows ${before} -> ${after}`,
    selfJoin.status >= 400 && after === before)

  const outsiderOrgs = await rest('organizations?select=id', { jwt: outsider.jwt })
  record('an outsider sees no organization at all',
    `${classify(outsiderOrgs)} (${outsiderOrgs.total} rows)`,
    classify(outsiderOrgs) === 'DENIED_EMPTY')

  // ══ 3. Self-promotion ══════════════════════════════════════════════════
  console.log('\n── 3. A member cannot promote themselves ───────────────────────')
  const roleBefore = (await rest(`organization_memberships?id=eq.${mMemberA.id}&select=role`, { key: SVC })).json[0].role
  const promote = await rest(`organization_memberships?id=eq.${mMemberA.id}`, {
    jwt: memberA.jwt, method: 'PATCH', body: { role: 'org_admin' } })
  const roleAfter = (await rest(`organization_memberships?id=eq.${mMemberA.id}&select=role`, { key: SVC })).json[0].role
  record('member CANNOT self-promote to org_admin',
    `${promote.status} ${promote.code ?? ''}, role ${roleBefore} -> ${roleAfter}`,
    roleAfter === 'viewer')

  // ══ 4. Membership grants nothing ═══════════════════════════════════════
  console.log('\n── 4. Membership is not access ─────────────────────────────────')
  record('org member has NO course access', await acc(memberA.jwt), (await acc(memberA.jwt)) === 'false')
  record('org member reads no content', await content(memberA.jwt), (await content(memberA.jwt)) === 'DENIED_EMPTY')
  record('org ADMIN has no course access either', await acc(adminA.jwt), (await acc(adminA.jwt)) === 'false')

  // ══ 5. Org admin cannot mint commercial authority ══════════════════════
  console.log('\n── 5. Org admin cannot mint entitlements ───────────────────────')
  const entBefore = (await rest('entitlements?select=id', { key: SVC })).total
  const mint = await rest('entitlements', { jwt: adminA.jwt, method: 'POST', body: {
    user_id: memberA.id, course_id: CID, source: 'CORPORATE_LICENSE',
    status: 'ACTIVE', expires_at: iso(30 * DAY), organization_id: orgA.id } })
  const entAfter = (await rest('entitlements?select=id', { key: SVC })).total
  record('org admin CANNOT create an entitlement',
    `${mint.status} ${mint.code ?? ''}, rows ${entBefore} -> ${entAfter}`,
    mint.code === '42501' && entAfter === entBefore)

  const readEnt = await rest('entitlements?select=id&limit=1', { jwt: adminA.jwt })
  record('org admin CANNOT read the entitlements table',
    `${classify(readEnt)} (${readEnt.status} ${readEnt.code ?? ''})`,
    classify(readEnt) === 'REFUSED_BY_PRIVILEGE')

  // ══ 6. Platform admin grants a corporate licence ═══════════════════════
  console.log('\n── 6. A corporate licence grants normal access ─────────────────')
  const lic = await rest('entitlements', { key: SVC, method: 'POST', body: {
    user_id: memberA.id, course_id: CID, source: 'CORPORATE_LICENSE', status: 'ACTIVE',
    expires_at: iso(30 * DAY), organization_id: orgA.id,
    granted_reason: 'XPA-7 verification' } })
  const licId = lic.json?.[0]?.id
  if (licId) ents.push(licId)
  record('platform authority CAN grant CORPORATE_LICENSE',
    `${lic.status} ${String(licId ?? '').slice(0, 8)}…`, Boolean(licId))
  record('licensed learner HAS access', await acc(memberA.jwt), (await acc(memberA.jwt)) === 'true')
  record('licensed learner reads content', await content(memberA.jwt), (await content(memberA.jwt)) === 'ALLOWED')

  const attributed = (await rest(`entitlements?id=eq.${licId}&select=organization_id`, { key: SVC })).json[0]
  record('the grant is attributed to the organization',
    String(attributed.organization_id === orgA.id), attributed.organization_id === orgA.id)

  const perpetual = await rest('entitlements', { key: SVC, method: 'POST', body: {
    user_id: adminA.id, course_id: CID, source: 'CORPORATE_LICENSE', status: 'ACTIVE',
    expires_at: null, organization_id: orgA.id } })
  record('a perpetual CORPORATE_LICENSE is refused',
    `${perpetual.status} ${perpetual.code ?? ''}`, perpetual.status >= 400)

  // ══ 7. Expiry and revocation outrank the enrollment ════════════════════
  console.log('\n── 7. Expiry and revocation beat academic state ────────────────')
  const enr = await rest('enrollments', { key: SVC, method: 'POST', body: {
    user_id: memberA.id, course_id: CID, payment_id: null, status: 'active' } })
  if (enr.json?.[0]?.id) enrols.push(enr.json[0].id)
  record('licensed learner + enrollment still has access', await acc(memberA.jwt), (await acc(memberA.jwt)) === 'true')

  await rest(`entitlements?id=eq.${licId}`, { key: SVC, method: 'PATCH', body: { expires_at: iso(-DAY) } })
  const enrLive = await rest(`enrollments?id=eq.${enrols[0]}&status=eq.active&select=id`, { key: SVC })
  record('EXPIRED licence denies access', await acc(memberA.jwt), (await acc(memberA.jwt)) === 'false')
  record('  …while the enrollment is still active', `${enrLive.total} active row(s)`, enrLive.total === 1)
  record('expired licence denies content', await content(memberA.jwt), (await content(memberA.jwt)) === 'DENIED_EMPTY')

  await rest(`entitlements?id=eq.${licId}`, { key: SVC, method: 'PATCH', body: { expires_at: iso(30 * DAY) } })
  record('reinstated window restores access', await acc(memberA.jwt), (await acc(memberA.jwt)) === 'true')
  await rest(`entitlements?id=eq.${licId}`, { key: SVC, method: 'PATCH', body: {
    status: 'REVOKED', revoked_at: new Date().toISOString() } })
  record('REVOKED licence denies access', await acc(memberA.jwt), (await acc(memberA.jwt)) === 'false')

  // ══ 8. Enrollment alone, and membership lifecycle ══════════════════════
  console.log('\n── 8. Enrollment-only and lifecycle ────────────────────────────')
  record('enrollment alone still denies', await acc(memberA.jwt), (await acc(memberA.jwt)) === 'false')

  await rest(`organization_memberships?id=eq.${mMemberA.id}`, {
    key: SVC, method: 'PATCH', body: { status: 'REMOVED' } })
  const removedSees = await rest('organizations?select=id', { jwt: memberA.jwt })
  record('a REMOVED member sees no organization',
    `${classify(removedSees)} (${removedSees.total} rows)`, classify(removedSees) === 'DENIED_EMPTY')

  await rest(`organization_memberships?id=eq.${mMemberA.id}`, {
    key: SVC, method: 'PATCH', body: { status: 'PENDING' } })
  const pendingSees = await rest('organizations?select=id', { jwt: memberA.jwt })
  record('a PENDING invitee sees no organization',
    `${classify(pendingSees)} (${pendingSees.total} rows)`, classify(pendingSees) === 'DENIED_EMPTY')

  // ══ 9. Multi-organization membership does not cross-leak ═══════════════
  console.log('\n── 9. Multi-organization membership (D7-5) ─────────────────────')
  await rest(`organization_memberships?id=eq.${mMemberA.id}`, {
    key: SVC, method: 'PATCH', body: { status: 'ACTIVE' } })
  const dual = await mk(orgB.id, memberA.id, 'viewer')
  const bothOrgs = await rest('organizations?select=id', { jwt: memberA.jwt })
  const seen = new Set((bothOrgs.json ?? []).map(o => o.id))
  record('a dual member sees BOTH of their organizations',
    `${bothOrgs.total} row(s)`, seen.has(orgA.id) && seen.has(orgB.id) && bothOrgs.total === 2)
  record('and still no third organization exists to leak',
    `${bothOrgs.total} of 2 fixtures`, bothOrgs.total === 2)

  const outsiderStill = await rest('organizations?select=id', { jwt: outsider.jwt })
  record('the outsider still sees nothing',
    `${classify(outsiderStill)} (${outsiderStill.total} rows)`, classify(outsiderStill) === 'DENIED_EMPTY')

  // ══ 10. XPA-6D unaffected ══════════════════════════════════════════════
  console.log('\n── 10. Answer-key protection unaffected ────────────────────────')
  for (const [label, path] of [
    ['quiz_questions.correct_answer', 'quiz_questions?select=id,correct_answer&limit=1'],
    ['exercise_items.correct_category_id', 'exercise_items?select=id,correct_category_id&limit=1'],
  ]) {
    const r = await rest(path, { jwt: memberA.jwt })
    record(`${label} refused`, `${r.status} ${r.code ?? ''}`, r.code === '42501')
  }
} finally {
  console.log('\n── Cleanup ─────────────────────────────────────────────────────')
  const gone = async (path, id) =>
    id ? (await rest(`${path}?id=eq.${id}&select=id`, { key: SVC })).total === 0 : true

  for (const id of ents)        await rest(`entitlements?id=eq.${id}`, { key: SVC, method: 'DELETE' })
  for (const id of enrols)      await rest(`enrollments?id=eq.${id}`, { key: SVC, method: 'DELETE' })
  for (const u of users)        await rest(`organization_memberships?user_id=eq.${u.id}`, { key: SVC, method: 'DELETE' })
  for (const id of orgs)        await rest(`organizations?id=eq.${id}`, { key: SVC, method: 'DELETE' })
  for (const u of users)        await adm(`/admin/users/${u.id}`, 'DELETE')

  const leftovers = []
  for (const id of ents)   if (!(await gone('entitlements', id)))            leftovers.push(`entitlement ${id}`)
  for (const id of enrols) if (!(await gone('enrollments', id)))             leftovers.push(`enrollment ${id}`)
  for (const id of memberships) if (!(await gone('organization_memberships', id))) leftovers.push(`membership ${id}`)
  for (const id of orgs)   if (!(await gone('organizations', id)))           leftovers.push(`organization ${id}`)

  const list = await (await adm('/admin/users?per_page=200', 'GET')).json()
  const strays = (list.users ?? []).filter(u => /xpa7-verify/.test(u.email ?? ''))

  const entAll = await rest('entitlements?select=id', { key: SVC })
  const orgAll = await rest('organizations?select=id', { key: SVC })
  console.log(`  this run's fixtures left:   ${leftovers.length}${leftovers.length ? ' — ' + leftovers.join(', ') : ''}`)
  console.log(`  leftover probe accounts:    ${strays.length}`)
  console.log(`  (real rows, informational)  entitlements=${entAll.total} organizations=${orgAll.total}`)

  const dirty = leftovers.length > 0 || strays.length !== 0
  const failed = results.filter(r => !r.pass)
  console.log('')
  if (failed.length === 0 && !dirty) {
    console.log(`✓ XPA-7 PASS — ${results.length} checks, 0 failures.`)
  } else {
    console.log(`✗ XPA-7 FAIL — ${failed.length} of ${results.length} checks failed:`)
    for (const f of failed) console.log(`    ${f.label}`)
    if (dirty) console.log('    synthetic fixtures were NOT fully cleaned up')
    process.exitCode = 1
  }
}
