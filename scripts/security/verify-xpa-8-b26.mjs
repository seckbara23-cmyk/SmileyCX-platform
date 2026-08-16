#!/usr/bin/env node
/**
 * XPA-8 B-2.6 production verification — the completion authority.
 *
 *   node scripts/security/verify-xpa-8-b26.mjs
 *
 * ── WHAT IT PROVES ────────────────────────────────────────────────────────
 *
 * That saying "I finished this lesson" requires the same thing as opening it:
 * a currently-accessible ENTITLEMENT. Not an enrollment, not an account, not a
 * lapsed entitlement, and not an operating mode.
 *
 * The audit found completion writes were authenticated but not authorized —
 * RLS enforced `user_id = auth.uid()` and nothing else, so four of six fixtures
 * wrote successfully with `has_course_access() = false`. With no assessment
 * gating any published course, self-asserted progress WAS the certificate.
 *
 * ── WHY THIS SCRIPT REPORTS TWO DIFFERENT STATES ──────────────────────────
 *
 * B-2.6 has an application half and a database half.
 *
 *   application  `completeLesson` re-checks the entitlement seam before
 *                writing. Deployed with the code. Closes the app path.
 *   database     migration 044 gates lesson_progress INSERT/UPDATE on
 *                `has_course_access()`. Applied by an OPERATOR. Closes the
 *                direct-API path.
 *
 * The learner still holds a JWT and PostgREST is still reachable, so until 044
 * is applied a bare `POST /rest/v1/lesson_progress` still lands — which is
 * exactly what this script measures. It detects which state production is in
 * from BEHAVIOUR rather than from introspection, and it FAILS while the hole is
 * open. A green run here means both halves are in place.
 *
 * ── WHAT IT DELIBERATELY DOES NOT ASSERT ──────────────────────────────────
 *
 * No watch-time evidence, no anti-cheating rule. B-2.6 did not decide whether
 * ending a video is sufficient proof of learning; completion remains
 * honour-based and only the ACCESS question was settled.
 *
 * Fixtures: six synthetic learners, removed by id. Marième is asserted
 * untouched at the end — never global-empty assertions.
 */
import { readFileSync } from 'node:fs'

const env = {}
try {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* fall through to process.env */ }

const SB   = env.NEXT_PUBLIC_SUPABASE_URL      ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SVC  = env.SUPABASE_SERVICE_ROLE_KEY     ?? process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SB || !ANON || !SVC) { console.error('Missing Supabase configuration.'); process.exit(1) }

const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' }

let pass = 0
const fails = []
const openItems = []
const rec = (l, d, ok) => {
  console.log(`  ${ok ? '✓' : '✗'} ${l.padEnd(56)} ${d}`)
  if (ok) pass++; else fails.push(`${l} — ${d}`)
}
/**
 * A check that can only be satisfied by migration 044. Failing it before the
 * operator applies 044 is the expected state, not a regression — so it is
 * tracked separately and never counted as a genuine failure. Everything routed
 * here is a consequence of S-1, the single hole 044 closes.
 */
const s1 = (l, d, ok) => {
  console.log(`  ${ok ? '✓' : '⚠'} ${l.padEnd(56)} ${d}`)
  if (ok) pass++; else openItems.push(`${l} — ${d}`)
}
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
  return { status: r.status, rows: Array.isArray(j) ? j : (j ? [j] : []), raw: t, json: j }
}

const STAMP = String(process.hrtime.bigint()).slice(-9)
const PW    = 'Gx4#mTd7!vLq3Rn8'
const E     = k => `b26-${k}-${STAMP}@xpclient-academy.com`

const users   = {}
const created = { users: [], ents: [], enrols: [] }

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
    body: JSON.stringify({ user_id: uid, course_id: cid, source: 'MANUAL_ADMIN',
                           status: 'ACTIVE', ...extra }) })
  if (r.rows[0]?.id) created.ents.push(r.rows[0].id)
  return r.rows[0]
}

