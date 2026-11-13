#!/usr/bin/env node
/**
 * XP-F2-03 — compare the reviewed agent manifest with live ElevenLabs agents. READ-ONLY.
 *
 *   ELEVENLABS_API_KEY=… node scripts/voice/compare-agents.mjs amara=<agent_id> ibrahima=<agent_id> …
 *
 * For each persona given, reads the live agent (GET /v1/convai/agents/{id}) and
 * compares it with lib/voice/agents.manifest.json: first message, language,
 * system prompt, and each evaluation criterion. It prints only « match » or
 * « differ » with short hashes — never a prompt, a key or a transcript — and
 * NEVER writes to ElevenLabs. Exit 0 when everything matches, 1 on any
 * difference or read failure, 2 on bad usage.
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const sha = s => createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex').slice(0, 12)

/** Field-by-field comparison of one manifest payload with one live agent. Pure. */
export function compareAgent(expected, live) {
  const ea = expected?.conversation_config?.agent ?? {}
  const la = live?.conversation_config?.agent ?? {}
  const rows = [
    { field: 'first_message', expected: sha(ea.first_message), live: sha(la.first_message) },
    { field: 'language', expected: ea.language ?? '', live: la.language ?? '' },
    { field: 'prompt', expected: sha(ea.prompt?.prompt), live: sha(la.prompt?.prompt) },
    { field: 'retention_days', expected: String(expected?.platform_settings?.privacy?.retention_days ?? ''), live: String(live?.platform_settings?.privacy?.retention_days ?? '') },
  ]
  const ec = expected?.platform_settings?.evaluation?.criteria ?? []
  const lc = new Map((live?.platform_settings?.evaluation?.criteria ?? []).map(c => [c.id, c]))
  for (const c of ec) {
    const l = lc.get(c.id)
    rows.push({ field: `criterion ${c.id}`, expected: sha(c.conversation_goal_prompt), live: l ? sha(l.conversation_goal_prompt) : 'absent' })
    lc.delete(c.id)
  }
  for (const id of lc.keys()) rows.push({ field: `criterion ${id}`, expected: 'absent', live: 'extra' })
  return rows.map(r => ({ ...r, match: r.expected === r.live }))
}

export function parseArgs(argv) {
  const pairs = argv.map(a => /^([a-z]+)=([A-Za-z0-9_-]{6,128})$/.exec(a))
  return pairs.every(Boolean) && pairs.length > 0 ? pairs.map(m => ({ personaId: m[1], agentId: m[2] })) : null
}

async function main() {
  const targets = parseArgs(process.argv.slice(2))
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!targets || !apiKey) {
    console.error('usage: ELEVENLABS_API_KEY=… node scripts/voice/compare-agents.mjs <persona>=<agent_id> …')
    process.exit(2)
  }
  const here = dirname(fileURLToPath(import.meta.url))
  const manifest = JSON.parse(readFileSync(join(here, '..', '..', 'lib', 'voice', 'agents.manifest.json'), 'utf8'))
  let allMatch = true
  for (const t of targets) {
    const entry = manifest.personas.find(p => p.personaId === t.personaId)
    if (!entry) { console.log(`${t.personaId}: not in the manifest`); allMatch = false; continue }
    const res = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(t.agentId)}`, {
      headers: { 'xi-api-key': apiKey }, signal: AbortSignal.timeout(10_000),
    }).catch(() => null)
    if (!res || !res.ok) { console.log(`${t.personaId}: live agent unreadable (HTTP ${res?.status ?? 'network'})`); allMatch = false; continue }
    const rows = compareAgent(entry.payload, await res.json())
    console.log(`${t.personaId} (manifest ${entry.fingerprint.slice(0, 12)})`)
    for (const r of rows) console.log(`  ${r.match ? 'match ' : 'DIFFER'}  ${r.field}  expected ${r.expected}  live ${r.live}`)
    if (rows.some(r => !r.match)) allMatch = false
  }
  process.exit(allMatch ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
