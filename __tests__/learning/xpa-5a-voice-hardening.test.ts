// @vitest-environment node
/**
 * XPA-5A — Voice Practice security and pedagogical hardening.
 *
 * Two pre-existing defects, both contradicting ratified Voice Training rules:
 *   A. the learner was shown a score out of 10;
 *   B. the anon key could read prompt_template and agent_id via PostgREST.
 *
 * (A) is a UI removal. (B) is structural: the fix is a view that CANNOT return
 * the confidential columns, plus a revoke on the base table — so these tests
 * check the boundary itself, not that some caller remembered to omit a field.
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

const MIGRATION = stripSqlComments(read('supabase/migrations/034_voice_scenario_confidentiality.sql'))
const REPORT    = stripTsComments(read('components/ai/ClaudeCoachReport.tsx'))
const PRACTICE  = stripTsComments(read('app/actions/ai-practice.ts'))
const CERT      = read('app/(platform)/certificate/[courseSlug]/page.tsx')

const CONFIDENTIAL = ['prompt_template', 'agent_id', 'coach_prompt_overrides']

// ── A. No numeric learner grading ───────────────────────────────────────────

describe('XPA-5A — no numeric grade reaches the learner', () => {
  it('the coach report renders no score out of 10', () => {
    expect(REPORT).not.toMatch(/overall_score/)
    // A bare /\/10/ would match Tailwind opacity utilities (border-white/10).
    // Target the rendered score text node instead.
    expect(REPORT).not.toMatch(/\}\s*\/10|>\s*\/10|\/10\s*</)
  })

  it('renders no per-competency score number or bar', () => {
    expect(REPORT).not.toMatch(/c\.score/)
    expect(REPORT).not.toMatch(/scoreBar|scoreColor/)
  })

  it('introduces no replacement scale — no percentage, stars or badge', () => {
    expect(REPORT).not.toMatch(/\* 10|\* 100|toFixed|percent|%\`|★|⭐/)
    // width: `${...}%` was the score bar; no width may be score-derived.
    expect(REPORT).not.toMatch(/width:\s*`\$\{[^}]*score/)
  })

  it('keeps the qualitative sections the specification requires', () => {
    const raw = read('components/ai/ClaudeCoachReport.tsx')
    // Labels as this component actually renders them. Recommendations are the
    // improvement plan ("Votre plan de progression": priority + next goal) —
    // renaming UI copy is outside this phase's two-defect scope.
    for (const section of ['Points forts', 'À améliorer', 'Votre plan de progression', 'Refaire l']) {
      expect(raw, `missing section: ${section}`).toContain(section)
    }
    expect(raw).toMatch(/improvement_plan\.priority/)
    expect(raw).toMatch(/improvement_plan\.next_practice_goal/)
  })

  it('still shows the coach summary and per-competency COMMENTS', () => {
    expect(REPORT).toMatch(/report\.summary/)
    expect(REPORT).toMatch(/c\.comment/)
  })

  it('omits competencies that carry no comment rather than showing empty rows', () => {
    expect(REPORT).toMatch(/competencies\.filter\(c => c\.comment\)/)
  })
})

describe('XPA-5A — overall_score drives nothing', () => {
  it('is not used for lesson completion', () => {
    // Bound the slice: an unbounded one runs to EOF and picks up later
    // functions that legitimately mention ai_scores.
    const start = PRACTICE.indexOf('async function markVoiceLessonComplete')
    const fn = PRACTICE.slice(start, start + 1400)
    expect(fn).not.toMatch(/score/)
  })

  it('is not used for certificate eligibility', () => {
    expect(CERT).not.toMatch(/overall_score|ai_feedback|ai_scores/)
  })

  it('is not used anywhere in the practice or coach actions', () => {
    expect(PRACTICE).not.toMatch(/overall_score/)
    expect(stripTsComments(read('app/actions/ai-coach.ts'))).not.toMatch(/overall_score\s*[<>=]/)
  })

  it('is retained in the stored report schema — no destructive change', () => {
    // Historical reports keep their score for internal reporting; only the
    // learner-facing presentation was removed.
    expect(read('lib/ai/claude-report.ts')).toMatch(/overall_score/)
    expect(MIGRATION).not.toMatch(/overall_score/)
  })
})

// ── B. Confidentiality boundary ─────────────────────────────────────────────

describe('XPA-5A — the learner-safe view cannot leak confidential columns', () => {
  const viewBlock = MIGRATION.slice(
    MIGRATION.indexOf('create or replace view public.public_voice_scenarios'),
    MIGRATION.indexOf('revoke all')
  )

  it('selects none of the confidential columns', () => {
    for (const c of CONFIDENTIAL) {
      // agent_id appears only inside the derived boolean, never as an output column.
      expect(viewBlock, `${c} selected by the view`).not.toMatch(new RegExp(`^\\s*s\\.${c}\\s*,?\\s*$`, 'm'))
    }
    expect(viewBlock).not.toMatch(/s\.prompt_template/)
    expect(viewBlock).not.toMatch(/s\.coach_prompt_overrides/)
  })

  it('exposes only a derived boolean instead of the agent id', () => {
    expect(viewBlock).toMatch(/as voice_configured/)
    // The id is consumed inside the expression, never emitted.
    expect(viewBlock).not.toMatch(/s\.agent_id\s*,/)
  })

  it('shows published scenarios only', () => {
    expect(viewBlock).toMatch(/where s\.is_published = true/)
  })

  it('the migration asserts the absence of confidential columns at apply time', () => {
    expect(MIGRATION).toMatch(/learner-safe view exposes confidential column/)
    expect(MIGRATION).toMatch(/information_schema\.columns/)
  })
})

describe('XPA-5A — the base registry is closed to public roles', () => {
  it('revokes anon and authenticated from ai_scenarios', () => {
    expect(MIGRATION).toMatch(/revoke all on public\.ai_scenarios from anon/i)
    expect(MIGRATION).toMatch(/revoke all on public\.ai_scenarios from authenticated/i)
  })

  it('grants read on the view only', () => {
    const grants = [...MIGRATION.matchAll(/grant select on public\.(\w+)\s+to/gi)].map(m => m[1])
    expect(grants).toEqual(['public_voice_scenarios'])
    expect(MIGRATION).not.toMatch(/grant\s+(insert|update|delete|all)\s+on public\./i)
  })

  /**
   * The view must be REVOKED before it is granted.
   *
   * Supabase applies `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon,
   * authenticated` to the public schema, so a new view is born holding SELECT,
   * INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER. A bare
   * `grant select` is additive and restricts nothing.
   *
   * This is not cosmetic: the view is security_invoker = false and
   * auto-updatable, so writes through it run as the view owner and BYPASS the
   * base table's RLS. Production verification confirmed anon could UPDATE and
   * DELETE through it before this correction.
   */
  it('REVOKES the view from public roles before granting — default privileges are ALL', () => {
    const revokeIdx = MIGRATION.search(/revoke all on public\.public_voice_scenarios/i)
    const grantIdx  = MIGRATION.search(/grant select on public\.public_voice_scenarios/i)

    expect(revokeIdx, 'view is never revoked — it keeps Supabase default ALL privileges').toBeGreaterThan(-1)
    expect(grantIdx).toBeGreaterThan(-1)
    expect(revokeIdx, 'revoke must precede grant, or the grant is a no-op').toBeLessThan(grantIdx)
  })

  it('revokes the view from every public role, including PUBLIC itself', () => {
    for (const role of ['public', 'anon', 'authenticated']) {
      expect(
        MIGRATION,
        `view not revoked from ${role}`
      ).toMatch(new RegExp(`revoke all on public\\.public_voice_scenarios from ${role}`, 'i'))
    }
  })

  it('asserts the exact privilege matrix at apply time', () => {
    // The migration must fail loudly rather than leave a silent write vector.
    expect(MIGRATION).toMatch(/role_table_grants/)
    expect(MIGRATION).toMatch(/expected SELECT only/)
    expect(MIGRATION).toMatch(/expected none/)
  })

  it('grants no write privilege to any public role, on any object', () => {
    const writeGrants = [...MIGRATION.matchAll(
      /grant\s+([a-z, ]*?(insert|update|delete|truncate|references|trigger)[a-z, ]*?)\s+on/gi
    )]
    expect(writeGrants.map(m => m[0])).toEqual([])
  })

  it('weakens no RLS policy and drops nothing', () => {
    expect(MIGRATION).not.toMatch(/drop policy|create policy|alter policy/i)
    expect(MIGRATION).not.toMatch(/using\s*\(\s*true\s*\)/i)
    expect(MIGRATION).not.toMatch(/drop (table|column)|truncate/i)
  })

  it('preserves admin access — no admin grant or policy is touched', () => {
    expect(MIGRATION).not.toMatch(/revoke.*from\s+service_role/i)
    expect(MIGRATION).not.toMatch(/is_platform_admin/)
  })
})

