#!/usr/bin/env node
/**
 * XPA-8 B-2.1 production verification — instructional completeness.
 *
 *   node scripts/security/verify-xpa-8-b21.mjs
 *
 * ── WHAT B-2.1 WAS ────────────────────────────────────────────────────────
 *
 * Twelve lessons had no instructional modality at all — no video, no body, no
 * resource, no voice, no quiz. Ten of them belonged to C2-F2, which was
 * withdrawn in B-2B. The remaining two, in C1-F3 and C2-F4, were retained by
 * product ruling and had to be authored.
 *
 * ── THE INVARIANT ─────────────────────────────────────────────────────────
 *
 *   No PUBLISHED course may contain a lesson with no instructional modality.
 *
 * Deliberately NOT `content IS NOT NULL`: the B-2A audit established that
 * `lessons.content` is optional supplemental text, unused by all 102 lessons
 * including the courses that work end to end. The standard is "an intentional
 * modality", which for this platform means video, a written body, a
 * downloadable resource, a published voice scenario, or a quiz.
 *
 * ── AND THE MEDIA MUST STILL BE PROTECTED ────────────────────────────────
 *
 * Completeness must not be bought by reintroducing public delivery, so this
 * verifier also proves the two new assets obey F-2: private object, no public
 * URL, entitlement-checked delivery, refusal for everyone else.
 */
import { readFileSync } from 'node:fs'
import { createServerClient } from '@supabase/ssr'

const env = {}
try {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* fall through */ }

const SB = env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SVC = env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
const SITE = process.env.SITE_URL ?? 'https://www.xpclient-academy.com'
if (!SB || !ANON || !SVC) { console.error('Missing Supabase configuration.'); process.exit(1) }

const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' }
const TARGETS = [
  { id: 'd59a1304-7d81-4bc3-aa97-ed0e2deffc22', label: 'C1-F3 M3L4' },
  { id: '0cb17453-71a5-4ed4-99e0-90d3f5baefe7', label: 'C2-F4 M4L1' },
]

let pass = 0
const fails = []
const rec = (l, d, ok) => { console.log(`  ${ok ? '✓' : '✗'} ${l.padEnd(56)} ${d}`); if (ok) pass++; else fails.push(`${l} — ${d}`) }
const info = (l, d) => console.log(`    · ${l.padEnd(54)} ${d}`)

const rest = async (p, o = {}) => {
  const key = o.key ?? SVC
  const r = await fetch(`${SB}/rest/v1/${p}`, {
    method: o.method ?? 'GET',
    headers: { apikey: key, Authorization: `Bearer ${o.jwt ?? key}`, 'Content-Type': 'application/json',
               Prefer: o.prefer ?? 'count=exact' },
    body: o.body })
  const t = await r.text(); let j = null
  try { j = JSON.parse(t) } catch { /* */ }
  return { status: r.status, rows: Array.isArray(j) ? j : (j ? [j] : []), raw: t }
}
const list = async (bucket, pfx) => {
  const out = []; let off = 0
  for (;;) {
    const r = await fetch(`${SB}/storage/v1/object/list/${bucket}`, {
      method: 'POST', headers: H, body: JSON.stringify({ prefix: pfx, limit: 1000, offset: off }) })
    const pg = await r.json()
    if (!Array.isArray(pg) || !pg.length) break
    for (const e of pg) if (e.id) out.push(`${pfx}/${e.name}`)
    if (pg.length < 1000) break
    off += pg.length
  }
  return out
}

const STAMP = String(process.hrtime.bigint()).slice(-9)
const PW = 'Vt6#qHn2!bZx8Wk4'
const E = k => `b21-verify-${k}-${STAMP}@xpclient-academy.com`
let inId = null, outId = null, enrId = null, entId = null, enrolId = null

