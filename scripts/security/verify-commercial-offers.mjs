#!/usr/bin/env node
/**
 * XP-LAUNCH-FINAL-08 — the commercial offers, verified read-only.
 *
 *   node scripts/security/verify-commercial-offers.mjs
 *
 * Reads ONLY what any visitor can read, with the public anon key (from .env.local
 * or the environment): the published courses' prices by their V8 code, and the
 * published packs with their courses and prices. It writes nothing and needs no
 * secret.
 *
 * It compares them with Marième's confirmed V4 commercial conditions (2026-11-08):
 * seven paid courses at 9 900 or 14 900 FCFA, the free C1-F4, Pack Conseiller at
 * 37 900 FCFA and Pack Manager at 38 000 FCFA. Run it before and after the
 * controlled price update in the administration (which does not audit a price
 * change by itself): its two outputs are the record of the change.
 *
 * Exit 0 when everything matches, 1 otherwise. Packs are reported absent, not
 * failed, while migration 065 is not applied (`--require-packs` makes that a failure).
 */
import { readFileSync } from 'node:fs'

const env = {}
try {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* fall through to the environment */ }
const SB = env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
if (!SB || !ANON) { console.error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.'); process.exit(1) }
const REQUIRE_PACKS = process.argv.includes('--require-packs')

export const V4_COURSES = {
  'C1-F1': 9900, 'C1-F2': 9900, 'C1-F3': 9900, 'C2-F4': 14900,
  'C2-F1': 14900, 'C2-F2': 14900, 'C2-F5': 14900, 'C1-F4': 0,
}
export const V4_PACKS = {
  'PACK-CONSEILLER': { price: 37900, courses: ['C1-F1', 'C1-F2', 'C1-F3', 'C2-F4'] },
  'PACK-MANAGER':    { price: 38000, courses: ['C2-F1', 'C2-F2', 'C2-F5'] },
}

let failures = 0
const line = (ok, label, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(44)} ${detail}`)
  if (!ok) failures++
}
async function get(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } })
  const body = await r.json().catch(() => null)
  return { status: r.status, body }
}

console.log('── Courses (published, anon read) ─────────────────────────')
const codes = Object.keys(V4_COURSES)
const courses = await get(`courses?select=id,code,price,currency,is_free,is_published&code=in.(${codes.join(',')})`)
if (courses.status !== 200 || !Array.isArray(courses.body)) {
  line(false, 'courses readable', `HTTP ${courses.status}`)
} else {
  const byCode = new Map(courses.body.map(c => [c.code, c]))
  for (const [code, expected] of Object.entries(V4_COURSES)) {
    const c = byCode.get(code)
    if (!c) { line(false, `${code}`, 'not published or not found'); continue }
    const price = Number(c.price)
    const ok = price === expected && c.currency === 'XOF' && (expected === 0 ? c.is_free === true : c.is_free !== true)
    line(ok, `${code}`, `${price} ${c.currency}${c.is_free ? ' (free)' : ''} — expected ${expected === 0 ? 'free' : `${expected} XOF`}`)
  }
}

console.log('── Packs (published, anon read) ───────────────────────────')
const packs = await get('course_packs?select=id,code,price,currency,is_published&is_published=eq.true&order=position')
if (packs.status === 404 || (packs.body && packs.body.code === 'PGRST205')) {
  line(!REQUIRE_PACKS, 'packs table', 'absent: migration 065 is not applied')
} else if (packs.status !== 200 || !Array.isArray(packs.body)) {
  line(false, 'packs readable', `HTTP ${packs.status}`)
} else {
  const links = await get(`course_pack_courses?select=pack_id,course_id,position&pack_id=in.(${packs.body.map(p => p.id).join(',')})`)
  const idToCode = new Map((Array.isArray(courses.body) ? courses.body : []).map(c => [c.id, c.code]))
  for (const [code, expected] of Object.entries(V4_PACKS)) {
    const p = packs.body.find(x => x.code === code)
    if (!p) { line(false, code, 'not published or not found'); continue }
    const mine = (Array.isArray(links.body) ? links.body : [])
      .filter(l => l.pack_id === p.id)
      .sort((a, b) => a.position - b.position)
      .map(l => idToCode.get(l.course_id) ?? `?${String(l.course_id).slice(0, 8)}`)
    const ok = Number(p.price) === expected.price && p.currency === 'XOF' && JSON.stringify(mine) === JSON.stringify(expected.courses)
    line(ok, code, `${Number(p.price)} ${p.currency}: ${mine.join(' + ')}`)
  }
}

console.log(failures === 0 ? '\nAll commercial offers match the confirmed V4 conditions.' : `\n${failures} mismatch(es).`)
process.exitCode = failures === 0 ? 0 : 1