describe('XPA-5A — the learner path reads the view, not the base table', () => {
  it('fetchVoiceScenario queries the learner-safe view', () => {
    const fn = PRACTICE.slice(PRACTICE.indexOf('export async function fetchVoiceScenario'))
    expect(fn).toMatch(/from\('public_voice_scenarios'\)/)
    expect(fn.slice(0, 900)).not.toMatch(/from\('ai_scenarios'\)/)
  })

  it('derives availability from the boolean, never from an agent id', () => {
    const fn = PRACTICE.slice(PRACTICE.indexOf('export async function fetchVoiceScenario'))
    expect(fn).toMatch(/voice_configured === true/)
    expect(fn.slice(0, 900)).not.toMatch(/agent_id/)
  })

  it('the returned scenario type carries no confidential field', () => {
    const iface = PRACTICE.slice(PRACTICE.indexOf('export interface VoiceScenario'), PRACTICE.indexOf('export interface VoiceScenario') + 700)
    for (const c of CONFIDENTIAL) {
      expect(iface, `${c} in the client-facing type`).not.toContain(c)
    }
  })

  it('server actions that NEED the agent still use the service-role client', () => {
    // startVoiceSession resolves agent_id internally; the revoke must not break it.
    const fn = PRACTICE.slice(PRACTICE.indexOf('export async function startVoiceSession'))
    expect(fn).toMatch(/createAdminClient\(\)/)
    expect(fn).toMatch(/agent_id/)
    // …and returns only the signed URL to the browser.
    expect(fn).toMatch(/signedUrl/)
  })

  it('the signed-URL flow authorizes the scenario before minting', () => {
    const fn = PRACTICE.slice(PRACTICE.indexOf('export async function startVoiceSession'))
    expect(fn).toMatch(/is_published/)
  })
})