const cookiesFor = async (email) => {
  const jar = new Map()
  const c = createServerClient(SB, ANON, {
    cookies: { get: n => jar.get(n), set: (n, v) => jar.set(n, v), remove: n => jar.delete(n) } })
  const { data } = await c.auth.signInWithPassword({ email, password: PW })
  return { cookie: [...jar.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '),
           jwt: data?.session?.access_token }
}

try {
  console.log('\nXPA-8 B-2.1 — instructional completeness, verified against production\n')

  // ══ 1. THE INVARIANT, across every published course ═══════════════════
  console.log('── 1. No published course contains a lesson with no modality ───')
  const courses = (await rest('courses?select=id,code,slug,is_published&order=code&limit=50')).rows
  const modules = (await rest('modules?select=id,course_id&limit=300')).rows
  const lessons = (await rest('lessons?select=*&limit=500')).rows
  const scenarios = (await rest('ai_scenarios?select=lesson_id,is_published&limit=200')).rows
  const quizzes = (await rest('quizzes?select=lesson_id&limit=200')).rows

  const hasModality = (l) =>
    Boolean(l.video_object_path || l.video_url || l.pdf_object_path || l.pdf_url ||
            (l.content && String(l.content).trim()) || l.subtitle_object_path || l.subtitle_url ||
            scenarios.some(s => s.lesson_id === l.id && s.is_published) ||
            quizzes.some(q => q.lesson_id === l.id))

  let totalPlaceholders = 0
  for (const c of courses.filter(x => x.is_published)) {
    const mids = modules.filter(m => m.course_id === c.id).map(m => m.id)
    const les = lessons.filter(l => mids.includes(l.module_id))
    const bad = les.filter(l => !hasModality(l))
    totalPlaceholders += bad.length
    rec(`${c.code} complete`, `${les.length - bad.length}/${les.length}` +
      (bad.length ? ` — placeholders: ${bad.map(b => `"${(b.title ?? '').slice(0, 30)}"`).join(', ')}` : ''),
      bad.length === 0)
  }
  rec('ZERO placeholders across published courses', `${totalPlaceholders}`, totalPlaceholders === 0)

  const withdrawn = courses.filter(c => !c.is_published)
  info('withdrawn courses (excluded by design)',
    withdrawn.map(c => c.code).join(', ') || 'none')

  // ══ 2. The two authored lessons ═══════════════════════════════════════
  console.log('\n── 2. The two retained lessons carry their intended media ──────')
  const priv = new Set(await list('course-content', 'video'))
  for (const t of TARGETS) {
    const l = lessons.find(x => x.id === t.id)
    rec(`${t.label} exists`, l ? `"${l.title.slice(0, 38)}"` : 'MISSING', Boolean(l))
    rec(`${t.label} video_object_path populated`, l?.video_object_path ?? 'NULL', Boolean(l?.video_object_path))
    rec(`${t.label} private object exists`, priv.has(l?.video_object_path) ? 'present' : 'MISSING',
      priv.has(l?.video_object_path))
    rec(`${t.label} has NO public video_url`, l?.video_url ?? 'null', l?.video_url === null)
    t.path = l?.video_object_path
    t.title = l?.title
  }

  // ══ 3. Fixtures ═══════════════════════════════════════════════════════
  console.log('\n── 3. Fixtures ─────────────────────────────────────────────────')
  const mk = async (e) => (await (await fetch(`${SB}/auth/v1/admin/users`, {
    method: 'POST', headers: H, body: JSON.stringify({ email: e, password: PW, email_confirm: true }) })).json()).id
  inId = await mk(E('ent')); outId = await mk(E('out')); enrId = await mk(E('enr'))
  const A = await cookiesFor(E('ent')), B = await cookiesFor(E('out')), C = await cookiesFor(E('enr'))

  // Entitle the learner to BOTH courses that own the two lessons.
  const courseOf = (lessonId) => {
    const l = lessons.find(x => x.id === lessonId)
    const m = modules.find(x => x.id === l.module_id)
    return m.course_id
  }
  const courseIds = [...new Set(TARGETS.map(t => courseOf(t.id)))]
  const entIds = []
  for (const cid of courseIds) {
    const e = await rest('entitlements', { method: 'POST', prefer: 'return=representation',
      body: JSON.stringify({ user_id: inId, course_id: cid, source: 'MANUAL_ADMIN', status: 'ACTIVE' }) })
    if (e.rows[0]?.id) entIds.push(e.rows[0].id)
  }
  entId = entIds[0]
  const enrol = await rest('enrollments', { method: 'POST', prefer: 'return=representation',
    body: JSON.stringify({ user_id: enrId, course_id: courseIds[0] }) })
  enrolId = enrol.rows[0]?.id ?? null
  rec('entitled / unentitled / enrollment-only', `${entIds.length} entitlement(s)`, entIds.length === courseIds.length)

  // ══ 4. Delivery and refusal ═══════════════════════════════════════════
  console.log('\n── 4. Protected delivery and refusal ───────────────────────────')
  for (const t of TARGETS) {
    const ROUTE = `${SITE}/api/media/lesson/${t.id}/video`
    console.log(`\n  ${t.label} — "${(t.title ?? '').slice(0, 40)}"`)

    const r = await fetch(ROUTE, { redirect: 'manual', headers: { cookie: A.cookie } })
    const loc = r.headers.get('location') ?? ''
    rec('  entitled learner authorized', `${r.status}`, r.status === 302)
    rec('  redirects to a SIGNED PRIVATE object',
      loc.includes('/object/sign/course-content/') ? 'signed → course-content' : loc.slice(0, 56),
      loc.includes('/object/sign/course-content/') && loc.includes('token='))
    rec('  no public URL in the redirect', loc.includes('/object/public/') ? 'LEAK' : 'clean',
      !loc.includes('/object/public/'))

    if (loc) {
      const full = await fetch(loc)
      rec('  full media request succeeds',
        `${full.status} ${full.headers.get('content-type') ?? ''} ${Number(full.headers.get('content-length') ?? 0).toLocaleString()}`,
        full.status === 200 && (full.headers.get('content-type') ?? '').includes('video'))
      const rng = await fetch(loc, { headers: { Range: 'bytes=0-8191' } })
      rec('  Range request succeeds', `${rng.status} ${rng.headers.get('content-range') ?? ''}`, rng.status === 206)
    }
    const viaRoute = await fetch(ROUTE, { headers: { cookie: A.cookie, Range: 'bytes=0-4095' } })
    rec('  Range through the route', `${viaRoute.status}`, viaRoute.status === 206 || viaRoute.status === 200)

    rec('  anonymous denied', `${(await fetch(ROUTE, { redirect: 'manual' })).status}`,
      (await fetch(ROUTE, { redirect: 'manual' })).status === 401)
    rec('  authenticated unentitled denied',
      `${(await fetch(ROUTE, { redirect: 'manual', headers: { cookie: B.cookie } })).status}`,
      (await fetch(ROUTE, { redirect: 'manual', headers: { cookie: B.cookie } })).status === 403)

    // Historical public URL must not serve the new asset.
    const hist = await fetch(`${SB}/storage/v1/object/public/course-media/${encodeURI(t.path)}`)
    rec('  no public historical URL serves it', `${hist.status}`, hist.status !== 200)
  }

  // enrollment-only, on the course that has the enrollment fixture
  console.log('')
  const enrTarget = TARGETS.find(t => courseOf(t.id) === courseIds[0])
  const enrRoute = `${SITE}/api/media/lesson/${enrTarget.id}/video`
  rec('enrollment-only learner denied',
    `${(await fetch(enrRoute, { redirect: 'manual', headers: { cookie: C.cookie } })).status}`,
    (await fetch(enrRoute, { redirect: 'manual', headers: { cookie: C.cookie } })).status === 403)

  // ══ 5. Expiry and revocation ══════════════════════════════════════════
  console.log('\n── 5. Expiry and revocation, per request ───────────────────────')
  const hit = async (t) => (await fetch(`${SITE}/api/media/lesson/${t.id}/video`,
    { redirect: 'manual', headers: { cookie: A.cookie } })).status
  const setAll = async (body) => {
    for (const id of entIds) await rest(`entitlements?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(body) })
  }
  await setAll({ expires_at: '2020-01-01T00:00:00Z' })
  rec('EXPIRED entitlement denied', `${await hit(TARGETS[0])} / ${await hit(TARGETS[1])}`,
    (await hit(TARGETS[0])) === 403 && (await hit(TARGETS[1])) === 403)
  await setAll({ expires_at: null })
  rec('restored → authorized again', `${await hit(TARGETS[0])} / ${await hit(TARGETS[1])}`,
    (await hit(TARGETS[0])) === 302 && (await hit(TARGETS[1])) === 302)
  await setAll({ status: 'REVOKED', revoked_at: new Date().toISOString() })
  rec('REVOKED entitlement denied', `${await hit(TARGETS[0])} / ${await hit(TARGETS[1])}`,
    (await hit(TARGETS[0])) === 403 && (await hit(TARGETS[1])) === 403)
  await setAll({ status: 'ACTIVE', revoked_at: null })
  rec('restored again → authorized', `${await hit(TARGETS[0])} / ${await hit(TARGETS[1])}`,
    (await hit(TARGETS[0])) === 302 && (await hit(TARGETS[1])) === 302)

  // ══ 6. Completion through the existing mechanism ══════════════════════
  console.log('\n── 6. Completion via the existing mechanism ────────────────────')
  // The learner client upserts lesson_progress on video end. Exercise that same
  // write with the learner's own session — no completion code is modified.
  for (const t of TARGETS) {
    const up = await fetch(`${SB}/rest/v1/lesson_progress?on_conflict=user_id,lesson_id`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${A.jwt}`, 'Content-Type': 'application/json',
                 Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ user_id: inId, lesson_id: t.id, is_completed: true,
                             completed_at: new Date().toISOString() }) })
    const body = await up.json()
    rec(`${t.label} completion recordable by the learner`,
      `${up.status} ${Array.isArray(body) && body[0]?.is_completed ? 'is_completed=true' : JSON.stringify(body).slice(0, 60)}`,
      up.status < 300 && Array.isArray(body) && body[0]?.is_completed === true)
  }
  const prog = await rest(`lesson_progress?select=lesson_id&user_id=eq.${inId}&is_completed=eq.true`)
  rec('both completions persisted', `${prog.rows.length} row(s)`, prog.rows.length === 2)
} finally {
  console.log('\n── Cleanup (fixture-scoped) ────────────────────────────────────')
  const ids = [inId, outId, enrId].filter(Boolean)
  if (ids.length) await rest(`lesson_progress?user_id=in.(${ids.join(',')})`, { method: 'DELETE' })
  if (enrolId) await rest(`enrollments?id=eq.${enrolId}`, { method: 'DELETE' })
  if (inId) await rest(`entitlements?user_id=eq.${inId}`, { method: 'DELETE' })
  for (const id of ids) await fetch(`${SB}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: H })
  const strayE = ids.length ? (await rest(`entitlements?user_id=in.(${ids.join(',')})&select=id`)).rows.length : 0
  const strayP = ids.length ? (await rest(`lesson_progress?user_id=in.(${ids.join(',')})&select=id`)).rows.length : 0
  console.log(`  strays — entitlements ${strayE}, progress ${strayP}`)

  console.log('\n────────────────────────────────────────────────────────────────')
  if (fails.length === 0) console.log(`✓ XPA-8 B-2.1 PASS — ${pass} checks, 0 failures.\n`)
  else {
    console.log(`✗ XPA-8 B-2.1 FAIL — ${fails.length} of ${pass + fails.length} checks failed:`)
    for (const f of fails) console.log(`    ${f}`)
    console.log('')
    process.exitCode = 1
  }
}
