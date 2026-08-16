// @vitest-environment node
/**
 * XPA-5 — Voice Practice productization.
 *
 * This phase did NOT build Voice Practice. The assertions below are therefore
 * mostly about what was REUSED and what must not have been duplicated: the
 * ElevenLabs integration, the AI feedback pipeline and the progress engine all
 * had to stay exactly as they were, with voice completion plugged into them
 * rather than shadowed by a parallel implementation.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

function stripSqlComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, m => ' '.repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
}
function stripTsComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*/g, (_m, p1: string) => p1 + ' ')
}

const MIGRATION_RAW = read('supabase/migrations/033_voice_practice_production.sql')
const MIGRATION     = stripSqlComments(MIGRATION_RAW)
const PRACTICE_RAW  = read('app/actions/ai-practice.ts')
const PRACTICE      = stripTsComments(PRACTICE_RAW)
const ADMIN         = read('app/(admin)/admin/voice/page.tsx')

/** The five personas the source document defines. */
const PERSONAS = ['amara', 'fatou', 'ibrahima', 'kader', 'awa']

// ── Reuse, not rebuild ──────────────────────────────────────────────────────

describe('XPA-5 — existing engines reused, nothing duplicated', () => {
  it('creates no new voice tables — the 024/025 schema is reused', () => {
    expect(MIGRATION).not.toMatch(/create table/i)
    for (const t of ['voice_scenarios', 'lesson_voice_scenarios', 'voice_attempts', 'voice_feedback', 'voice_progress']) {
      expect(MIGRATION, `${t} would duplicate an existing table`).not.toContain(t)
    }
  })

  it('adds only two additive columns to the existing ai_scenarios table', () => {
    const adds = [...MIGRATION.matchAll(/add column if not exists (\w+)/gi)].map(m => m[1])
    expect(adds.sort()).toEqual(['difficulty', 'order_index'])
    expect(MIGRATION).toMatch(/alter table public\.ai_scenarios/i)
  })

  it('does not rebuild the ElevenLabs integration', () => {
    // startVoiceSession still mints the signed URL server-side, unchanged.
    expect(PRACTICE).toMatch(/get-signed-url|signedUrl/)
    expect(PRACTICE).toMatch(/ELEVENLABS_API_KEY/)
  })

  it('does not rebuild AI feedback — the competency engine still runs', () => {
    expect(PRACTICE).toMatch(/runEngineForSession/)
    expect(PRACTICE).toMatch(/AI_COACH_ENABLED/)
  })

  it('introduces no numeric grade for the learner', () => {
    // Feedback stays qualitative. No pass/fail or percentage is computed here.
    expect(PRACTICE).not.toMatch(/passingThreshold|passed\s*=|percentage/)
  })

  it('touches no session, turn, score or feedback row', () => {
    for (const t of ['ai_sessions', 'ai_turns', 'ai_feedback', 'ai_scores']) {
      expect(MIGRATION).not.toMatch(new RegExp(`(update|delete from|alter table)\\s+(public\\.)?${t}`, 'i'))
    }
  })
})

// ── The productization gap this phase closes ────────────────────────────────

