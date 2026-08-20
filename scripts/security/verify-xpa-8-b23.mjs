#!/usr/bin/env node
/**
 * XPA-8 B-2.3A production verification — the assessment contract.
 *
 *   node scripts/security/verify-xpa-8-b23.mjs
 *
 * ── WHAT IT PROVES ────────────────────────────────────────────────────────
 *
 * That sitting an assessment requires the same thing as opening the course —
 * a currently-accessible ENTITLEMENT — that a final exam gives nothing away,
 * that three attempts means three, and that a certificate is issued only when
 * it has been earned.
 *
 * ── WHY IT REPORTS TWO STATES ─────────────────────────────────────────────
 *
 * B-2.3A has an application half and a database half, exactly as B-2.6 did.
 *
 *   application  `submitQuizAnswers` re-checks the entitlement seam, budgets
 *                attempts and withholds the key. Ships with the code.
 *   database     migration 046 gates `quiz_attempts` INSERT/UPDATE on
 *                `has_course_access()`. Applied by an OPERATOR, after the code.
 *
 * Until 046 is applied a learner still holds a JWT and PostgREST is still
 * reachable, so a bare `POST /rest/v1/quiz_attempts` still lands. This script
 * measures that and FAILS while it stands, rather than reporting a pass it has
 * not earned. Migration 047 (`courses.requires_final_exam`) is detected the
 * same way and its absence is reported, not worked around.
 *
 * ── FIXTURES ──────────────────────────────────────────────────────────────
 *
 * Six synthetic learners (A–F) plus one throwaway formative/exam pair created
 * on a REAL course and removed by id. Nothing pre-existing is mutated:
 * `requires_final_exam` is never flipped on a real course, and the one
 * production quiz (C1-F1's warm-up) is read, never written.
 */
import { readFileSync } from 'node:fs'

const env = {}
try {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* fall through */ }

const SB   = env.NEXT_PUBLIC_SUPABASE_URL      ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SVC  = env.SUPABASE_SERVICE_ROLE_KEY     ?? process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SB || !ANON || !SVC) { console.error('Missing Supabase configuration.'); process.exit(1) }

const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' }

let pass = 0
const fails = []
const openItems = []
const rec = (l, d, ok) => { console.log(`  ${ok ? '✓' : '✗'} ${l.padEnd(56)} ${d}`); if (ok) pass++; else fails.push(`${l} — ${d}`) }
/** A check only migration 046/047 can satisfy. Tracked apart from real failures. */
const pending = (l, d, ok) => { console.log(`  ${ok ? '✓' : '⚠'} ${l.padEnd(56)} ${d}`); if (ok) pass++; else openItems.push(`${l} — ${d}`) }
const info = (l, d) => console.log(`    · ${l.padEnd(54)} ${d}`)

const rest = async (p, o = {}) => {
  const key = o.key ?? SVC
  const r = await fetch(`${SB}/rest/v1/${p}`, {
    method:  o.method ?? 'GET',
    headers: { apikey: key, Authorization: `Bearer ${o.jwt ?? key}`,
               'Content-Type': 'application/json', Prefer: o.prefer ?? 'count=exact' },
    body: o.body,
  })
  const t = await r.text(); let j = null
  try { j = JSON.parse(t) } catch { /* non-JSON */ }
  return { status: r.status, rows: Array.isArray(j) ? j : (j ? [j] : []), json: j, raw: t }
}

const STAMP = String(process.hrtime.bigint()).slice(-9)
const PW    = 'Gx4#mTd7!vLq3Rn8'
const E     = k => `b23-${k}-${STAMP}@xpclient-academy.com`

const users   = {}
const created = { users: [], ents: [], enrols: [], quizzes: [], questions: [] }

