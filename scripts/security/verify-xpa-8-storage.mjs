#!/usr/bin/env node
/**
 * XPA-8 W3 production verification — protected storage delivery (F-2).
 *
 *   node scripts/security/verify-xpa-8-storage.mjs
 *
 * ── WHAT THIS SCRIPT REFUSES TO DO ────────────────────────────────────────
 *
 * It does not read bucket metadata and call that a security check. `public =
 * false` in a table is a claim; an HTTP request is a measurement. Every verdict
 * below comes from actually asking Storage for bytes, over the same routes an
 * attacker would use:
 *
 *   /storage/v1/object/public/<bucket>/<path>   the public route
 *   /storage/v1/object/<bucket>/<path>          the RLS route
 *   /storage/v1/object/list/<bucket>            enumeration
 *   /storage/v1/object/sign/<bucket>/<path>     the signed route
 *
 * ── IT RUNS BEFORE AND AFTER REMEDIATION ──────────────────────────────────
 *
 * Run against an unremediated project it reports the exposure as failures and
 * says so plainly. Run after, the same checks pass. Same script, so the two
 * runs are comparable and nobody has to trust that "the old one was equivalent".
 *
 * ── FIXTURES ──────────────────────────────────────────────────────────────
 *
 * Synthetic throughout: two learners, one entitlement, one lesson-shaped
 * object, one certificate-shaped object. Everything is removed by id in the
 * finally block. Nothing is ever asserted to be globally empty — other work is
 * legitimately in flight on this project.
 *
 * The one thing it does NOT create is a course: it borrows a real published
 * course so that `has_course_access()` is exercised against real data. It
 * writes nothing to that course.
 */
import { readFileSync } from 'node:fs'

const env = {}
try {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* fall through to process.env */ }

const SB = env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SVC = env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SB || !ANON || !SVC) { console.error('Missing Supabase configuration.'); process.exit(1) }

const PROTECTED = 'course-content'
const PUBLIC_B = 'course-media'
const CERTS = 'certificates'

const svcH = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' }

let pass = 0
const failures = []
const record = (label, detail, ok) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(56)} ${detail}`)
  if (ok) pass++; else failures.push(`${label} — ${detail}`)
}
const info = (label, detail) => console.log(`    · ${label.padEnd(54)} ${detail}`)

const rest = async (p, o = {}) => {
  const r = await fetch(`${SB}/rest/v1/${p}`, {
    method: o.method ?? 'GET',
    headers: { ...svcH, Prefer: o.prefer ?? 'count=exact' },
    body: o.body,
  })
  const t = await r.text(); let j = null
  try { j = JSON.parse(t) } catch { /* */ }
  return { status: r.status, rows: Array.isArray(j) ? j : (j ? [j] : []), raw: t }
}
const adminAuth = (p, m, b) => fetch(`${SB}/auth/v1${p}`, {
  method: m, headers: svcH, body: b ? JSON.stringify(b) : undefined,
})
const signIn = async (email, password) => {
  const r = await fetch(`${SB}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return (await r.json()).access_token ?? null
}

/** GET an object over the PUBLIC route, with no credentials whatsoever. */
const getPublic = (bucket, path) =>
  fetch(`${SB}/storage/v1/object/public/${bucket}/${encodeURI(path)}`)
/** GET an object over the RLS route as some caller. */
const getRls = (bucket, path, jwt) =>
  fetch(`${SB}/storage/v1/object/${bucket}/${encodeURI(path)}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${jwt ?? ANON}` },
  })
