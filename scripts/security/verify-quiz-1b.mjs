#!/usr/bin/env node
/**
 * QUIZ-1B production verification — randomisation activated, nothing else moved.
 *
 *   node scripts/security/verify-quiz-1b.mjs
 *
 * ── WHEN TO RUN IT ────────────────────────────────────────────────────────
 *
 * AFTER migration 052 is applied. Run before, and the two activation checks
 * fail by design — that is the migration reporting as not-yet-applied, not a
 * defect. Every other check is a standing invariant and must pass either way.
 *
 * ── WHAT IT PROVES ────────────────────────────────────────────────────────
 *
 * Migration 052 flips two presentational booleans on ONE quiz. The risk is
 * never the flip itself; it is that something else moved at the same time, or
 * that the flip reached further than intended. So this verifier asserts the
 * change AND the absence of change:
 *
 *   activated   the target quiz has both flags true
 *   contained   no other quiz has either flag
 *   intact      3 questions, 4 options each, answer key still [0, 1, 1]
 *   scoped      the quiz is still lesson-parented, so it is still FORMATIVE
 *   historical  Marième's UAT attempt still reads 33/100, passed=false, with
 *               its original answer indices
 *   authority   the course's publication state is unchanged, no course has
 *               acquired a final-exam requirement, and the answer key is still
 *               ungranted to anonymous callers
 *
 * The answer-key probe matters here specifically: randomisation is the first
 * feature that asks the client to reorder options it holds, and the invariant
 * that keeps that safe is that the client holds `options` and never
 * `correct_answer`. Migration 038 established it; this re-proves it after the
 * flags go live.
 *
 * ── READ-ONLY ─────────────────────────────────────────────────────────────
 *
 * No fixtures, no inserts, no updates, no deletes. Every request is a GET.
 * Learner-write denial on `quiz_attempts` is covered by
 * verify-xpa-8-b23.mjs, which owns the fixtures for it.
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

/** The one quiz QUIZ-1B activates. */
const QUIZ    = '70bbc2a8-9c34-4607-88a3-7ce328ea9e7e'
/** The production UAT attempt whose result must never move. */
const ATTEMPT = '650fc334-4577-496f-a9f3-fd464362b93f'

let pass = 0
const fails = []
const pendings = []

const rec = (l, d, ok) => {
  console.log(`  ${ok ? '✓' : '✗'} ${l.padEnd(52)} ${d}`)
  if (ok) pass++; else fails.push(`${l} — ${d}`)
}
/** A check only migration 052 can satisfy. Tracked apart from real failures. */
const pending = (l, d, ok) => {
  console.log(`  ${ok ? '✓' : '⚠'} ${l.padEnd(52)} ${d}`)
  if (ok) pass++; else pendings.push(`${l} — ${d}`)
}
const info = (l, d) => console.log(`    · ${l.padEnd(50)} ${d}`)