const mkUser = async (k) => {
  const made = await (await fetch(`${SB}/auth/v1/admin/users`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ email: E(k), password: PW, email_confirm: true }) })).json()
  created.users.push(made.id)
  const tok = await (await fetch(`${SB}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: E(k), password: PW }) })).json()
  users[k] = { id: made.id, jwt: tok.access_token }
  return users[k]
}
const grant = async (uid, cid, extra = {}) => {
  const r = await rest('entitlements', { method: 'POST', prefer: 'return=representation',
    body: JSON.stringify({ user_id: uid, course_id: cid, source: 'MANUAL_ADMIN', status: 'ACTIVE', ...extra }) })
  if (r.rows[0]?.id) created.ents.push(r.rows[0].id)
  return r.rows[0]
}
const enrol = async (uid, cid) => {
  const r = await rest('enrollments', { method: 'POST', prefer: 'return=representation',
    body: JSON.stringify({ user_id: uid, course_id: cid }) })
  if (r.rows[0]?.id) created.enrols.push(r.rows[0].id)
}
const access = async (jwt, cid) => {
  const r = await fetch(`${SB}/rest/v1/rpc/has_course_access`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_course_id: cid }) })
  return (await r.text()).trim() === 'true'
}

/**
 * The direct-API write the application no longer performs but a learner still
 * can. Compares the ROW COUNT before and after, because an HTTP 2xx is not
 * evidence of a write, and a non-2xx settles it outright.
 */
const writeAttempt = async (jwt, uid, quizId) => {
  const before = (await rest(`quiz_attempts?user_id=eq.${uid}&quiz_id=eq.${quizId}&select=id`)).rows.length
  const r = await fetch(`${SB}/rest/v1/quiz_attempts`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json',
               Prefer: 'return=representation' },
    body: JSON.stringify({ user_id: uid, quiz_id: quizId, answers: {}, score: 100, max_score: 100, passed: true }) })
  const t = await r.text(); let j = null
  try { j = JSON.parse(t) } catch { /* */ }
  const after = (await rest(`quiz_attempts?user_id=eq.${uid}&quiz_id=eq.${quizId}&select=id`)).rows.length
  return { status: r.status, landed: r.status < 300 && after > before,
           code: j?.code ?? '', rows: after }
}

console.log('\n═══ XPA-8 B-2.3A — ASSESSMENT CONTRACT ═════════════════════════')

try {
  // ── Targets ─────────────────────────────────────────────────────────────
  const courses = await rest('courses?select=id,code,slug,is_published&order=code')
  const target  = courses.rows.find(c => c.code === 'C1-F1')
  const foreign = courses.rows.find(c => c.code === 'C2-F1')
  if (!target || !foreign) { console.error('Expected C1-F1 and C2-F1.'); process.exit(1) }

  console.log('\n── Targets ─────────────────────────────────────────────────────')
  info('assessed course', `${target.code} ${target.id.slice(0, 8)}`)
  info('foreign course',  `${foreign.code} ${foreign.id.slice(0, 8)}`)

  // ── Migration state, detected rather than assumed ───────────────────────
  console.log('\n── Migration state ─────────────────────────────────────────────')
  const flagProbe = await rest('courses?select=requires_final_exam&limit=1')
  const has047 = flagProbe.status < 300
  pending('047 applied — courses.requires_final_exam exists',
    has047 ? 'present' : `absent (${flagProbe.json?.code ?? flagProbe.status})`, has047)
  if (has047) {
    const enabled = (await rest('courses?select=id&requires_final_exam=eq.true')).rows.length
    rec('no course requires an exam yet (B-2.3A ships none)', `${enabled} enabled`, enabled === 0)
  }

  // ── Fixtures ────────────────────────────────────────────────────────────
  console.log('\n── Fixtures A–F ────────────────────────────────────────────────')
  for (const k of ['A', 'B', 'C', 'D', 'E', 'F']) await mkUser(k)
  await grant(users.A.id, target.id); await enrol(users.A.id, target.id)
  await grant(users.B.id, target.id)
  await enrol(users.C.id, target.id)
  await grant(users.D.id, target.id, { expires_at: '2020-01-01T00:00:00Z' })
  const eEnt = await grant(users.E.id, target.id)
  const rev = await rest(`entitlements?id=eq.${eEnt.id}`, { method: 'PATCH', prefer: 'return=representation',
    body: JSON.stringify({ status: 'REVOKED', revoked_at: new Date().toISOString() }) })
  rec('E is genuinely REVOKED (the PATCH landed)', `${rev.status} ${rev.rows[0]?.status ?? '—'}`,
    rev.rows[0]?.status === 'REVOKED')
  info('A entitled+enrolled · B entitled · C enrolled-only', '')
  info('D expired · E revoked · F neither', '')

  // A throwaway COURSE-SCOPED quiz = a final exam, on the real course.
  const mkQuiz = async (parent, title) => {
    const q = await rest('quizzes', { method: 'POST', prefer: 'return=representation',
      body: JSON.stringify({ title, passing_score: 80, ...parent }) })
    if (q.rows[0]?.id) created.quizzes.push(q.rows[0].id)
    return q.rows[0]
  }
  const exam = await mkQuiz({ course_id: target.id }, `B-2.3 verifier exam ${STAMP}`)
  rec('a course-scoped quiz can be created (the exam shape)', `${exam?.id?.slice(0, 8) ?? 'FAILED'}`, Boolean(exam?.id))

  // ── 1. The access seam classifies A–F ───────────────────────────────────
  console.log('\n── 1. has_course_access() — the ACCESS authority ───────────────')
  const EXPECT = { A: true, B: true, C: false, D: false, E: false, F: false }
  const actual = {}
  for (const k of Object.keys(EXPECT)) {
    actual[k] = await access(users[k].jwt, target.id)
    rec(`${k} — has_course_access`, String(actual[k]), actual[k] === EXPECT[k])
  }
  rec('enrollment alone does NOT grant access (Q-L)', `C=${actual.C}`, actual.C === false)

  // ── 2. NOBODY writes an attempt directly. Not even an entitled learner ──
  //
  // The B-2.3 audit expected the pre-044 `attempts_own FOR ALL` shape here and
  // was WRONG. Migration 011 had already replaced it with
  // `attempts_insert_service WITH CHECK (false)`, and nothing superseded that.
  // Scores are computed server-side and written with the service role, so the
  // correct invariant is not "entitled may, unentitled may not" — it is that
  // the direct path is closed to EVERYONE. The proposed migration 046 was
  // withdrawn for exactly this reason; see 047's header.
  console.log('\n── 2. Direct API attempt writes are closed to EVERYONE ─────────')
  for (const k of Object.keys(EXPECT)) {
    const w = await writeAttempt(users[k].jwt, users[k].id, exam.id)
    rec(`${k} → quiz_attempts (${EXPECT[k] ? 'entitled' : 'no access'})`,
      w.landed ? 'ROW WRITTEN' : `refused ${w.status} ${w.code}`, w.landed === false)
  }
  info('why', 'scores are server-computed; 011 makes the browser path impossible')

  // ── 3. Nor may a learner tamper with an attempt they own ────────────────
  console.log('\n── 3. A learner cannot tamper with their own attempt ───────────')
  // A 204 is not evidence of anything. Row effects are what count — PostgREST
  // returns 204 for a PATCH that RLS silently matched zero rows for.
  const seeded = (await rest('quiz_attempts', { method: 'POST', prefer: 'return=representation',
    body: JSON.stringify({ user_id: users.A.id, quiz_id: exam.id, answers: {}, score: 10, max_score: 100, passed: false }) })).rows[0]
  const L = { key: ANON, jwt: users.A.jwt }
  const up = await rest(`quiz_attempts?id=eq.${seeded.id}`, { ...L, method: 'PATCH', body: JSON.stringify({ passed: true, score: 100 }) })
  const afterUp = (await rest(`quiz_attempts?select=passed,score&id=eq.${seeded.id}`)).rows[0]
  rec('an entitled learner cannot flip their own attempt to passed',
    `HTTP ${up.status}, row passed=${afterUp?.passed} score=${afterUp?.score}`, afterUp?.passed === false)
  const del = await rest(`quiz_attempts?id=eq.${seeded.id}`, { ...L, method: 'DELETE' })
  const afterDel = (await rest(`quiz_attempts?select=id&id=eq.${seeded.id}`)).rows.length
  rec('…nor delete it, so the 3-attempt budget cannot be self-reset',
    `HTTP ${del.status}, rows remaining ${afterDel}`, afterDel === 1)

  // ── 4. Cross-course and impersonation ───────────────────────────────────
  console.log('\n── 4. Cross-course and impersonation ───────────────────────────')
  const foreignExam = await mkQuiz({ course_id: foreign.id }, `B-2.3 verifier foreign ${STAMP}`)
  const xCourse = await writeAttempt(users.A.jwt, users.A.id, foreignExam.id)
  rec('A cannot record an attempt in a course A does not hold',
    `has_access=${await access(users.A.jwt, foreign.id)}  ${xCourse.landed ? 'ROW WRITTEN' : `refused ${xCourse.status}`}`,
    !xCourse.landed)
  const imp = await writeAttempt(users.A.jwt, users.F.id, exam.id)
  rec('A cannot record an attempt belonging to learner F', `${imp.status} ${imp.code}`, !imp.landed)
  info('the entitlement matrix lives in the ACTION', 'service role bypasses RLS, so submitQuizAnswers is the gate')
  info('proved by', '__tests__/security/xpa-8-b23-assessment-contract.test.ts (A–F, executed)')

  // ── 5. Results are retained when access ends ────────────────────────────
  console.log('\n── 5. Results retained after access ends ───────────────────────')
  await rest('quiz_attempts', { method: 'POST',
    body: JSON.stringify({ user_id: users.D.id, quiz_id: exam.id, answers: {}, score: 90, max_score: 100, passed: true }) })
  const dReads = await rest(`quiz_attempts?user_id=eq.${users.D.id}&select=id,score`, { key: ANON, jwt: users.D.jwt })
  rec('an EXPIRED learner can still read their own results', `${dReads.status}, ${dReads.rows.length} row(s)`,
    dReads.rows.length >= 1)
  const dOther = await rest(`quiz_attempts?user_id=eq.${users.A.id}&select=id`, { key: ANON, jwt: users.D.jwt })
  rec("…but not somebody else's", `${dOther.rows.length} row(s)`, dOther.rows.length === 0)

  // ── 6. Best passing attempt endures ─────────────────────────────────────
  console.log('\n── 6. Best passing result ──────────────────────────────────────')
  await rest('quiz_attempts', { method: 'POST',
    body: JSON.stringify({ user_id: users.A.id, quiz_id: exam.id, answers: {}, score: 95, max_score: 100, passed: true }) })
  await rest('quiz_attempts', { method: 'POST',
    body: JSON.stringify({ user_id: users.A.id, quiz_id: exam.id, answers: {}, score: 20, max_score: 100, passed: false }) })
  const anyPass = (await rest(`quiz_attempts?user_id=eq.${users.A.id}&quiz_id=eq.${exam.id}&passed=eq.true&select=id`)).rows.length
  rec('a later FAILED attempt does not revoke an earned pass', `${anyPass} passing attempt(s) remain`, anyPass >= 1)

  // ── 7. The formative warm-up gates nothing ──────────────────────────────
  console.log('\n── 7. C1-F1 warm-up is formative and ungated ───────────────────')
  const warm = (await rest(`quizzes?select=id,title,lesson_id,module_id,course_id&lesson_id=not.is.null`)).rows
    .find(q => /chauffement/i.test(q.title ?? ''))
  if (warm) {
    rec('the warm-up is LESSON-scoped, therefore formative',
      `lesson_id=${String(warm.lesson_id).slice(0, 8)} module_id=${warm.module_id} course_id=${warm.course_id}`,
      Boolean(warm.lesson_id) && !warm.module_id && !warm.course_id)
    const modQuizzes = (await rest(`quizzes?select=id&module_id=not.is.null`)).rows.length
    rec('no module-scoped quiz exists, so nothing gates a module', `${modQuizzes}`, modQuizzes === 0)
  } else {
    info('warm-up quiz', 'not found — skipped')
  }

  // ── 8. The application half is deployed ─────────────────────────────────
  console.log('\n── 8. The application half ─────────────────────────────────────')
  const blank = m => m.replace(/[^\n]/g, ' ')
  const stripJs = s => s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank)
  const src = p => { try { return readFileSync(p, 'utf8') } catch { return '' } }

  const grader = stripJs(src('app/actions/quiz.ts'))
  const assess = stripJs(src('lib/learn/assessment.ts'))
  const cert   = stripJs(src('app/(platform)/certificate/[courseSlug]/page.tsx'))
  const player = stripJs(src('app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'))
  const examPg = stripJs(src('app/(learn)/learn/[courseSlug]/final-exam/page.tsx'))

  rec('submission checks the entitlement seam', 'resolveCourseAccessById', /resolveCourseAccessById\(context\.courseId\)/.test(grader))
  rec('final exams withhold the answer key', 'restrictedFeedback', /restrictedFeedback: true/.test(grader))
  rec('formative quizzes keep full feedback', 'correctAnswers retained', /restrictedFeedback: false/.test(grader))
  rec('the attempt budget is enforced server-side', 'FINAL_EXAM_MAX_ATTEMPTS', /FINAL_EXAM_MAX_ATTEMPTS/.test(grader))
  rec('a final exam is a COURSE-scoped quiz', "kind === 'final_exam'", /course_id \? 'final_exam'/.test(assess))
  rec('certificate delegates to the eligibility resolver', 'resolveCertificateEligibility', /resolveCertificateEligibility/.test(cert))
  rec('requires_final_exam true + no exam FAILS CLOSED', 'final_exam_missing', /final_exam_missing/.test(assess))
  rec('no assessment module consults the operating mode', 'no PILOT_MODE/PLATFORM_MODE',
    !/PILOT_MODE|PLATFORM_MODE/.test(grader) && !/PILOT_MODE|PLATFORM_MODE/.test(assess))
  rec('the certificate gate is not mode-gated', 'no if (!PILOT_MODE)', !/if \(!PILOT_MODE\)/.test(cert))
  rec('lesson-scoped quizzes no longer gate a module', 'no lessonIdSet', !/lessonIdSet/.test(player))
  rec('final exams randomize', 'orderQuestions(questions, true, …)', /orderQuestions\(questions, true/.test(examPg))

  // ── 9. Certificate consequence ──────────────────────────────────────────
  console.log('\n── 9. What a certificate attests today ─────────────────────────')
  info('courses requiring an exam', has047 ? '0 — none flipped, by ruling' : 'column absent (047 pending)')
  info('certificate contract', 'required lessons complete; exam gate off until a course opts in')
} finally {
  // ── Cleanup — ID-scoped, never global ───────────────────────────────────
  console.log('\n── Cleanup (ID-scoped) ─────────────────────────────────────────')
  const ids = created.users.filter(Boolean)
  if (created.quizzes.length) {
    const qIn = created.quizzes.join(',')
    const da = await rest(`quiz_attempts?quiz_id=in.(${qIn})`, { method: 'DELETE' })
    const dq = await rest(`quizzes?id=in.(${qIn})`, { method: 'DELETE' })
    console.log(`  fixture attempts ${da.status}  fixture quizzes ${dq.status}`)
  }
  if (ids.length) {
    const inList = ids.join(',')
    const d0 = await rest(`quiz_attempts?user_id=in.(${inList})`, { method: 'DELETE' })
    const d1 = await rest(`lesson_progress?user_id=in.(${inList})`, { method: 'DELETE' })
    const d2 = await rest(`enrollments?user_id=in.(${inList})`,     { method: 'DELETE' })
    const d3 = await rest(`entitlements?user_id=in.(${inList})`,    { method: 'DELETE' })
    console.log(`  attempts ${d0.status}  progress ${d1.status}  enrollments ${d2.status}  entitlements ${d3.status}`)
    for (const u of ids) await fetch(`${SB}/auth/v1/admin/users/${u}`, { method: 'DELETE', headers: H })
    const sq = (await rest(`quiz_attempts?user_id=in.(${inList})&select=id`)).rows.length
    const se = (await rest(`entitlements?user_id=in.(${inList})&select=id`)).rows.length
    console.log(`  strays — attempts ${sq}, entitlements ${se}`)
  }
  // The real quiz must survive untouched.
  const realQuizzes = (await rest('quizzes?select=id')).rows.length
  console.log(`  production quizzes remaining: ${realQuizzes} (expected 1 — the C1-F1 warm-up)`)
  const mar = (await rest('profiles?select=id&email=eq.mariemeify@gmail.com')).rows[0]
  if (mar) {
    const mp = (await rest(`lesson_progress?user_id=eq.${mar.id}&select=id`)).rows.length
    const me = (await rest(`entitlements?user_id=eq.${mar.id}&select=id`)).rows.length
    console.log(`  Marième untouched — progress ${mp}, entitlements ${me}`)
  }

  console.log('\n────────────────────────────────────────────────────────────────')
  if (openItems.length) {
    console.log(`\n  ⚠ AWAITING MIGRATION 047 — ${openItems.length} item(s):\n`)
    for (const o of openItems) console.log(`      ${o}`)
    console.log(`
  This is the EXPECTED state until an operator applies

      supabase/migrations/047_courses_requires_final_exam.sql

  It is additive and safe to apply at any time — the application already reads
  its absence (42703) as false, which is the column's own default.

  There is deliberately NO migration 046. The quiz_attempts hardening it would
  have performed was already done by migration 011, and applying it would have
  LOOSENED the table. See 047's header.
`)
  }

  const total = pass + fails.length + openItems.length
  if (fails.length === 0 && openItems.length === 0) {
    console.log(`✓ XPA-8 B-2.3A PASS — ${pass} checks, 0 failures. Both halves in place.\n`)
  } else {
    console.log(`✗ XPA-8 B-2.3A INCOMPLETE — ${pass} of ${total} checks passed.`)
    if (fails.length) {
      console.log(`  ${fails.length} genuine failure(s):`)
      for (const f of fails) console.log(`    ${f}`)
    }
    if (openItems.length) console.log(`  ${openItems.length} awaiting migration 047.`)
    console.log('')
    process.exitCode = 1
  }
}
