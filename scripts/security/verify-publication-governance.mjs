#!/usr/bin/env node
/**
 * F-5.2 publication governance verification.
 *
 *   node scripts/security/verify-publication-governance.mjs
 *
 * ── WHY THIS SCRIPT EXISTS ────────────────────────────────────────────────
 *
 * Publication state drifted four times. Each time it was repaired by a
 * migration, and each time the repair was discovered by accident — the fourth
 * only because an unrelated PDF audit happened to read the courses table.
 *
 * `__tests__/security/xpa-8-f5-publication-governance.test.ts` cannot catch it.
 * It imports `readFileSync` and nothing else: every one of its 28 assertions is
 * about migration and application SOURCE TEXT. It can be 28/28 green while
 * production says anything at all, and on 2026-09-05 it was.
 *
 * So the runtime half lives here, outside the database and outside vitest.
 *
 * ── WHAT IT PROVES ────────────────────────────────────────────────────────
 *
 *   installed    all three migration-053 recorders are attached to
 *                public.courses and still ENABLE ALWAYS — this is the ONLY
 *                thing that catches a live DISABLE TRIGGER, and it is reported
 *                as a FAILURE, never as a pending item
 *   approved     production publication state matches the approved manifest
 *   accounted    where it does NOT match, whether a DATABASE WITNESS explains
 *                the difference (ACCOUNTED), an application row exists without
 *                one (NO WITNESS — a governance failure), or nothing explains
 *                it at all (UNACCOUNTED — the F-5 shape)
 *   intact       content did not silently shrink
 *   contained    entitlement is still the access authority, the answer key is
 *                still ungranted, and preview status still buys nothing
 *
 * ── DRIFT IS NOT AUTOMATICALLY A FAILURE ──────────────────────────────────
 *
 * The owner publishes courses; that is the job. A verifier that goes red every
 * time she does, and stays red until someone edits a JSON file, would be muted
 * within a week — and a muted control is worse than no control, because it
 * looks like coverage. So publication drift is graded by whether the database
 * can EXPLAIN it:
 *
 *   drift + a course.publication_observed WITNESS   ->  ACCOUNTED  (notice)
 *   drift + only course.published/unpublished       ->  NO WITNESS (failure)
 *   drift + nothing at all                          ->  UNACCOUNTED (failure)
 *
 * The middle case matters. The application row is written by one code path
 * whose writer swallows its own failures; the witness is written by the
 * database on every path. Only the witness makes a record unskippable, so an
 * application row alone does not account for drift — it just tells you a human
 * was probably involved. Transitions are COUNTED from witnesses only, so a
 * normal Admin publish producing both rows is one transition, never two.
 *
 * Lesson growth is expected and never fails. Lesson SHRINKAGE does, because
 * teaching material should not evaporate. Preview flags are owner-managed
 * content configuration per the 2026-09-06 ruling and are informational only.
 *
 * ── READ-ONLY ─────────────────────────────────────────────────────────────
 *
 * Every request is a GET. No insert, no update, no delete, no mutating RPC, no
 * fixtures. It is safe to run against production at any time, including from a
 * schedule.
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

const MANIFEST_PATH = 'scripts/security/publication-manifest.json'
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))

let pass = 0
const fails = []
const notices = []

const rec = (l, d, ok) => {
  console.log(`  ${ok ? '✓' : '✗'} ${l.padEnd(52)} ${d}`)
  if (ok) pass++; else fails.push(`${l} — ${d}`)
}
const note = (l, d) => { console.log(`  · ${l.padEnd(52)} ${d}`); notices.push(`${l} — ${d}`) }
const info = (l, d) => console.log(`    · ${l.padEnd(50)} ${d}`)

const rest = async (p, key = SVC) => {
  const r = await fetch(`${SB}/rest/v1/${p}`, {
    method: 'GET',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  })
  const t = await r.text()
  let j = null
  try { j = JSON.parse(t) } catch { /* non-JSON */ }
  return { status: r.status, rows: Array.isArray(j) ? j : (j ? [j] : []), json: j, raw: t }
}