const enrol = async (uid, cid) => {
  const r = await rest('enrollments', { method: 'POST', prefer: 'return=representation',
    body: JSON.stringify({ user_id: uid, course_id: cid }) })
  if (r.rows[0]?.id) created.enrols.push(r.rows[0].id)
}

/** The ACCESS authority, as the learner's own session sees it. */
const access = async (jwt, cid) => {
  const r = await fetch(`${SB}/rest/v1/rpc/has_course_access`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_course_id: cid }) })
  return (await r.text()).trim() === 'true'
}

/** The row as it stands, or null. */
const snap = async (uid, lessonId) => (await rest(
  `lesson_progress?user_id=eq.${uid}&lesson_id=eq.${lessonId}&select=id,is_completed,completed_at`
)).rows[0] ?? null

/**
 * The direct-API write the application no longer performs but a learner still
 * can.
 *
 * `landed` compares the ROW before and after, because an HTTP 2xx is not
 * evidence of a write — PostgREST happily returns 201 for an upsert that
 * changed nothing.
 *
 * The first version of this helper got the IMPERSONATION probe wrong. It scored
 * a write as landed when `after.is_completed === true && before > 0`, meaning
 * it fired whenever a completed row already existed — regardless of whether
 * THIS call had done anything. A's attempt to write F's row was refused with
 * 403 42501, exactly as it should be, and the helper reported it as a
 * successful impersonation because F had legitimately written that row moments
 * earlier. A refusal must be read from the refusal, so a non-2xx now settles it
 * outright and the row comparison is exact rather than a heuristic.
 */
const writeProgress = async (jwt, uid, lessonId) => {
  const before = await snap(uid, lessonId)
  const r = await fetch(`${SB}/rest/v1/lesson_progress?on_conflict=user_id,lesson_id`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json',
               Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ user_id: uid, lesson_id: lessonId, is_completed: true,
                           completed_at: new Date().toISOString() }) })
  const t = await r.text(); let j = null
  try { j = JSON.parse(t) } catch { /* */ }
  const after = await snap(uid, lessonId)

  const landed = r.status < 300 && (
    (!before && !!after) ||
    (!!before && !!after && (before.is_completed  !== after.is_completed ||
                             before.completed_at  !== after.completed_at))
  )

  return {
    status:  r.status,
    landed,
    rows:    after ? 1 : 0,
    code:    j?.code ?? '',
    message: (j?.message ?? '').slice(0, 60),
  }
}

console.log('\n═══ XPA-8 B-2.6 — COMPLETION AUTHORITY ═════════════════════════')

let migrationApplied = null

