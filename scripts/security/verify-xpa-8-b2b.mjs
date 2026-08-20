#!/usr/bin/env node
/**
 * XPA-8 B-2B production verification — publication safety.
 *
 *   node scripts/security/verify-xpa-8-b2b.mjs
 *
 * ── WHAT IT PROVES ────────────────────────────────────────────────────────
 *
 * That withdrawing a course actually withdraws it, and that withdrawing it does
 * NOT confiscate what an entitled learner already holds. Those are two separate
 * claims and the platform ratified both:
 *
 *     publication controls DISCOVERY, never ACCESS      (migrations 035, 037)
 *
 * ── WHY IT CHECKS THE CATALOGUE PAYLOAD AND NOT JUST THE DATABASE ─────────
 *
 * The database told the truth immediately; the shop window did not. `/courses`
 * was prerendered at build time with no revalidation, so after C2-F2 was
 * unpublished the detail route began returning 404 while the listing kept
 * shipping the course as `"available": true`. Checking `courses.is_published`
 * would have reported success. Only fetching the page caught it.
 *
 * Fixtures: one entitled learner and one outsider, removed by id.
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

const WITHDRAWN = 'mesurer-l-experience-client'
const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' }

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

const STAMP = String(process.hrtime.bigint()).slice(-9)
const PW = 'Nq5#bWt8!jEs2Hv7'
const E = k => `b2b-verify-${k}-${STAMP}@xpclient-academy.com`
let inId = null, outId = null, entId = null

const cookiesFor = async (email) => {
  const jar = new Map()
  const c = createServerClient(SB, ANON, {
    cookies: { get: n => jar.get(n), set: (n, v) => jar.set(n, v), remove: n => jar.delete(n) } })
  const { data } = await c.auth.signInWithPassword({ email, password: PW })
  return { cookie: [...jar.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '),
           jwt: data?.session?.access_token }
}

try {
  console.log(`\nXPA-8 B-2B — publication safety, verified against ${SITE}\n`)

  const course = (await rest(`courses?select=id,slug,title,is_published&slug=eq.${WITHDRAWN}`)).rows[0]
  if (!course) { console.error(`✗ course ${WITHDRAWN} not found`); process.exitCode = 1 }
  const mods = (await rest(`modules?select=id,slug&course_id=eq.${course.id}`)).rows
  const les = (await rest(`lessons?select=id,slug,module_id,video_object_path&module_id=in.(${mods.map(m => m.id).join(',')})&order=order_index`)).rows
  const withMedia = les.filter(l => l.video_object_path)

  console.log('── 1. The course is withdrawn ──────────────────────────────────')
  rec('is_published is false', String(course.is_published), course.is_published === false)
  const others = (await rest('courses?select=slug&is_published=eq.true&limit=50')).rows
  rec('every other course is still published', `${others.length} of 5`, others.length === 5)
  rec('no other course was withdrawn', others.some(c => c.slug === WITHDRAWN) ? 'LEAKED' : 'correct',
    !others.some(c => c.slug === WITHDRAWN))

  console.log('\n── 2. Discovery surfaces no longer offer it ────────────────────')
  const anonRow = await rest(`courses?select=id&slug=eq.${WITHDRAWN}`, { key: ANON })
  rec('anon cannot read the course row', `${anonRow.rows.length} row(s)`, anonRow.rows.length === 0)
  const pcl = await rest(`public_course_lessons?select=id&course_id=eq.${course.id}&limit=50`, { key: ANON })
  const pcm = await rest(`public_course_modules?select=id&course_id=eq.${course.id}&limit=50`, { key: ANON })
  rec('public_course_lessons drops it', `${pcl.rows.length} row(s)`, pcl.rows.length === 0)
  rec('public_course_modules drops it', `${pcm.rows.length} row(s)`, pcm.rows.length === 0)

  const detail = await fetch(`${SITE}/courses/${WITHDRAWN}`, { redirect: 'manual' })
  rec('the course detail page is gone', `${detail.status}`, detail.status === 404)

  // THE CHECK THAT CAUGHT THE DEFECT — the page, not the database.
  //
  // Match the BARE SLUG, not a JSON fragment. The first version of this check
  // looked for `"slug":"mesurer-…"` and passed, because the RSC payload escapes
  // its quotes (`\"slug\":\"mesurer-…\"`). It reported the catalogue clean while
  // the catalogue was still shipping the course. A check that can only fail
  // when a string is quoted the way you imagined is not a check.
  const cat = await fetch(`${SITE}/courses`, { redirect: 'manual' })
  const catHtml = cat.status === 200 ? await cat.text() : ''
  const advertised = catHtml.includes(WITHDRAWN)
  rec('the catalogue page no longer ships it',
    advertised ? `STILL ADVERTISED (age=${cat.headers.get('age') ?? '?'}s, cache=${cat.headers.get('x-vercel-cache') ?? '?'})`
               : 'absent from the payload',
    !advertised)
  if (advertised) {
    console.log('      the listing is serving a build-time snapshot; a withdrawn course')
    console.log('      is still being offered and will 404 on click.')
  }
  for (const p of ['/', '/parcours', '/secteurs']) {
    const r = await fetch(SITE + p, { redirect: 'manual' })
    const h = r.status === 200 ? await r.text() : ''
    rec(`${p} does not link to it`, h.includes(`/courses/${WITHDRAWN}`) ? 'LINKED' : 'clean',
      !h.includes(`/courses/${WITHDRAWN}`))
  }
  const sm = await fetch(`${SITE}/sitemap.xml`)
  const smx = sm.status === 200 ? await sm.text() : ''
  rec('the sitemap does not list it', smx.includes(WITHDRAWN) ? 'LISTED' : 'clean', !smx.includes(WITHDRAWN))

  console.log('\n── 3. Fixtures ─────────────────────────────────────────────────')
  const mk = async (e) => (await (await fetch(`${SB}/auth/v1/admin/users`, {
    method: 'POST', headers: H, body: JSON.stringify({ email: e, password: PW, email_confirm: true }) })).json()).id
  inId = await mk(E('ent')); outId = await mk(E('out'))
  const A = await cookiesFor(E('ent')), B = await cookiesFor(E('out'))
  entId = (await rest('entitlements', { method: 'POST', prefer: 'return=representation',
    body: JSON.stringify({ user_id: inId, course_id: course.id, source: 'MANUAL_ADMIN', status: 'ACTIVE' }) })).rows[0]?.id
  rec('entitled learner + outsider created', entId ? 'ok' : 'FAILED', Boolean(entId))

  console.log('\n── 4. Publication did NOT revoke access (the ratified contract) ─')
  const acc = await fetch(`${SB}/rest/v1/rpc/has_course_access`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${A.jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_course_id: course.id }) })
  const verdict = (await acc.text()).trim()
  rec('has_course_access() still true for the entitled learner', verdict, verdict === 'true')
  const outAcc = await fetch(`${SB}/rest/v1/rpc/has_course_access`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${B.jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_course_id: course.id }) })
  rec('and still false for someone without an entitlement', (await outAcc.text()).trim(),
    (await (await fetch(`${SB}/rest/v1/rpc/has_course_access`, {
      method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${B.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_course_id: course.id }) })).text()).trim() === 'false')

  console.log('\n── 5. What the entitled learner can actually reach ─────────────')
  const c = await rest(`courses?select=id&slug=eq.${WITHDRAWN}`, { key: ANON, jwt: A.jwt })
  const m = await rest(`modules?select=id&course_id=eq.${course.id}&limit=50`, { key: ANON, jwt: A.jwt })
  const l = await rest(`lessons?select=id&module_id=in.(${mods.map(x => x.id).join(',')})&limit=50`, { key: ANON, jwt: A.jwt })
  info('entitled learner sees courses / modules / lessons', `${c.rows.length} / ${m.rows.length} / ${l.rows.length}`)
  rec('the COURSE ROW is hidden by publication RLS', `${c.rows.length} row(s)`, c.rows.length === 0)
  info('note', 'courses_public_select (001) still carries an is_published arm,')
  info('', 'while modules/lessons (036) are entitlement-based. The learn page')
  info('', 'queries courses first, so it dead-ends on "Leçon introuvable".')

  console.log('\n── 6. Media delivery is unchanged by publication ───────────────')
  if (withMedia[0]) {
    const r1 = await fetch(`${SITE}/api/media/lesson/${withMedia[0].id}/video`, { redirect: 'manual', headers: { cookie: A.cookie } })
    rec('entitled learner still streams (contract: access ≠ discovery)', `${r1.status}`, r1.status === 302)
    const r2 = await fetch(`${SITE}/api/media/lesson/${withMedia[0].id}/video`, { redirect: 'manual', headers: { cookie: B.cookie } })
    rec('outsider is still refused', `${r2.status}`, r2.status === 403)
    const r3 = await fetch(`${SITE}/api/media/lesson/${withMedia[0].id}/video`, { redirect: 'manual' })
    rec('anonymous is still refused', `${r3.status}`, r3.status === 401)
  }

  console.log('\n── 7. Nothing was destroyed ────────────────────────────────────')
  // The invariant is PRESERVATION, not stasis:
  //
  //     current preserved content >= withdrawal baseline
  //
  // These three were written as exact equality against the counts C2-F2 had
  // when the withdrawal contract was established. That reads as "nothing was
  // destroyed" only for as long as nothing is legitimately ADDED either. On
  // 17 August 2026 a module, a lesson and ten media references were added to
  // the withdrawn course, and all three assertions failed while the thing they
  // exist to detect -- destruction -- had not happened.
  //
  // The baselines stay EXPLICIT and stay at their withdrawal-era values. They
  // are deliberately NOT re-pinned to whatever production holds today: that
  // would make the check self-fulfilling and blind to a later deletion. A
  // destructive regression still fails, because 3 >= 4 is false.
  //
  // Note the two assertions immediately below already use `>= 1` for
  // entitlements and enrollments. Minimum-preservation was always this file's
  // idiom; these three were the outliers.
  //
  // Same lesson XPA-1 learned when its "exactly 27 migrations" assertion broke
  // on every legitimate later migration: pin the invariant, not the snapshot.
  const BASELINE = { modules: 4, lessons: 20, media: 10 } // C2-F2 at withdrawal
  rec('modules preserved', `${mods.length} >= ${BASELINE.modules}`,
    mods.length >= BASELINE.modules)
  rec('lessons preserved', `${les.length} >= ${BASELINE.lessons}`,
    les.length >= BASELINE.lessons)
  rec('media references preserved', `${withMedia.length} >= ${BASELINE.media}`,
    withMedia.length >= BASELINE.media)
  const realEnts = (await rest(`entitlements?select=id,user_id&course_id=eq.${course.id}`)).rows
    .filter(e => e.user_id !== inId)
  const realEnrs = (await rest(`enrollments?select=id&course_id=eq.${course.id}`)).rows
  rec('pre-existing entitlements preserved', `${realEnts.length}`, realEnts.length >= 1)
  rec('pre-existing enrollments preserved', `${realEnrs.length}`, realEnrs.length >= 1)

  console.log('\n── 8. Administration still owns it ─────────────────────────────')
  const adminRow = await rest(`courses?select=id,is_published&slug=eq.${WITHDRAWN}`)
  rec('the row remains for administrators', `${adminRow.rows.length}`, adminRow.rows.length === 1)
  const grantable = (await rest('courses?select=id&is_published=eq.true&limit=50')).rows
  rec('it can no longer be granted as a new entitlement', `${grantable.length} grantable of 6`,
    grantable.length === 5)
} finally {
  console.log('\n── Cleanup ─────────────────────────────────────────────────────')
  if (entId) await rest(`entitlements?id=eq.${entId}`, { method: 'DELETE' })
  for (const id of [inId, outId]) if (id) await fetch(`${SB}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: H })
  const ids = [inId, outId].filter(Boolean).join(',')
  const stray = ids ? (await rest(`entitlements?user_id=in.(${ids})&select=id`)).rows.length : 0
  console.log(`  strays — entitlements ${stray}`)

  console.log('\n────────────────────────────────────────────────────────────────')
  if (fails.length === 0) console.log(`✓ XPA-8 B-2B PASS — ${pass} checks, 0 failures.\n`)
  else {
    console.log(`✗ XPA-8 B-2B FAIL — ${fails.length} of ${pass + fails.length} checks failed:`)
    for (const f of fails) console.log(`    ${f}`)
    console.log('')
    process.exitCode = 1
  }
}