const rest = async (p, key = SVC) => {
  const r = await fetch(`${SB}/rest/v1/${p}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  })
  const t = await r.text()
  let j = null
  try { j = JSON.parse(t) } catch { /* non-JSON */ }
  return { status: r.status, rows: Array.isArray(j) ? j : (j ? [j] : []), raw: t }
}

async function main () {
  console.log('\nQUIZ-1B — randomisation activation verification\n')

  // ── 1. The target quiz ──────────────────────────────────────────────────
  console.log('  Target quiz')
  const q = await rest(`quizzes?id=eq.${QUIZ}&select=id,title,lesson_id,module_id,course_id,passing_score,randomize_questions,randomize_options`)
  const quiz = q.rows[0]
  rec('quiz exists', quiz ? quiz.title : `HTTP ${q.status}`, !!quiz)
  if (!quiz) { report(); return }

  pending('randomize_questions = true', String(quiz.randomize_questions), quiz.randomize_questions === true)
  pending('randomize_options = true',   String(quiz.randomize_options),   quiz.randomize_options === true)

  // ── 2. Still lesson-scoped, therefore still formative ───────────────────
  //
  // `resolveQuizContext` reads a course_id as "this IS the final exam". If the
  // parent drifted, the quiz changed kind and the activation no longer means
  // what it was approved to mean.
  rec('lesson-scoped (lesson_id set)', quiz.lesson_id ?? 'null', !!quiz.lesson_id)
  rec('not module-scoped',   String(quiz.module_id), quiz.module_id === null)
  rec('not course-scoped (not a final exam)', String(quiz.course_id), quiz.course_id === null)

  // ── 3. Containment ──────────────────────────────────────────────────────
  console.log('\n  Containment')
  const flagged = await rest('quizzes?or=(randomize_questions.eq.true,randomize_options.eq.true)&select=id,title')
  const strays  = flagged.rows.filter(r => r.id !== QUIZ)
  rec('no unintended quiz randomised',
    strays.length === 0 ? 'none' : strays.map(s => s.id).join(', '), strays.length === 0)

  const all = await rest('quizzes?select=id')
  info('quizzes platform-wide', String(all.rows.length))

  // ── 4. Content intact ───────────────────────────────────────────────────
  console.log('\n  Content')
  const qs = await rest(`quiz_questions?quiz_id=eq.${QUIZ}&select=id,options,correct_answer,order_index&order=order_index`)
  rec('exactly 3 questions', String(qs.rows.length), qs.rows.length === 3)

  const badOpts = qs.rows.filter(r => !Array.isArray(r.options) || r.options.length !== 4)
  rec('every question has exactly 4 options',
    badOpts.length === 0 ? 'all 4' : `${badOpts.length} malformed`, badOpts.length === 0)

  // The audited key. Randomisation is presentational; if this moved, something
  // else did it, and every past attempt would be reinterpreted.
  const key = qs.rows.map(r => r.correct_answer).join(',')
  rec('answer key unchanged [0,1,1]', key || '(none)', key === '0,1,1')

  // ── 5. The historical attempt ───────────────────────────────────────────
  console.log('\n  Historical UAT attempt')
  const a = await rest(`quiz_attempts?id=eq.${ATTEMPT}&select=id,quiz_id,score,max_score,passed,answers`)
  const att = a.rows[0]
  rec('attempt still exists', att ? att.id : `HTTP ${a.status}`, !!att)
  if (att) {
    rec('still belongs to this quiz', String(att.quiz_id), att.quiz_id === QUIZ)
    rec('score still 33',      String(att.score),     att.score === 33)
    rec('max_score still 100', String(att.max_score), att.max_score === 100)
    rec('passed still false',  String(att.passed),    att.passed === false)

    // Answers are stored as ORIGINAL option indices, which is why shuffling
    // cannot reinterpret them. Re-grade to prove it rather than assume it.
    const byId = Object.fromEntries(qs.rows.map(r => [r.id, r.correct_answer]))
    const graded = qs.rows.filter(r => att.answers?.[r.id] === byId[r.id]).length
    const pct = qs.rows.length ? Math.round(graded / qs.rows.length * 100) : 0
    rec('re-grades to the stored score', `${graded}/${qs.rows.length} = ${pct}%`, pct === att.score)
  }

  // ── 6. Authority unchanged ──────────────────────────────────────────────
  console.log('\n  Publication / access authority')
  const les = await rest(`lessons?id=eq.${quiz.lesson_id}&select=id,module_id`)
  const mod = les.rows[0]
    ? await rest(`modules?id=eq.${les.rows[0].module_id}&select=id,course_id`)
    : { rows: [] }
  const crs = mod.rows[0]
    ? await rest(`courses?id=eq.${mod.rows[0].course_id}&select=id,code,is_published,requires_final_exam`)
    : { rows: [] }
  const course = crs.rows[0]

  rec('owning course resolves', course ? course.code : 'unresolved', !!course)
  if (course) {
    rec('course still published',        String(course.is_published),        course.is_published === true)
    rec('requires_final_exam unchanged', String(course.requires_final_exam), course.requires_final_exam === false)
  }

  const rfe = await rest('courses?requires_final_exam=eq.true&select=id')
  rec('no course requires a final exam', String(rfe.rows.length), rfe.rows.length === 0)

  // The invariant that makes client-side shuffling safe: the learner holds the
  // options, never the key. Probed as ANON, which is what a browser is.
  const leak = await rest(`quiz_questions?select=correct_answer&limit=1`, ANON)
  rec('answer key ungranted to anon', `HTTP ${leak.status}`, leak.status !== 200)

  const opts = await rest(`quiz_questions?select=id,options&limit=1`, ANON)
  rec('options still readable by anon', `HTTP ${opts.status}`, opts.status === 200)

  report()
}

function report () {
  const total = pass + fails.length + pendings.length
  console.log('')
  if (fails.length === 0 && pendings.length === 0) {
    console.log(`✓ QUIZ-1B PASS — ${pass} checks, 0 failures. Randomisation active and contained.\n`)
    return
  }
  console.log(`✗ QUIZ-1B INCOMPLETE — ${pass} of ${total} checks passed.`)
  if (fails.length) {
    console.log(`  ${fails.length} genuine failure(s):`)
    for (const f of fails) console.log(`    ${f}`)
  }
  if (pendings.length) {
    console.log(`  ${pendings.length} awaiting migration 052:`)
    for (const p of pendings) console.log(`    ${p}`)
    console.log(`
  Apply it only AFTER the QUIZ-1B release is merged and deployed:

      supabase/migrations/052_quiz1b_activate_randomization.sql
`)
  }
  console.log('')
  process.exitCode = 1
}

main().catch(e => { console.error(e); process.exit(1) })
