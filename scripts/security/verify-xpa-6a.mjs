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

/**
 * Classify a WRITE probe. Reads and writes fail in different ways, and a write
 * has safe outcomes a read does not:
 *
 *   REFUSED_BY_PRIVILEGE  42501           no grant — this caller may not
 *   REFUSED_BY_VIEW       55000 / 0A000   not an updatable view — nobody can
 *   REFUSED_BY_API        21000           PostgREST refused it before Postgres
 *   ALLOWED               2xx             a failure for every probe here
 *   BROKEN                anything else
 *
 * REFUSED_BY_VIEW is the STRONGEST guarantee: `my_course_access` aggregates, so
 * the write is rejected during query rewrite before privileges are consulted,
 * and it stays rejected even for a role that is later over-granted.
 *
 * ── WHY 21000 IS NAMED, AND WHY IT IS NOT ENOUGH ON ITS OWN ───────────────
 *
 * The fourth variant of the same mistake. These probes sent an UNFILTERED
 * PATCH/DELETE, and PostgREST rejects those itself — 400 / 21000, "UPDATE
 * requires a WHERE clause" — before the statement ever reaches Postgres. The
 * classifier scored that BROKEN, so a correct system reported a failure.
 *
 * But the deeper fault was not the classification. An unfiltered probe never
 * exercises the view at all, so the check was proving "PostgREST rejects
 * unfiltered writes" while claiming to prove "a learner cannot write through
 * this view". Those are different statements, and only the second is the
 * security invariant.
 *
 * So 21000 is a refusal and is named as one — but every view write is now
 * probed BOTH ways: unfiltered (the API guard) and filtered (which reaches the
 * rewriter and must come back 55000). Measured, not assumed:
 *
 *   unfiltered PATCH/DELETE -> 400 21000  "requires a WHERE clause"
 *   filtered   PATCH/DELETE -> 500 55000  "cannot update/delete view"
 *
 * Neither is taken on trust — callers must also prove the data did not change.
 */
function classifyWrite({ status, code }) {
  if (status >= 200 && status < 300) return 'ALLOWED'
  if (code === '42501') return 'REFUSED_BY_PRIVILEGE'
  if (code === '55000' || code === '0A000') return 'REFUSED_BY_VIEW'
  if (code === '21000') return 'REFUSED_BY_API'
  if (status === 401 || status === 403) return 'REFUSED_BY_PRIVILEGE'
  return `BROKEN:${status}:${code ?? '?'}`
}

