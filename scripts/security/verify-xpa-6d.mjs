#!/usr/bin/env node
/**
 * XPA-6D production verification — answer-key protection, quizzes AND exercises.
 *
 * Run AFTER applying migration 038:
 *   node scripts/security/verify-xpa-6d.mjs
 *
 * ── WHAT THIS PROVES, AND WHAT IT DELIBERATELY DOES NOT ───────────────────
 *
 * Probes run as a REAL entitled learner, with a real JWT, against production.
 * A learner who is legitimately entitled is the hard case: anonymous denial
 * proves nothing about B-4, because B-4 was always about the caller who is
 * *supposed* to see the question but not the answer.
 *
 * Outcomes are classified, never pattern-matched on one SQLSTATE:
 *
 *   ALLOWED               the statement ran
 *   REFUSED_BY_PRIVILEGE  42501 — no grant on that column
 *   DENIED_EMPTY          200 with zero rows — reachable, RLS returned nothing
 *   BROKEN                anything else — never a pass, whichever way
 *
 * Scoring: this script verifies the DATA PATH scoring depends on — that the
 * service role can still read the key while the learner cannot. It does not
 * invoke the Next.js server action; the scoring arithmetic is covered by unit
 * tests over `lib/exercises/scoring.ts`. Saying so plainly is the point: a
 * verifier that claimed to test scoring end-to-end here would be lying.
 *
 * Production holds 0 exercises, so the exercise arm builds a synthetic one.
 * It is invisible to real users — no real account holds an entitlement to the
 * course, so RLS hides it from everyone except this script's throwaway
 * learner — and it is removed in a finally block, innermost rows first.
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
  if (code === '42P17' || code === '57014') return 'BROKEN'
  if (code === '42501') return 'REFUSED_BY_PRIVILEGE'
  if (status === 401 || status === 403) return 'BROKEN'
  if (status >= 400) return `BROKEN:${status}:${code ?? '?'}`
  return total > 0 ? 'ALLOWED' : 'DENIED_EMPTY'
}

async function rest(path, { key = ANON, jwt = null, method = 'GET', body, count = true } = {}) {
  const headers = {
    apikey: key,
    Authorization: `Bearer ${jwt ?? key}`,
    'Content-Type': 'application/json',
  }
  if (count) headers.Prefer = 'count=exact'
  if (method === 'POST') headers.Prefer = 'return=representation'
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
    message: (json?.message ?? '').slice(0, 70),
  }
}

const adm = (p, method, body) => fetch(`${U}/auth/v1${p}`, {
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

const PW = 'Vq4#zTn8!pLr2Wd6'
const LEARNER = 'xpa6d-verify-learner-delete-me@xpclient-academy.com'
const ENROL_ONLY = 'xpa6d-verify-enrolonly-delete-me@xpclient-academy.com'

// The exact projections the learner surfaces use. If a page is changed to ask
// for more, this script must be changed too — and that is the point.
const QUIZ_SAFE = 'id,quiz_id,question,options,order_index,question_type,question_image_url'
const EX_SAFE = 'id,exercise_id,label,order_index'
const QUIZ_KEYS = ['correct_answer', 'drag_match_answers', 'explanation']

let learnerId = null, entitlementId = null
let enrolOnlyId = null, enrollmentId = null
let exerciseId = null, categoryIds = [], itemIds = []

try {
  // ── Fixtures ────────────────────────────────────────────────────────────
  const quiz = (await rest('quizzes?select=id&limit=1', { key: SVC })).json[0]
  const courseId = (await rest('rpc/course_of_quiz', {
    key: SVC, method: 'POST', count: false, body: JSON.stringify({ p_quiz_id: quiz.id }),
  })).json
  // The fixture lesson MUST belong to the entitled course. An unfiltered
  // `lessons?limit=1` picks some other course's lesson, RLS then hides the
  // fixture from the probe learner, and every exercise check reads
  // DENIED_EMPTY — which looks like protection and is actually a broken test.
  const mod = (await rest(`modules?select=id&course_id=eq.${courseId}&limit=1`, { key: SVC })).json[0]
  const lesson = (await rest(`lessons?select=id&module_id=eq.${mod.id}&limit=1`, { key: SVC })).json[0]

  const existing = await (await adm('/admin/users?per_page=200', 'GET')).json()
  for (const u of existing.users ?? []) {
    if (u.email === LEARNER || u.email === ENROL_ONLY) await adm(`/admin/users/${u.id}`, 'DELETE')
  }
  learnerId = (await (await adm('/admin/users', 'POST', {
    email: LEARNER, password: PW, email_confirm: true,
  })).json()).id
  const jwt = await signIn(LEARNER, PW)

  await rest('entitlements', {
    key: SVC, method: 'POST', count: false,
    body: JSON.stringify({
      user_id: learnerId, course_id: courseId, source: 'MANUAL_ADMIN', status: 'ACTIVE',
    }),
  })
  entitlementId = (await rest(`entitlements?user_id=eq.${learnerId}&select=id`, { key: SVC })).json[0].id
  record('entitled probe learner provisioned', `course ${String(courseId).slice(0, 8)}…`, Boolean(jwt) && Boolean(entitlementId))

  // ══ 1. QUIZ — the original B-4 attack ═════════════════════════════════
  console.log('\n── 1. Quiz: B-4 direct answer-key read ─────────────────────────')

  const safe = await rest(`quiz_questions?select=${QUIZ_SAFE}&limit=5`, { jwt })
  record('entitled learner reads learner-safe quiz fields',
    `${classify(safe)} (${safe.total} rows)`, classify(safe) === 'ALLOWED')

  for (const key of QUIZ_KEYS) {
    const r = await rest(`quiz_questions?select=id,${key}&limit=5`, { jwt })
    record(`entitled learner CANNOT read ${key}`,
      `${classify(r)} (${r.status} ${r.code ?? ''})`,
      classify(r) === 'REFUSED_BY_PRIVILEGE')
  }

  const star = await rest('quiz_questions?select=*&limit=5', { jwt })
  record('entitled learner CANNOT wildcard-read quiz_questions',
    `${classify(star)} (${star.status} ${star.code ?? ''})`,
    classify(star) === 'REFUSED_BY_PRIVILEGE')

  const qMut = await rest(`quiz_questions?id=eq.${(safe.json ?? [])[0]?.id}`, {
    jwt, method: 'PATCH', count: false, body: JSON.stringify({ correct_answer: 99 }),
  })
  const qBefore = JSON.stringify((await rest('quiz_questions?select=id,correct_answer&order=id', { key: SVC })).json)
  record('entitled learner CANNOT mutate correct_answer',
    `${qMut.status} ${qMut.code ?? ''}`, qMut.code === '42501')

  const qSvc = await rest(`quiz_questions?select=${QUIZ_KEYS.join(',')}&limit=1`, { key: SVC })
  record('service role still reads the quiz key (scoring path)',
    `${classify(qSvc)} (${qSvc.total} rows)`, classify(qSvc) === 'ALLOWED')

  const qAfter = JSON.stringify((await rest('quiz_questions?select=id,correct_answer&order=id', { key: SVC })).json)
  record('quiz answer key byte-identical after the attack',
    qBefore === qAfter ? 'unchanged' : 'MUTATED', qBefore === qAfter)

  // ══ 2. EXERCISE — synthetic fixture ═══════════════════════════════════
  console.log('\n── 2. Exercise: synthetic fixture (production holds 0) ─────────')

  const ex = await rest('exercises', {
    key: SVC, method: 'POST', count: false,
    body: JSON.stringify({
      lesson_id: lesson.id, title: 'XPA-6D verification fixture — delete me',
      instructions: 'synthetic', exercise_type: 'drag_match', is_published: true,
    }),
  })
  exerciseId = ex.json?.[0]?.id
  record('fixture exercise created', `${ex.status} ${String(exerciseId ?? '').slice(0, 8)}…`, Boolean(exerciseId))

  const cats = await rest('exercise_categories', {
    key: SVC, method: 'POST', count: false,
    body: JSON.stringify([
      { exercise_id: exerciseId, name: 'Alpha', order_index: 0 },
      { exercise_id: exerciseId, name: 'Beta', order_index: 1 },
    ]),
  })
  categoryIds = (cats.json ?? []).map(c => c.id)

  const its = await rest('exercise_items', {
    key: SVC, method: 'POST', count: false,
    body: JSON.stringify([
      { exercise_id: exerciseId, label: 'one', correct_category_id: categoryIds[0], order_index: 0 },
      { exercise_id: exerciseId, label: 'two', correct_category_id: categoryIds[1], order_index: 1 },
    ]),
  })
  itemIds = (its.json ?? []).map(i => i.id)
  record('fixture categories + items created',
    `${categoryIds.length} categories, ${itemIds.length} items`,
    categoryIds.length === 2 && itemIds.length === 2)

  console.log('\n── 3. Exercise: the learner-facing payload ─────────────────────')

  const exSafe = await rest(`exercise_items?select=${EX_SAFE}&exercise_id=eq.${exerciseId}`, { jwt })
  record('entitled learner reads learner-safe exercise fields',
    `${classify(exSafe)} (${exSafe.total} rows)`, classify(exSafe) === 'ALLOWED')

  const payloadKeys = Object.keys((exSafe.json ?? [])[0] ?? {})
  record('learner payload carries NO authoritative mapping',
    payloadKeys.length ? payloadKeys.join(',') : '(empty)',
    payloadKeys.length > 0 && !payloadKeys.includes('correct_category_id'))

  // The nested shape the lesson page actually issues.
  const nested = await rest(
    `exercises?select=id,title,instructions,exercise_categories(id,name,color,order_index),exercise_items(id,label,order_index)&id=eq.${exerciseId}`,
    { jwt })
  const nestedItem = nested.json?.[0]?.exercise_items?.[0] ?? {}
  record('nested lesson-page payload carries no key',
    `${classify(nested)} keys=${Object.keys(nestedItem).join(',') || '(none)'}`,
    classify(nested) === 'ALLOWED' && !('correct_category_id' in nestedItem))

  // Q-L for exercises. Before 038 this arm PASSED for the wrong reason: an
  // enrollment granted exercise access while an entitlement did not, because
  // `exercises_select` was never moved off the rule XPA-6B abolished.
  enrolOnlyId = (await (await adm('/admin/users', 'POST', {
    email: ENROL_ONLY, password: PW, email_confirm: true,
  })).json()).id
  const enrolJwt = await signIn(ENROL_ONLY, PW)
  await rest('enrollments', {
    key: SVC, method: 'POST', count: false,
    body: JSON.stringify({ user_id: enrolOnlyId, course_id: courseId, status: 'active' }),
  })
  enrollmentId = (await rest(`enrollments?user_id=eq.${enrolOnlyId}&select=id`, { key: SVC })).json[0].id

  const enrolRead = await rest(
    `exercise_items?select=${EX_SAFE}&exercise_id=eq.${exerciseId}`, { jwt: enrolJwt })
  record('ENROLLMENT alone grants NO exercise access (Q-L)',
    `${classify(enrolRead)} (${enrolRead.total} rows)`,
    classify(enrolRead) === 'DENIED_EMPTY')

  console.log('\n── 4. Exercise: direct attack on the key ───────────────────────')

  const exKey = await rest(`exercise_items?select=id,correct_category_id&exercise_id=eq.${exerciseId}`, { jwt })
  record('entitled learner CANNOT read correct_category_id',
    `${classify(exKey)} (${exKey.status} ${exKey.code ?? ''})`,
    classify(exKey) === 'REFUSED_BY_PRIVILEGE')

  const exStar = await rest(`exercise_items?select=*&exercise_id=eq.${exerciseId}`, { jwt })
  record('entitled learner CANNOT wildcard-read exercise_items',
    `${classify(exStar)} (${exStar.status} ${exStar.code ?? ''})`,
    classify(exStar) === 'REFUSED_BY_PRIVILEGE')

  const before = JSON.stringify((await rest(
    `exercise_items?select=id,correct_category_id&exercise_id=eq.${exerciseId}&order=order_index`,
    { key: SVC })).json)
  const exMut = await rest(`exercise_items?id=eq.${itemIds[0]}`, {
    jwt, method: 'PATCH', count: false,
    body: JSON.stringify({ correct_category_id: categoryIds[1] }),
  })
  const after = JSON.stringify((await rest(
    `exercise_items?select=id,correct_category_id&exercise_id=eq.${exerciseId}&order=order_index`,
    { key: SVC })).json)
  record('entitled learner CANNOT mutate correct_category_id',
    `${exMut.status} ${exMut.code ?? ''}`, exMut.code === '42501')
  record('exercise answer key byte-identical after the attack',
    before === after ? 'unchanged' : `MUTATED: ${before} -> ${after}`, before === after)

  const exSvc = await rest(
    `exercise_items?select=id,correct_category_id&exercise_id=eq.${exerciseId}`, { key: SVC })
  record('service role still reads the exercise key (scoring path)',
    `${classify(exSvc)} (${exSvc.total} rows)`, classify(exSvc) === 'ALLOWED')

  console.log('\n── 5. Administration still works ───────────────────────────────')
  const admWrite = await rest(`exercise_items?id=eq.${itemIds[0]}`, {
    key: SVC, method: 'PATCH', count: false,
    body: JSON.stringify({ correct_category_id: categoryIds[1] }),
  })
  record('service role CAN manage the exercise key', String(admWrite.status), admWrite.status < 300)
  await rest(`exercise_items?id=eq.${itemIds[0]}`, {
    key: SVC, method: 'PATCH', count: false,
    body: JSON.stringify({ correct_category_id: categoryIds[0] }),
  })

  const admQuiz = await rest(`quiz_questions?select=id,correct_answer&limit=1`, { key: SVC })
  record('service role CAN read quiz keys for administration',
    `${classify(admQuiz)}`, classify(admQuiz) === 'ALLOWED')
} finally {
  console.log('\n── Cleanup ─────────────────────────────────────────────────────')
  // Innermost first: exercise_items.correct_category_id is ON DELETE RESTRICT
  // against exercise_categories, so categories cannot go until items have.
  if (itemIds.length) {
    const d = await rest(`exercise_items?exercise_id=eq.${exerciseId}`, { key: SVC, method: 'DELETE', count: false })
    console.log(`  fixture items deleted:      ${d.status}`)
  }
  if (categoryIds.length) {
    const d = await rest(`exercise_categories?exercise_id=eq.${exerciseId}`, { key: SVC, method: 'DELETE', count: false })
    console.log(`  fixture categories deleted: ${d.status}`)
  }
  if (exerciseId) {
    const d = await rest(`exercises?id=eq.${exerciseId}`, { key: SVC, method: 'DELETE', count: false })
    console.log(`  fixture exercise deleted:   ${d.status}`)
  }
  if (enrollmentId) {
    const d = await rest(`enrollments?id=eq.${enrollmentId}`, { key: SVC, method: 'DELETE', count: false })
    console.log(`  probe enrollment deleted:   ${d.status}`)
  }
  for (const [label, id] of [['enrol-only learner', enrolOnlyId]]) {
    if (id) console.log(`  ${label} deleted:  ${(await adm(`/admin/users/${id}`, 'DELETE')).status}`)
  }
  if (entitlementId) {
    const d = await rest(`entitlements?id=eq.${entitlementId}`, { key: SVC, method: 'DELETE', count: false })
    console.log(`  probe entitlement deleted:  ${d.status}`)
  }
  if (learnerId) {
    console.log(`  probe learner deleted:      ${(await adm(`/admin/users/${learnerId}`, 'DELETE')).status}`)
  }

  const exLeft = await rest('exercises?select=id', { key: SVC })
  const entLeft = await rest('entitlements?select=id', { key: SVC })
  const users = await (await adm('/admin/users?per_page=200', 'GET')).json()
  const strays = (users.users ?? []).filter(u => /xpa6d-verify/.test(u.email ?? ''))
  const enrolLeft = await rest('enrollments?select=id', { key: SVC })
  console.log(`  enrollments remaining:      ${enrolLeft.total}`)
  console.log(`  exercises remaining:        ${exLeft.total}`)
  console.log(`  entitlements remaining:     ${entLeft.total}`)
  console.log(`  leftover probe accounts:    ${strays.length}`)

  const dirty = exLeft.total !== 0 || entLeft.total !== 0 || strays.length !== 0 || enrolLeft.total !== 0
  const failed = results.filter(r => !r.pass)
  console.log('')
  if (failed.length === 0 && !dirty) {
    console.log(`✓ XPA-6D PASS — ${results.length} checks, 0 failures.`)
  } else {
    console.log(`✗ XPA-6D FAIL — ${failed.length} of ${results.length} checks failed:`)
    for (const f of failed) console.log(`    ${f.label}`)
    if (dirty) console.log('    synthetic fixtures were NOT fully cleaned up')
    process.exitCode = 1
  }
}