try {
  // ── Targets ─────────────────────────────────────────────────────────────
  const courses   = await rest('courses?select=id,code,slug,is_published&order=code')
  const target    = courses.rows.find(c => c.code === 'C1-F1')
  const foreign   = courses.rows.find(c => c.code === 'C2-F1')
  const withdrawn = courses.rows.find(c => c.is_published === false)
  if (!target || !foreign || !withdrawn) {
    console.error('Expected C1-F1, C2-F1 and one withdrawn course.'); process.exit(1)
  }

  const lessonOf = async (courseId) => {
    const mods = await rest(`modules?select=id&course_id=eq.${courseId}`)
    const ids  = mods.rows.map(m => m.id).join(',')
    const les  = await rest(`lessons?select=id,title&module_id=in.(${ids})&limit=1`)
    return les.rows[0]
  }
  const lTarget    = await lessonOf(target.id)
  const lForeign   = await lessonOf(foreign.id)
  const lWithdrawn = await lessonOf(withdrawn.id)

  console.log('\n── Targets ─────────────────────────────────────────────────────')
  info('entitled course',   `${target.code}  lesson ${lTarget.id.slice(0, 8)}`)
  info('foreign course',    `${foreign.code}  lesson ${lForeign.id.slice(0, 8)}`)
  info('withdrawn course',  `${withdrawn.code ?? withdrawn.slug}  lesson ${lWithdrawn.id.slice(0, 8)}`)

  // ── Fixtures ────────────────────────────────────────────────────────────
  console.log('\n── Fixtures A–F ────────────────────────────────────────────────')
  for (const k of ['A', 'B', 'C', 'D', 'E', 'F']) await mkUser(k)

  await grant(users.A.id, target.id); await enrol(users.A.id, target.id)
  await grant(users.B.id, target.id)
  await enrol(users.C.id, target.id)
  await grant(users.D.id, target.id, { expires_at: '2020-01-01T00:00:00Z' })
  const eEnt = await grant(users.E.id, target.id)

  // Revoking requires revoked_at: migration 037 carries
  // CHECK ((status='REVOKED') = (revoked_at is not null)). Assert the PATCH
  // actually landed — a silently rejected revoke would make E a false pass.
  const rev = await rest(`entitlements?id=eq.${eEnt.id}`, {
    method: 'PATCH', prefer: 'return=representation',
    body: JSON.stringify({ status: 'REVOKED', revoked_at: new Date().toISOString() }) })
  rec('E is genuinely REVOKED (the PATCH landed)',
    `${rev.status} status=${rev.rows[0]?.status ?? '—'}`, rev.rows[0]?.status === 'REVOKED')

  info('A', 'entitlement + enrollment'); info('B', 'entitlement, no enrollment')
  info('C', 'enrollment only');          info('D', 'expired entitlement')
  info('E', 'revoked entitlement');      info('F', 'neither')

  // ── 1. The access seam classifies them correctly ────────────────────────
  console.log('\n── 1. has_course_access() — the ACCESS authority ───────────────')
  const EXPECT = { A: true, B: true, C: false, D: false, E: false, F: false }
  const actual = {}
  for (const k of Object.keys(EXPECT)) {
    actual[k] = await access(users[k].jwt, target.id)
    rec(`${k} — has_course_access`, String(actual[k]), actual[k] === EXPECT[k])
  }
  rec('enrollment alone does NOT grant access (Q-L)', `C=${actual.C}`, actual.C === false)

  // ── 2. The A–F matrix at the DATABASE boundary ──────────────────────────
  console.log('\n── 2. Direct API write — can each fixture record progress? ─────')
  const wrote = {}
  for (const k of Object.keys(EXPECT)) {
    const w = await writeProgress(users[k].jwt, users[k].id, lTarget.id)
    wrote[k] = w.landed
    const verdict = w.landed ? 'ROW WRITTEN' : `refused ${w.status} ${w.code}`
    const correct = w.landed === EXPECT[k]
    // An ENTITLED fixture that cannot write is a genuine regression — the fix
    // would have broken legitimate learners. An unentitled one that CAN write
    // is S-1, awaiting 044.
    if (EXPECT[k]) rec(`${k} → lesson_progress (entitled)`, verdict, correct)
    else           s1(`${k} → lesson_progress (NO access)`, verdict, correct)
  }

  // Behavioural detection: F holds nothing at all. If F's write lands, the
  // policy has no access arm and migration 044 is not applied.
  migrationApplied = wrote.F === false && wrote.C === false && wrote.D === false && wrote.E === false

  // ── 3. The write must not become detached from the seam ─────────────────
  console.log('\n── 3. The two must agree ───────────────────────────────────────')
  const disagreements = Object.keys(EXPECT).filter(k => actual[k] !== wrote[k])
  s1('access decision and write outcome agree for all six',
    disagreements.length === 0 ? 'A–F consistent' : `disagree: ${disagreements.join(', ')}`,
    disagreements.length === 0)

  // ── 4. Cross-course, withdrawn, impersonation ───────────────────────────
  console.log('\n── 4. Cross-course, withdrawn content, impersonation ───────────')

  const aForeign = await access(users.A.jwt, foreign.id)
  const xCourse  = await writeProgress(users.A.jwt, users.A.id, lForeign.id)
  s1('A cannot record progress in a course A does not hold',
    `has_access=${aForeign}  ${xCourse.landed ? 'ROW WRITTEN' : `refused ${xCourse.status}`}`,
    !xCourse.landed)

  const aWithdrawn = await access(users.A.jwt, withdrawn.id)
  const xWithdrawn = await writeProgress(users.A.jwt, users.A.id, lWithdrawn.id)
  s1('A cannot record progress in a withdrawn course A does not hold',
    `has_access=${aWithdrawn}  ${xWithdrawn.landed ? 'ROW WRITTEN' : `refused ${xWithdrawn.status}`}`,
    !xWithdrawn.landed)
  info('why it is refused', 'the ENTITLEMENT check, not a publication test — ' +
                            'publication controls discovery, never access')

  const imp = await writeProgress(users.A.jwt, users.F.id, lTarget.id)
  rec('A cannot write a row belonging to learner F', `${imp.status} ${imp.code}`, !imp.landed)

  // ── 5. Idempotency ──────────────────────────────────────────────────────
  console.log('\n── 5. Idempotency ──────────────────────────────────────────────')
  const countA = async () => (await rest(`lesson_progress?user_id=eq.${users.A.id}&select=id`)).rows.length
  const before = await countA()
  const firstRow = (await rest(
    `lesson_progress?user_id=eq.${users.A.id}&lesson_id=eq.${lTarget.id}&select=completed_at`)).rows[0]
  await writeProgress(users.A.jwt, users.A.id, lTarget.id)
  await writeProgress(users.A.jwt, users.A.id, lTarget.id)
  const after = await countA()
  rec('replaying a completion creates no duplicate', `${before} → ${after} rows`, before === after)
  rec('UNIQUE(user_id, lesson_id) is what enforces it',
    'schema constraint', before === after && before > 0)
  info('completed_at at first write', firstRow?.completed_at ?? '—')

  // ── 6. Retention — the record survives access ending ────────────────────
  console.log('\n── 6. The academic record is retained when access ends ─────────')
  // D's entitlement is expired, so D has no access. D must still be able to
  // READ progress: migration 044 gates writes only, and the platform promises
  // "votre progression … sont conservés".
  await rest('lesson_progress', { method: 'POST',
    body: JSON.stringify({ user_id: users.D.id, lesson_id: lTarget.id,
                           is_completed: true, completed_at: new Date().toISOString() }) })
  const dReads = await rest(`lesson_progress?user_id=eq.${users.D.id}&select=id,is_completed`,
    { key: ANON, jwt: users.D.jwt })
  rec('an EXPIRED learner can still read their own transcript',
    `${dReads.status}, ${dReads.rows.length} row(s)`, dReads.rows.length >= 1)
  const dOther = await rest(`lesson_progress?user_id=eq.${users.A.id}&select=id`,
    { key: ANON, jwt: users.D.jwt })
  rec('…but not somebody else\'s', `${dOther.rows.length} row(s)`, dOther.rows.length === 0)

  // ── 7. The application half is deployed ─────────────────────────────────
  console.log('\n── 7. The application half ─────────────────────────────────────')
  const blank  = m => m.replace(/[^\n]/g, ' ')
  const stripJs = s => s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank)
  const src = p => { try { return readFileSync(p, 'utf8') } catch { return '' } }

  const nav    = stripJs(src('components/lms/LessonNavigation.tsx'))
  const player = stripJs(src('app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'))
  const core   = stripJs(src('lib/learn/completion.ts'))

  rec('the PLATFORM_MODE gate on completion is gone', 'LessonNavigation', !/pilotMode/.test(nav))
  rec('the completion control follows identity', 'canComplete', /canComplete/.test(nav))
  rec('the browser no longer upserts lesson_progress',
    'player', !/lesson_progress'\)[\s\S]{0,120}?\.(upsert|insert|update)\(/.test(player))
  rec('completion goes through the server action', 'completeLesson', /completeLesson\(/.test(player))
  rec('the shared authority checks the entitlement seam',
    'resolveCourseAccessById', /resolveCourseAccessById\(/.test(core))
  rec('no completion writer consults the operating mode',
    'no PILOT_MODE / PLATFORM_MODE', !/PILOT_MODE|PLATFORM_MODE/.test(core))
  rec('no watch-time threshold was introduced',
    'honour-based, unchanged', !/watched_seconds|threshold|percentWatched/.test(core))

  // ── 8. Certificate input ────────────────────────────────────────────────
  console.log('\n── 8. What a certificate now attests ───────────────────────────')
  const mods = await rest(`modules?select=id&course_id=eq.${target.id}`)
  const all  = await rest(`lessons?select=id&module_id=in.(${mods.rows.map(m => m.id).join(',')})`)
  info(`${target.code} lessons`, String(all.rows.length))
  const quizzes = await rest(`quizzes?select=id&course_id=eq.${target.id}`)
  info('course-level final exam', quizzes.rows.length ? String(quizzes.rows.length) : '0 — B-2.3 owns this')
  info('certificate input', migrationApplied
    ? 'progress asserted by an ENTITLED learner'
    : 'progress asserted by ANY authenticated account (until 044)')
} finally {
  // ── Cleanup — ID-scoped, never global ───────────────────────────────────
  console.log('\n── Cleanup (ID-scoped) ─────────────────────────────────────────')
  const ids = created.users.filter(Boolean)
  if (ids.length) {
    const inList = ids.join(',')
    const d1 = await rest(`lesson_progress?user_id=in.(${inList})`, { method: 'DELETE' })
    const d2 = await rest(`enrollments?user_id=in.(${inList})`,     { method: 'DELETE' })
    const d3 = await rest(`entitlements?user_id=in.(${inList})`,    { method: 'DELETE' })
    console.log(`  progress ${d1.status}  enrollments ${d2.status}  entitlements ${d3.status}`)
    for (const u of ids) await fetch(`${SB}/auth/v1/admin/users/${u}`, { method: 'DELETE', headers: H })
    const sp = (await rest(`lesson_progress?user_id=in.(${inList})&select=id`)).rows.length
    const se = (await rest(`entitlements?user_id=in.(${inList})&select=id`)).rows.length
    console.log(`  strays — progress ${sp}, entitlements ${se}`)
  }

  // A real learner, asserted untouched. Never a global-empty assertion.
  const mar = (await rest('profiles?select=id&email=eq.mariemeify@gmail.com')).rows[0]
  if (mar) {
    const mp = (await rest(`lesson_progress?user_id=eq.${mar.id}&select=id`)).rows.length
    const me = (await rest(`entitlements?user_id=eq.${mar.id}&select=id`)).rows.length
    console.log(`  Marième untouched — progress ${mp}, entitlements ${me}`)
  }

  // ── Verdict ─────────────────────────────────────────────────────────────
  console.log('\n────────────────────────────────────────────────────────────────')
  if (openItems.length) {
    console.log(`\n  ⚠ S-1 IS STILL OPEN AT THE DATABASE BOUNDARY — ${openItems.length} finding(s):\n`)
    for (const o of openItems) console.log(`      ${o}`)
    console.log(`
  This is the EXPECTED state until an operator applies

      supabase/migrations/044_lesson_progress_access_boundary.sql

  The application half is deployed and closes the player path; these writes
  are the direct PostgREST path, which only a policy can refuse. Apply 044
  AFTER the B-2.6 build is live in production — never before, or learners on
  the previous build stop recording progress.
`)
  }

  const total = pass + fails.length + openItems.length
  if (fails.length === 0 && openItems.length === 0) {
    console.log(`✓ XPA-8 B-2.6 PASS — ${pass} checks, 0 failures. Both halves in place.\n`)
  } else {
    console.log(`✗ XPA-8 B-2.6 INCOMPLETE — ${pass} of ${total} checks passed.`)
    if (fails.length) {
      console.log(`  ${fails.length} genuine failure(s):`)
      for (const f of fails) console.log(`    ${f}`)
    }
    if (openItems.length) console.log(`  ${openItems.length} finding(s) awaiting migration 044.`)
    console.log('')
    process.exitCode = 1
  }
}