const SAFE_REFUSALS = ['REFUSED_BY_PRIVILEGE', 'REFUSED_BY_VIEW', 'REFUSED_BY_API']

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
  //
  // -- WHY THIS IS NO LONGER "ANON MUST SEE ZERO ROWS" ----------------------
  //
  // It used to be. That expectation was written the day migration 035 zeroed a
  // blanket is_preview flag, and it encoded THE COUNT ON THAT DAY as though it
  // were the rule. It is not: 035's own comment says designating a preview
  // lesson "remains a normal editorial action", and 001's policy carries an
  // `OR is_preview = true` arm precisely so it can.
  //
  // When 20 lessons were later flagged, this check went red for a legitimate
  // editorial change and stayed red. A permanently-red check is not a signal;
  // it is noise that hides the next real finding.
  //
  // The assertion is now the INVARIANT, which is strictly stronger than "the
  // count is zero" and survives whatever an administrator legitimately does:
  //
  //   anon-visible lessons  ==  exactly the is_preview set
  //   a visible preview row exposes NO body and NO object path
  //   a non-preview row is NEVER visible
  //   modules are visible only when they hold a preview lesson
  //
  // With no previews designated it collapses to the old check, so nothing is
  // lost today; the difference is that it still means something tomorrow.
  const previewIds = new Set(
    ((await rest('lessons?select=id&is_preview=eq.true&limit=1000', { key: SVC })).json ?? []).map(r => r.id))
  const previewModuleIds = new Set(
    ((await rest('lessons?select=module_id&is_preview=eq.true&limit=1000', { key: SVC })).json ?? [])
      .map(r => r.module_id))

  for (const t of CONTENT) {
    if (t === 'lessons') {
      const seen = await rest('lessons?select=id,is_preview,content,video_object_path,pdf_object_path&limit=1000')
      const rows = seen.json ?? []
      const nonPreview = rows.filter(l => !l.is_preview)
      const leakedBody = rows.filter(l => l.content)
      const leakedPath = rows.filter(l => l.video_object_path || l.pdf_object_path)
      const invisible = [...previewIds].filter(id => !rows.some(l => l.id === id))
      record('anon lessons == exactly the preview set',
        `${rows.length} visible / ${previewIds.size} preview` +
        (nonPreview.length ? ` -- ${nonPreview.length} NON-PREVIEW LEAKED` : '') +
        (invisible.length ? ` -- ${invisible.length} preview row(s) invisible` : ''),
        nonPreview.length === 0 && invisible.length === 0)
      record('anon lessons expose no body',
        `${leakedBody.length} row(s) carrying content`, leakedBody.length === 0)
      record('anon lessons expose no object path',
        `${leakedPath.length} row(s) carrying an object path`, leakedPath.length === 0)
      continue
    }
    if (t === 'modules') {
      const mods = (await rest('modules?select=id&limit=1000')).json ?? []
      const unexpected = mods.filter(m => !previewModuleIds.has(m.id))
      record('anon modules == only those holding a preview lesson',
        `${mods.length} visible / ${previewModuleIds.size} expected` +
        (unexpected.length ? ` -- ${unexpected.length} UNEXPECTED` : ''),
        unexpected.length === 0)
      continue
    }
    const r = await rest(`${t}?select=id&limit=5`)
    const verdict = classify(r)
    record(`anon ${t}`, `${verdict} (${r.status}${r.code ? ' ' + r.code : ''}, ${r.total} rows) ${r.message}`,
      verdict === 'DENIED_EMPTY')
  }

  console.log('\n── 2. correct_answer confidentiality ───────────────────────────')
  // XPA-6D strengthened this. It used to be DENIED_EMPTY: the column was
  // granted, and only RLS withheld the rows — so a caller who satisfied the
  // row predicate got the key (finding B-4). Migration 038 revoked the column,
  // so the correct answer is now EXPECTED_DENIAL — refused before RLS is even
  // consulted. Accepting DENIED_EMPTY here again would mean the grant is back.
  const ca = await rest('quiz_questions?select=id,correct_answer&limit=5')
  record('anon quiz_questions.correct_answer',
    `${classify(ca)} (${ca.status}${ca.code ? ' ' + ca.code : ''}, ${ca.total} rows)`,
    classify(ca) === 'EXPECTED_DENIAL')

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
    const w = classifyWrite(r)
    record(`anon entitlements ${verb}`, `${w} (${r.status} ${r.code ?? ''})`,
      w === 'REFUSED_BY_PRIVILEGE')
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

  // Same invariant as the anonymous arm: an unentitled learner may see exactly
  // what the public may, and nothing more.
  for (const t of CONTENT) {
    if (t === 'lessons') {
      const seen = await rest('lessons?select=id,is_preview,content,video_object_path&limit=1000',
        { jwt: learnerJwt })
      const lrows = seen.json ?? []
      const nonPreview = lrows.filter(l => !l.is_preview)
      const leaked = lrows.filter(l => l.content || l.video_object_path)
      record('learner lessons == exactly the preview set',
        `${lrows.length} visible / ${previewIds.size} preview` +
        (nonPreview.length ? ` -- ${nonPreview.length} NON-PREVIEW LEAKED` : ''),
        nonPreview.length === 0)
      record('learner lessons expose no body or object path',
        `${leaked.length} row(s)`, leaked.length === 0)
      continue
    }
    if (t === 'modules') {
      const mods = (await rest('modules?select=id&limit=1000', { jwt: learnerJwt })).json ?? []
      const unexpected = mods.filter(m => !previewModuleIds.has(m.id))
      record('learner modules == only those holding a preview lesson',
        `${mods.length} visible / ${previewModuleIds.size} expected`,
        unexpected.length === 0)
      continue
    }
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

  // ── No write through the view may alter data ─────────────────────────
  // Both refusal shapes are safe, and the refusal is not taken on trust: each
  // probe is bracketed by a fingerprint of the underlying row. "It errored" is
  // not proof that nothing changed.
  const fingerprint = async () => {
    const r = await rest(
      `entitlements?id=eq.${entitlementId}&select=id,status,source,starts_at,expires_at,revoked_at,revoked_reason`,
      { key: SVC, count: false })
    return JSON.stringify(r.json ?? null)
  }

  // Every write is probed BOTH ways. An unfiltered PATCH/DELETE is rejected by
  // PostgREST itself (21000) and never reaches the view, so on its own it
  // proves nothing about the view. The FILTERED probe reaches the rewriter and
  // is the one that actually tests the invariant — it must be refused by the
  // DATABASE, not by the API layer.
  const DB_LEVEL_REFUSALS = ['REFUSED_BY_PRIVILEGE', 'REFUSED_BY_VIEW']
  const F = `my_course_access?course_id=eq.${courseId}`

  for (const [verb, path, method, body, mustBeDbLevel] of [
    ['INSERT',            'my_course_access', 'POST', JSON.stringify({
      course_id: '00000000-0000-0000-0000-000000000000', has_access: true, access_ended: false }), true],
    ['UPDATE unfiltered', 'my_course_access', 'PATCH',  JSON.stringify({ has_access: true }), false],
    ['DELETE unfiltered', 'my_course_access', 'DELETE', undefined, false],
    ['UPDATE filtered',   F,                  'PATCH',  JSON.stringify({ has_access: true }), true],
    ['DELETE filtered',   F,                  'DELETE', undefined, true],
  ]) {
    const before = await fingerprint()
    const r = await rest(path, { jwt: learnerJwt, method, body, count: false })
    const w = classifyWrite(r)
    const after = await fingerprint()

    const ok = mustBeDbLevel ? DB_LEVEL_REFUSALS.includes(w) : SAFE_REFUSALS.includes(w)
    record(`learner ${verb} my_course_access refused`,
      `${w} (${r.status} ${r.code ?? ''})${mustBeDbLevel ? ' [database-level required]' : ''}`, ok)
    record(`learner ${verb} left the data unchanged`,
      before === after ? 'byte-identical' : `MUTATED: ${before} -> ${after}`, before === after)
  }

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
  //
  // XPA-8 F-5 / Track 4 - `ai_sessions` and `ai_turns` are APPEND-ONLY tables
  // that grow whenever a learner legitimately practises. Pinning them to an
  // exact count asserted "nothing was destroyed" by asserting "nothing has
  // happened", so the pilot first real voice session turned this section red
  // (12 vs 11, 40 vs 36) while nothing was actually wrong.
  //
  // The invariant these checks exist to defend is PRESERVATION, not stasis:
  // recorded pilot work must never disappear. That is >= against a frozen
  // baseline. The baseline stays at the audited pilot floor and is deliberately
  // NOT re-pinned to the current totals - re-pinning a preservation check to
  // present reality is exactly how it stops detecting deletion.
  //
  // `unpublished voice personas` keeps exact equality on purpose: four planned
  // personas is a fixed roster, not a growing table, and a fifth appearing is as
  // much a finding as a fourth disappearing.
  const PRESERVE_FLOOR = { sessions: 11, turns: 36 }
  for (const [label, path, want, mode] of [
    ['ai_sessions', 'ai_sessions?select=id&limit=1', PRESERVE_FLOOR.sessions, 'min'],
    ['ai_turns', 'ai_turns?select=id&limit=1', PRESERVE_FLOOR.turns, 'min'],
    ['unpublished voice personas', 'ai_scenarios?select=id&is_published=eq.false', 4, 'exact'],
  ]) {
    const r = await rest(path, { key: SVC })
    const held = mode === 'min' ? r.total >= want : r.total === want
    record(label, mode === 'min' ? `${r.total} (>= ${want})` : `${r.total} (want ${want})`, held)
  }
  const pvs = await rest('public_voice_scenarios?select=id')
  record('anon public_voice_scenarios', `${classify(pvs)} (${pvs.total} rows)`,
    classify(pvs) === 'ALLOWED' && pvs.total === 1)
  for (const t of ['ai_scenarios', 'course_codes', 'catalogues', 'learning_paths']) {
    const r = await rest(`${t}?select=id&limit=1`)
    record(`anon ${t} stays private`, `${r.status} ${r.code ?? ''}`, r.status >= 400 && r.status < 500)
  }

  // A census, not a verdict. "How many lessons are preview" is an editorial
  // fact, and section 1 already asserts that preview means what it should.
  // What IS a defect is a whole course flagged wholesale -- the pattern 035 was
  // written to eliminate -- so that is what this asserts.
  const prev = await rest('lessons?select=id,module_id&is_preview=eq.true&limit=1000', { key: SVC })
  const all = await rest('lessons?select=id&limit=1', { key: SVC })
  console.log(`    preview census: ${prev.total} of ${all.total} lesson(s)`)

  if (prev.total === 0) {
    record('no lesson is designated preview', `0 of ${all.total}`, all.total > 0)
  } else {
    const modRows = (await rest('modules?select=id,course_id&limit=1000', { key: SVC })).json ?? []
    const courseOf = Object.fromEntries(modRows.map(m => [m.id, m.course_id]))
    const totals = {}
    for (const l of ((await rest('lessons?select=module_id&limit=1000', { key: SVC })).json ?? [])) {
      const c = courseOf[l.module_id]
      if (c) totals[c] = (totals[c] ?? 0) + 1
    }
    const perCourse = {}
    for (const l of (prev.json ?? [])) {
      const c = courseOf[l.module_id]
      if (c) perCourse[c] = (perCourse[c] ?? 0) + 1
    }
    const blanket = Object.entries(perCourse).filter(([cid, n]) => totals[cid] === n)
    record('no course is flagged preview WHOLESALE',
      blanket.length
        ? `${blanket.length} course(s) with EVERY lesson preview -- the 035 pattern`
        : `${Object.keys(perCourse).length} course(s) with a deliberate subset`,
      blanket.length === 0)
  }
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
  if (results.length === 0) {
    // A verifier that recorded nothing has proved nothing. Reporting PASS here
    // is worse than reporting a failure, because it looks like evidence.
    console.log('✗ XPA-6A INCONCLUSIVE — 0 checks recorded; the run did not complete.')
    process.exitCode = 1
  } else if (failed.length === 0 && leftovers.length === 0) {
    console.log(`✓ XPA-6A PASS — ${results.length} checks, 0 failures.`)
  } else {
    console.log(`✗ XPA-6A FAIL — ${failed.length} of ${results.length} checks failed:`)
    for (const f of failed) console.log(`    ${f.label}`)
    if (leftovers.length) console.log(`    ${leftovers.length} probe account(s) NOT cleaned up`)
    process.exitCode = 1
  }
}