/** Try to enumerate a bucket as some caller. */
const listAs = async (bucket, prefix, jwt) => {
  const r = await fetch(`${SB}/storage/v1/object/list/${bucket}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${jwt ?? ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix, limit: 1000 }),
  })
  const b = await r.json()
  return { status: r.status, files: Array.isArray(b) ? b.filter(o => o.id) : [] }
}

const PW = 'Hn6#tBk2!wYc9Fs4'
const STAMP = String(process.hrtime.bigint()).slice(-9)
const LEARNER_IN = `xpa8w3-entitled-${STAMP}@xpclient-academy.com`
const LEARNER_OUT = `xpa8w3-outsider-${STAMP}@xpclient-academy.com`

let inId = null, outId = null, entId = null, enrolId = null
let probeObj = null, certObj = null, certRow = null

try {
  console.log('\nXPA-8 W3 — protected storage delivery, verified against production')
  console.log(`Fixture stamp: ${STAMP}`)

  // ── 0. Which world are we in? ───────────────────────────────────────────
  console.log('\n── 0. Bucket inventory ─────────────────────────────────────────')
  const buckets = await (await fetch(`${SB}/storage/v1/bucket`, { headers: svcH })).json()
  for (const b of buckets) info(b.name, `public=${b.public}`)
  const protectedBucket = buckets.find(b => b.id === PROTECTED)
  const REMEDIATED = Boolean(protectedBucket && protectedBucket.public === false)

  if (!REMEDIATED) {
    console.log('\n  ⚠ MIGRATION 041 IS NOT APPLIED — this is a PRE-REMEDIATION run.')
    console.log('    The checks below record the exposure as it stands today.')
  }

  record('a private bucket for protected media exists',
    protectedBucket ? `public=${protectedBucket.public}` : 'course-content MISSING',
    Boolean(protectedBucket) && protectedBucket.public === false)

  const certBucket = buckets.find(b => b.id === CERTS)
  record('the certificates bucket is private',
    certBucket ? `public=${certBucket.public}` : 'MISSING',
    Boolean(certBucket) && certBucket.public === false)

  // ── 1. Fixtures ─────────────────────────────────────────────────────────
  console.log('\n── 1. Fixtures ─────────────────────────────────────────────────')
  const course = (await rest('courses?select=id,slug,title&is_published=eq.true&limit=1')).rows[0]
  info('borrowed published course', course.slug)

  inId = (await (await adminAuth('/admin/users', 'POST', { email: LEARNER_IN, password: PW, email_confirm: true })).json()).id
  outId = (await (await adminAuth('/admin/users', 'POST', { email: LEARNER_OUT, password: PW, email_confirm: true })).json()).id
  const jwtIn = await signIn(LEARNER_IN, PW)
  const jwtOut = await signIn(LEARNER_OUT, PW)
  record('two learners created and signed in', `${jwtIn ? 'in✓' : 'in✗'} ${jwtOut ? 'out✓' : 'out✗'}`,
    Boolean(jwtIn && jwtOut))

  // A lesson-shaped object in whichever bucket protected media lives in.
  const targetBucket = REMEDIATED ? PROTECTED : PUBLIC_B
  probeObj = `video/xpa8w3-probe-${STAMP}.mp4`
  const body = Buffer.from(`SYNTHETIC-PROTECTED-MEDIA-${STAMP}`)
  const up = await fetch(`${SB}/storage/v1/object/${targetBucket}/${probeObj}`, {
    method: 'POST',
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'video/mp4' },
    body,
  })
  record(`probe object uploaded to ${targetBucket}`, `${up.status}`, up.status < 300)

  // ── 2. Anonymous retrieval of protected media ───────────────────────────
  console.log('\n── 2. Anonymous callers ────────────────────────────────────────')
  const a1 = await getPublic(targetBucket, probeObj)
  record('anon GET /object/public/… is DENIED', `${a1.status}`, a1.status !== 200)

  const a2 = await getRls(targetBucket, probeObj, null)
  record('anon GET /object/… (RLS route) is DENIED', `${a2.status}`, a2.status !== 200)

  const a3 = await listAs(targetBucket, 'video', null)
  record('anon cannot ENUMERATE protected media', `${a3.status} — ${a3.files.length} object(s) listed`,
    a3.files.length === 0)

  // Real production media, not just the probe.
  const realLesson = (await rest(
    'lessons?select=id,video_url,video_object_path&is_preview=eq.false&limit=200')).rows
  const withPath = realLesson.filter(l => l.video_object_path)
  const withUrl = realLesson.filter(l => l.video_url && !l.video_object_path)
  info('non-preview lessons with an object path', String(withPath.length))
  info('non-preview lessons still on a public URL', String(withUrl.length))

  if (withPath.length) {
    const p = withPath[0].video_object_path
    const r = await getPublic(PROTECTED, p)
    record('a REAL protected video is denied on the public route', `${r.status}`, r.status !== 200)
  }
  if (withUrl.length) {
    const r = await fetch(withUrl[0].video_url, { method: 'HEAD' })
    record('no non-preview lesson is still anonymously downloadable',
      `${r.status} ${r.headers.get('content-length') ?? ''} (${withUrl.length} lesson(s) on public URLs)`,
      r.status !== 200)
  }

  // ── 3. Authenticated but unentitled ─────────────────────────────────────
  console.log('\n── 3. Authenticated, no entitlement ────────────────────────────')
  const accOut = await fetch(`${SB}/rest/v1/rpc/has_course_access`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${jwtOut}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_course_id: course.id }),
  })
  info('has_course_access() for the outsider', (await accOut.text()).trim())
  const o1 = await getRls(targetBucket, probeObj, jwtOut)
  record('unentitled learner is DENIED on the RLS route', `${o1.status}`, o1.status !== 200)
  const o2 = await getPublic(targetBucket, probeObj)
  record('unentitled learner is DENIED on the public route', `${o2.status}`, o2.status !== 200)

  // ── 4. Enrollment alone grants nothing ──────────────────────────────────
  console.log('\n── 4. Enrollment alone ─────────────────────────────────────────')
  const enrol = await rest('enrollments', {
    method: 'POST', prefer: 'return=representation',
    body: JSON.stringify({ user_id: outId, course_id: course.id }),
  })
  enrolId = enrol.rows[0]?.id ?? null
  if (enrolId) {
    const accEnrolled = await fetch(`${SB}/rest/v1/rpc/has_course_access`, {
      method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${jwtOut}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_course_id: course.id }),
    })
    const verdict = (await accEnrolled.text()).trim()
    record('an enrollment does NOT grant course access', verdict, verdict === 'false')
    const e1 = await getRls(targetBucket, probeObj, jwtOut)
    record('an enrolled-but-unentitled learner is DENIED the file', `${e1.status}`, e1.status !== 200)
  } else {
    info('enrollment fixture skipped', enrol.raw.slice(0, 70))
  }

  // ── 5. A valid entitlement DOES deliver ─────────────────────────────────
  console.log('\n── 5. Valid entitlement ────────────────────────────────────────')
  const ent = await rest('entitlements', {
    method: 'POST', prefer: 'return=representation',
    body: JSON.stringify({ user_id: inId, course_id: course.id, source: 'MANUAL_ADMIN', status: 'ACTIVE' }),
  })
  entId = ent.rows[0]?.id ?? null
  const accIn = await fetch(`${SB}/rest/v1/rpc/has_course_access`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${jwtIn}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_course_id: course.id }),
  })
  const inVerdict = (await accIn.text()).trim()
  record('the entitled learner has course access', inVerdict, inVerdict === 'true')

  // The supported delivery path: a server-minted signed URL.
  const sign = await fetch(`${SB}/storage/v1/object/sign/${targetBucket}/${probeObj}`, {
    method: 'POST', headers: svcH, body: JSON.stringify({ expiresIn: 300 }),
  })
  const signedUrl = sign.status === 200 ? `${SB}/storage/v1${(await sign.json()).signedURL}` : null
  record('a signed delivery URL can be minted server-side', `${sign.status}`, Boolean(signedUrl))

  if (signedUrl) {
    const got = await fetch(signedUrl)
    const txt = await got.text()
    record('the entitled learner RECEIVES the content', `${got.status} ${txt.includes(STAMP) ? 'bytes match' : 'MISMATCH'}`,
      got.status === 200 && txt.includes(STAMP))

    const rng = await fetch(signedUrl, { headers: { Range: 'bytes=0-9' } })
    record('range requests work (video seeking)', `${rng.status} ${rng.headers.get('content-range') ?? ''}`,
      rng.status === 206)

    // The token must not be a skeleton key.
    const other = `${SB}/storage/v1/object/sign/${targetBucket}/video/does-not-exist-${STAMP}.mp4?token=${new URL(signedUrl).searchParams.get('token')}`
    const sw = await fetch(other)
    record('a signed token is bound to ONE object path', `${sw.status}`, sw.status !== 200)
  }

  // ── 6. Revocation ───────────────────────────────────────────────────────
  console.log('\n── 6. Revocation and expiry ────────────────────────────────────')
  if (entId) {
    // ── EXPIRY ────────────────────────────────────────────────────────────
    // Backdate the window rather than deleting the row: an expired
    // entitlement still exists, and that is the case worth testing.
    const expPatch = await rest(`entitlements?id=eq.${entId}`, {
      method: 'PATCH', prefer: 'return=representation',
      body: JSON.stringify({ expires_at: '2020-01-01T00:00:00Z' }),
    })
    record('the expiry PATCH actually landed',
      `${expPatch.status} ${expPatch.rows[0]?.expires_at ?? expPatch.raw.slice(0, 60)}`,
      expPatch.status < 300 && Boolean(expPatch.rows[0]))
    const accExp = await fetch(`${SB}/rest/v1/rpc/has_course_access`, {
      method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${jwtIn}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_course_id: course.id }),
    })
    const ev = (await accExp.text()).trim()
    record('an EXPIRED entitlement grants nothing', ev, ev === 'false')

    // ── REVOCATION ────────────────────────────────────────────────────────
    // 037 line 138 enforces `(status = 'REVOKED') = (revoked_at is not null)`,
    // so status alone is a CHECK violation (23514). An earlier version of this
    // script set only the status, never looked at the response, and reported
    // "revocation does not work" — the PATCH had been refused and the row was
    // untouched. The write is now asserted to have LANDED before its effect is
    // believed.
    const revPatch = await rest(`entitlements?id=eq.${entId}`, {
      method: 'PATCH', prefer: 'return=representation',
      body: JSON.stringify({
        status: 'REVOKED', revoked_at: new Date().toISOString(), expires_at: null,
      }),
    })
    record('the revocation PATCH actually landed',
      `${revPatch.status} status=${revPatch.rows[0]?.status ?? '—'} ${revPatch.status >= 400 ? revPatch.raw.slice(0, 70) : ''}`,
      revPatch.status < 300 && revPatch.rows[0]?.status === 'REVOKED')

    const accRevoked = await fetch(`${SB}/rest/v1/rpc/has_course_access`, {
      method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${jwtIn}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_course_id: course.id }),
    })
    const rv = (await accRevoked.text()).trim()
    record('revocation removes course access immediately', rv, rv === 'false')
    info('note', 'delivery re-authorizes per request, so the next fetch is refused')
  }

  const shortSign = await fetch(`${SB}/storage/v1/object/sign/${targetBucket}/${probeObj}`, {
    method: 'POST', headers: svcH, body: JSON.stringify({ expiresIn: 3 }),
  })
  if (shortSign.status === 200) {
    const shortUrl = `${SB}/storage/v1${(await shortSign.json()).signedURL}`
    const now = await fetch(shortUrl)
    await new Promise(r => setTimeout(r, 5000))
    const later = await fetch(shortUrl)
    record('a delivery URL actually expires', `t=0 → ${now.status}, t=5s → ${later.status}`,
      now.status === 200 && later.status !== 200)
  }

  // ── 7. Certificates ─────────────────────────────────────────────────────
  console.log('\n── 7. Certificate ownership ────────────────────────────────────')
  const certBefore = await listAs(CERTS, '', null)
  info('certificates visible to anon before fixture', String(certBefore.files.length))

  certObj = `${inId}/xpa8w3-${STAMP}.pdf`
  const cUp = await fetch(`${SB}/storage/v1/object/${CERTS}/${certObj}`, {
    method: 'POST',
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/pdf' },
    body: Buffer.from(`%PDF-1.4\n% xpa8w3 ${STAMP}\n%%EOF\n`),
  })
  record('synthetic certificate uploaded for learner A', `${cUp.status}`, cUp.status < 300)

  const cAnon = await getPublic(CERTS, certObj)
  record("anon CANNOT download learner A's certificate", `${cAnon.status}`, cAnon.status !== 200)

  const cOther = await getRls(CERTS, certObj, jwtOut)
  record("learner B CANNOT download learner A's certificate", `${cOther.status}`, cOther.status !== 200)

  const cOwner = await getRls(CERTS, certObj, jwtIn)
  record('the OWNER can download their own certificate', `${cOwner.status}`, cOwner.status === 200)

  // Write access — the 018 hole.
  const victimPath = `${outId}/forged-${STAMP}.pdf`
  const beforeCount = (await listAs(CERTS, outId, null)).files.length
  const forge = await fetch(`${SB}/storage/v1/object/${CERTS}/${victimPath}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${jwtIn}`, 'Content-Type': 'application/pdf' },
    body: Buffer.from('%PDF-1.4\n%forged\n%%EOF\n'),
  })
  // Count with the service role — anon listing is not a reliable witness.
  const afterList = await fetch(`${SB}/storage/v1/object/list/${CERTS}`, {
    method: 'POST', headers: svcH, body: JSON.stringify({ prefix: outId, limit: 100 }),
  })
  const afterCount = (await afterList.json()).filter(o => o.id).length
  record("a learner CANNOT write into another learner's folder",
    `HTTP ${forge.status}, folder went ${beforeCount} → ${afterCount} object(s)`,
    forge.status >= 400 && afterCount === 0)
  if (afterCount > 0) {
    await fetch(`${SB}/storage/v1/object/${CERTS}`, {
      method: 'DELETE', headers: svcH, body: JSON.stringify({ prefixes: [victimPath] }),
    })
    console.log('      (forged object removed)')
  }

  // ── 8. Historical URLs ──────────────────────────────────────────────────
  console.log('\n── 8. Historical URLs ──────────────────────────────────────────')
  const leftovers = []
  for (const pfx of ['video', 'pdf', 'subtitle']) {
    const r = await fetch(`${SB}/storage/v1/object/list/${PUBLIC_B}`, {
      method: 'POST', headers: svcH, body: JSON.stringify({ prefix: pfx, limit: 1000 }),
    })
    for (const o of (await r.json()).filter(x => x.id)) leftovers.push(`${pfx}/${o.name}`)
  }
  record('no protected object remains in the PUBLIC bucket',
    `${leftovers.length} left in ${PUBLIC_B}`, leftovers.length === 0)

  if (leftovers.length) {
    const sample = leftovers[0]
    const still = await getPublic(PUBLIC_B, sample)
    record('a historical public URL no longer serves content',
      `${still.status} ${still.headers.get('content-length') ?? ''} (${sample})`, still.status !== 200)
  }

  const covers = await listAs(PUBLIC_B, 'cover', null)
  record('public marketing covers are STILL publicly readable',
    `${covers.files.length} cover(s) listed`, covers.files.length > 0)
} finally {
  console.log('\n── Cleanup (fixture-scoped, by id) ─────────────────────────────')
  if (entId) console.log(`  entitlement: ${(await rest(`entitlements?id=eq.${entId}`, { method: 'DELETE' })).status}`)
  if (enrolId) console.log(`  enrollment:  ${(await rest(`enrollments?id=eq.${enrolId}`, { method: 'DELETE' })).status}`)
  for (const [bucket, obj] of [['probe', probeObj], ['cert', certObj]]) {
    if (!obj) continue
    for (const b of [PROTECTED, PUBLIC_B, CERTS]) {
      await fetch(`${SB}/storage/v1/object/${b}`, {
        method: 'DELETE', headers: svcH, body: JSON.stringify({ prefixes: [obj] }),
      }).catch(() => {})
    }
    console.log(`  ${bucket} object removed: ${obj}`)
  }
  if (certRow) await rest(`certificates?id=eq.${certRow}`, { method: 'DELETE' })
  for (const [l, id] of [['entitled learner', inId], ['outsider', outId]]) {
    if (id) console.log(`  ${l}: ${(await adminAuth(`/admin/users/${id}`, 'DELETE')).status}`)
  }

  // Fixture-scoped stray check — never a global-empty assertion.
  const strayEnt = await rest(`entitlements?user_id=in.(${inId ?? '00000000-0000-0000-0000-000000000000'},${outId ?? '00000000-0000-0000-0000-000000000000'})&select=id`)
  const strayObjs = []
  for (const b of [PROTECTED, PUBLIC_B, CERTS]) {
    const r = await fetch(`${SB}/storage/v1/object/list/${b}`, {
      method: 'POST', headers: svcH, body: JSON.stringify({ prefix: '', limit: 1000, search: STAMP }),
    })
    const j = await r.json()
    if (Array.isArray(j)) for (const o of j) if (o.id && o.name.includes(STAMP)) strayObjs.push(`${b}/${o.name}`)
  }
  console.log(`  strays — entitlements: ${strayEnt.rows.length}, objects matching ${STAMP}: ${strayObjs.length}`)

  console.log('\n────────────────────────────────────────────────────────────────')
  if (failures.length === 0) {
    console.log(`✓ XPA-8 W3 STORAGE PASS — ${pass} checks, 0 failures.\n`)
  } else {
    console.log(`✗ XPA-8 W3 STORAGE FAIL — ${failures.length} of ${pass + failures.length} checks failed:`)
    for (const f of failures) console.log(`    ${f}`)
    console.log('')
    process.exitCode = 1
  }
}