/**
 * Call the migration-053 probe.
 *
 * This is a POST because PostgREST exposes functions that way, but the function
 * is declared STABLE and reads pg_trigger only — it writes nothing. It is the
 * single exception to "every request is a GET", and it is a read in every sense
 * that matters.
 */
const probeInstalled = async () => {
  const r = await fetch(`${SB}/rest/v1/rpc/publication_governance_installed`, {
    method: 'POST',
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
  const t = await r.text()
  try { return { status: r.status, value: JSON.parse(t) } } catch { return { status: r.status, value: null } }
}

async function main () {
  console.log('\nF-5.2 — publication governance verification')
  console.log(`  manifest: ${MANIFEST_PATH} (approved ${manifest.approved_at} by ${manifest.approved_by})\n`)

  // ── 1. Is the accountability control actually installed? ────────────────
  //
  // First, because every other result below is only as trustworthy as this.
  console.log('  Recorders')
  const probe = await probeInstalled()
  if (probe.status === 404) {
    rec('migration 053 recorders installed', 'probe function absent — 053 NOT APPLIED', false)
  } else {
    rec('migration 053 recorders installed',
      probe.value === true ? 'all 3 present and ENABLE ALWAYS' : `probe returned ${JSON.stringify(probe.value)}`,
      probe.value === true)
  }

  // ── 2. Observed catalogue state ─────────────────────────────────────────
  console.log('\n  Catalogue')
  const courses = await rest('courses?select=id,code,slug,is_published,updated_at&order=slug')
  const mods    = await rest('modules?select=id,course_id')
  const lessons = await rest('lessons?select=id,module_id,is_preview')
  if (!Array.isArray(courses.json)) {
    rec('courses readable', `HTTP ${courses.status}`, false)
    return report()
  }
  const modCourse = Object.fromEntries(mods.rows.map(m => [m.id, m.course_id]))
  const observed = courses.rows.map(c => {
    const ls = lessons.rows.filter(l => modCourse[l.module_id] === c.id)
    return {
      slug: c.slug, code: c.code ?? null, id: c.id,
      is_published: c.is_published, updated_at: c.updated_at,
      lessons: ls.length, preview_lessons: ls.filter(l => l.is_preview).length,
    }
  })

  const approved = manifest.approved_state
  const bySlug   = Object.fromEntries(approved.map(c => [c.slug, c]))
  const obsSlugs = new Set(observed.map(c => c.slug))
  const appSlugs = new Set(approved.map(c => c.slug))

  rec('course set matches the manifest',
    `${observed.length} observed / ${approved.length} approved`,
    observed.length === approved.length &&
    [...appSlugs].every(s => obsSlugs.has(s)) && [...obsSlugs].every(s => appSlugs.has(s)))

  for (const s of [...obsSlugs].filter(x => !appSlugs.has(x))) note('course NOT in the manifest', s)
  for (const s of [...appSlugs].filter(x => !obsSlugs.has(x))) note('approved course MISSING in production', s)

  // ── 3. Publication drift, graded by whether the DATABASE WITNESS explains it
  //
  // TWO RECORD FAMILIES, DELIBERATELY DISTINCT. One normal Admin publication
  // produces up to TWO rows and they answer different questions:
  //
  //   course.publication_observed   the DATABASE WITNESS (migration 053).
  //                                 Proves the transition HAPPENED, on every
  //                                 write path. Cannot be skipped by a caller.
  //                                 Attribution is best-effort: actor_id is set
  //                                 ONLY from a JWT sub, never inferred from
  //                                 current_user or session_user.
  //   course.published /            the APPLICATION EVENT
  //   course.unpublished            (lib/admin/publication-audit.ts). Carries
  //                                 the human: which admin, which form, and
  //                                 whether the attempt succeeded or failed.
  //                                 Bound to one code path, and its writer
  //                                 swallows insert failures.
  //
  // They are NOT two transitions. Transitions are counted from WITNESSES only;
  // the application family is read for attribution and never for existence.
  // Getting this backwards would let a swallowed application write look like a
  // missing publication, or a pair of rows look like two publications.
  //
  // Consequences, both intended:
  //   * a missing APPLICATION row does not erase the witness — drift stays
  //     ACCOUNTED, and the unattributed pairing is reported as a notice;
  //   * a missing WITNESS is a governance failure EVEN IF an application row
  //     exists, because the recorder is what makes the record unskippable.
  console.log('\n  Publication state')
  const events = await rest(
    'audit_log?select=created_at,event_type,actor_type,actor_id,actor_email,method,metadata' +
    '&event_type=in.(course.publication_observed,course.published,course.unpublished)' +
    '&order=created_at.desc&limit=500')

  const WITNESS = 'course.publication_observed'
  const APP_EVENTS = ['course.published', 'course.unpublished']
  const witnessBy = {}
  const appBy = {}
  for (const e of events.rows) {
    const cid = e.metadata?.courseId
    if (!cid) continue
    if (e.event_type === WITNESS) (witnessBy[cid] ??= []).push(e)
    else if (APP_EVENTS.includes(e.event_type)) (appBy[cid] ??= []).push(e)
  }
  const nWitness = Object.values(witnessBy).reduce((n, a) => n + a.length, 0)
  const nApp     = Object.values(appBy).reduce((n, a) => n + a.length, 0)
  info('database witnesses on record', String(nWitness))
  info('application events on record', String(nApp))

  let drift = 0
  for (const o of observed) {
    const a = bySlug[o.slug]
    if (!a) continue
    if (o.is_published === a.is_published) {
      rec(`${(a.code ?? o.slug).padEnd(7)} is_published`, String(o.is_published), true)
      continue
    }
    drift++
    const w = witnessBy[o.id] ?? []
    const p = appBy[o.id] ?? []
    if (w.length > 0) {
      // The witness is what accounts for drift. The application row, if any,
      // only enriches the message with a human name.
      const latest = w[0]
      const who = p[0]?.actor_email ?? latest.actor_email ?? `${latest.actor_type} (unattributed)`
      note(`${(a.code ?? o.slug).padEnd(7)} DRIFT — ACCOUNTED`,
        `approved=${a.is_published} observed=${o.is_published}; witnessed ${latest.created_at} ` +
        `via ${latest.method ?? '?'} by ${who}` + (p.length === 0 ? ' [no application row — attribution unavailable]' : ''))
    } else if (p.length > 0) {
      // An application row with no witness. Either the recorders are not
      // installed, or something changed the row without firing them. Both are
      // governance failures: the unskippable half of the record is missing.
      rec(`${(a.code ?? o.slug).padEnd(7)} DRIFT — NO WITNESS`,
        `approved=${a.is_published} observed=${o.is_published}; an application event exists ` +
        `(${p[0].created_at}) but NO database witness — the recorder did not fire`, false)
    } else {
      rec(`${(a.code ?? o.slug).padEnd(7)} DRIFT — UNACCOUNTED`,
        `approved=${a.is_published} observed=${o.is_published}; NO audit record of any kind explains this`, false)
    }
  }
  if (drift === 0) info('publication drift', 'none — production matches the ruling')

  // ── 3b. Pairing between the two families ────────────────────────────────
  //
  // Reported, never failed. A witness with no application row has TWO honest
  // readings — an out-of-band write, or an Admin write whose application audit
  // was swallowed (the very defect the witness compensates for) — and this
  // script cannot tell them apart. Claiming it as an out-of-band detector would
  // be false, and a detector that cries wolf on its own known benign case stops
  // being read.
  const witnessOnly = Object.keys(witnessBy).filter(id => !(appBy[id]?.length))
  const appOnly     = Object.keys(appBy).filter(id => !(witnessBy[id]?.length))
  if (nWitness === 0 && nApp === 0) {
    info('record pairing', 'no publication records yet on either side')
  } else {
    info('courses with a witness but no application row', String(witnessOnly.length))
    info('courses with an application row but no witness', String(appOnly.length))
    for (const id of witnessOnly) {
      note('witness without attribution',
        `course ${id} — either an out-of-band write or a swallowed application audit; this script cannot distinguish them`)
    }
  }
  // ── 4. Content did not silently shrink ──────────────────────────────────
  console.log('\n  Content')
  for (const o of observed) {
    const a = bySlug[o.slug]
    if (!a) continue
    if (o.lessons < a.lessons) {
      rec(`${(a.code ?? o.slug).padEnd(7)} lessons`, `${o.lessons} < approved ${a.lessons} — SHRANK`, false)
    } else if (o.lessons > a.lessons) {
      note(`${(a.code ?? o.slug).padEnd(7)} lessons grew`, `${a.lessons} -> ${o.lessons} (owner authoring; expected)`)
    } else {
      rec(`${(a.code ?? o.slug).padEnd(7)} lessons`, String(o.lessons), true)
    }
    if (o.preview_lessons !== a.preview_lessons) {
      info(`${(a.code ?? o.slug)} preview flags`, `${a.preview_lessons} -> ${o.preview_lessons} (owner-managed; informational)`)
    }
  }

  // ── 5. The boundaries F-5.2 must not have moved ─────────────────────────
  //
  // A governance release that quietly weakened access control would be a poor
  // trade. These are the same probes the QUIZ-1B verifier runs, kept here so
  // this script can stand alone on a schedule.
  console.log('\n  Access authority (must be unchanged)')
  const key  = await rest('quiz_questions?select=correct_answer&limit=1', ANON)
  rec('answer key ungranted to anon', `HTTP ${key.status}`, key.status !== 200)
  const opts = await rest('quiz_questions?select=id,options&limit=1', ANON)
  rec('options still readable by anon', `HTTP ${opts.status}`, opts.status === 200)
  const ents = await rest('entitlements?select=id&limit=1', ANON)
  rec('entitlements denied to anon', `HTTP ${ents.status}`, ents.status !== 200)
  const atts = await rest('quiz_attempts?select=id&limit=1', ANON)
  rec('quiz_attempts return nothing to anon',
    `HTTP ${atts.status}, ${atts.rows.length} row(s)`, atts.rows.length === 0)

  // Preview status must not be an access grant. A preview lesson is the most
  // exposed row in the schema, so it is the right one to prove nothing leaks.
  const anonLessons = await rest('lessons?select=id,is_preview,video_object_path&limit=50', ANON)
  const previewWithMedia = anonLessons.rows.filter(l => l.video_object_path)
  info('lessons visible to anon', String(anonLessons.rows.length))
  if (previewWithMedia.length > 0) {
    const r = await fetch(
      `${SB}/storage/v1/object/public/course-content/${previewWithMedia[0].video_object_path}`,
      { method: 'GET' })
    rec('preview media NOT anonymously retrievable', `HTTP ${r.status}`, r.status !== 200)
  } else {
    info('preview media probe', 'no anon-visible lesson carries an object path')
  }

  report()
}

function report () {
  const total = pass + fails.length
  console.log('')
  if (notices.length) {
    console.log(`  ${notices.length} notice(s) — reported, not failed:`)
    for (const n of notices) console.log(`    · ${n}`)
    console.log('')
  }
  if (total === 0) {
    // A verifier that recorded nothing has proved nothing. Reporting PASS here
    // would be worse than a failure, because it would look like evidence.
    console.log('✗ F-5.2 INCONCLUSIVE — 0 checks recorded; the run did not complete.\n')
    process.exitCode = 1
    return
  }
  if (fails.length === 0) {
    console.log(`✓ F-5.2 PASS — ${pass} checks, 0 failures. Publication accountability installed and production matches the ruling.\n`)
    return
  }
  console.log(`✗ F-5.2 FAIL — ${fails.length} of ${total} checks failed:`)
  for (const f of fails) console.log(`    ${f}`)
  console.log(`
  An UNACCOUNTED drift means production publication state differs from the
  approved ruling and NO audit event explains it. Either the change was made
  out of band, or the recorders are not installed. Check the first line of this
  report before anything else.

  If the change was legitimate, approve it deliberately: update
  ${MANIFEST_PATH} and say who ruled.
`)
  process.exitCode = 1
}

main().catch(e => { console.error(e); process.exit(1) })
