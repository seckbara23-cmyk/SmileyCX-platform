import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * CAT-1 — assigning academic identity from the Admin surface.
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ───────────────────────────────────────
 *
 * `courses.code` is the permanent academic identity (C1-F1, C2-F5…). The
 * public catalogue groups by its catalogue prefix, and every parcours/secteur
 * membership is keyed on it. Neither Admin course action wrote it — not on
 * create, not on edit — so every course authored through the Admin UI was born
 * with `code = NULL`, and `getPublishedCoursesByCatalogue()` excludes null-code
 * rows with `.not('code','is',null)`.
 *
 * The result was a published course that renders its own page but appears in no
 * catalogue and no path. That is UAT-FU-1, reported by Marième on 19 August
 * 2026 as "not all 7 published formations appear" — a systemic authoring gap,
 * not a one-off content omission.
 *
 * ── THE CONTRACT ──────────────────────────────────────────────────────────
 *
 *   NULL code  →  Admin may assign ONE valid, unused, unretired canonical code
 *              →  the code becomes PERMANENT
 *              →  Admin may never replace or remove it
 *
 * ── WHY VALIDATION LIVES HERE AND ALSO IN THE DATABASE ────────────────────
 *
 * The database already enforces the hard invariants, and nothing here weakens
 * them. Migration 028 gives `courses.code`:
 *
 *   courses_code_fkey        REFERENCES course_codes(code)  — no invented code
 *   courses_code_unique      UNIQUE                          — no two courses share one
 *   courses_code_immutable   BEFORE UPDATE trigger           — set once, never changed
 *
 * Those are the authority and remain the last word. This module exists because
 * a constraint violation surfaces as `23503`/`23505`/`23514` with a Postgres
 * message an operator should never have to read. It turns the same rules into
 * French errors BEFORE the write, and lets the form offer only codes that can
 * actually be assigned. A disabled `<select>` is not a control — the server
 * check below is, and the database is the backstop behind it.
 */

/** `C<catalogue digit>-F<position>` — the shape migration 028 registers. */
export const COURSE_CODE_PATTERN = /^C\d-F\d+$/

export interface AssignableCourseCode {
  code:            string
  catalogue_code:  string
  canonical_title: string | null
  status:          string | null
}

/**
 * Canonical codes that could be assigned right now: registered, not retired,
 * and not already carried by another course.
 *
 * Read with the admin client because `course_codes` is admin-only by RLS
 * (migration 028 deliberately refused a public policy — it would have published
 * the entire unbuilt roadmap to anyone holding the anon key).
 */
export async function listAssignableCourseCodes(
  excludeCourseId?: string,
): Promise<AssignableCourseCode[]> {
  const supabase = createAdminClient()

  const [{ data: registry }, { data: taken }] = await Promise.all([
    supabase
      .from('course_codes')
      .select('code, catalogue_code, canonical_title, status')
      .order('catalogue_code')
      .order('position'),
    supabase
      .from('courses')
      .select('id, code')
      .not('code', 'is', null),
  ])

  const used = new Set(
    ((taken ?? []) as { id: string; code: string }[])
      .filter(c => c.id !== excludeCourseId)
      .map(c => c.code),
  )

  return ((registry ?? []) as AssignableCourseCode[])
    // A retired code must never be reused — 028's registry trigger refuses
    // deletion precisely so retirement is the only exit.
    .filter(r => r.status !== 'retired')
    .filter(r => !used.has(r.code))
}

export type CodeAssignment =
  /** `code` present → write it. `code` absent → leave the column alone. */
  | { ok: true; code?: string }
  | { ok: false; error: string }

/**
 * Decide what a submitted code field means, given what the row already holds.
 *
 * `requested` is the raw form value: `null` when the field was not submitted at
 * all, `''` when it was submitted empty. Those are different intentions and are
 * treated differently — an absent field is an ordinary save that says nothing
 * about the code, whereas an empty one on a coded course is an attempt to
 * clear it.
 */
export async function resolveCourseCodeAssignment(
  currentCode: string | null,
  requested:   string | null,
  courseId?:   string,
): Promise<CodeAssignment> {
  const value = typeof requested === 'string' ? requested.trim().toUpperCase() : null

  // ── The code is already set: permanent, and that is the whole point ──────
  if (currentCode) {
    if (value === null || value === currentCode) return { ok: true }   // no change
    if (value === '') {
      return {
        ok: false,
        error: `Le code académique ${currentCode} est permanent et ne peut pas être supprimé.`,
      }
    }
    return {
      ok: false,
      error: `Le code académique est permanent : ${currentCode} ne peut pas devenir ${value}. `
           + 'Le titre est une étiquette modifiable ; le code est une identité définitive.',
    }
  }

  // ── The code is null: one assignment is allowed ─────────────────────────
  if (value === null || value === '') return { ok: true }              // none chosen

  if (!COURSE_CODE_PATTERN.test(value)) {
    return { ok: false, error: `Code académique invalide : ${value}. Format attendu, par exemple C2-F5.` }
  }

  const supabase = createAdminClient()

  const { data: registered, error: registryError } = await supabase
    .from('course_codes')
    .select('code, status')
    .eq('code', value)
    .maybeSingle()

  // Fail closed, exactly as the F-5.2 prior-state read does: if the registry
  // cannot be read we do not know whether this code is legitimate, and writing
  // an unverified academic identity is worse than refusing the save.
  if (registryError) {
    return {
      ok: false,
      error: 'Impossible de vérifier le registre des codes académiques. Aucune modification enregistrée.',
    }
  }
  if (!registered) {
    return { ok: false, error: `Code académique inconnu : ${value}. Il doit exister dans le registre.` }
  }
  if (registered.status === 'retired') {
    return { ok: false, error: `Le code ${value} est retiré et ne peut pas être réattribué.` }
  }

  const { data: clash, error: clashError } = await supabase
    .from('courses')
    .select('id, slug')
    .eq('code', value)
    .maybeSingle()

  if (clashError) {
    return {
      ok: false,
      error: 'Impossible de vérifier si ce code est déjà attribué. Aucune modification enregistrée.',
    }
  }
  if (clash && clash.id !== courseId) {
    return { ok: false, error: `Le code ${value} est déjà attribué à la formation « ${clash.slug} ».` }
  }

  return { ok: true, code: value }
}