describe('XPA-5 — voice completion feeds the EXISTING progress engine', () => {
  // XPA-8 B-2.6 unified the two completion writers. The voice path still marks
  // the lesson complete; the write itself now happens in the shared authority
  // `lib/learn/completion.ts`, which both voice and video go through, so these
  // assertions follow it there rather than being deleted.
  const COMPLETION = stripTsComments(read('lib/learn/completion.ts'))

  it('a completed session writes lesson_progress', () => {
    expect(PRACTICE).toMatch(/markVoiceLessonComplete/)
    expect(PRACTICE).toMatch(/recordLessonCompletion\(/)
    expect(COMPLETION).toMatch(/from\('lesson_progress'\)/)
  })

  it('uses the existing uniqueness constraint, so replays are idempotent', () => {
    expect(COMPLETION).toMatch(/onConflict: 'user_id,lesson_id'/)
    expect(read('supabase/schema.sql')).toMatch(/UNIQUE\(user_id, lesson_id\)/)
  })

  it('resolves the lesson from the SCENARIO, never from client input', () => {
    const fn = PRACTICE.slice(PRACTICE.indexOf('async function markVoiceLessonComplete'))
    expect(fn).toMatch(/from\('ai_scenarios'\)[\s\S]{0,160}?select\('lesson_id'\)/)
    // No lessonId parameter exists to forge.
    expect(PRACTICE).not.toMatch(/markVoiceLessonComplete\([^)]*lessonId/)
  })

  it('only fires on completion, never on abandonment', () => {
    expect(PRACTICE).toMatch(/if \(status === 'completed'\)[\s\S]{0,220}?markVoiceLessonComplete/)
  })

  it('skips anonymous pilot sessions rather than inventing a learner', () => {
    const fn = PRACTICE.slice(PRACTICE.indexOf('async function markVoiceLessonComplete'))
    expect(fn).toMatch(/if \(!userId\) return/)
  })

  it('progress failure never loses a completed conversation', () => {
    // The call is wrapped and logged, not allowed to fail the completion.
    expect(PRACTICE).toMatch(/try \{[\s\S]{0,120}?markVoiceLessonComplete[\s\S]{0,200}?catch/)
  })

  it('adds no parallel progress model', () => {
    for (const t of ['voice_progress', 'voice_attempts']) {
      expect(PRACTICE).not.toContain(t)
    }
  })
})

// ── Scenario configuration without code edits ───────────────────────────────

describe('XPA-5 — scenarios are data, not code', () => {
  it('seeds the four remaining personas from the source document', () => {
    for (const p of PERSONAS.filter(p => p !== 'ibrahima')) {
      expect(MIGRATION.toLowerCase(), `${p} not seeded`).toContain(p)
    }
  })

  it('invents no ElevenLabs agent id', () => {
    // Every seeded scenario carries a null agent until an admin configures one.
    expect(MIGRATION).toMatch(/agent_id[\s\S]{0,80}?null/i)
    expect(MIGRATION).not.toMatch(/agent_[0-9a-f]{8}/i)
  })

  it('invents no AI prompt text', () => {
    expect(MIGRATION).not.toMatch(/prompt_template\s*,?\s*'/)
  })

  it('seeds every new scenario UNPUBLISHED', () => {
    // is_published false is passed positionally in the seed values.
    expect(MIGRATION).toMatch(/'elevenlabs', null, false/)
  })

  it('refuses to leave a published scenario without an agent', () => {
    expect(MIGRATION).toMatch(/published scenario\(s\) have no ElevenLabs agent/)
  })

  it('resolves lessons through the immutable course code, not hardcoded uuids', () => {
    expect(MIGRATION).toMatch(/c\.code = 'C1-F2'/)
    expect(MIGRATION).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/)
  })

  it('re-links Ibrahima to the lesson the source document specifies', () => {
    expect(MIGRATION).toMatch(/Garder son calme/)
    expect(MIGRATION).toMatch(/ibrahima-double-facturation/)
  })
})

// ── Admin & reporting ───────────────────────────────────────────────────────

describe('XPA-5 — admin visibility', () => {
  it('is admin-authorized server-side', () => {
    expect(ADMIN).toMatch(/await requirePlatformAdmin\(\)/)
  })

  it('performs no writes in this phase', () => {
    expect(ADMIN).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/)
  })

  it('surfaces scenarios awaiting an agent', () => {
    expect(ADMIN).toMatch(/agent ElevenLabs/)
    expect(ADMIN).toMatch(/awaiting/)
  })

  it('reports sessions, completion, learners, retries and feedback', () => {
    for (const label of ['Sessions', 'Terminées', 'Apprenants', 'Reprises', 'Avec feedback']) {
      expect(ADMIN, `missing report metric: ${label}`).toContain(label)
    }
  })

  it('reuses the existing ai_* tables for reporting', () => {
    expect(ADMIN).toMatch(/from\('ai_scenarios'\)/)
    expect(ADMIN).toMatch(/from\('ai_sessions'\)/)
    expect(ADMIN).toMatch(/from\('ai_feedback'\)/)
  })
})

// ── Scope guards ────────────────────────────────────────────────────────────

describe('XPA-5 — no scope creep', () => {
  it('does not touch auth, payments, certificates or the catalogue', () => {
    for (const t of ['profiles', 'platform_role', 'payments', 'certificates',
                     'catalogues', 'course_codes', 'learning_paths', 'learning_path_courses']) {
      expect(MIGRATION, `${t} referenced`).not.toMatch(
        new RegExp(`(alter|drop|update|delete from|insert into)\\s+(public\\.)?${t}\\b`, 'i')
      )
    }
  })

  it('changes no course slug or immutable code', () => {
    expect(MIGRATION).not.toMatch(/update\s+public\.courses/i)

    // Parse SET clauses only. A bare /slug\s*=/ would flag
    // `where slug = 'ibrahima…'`, which is a lookup, not a rename.
    const assigned: string[] = []
    for (const stmt of MIGRATION.matchAll(/update\s+public\.(\w+)\s+set\s+([\s\S]*?)(?:\bwhere\b|;)/gi)) {
      for (const a of stmt[2].matchAll(/(\w+)\s*=/g)) assigned.push(`${stmt[1]}.${a[1].toLowerCase()}`)
    }
    // The only UPDATE in this migration re-links Ibrahima's lesson.
    expect(assigned.sort()).toEqual(['ai_scenarios.difficulty', 'ai_scenarios.lesson_id', 'ai_scenarios.updated_at'])
    expect(assigned.some(a => a.endsWith('.slug'))).toBe(false)
    expect(assigned.some(a => a.endsWith('.code'))).toBe(false)
  })

  it('D-Q1 remains untouched — no launch status assigned', () => {
    expect(MIGRATION).not.toMatch(/'launch'/)
  })

  it('does not modify migrations 001-027', () => {
    expect(MIGRATION).not.toMatch(/00[0-9]_|01[0-9]_|02[0-7]_/)
  })

  it('keeps lesson resources on the existing pdf_url model', () => {
    // No new resource table: the two F2 PDFs are already attached to lessons.
    expect(MIGRATION).not.toMatch(/lesson_resources|create table.*resource/i)
  })
})