// ── Preservation ────────────────────────────────────────────────────────────

describe('XPA-5A — existing functionality preserved', () => {
  it('touches no session, turn, feedback or score data', () => {
    for (const t of ['ai_sessions', 'ai_turns', 'ai_feedback', 'ai_scores']) {
      expect(MIGRATION).not.toMatch(new RegExp(`(update|delete from|alter table|drop)\\s+(public\\.)?${t}`, 'i'))
    }
  })

  it('publishes no draft persona', () => {
    // The view's `where s.is_published = true` is a filter, not a publish.
    // What must not exist is an UPDATE that flips the flag.
    expect(MIGRATION).not.toMatch(/update[\s\S]{0,120}?set[\s\S]{0,80}?is_published/i)
    for (const p of ['amara', 'fatou', 'kader', 'awa']) {
      expect(MIGRATION.toLowerCase()).not.toContain(p)
    }
  })

  it('keeps the retry action and feature flags intact', () => {
    const raw = read('components/ai/ClaudeCoachReport.tsx')
    expect(raw).toMatch(/onRetry/)
    expect(read('lib/ai/flags.ts')).toMatch(/AI_COACH_CLAUDE_ENABLED/)
  })

  it('leaves progress integration untouched', () => {
    expect(PRACTICE).toMatch(/markVoiceLessonComplete/)
    // XPA-8 B-2.6: the idempotent upsert moved to the shared completion
    // authority that voice and video now share. Same constraint, one writer.
    expect(stripTsComments(read('lib/learn/completion.ts')))
      .toMatch(/onConflict: 'user_id,lesson_id'/)
  })

  it('makes no unrelated schema or permission change', () => {
    for (const t of ['courses', 'lessons', 'modules', 'profiles', 'certificates',
                     'catalogues', 'course_codes', 'learning_paths', 'quizzes']) {
      expect(MIGRATION, `${t} touched`).not.toMatch(
        new RegExp(`(alter table|drop|revoke|grant)[^;]*\\b${t}\\b`, 'i')
      )
    }
  })
})
