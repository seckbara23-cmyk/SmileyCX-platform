import 'server-only'

/**
 * UAT-EXERCISE-CATEGORY-FK-01 — validating an exercise builder payload.
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ───────────────────────────────────────
 *
 * Marième reported that "Créer l'exercice" failed with
 *
 *   insert or update on table "exercise_items" violates foreign key
 *   constraint "exercise_items_correct_category_id_fkey"
 *
 * The builder minted category UUIDs *during render*, so the server-rendered
 * HTML and the hydrated React state disagreed: the `<option value>` in the DOM
 * carried the SSR uuid while state carried the client one. Selecting a category
 * therefore stored an id that was never inserted, and PostgreSQL — correctly —
 * refused the items.
 *
 * The form is fixed at source. This module is the second line: it is the reason
 * a mismatched payload can never again reach the database, whatever a future
 * client does. Both the create and the edit action run it before their first
 * write, so there is ONE definition of "is this exercise payload coherent",
 * not two drifting copies.
 *
 * ── WHY VALIDATE HERE WHEN THE DATABASE ALREADY REFUSES ───────────────────
 *
 * The foreign key is the authority and is deliberately untouched: it is the
 * only thing that stopped a broken exercise from being persisted, where an item
 * would point at nothing and the learner-side scorer would mark every answer
 * wrong. But a constraint violation surfaces as a raw PostgreSQL string in an
 * author's face, in English, naming a constraint she has no way to act on.
 *
 * So the database refuses last and absolutely; this refuses first and in
 * French. Nothing here weakens the constraint, and the constraint remains the
 * backstop if this is ever bypassed.
 */

/** RFC 4122 shape. The builder mints v4; the database column is `uuid`. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface CategoryPayload {
  id:          string
  name:        string
  color:       string
  order_index: number
}

export interface ItemPayload {
  id:                string
  label:             string
  correctCategoryId: string
  order_index:       number
}

export type ParsedExercisePayload =
  | { ok: true;  categories: CategoryPayload[]; items: ItemPayload[] }
  | { ok: false; error: string }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Parse and fully validate the two JSON blobs the builder submits.
 *
 * Returns the author-facing French message on the first problem found. The
 * caller must not touch the database unless `ok` is true.
 */
export function parseExercisePayload(
  categoriesJson: string,
  itemsJson:      string,
): ParsedExercisePayload {
  let rawCategories: unknown
  let rawItems:      unknown
  try {
    rawCategories = JSON.parse(categoriesJson)
    rawItems      = JSON.parse(itemsJson)
  } catch {
    return { ok: false, error: 'Données invalides.' }
  }

  if (!Array.isArray(rawCategories) || !Array.isArray(rawItems)) {
    return { ok: false, error: 'Données invalides.' }
  }

  // ── Categories ──────────────────────────────────────────────────────────
  if (rawCategories.length < 2) {
    return { ok: false, error: 'Au moins 2 catégories sont requises.' }
  }

  const categories: CategoryPayload[] = []
  const seenCategoryIds = new Set<string>()

  for (const raw of rawCategories) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') {
      return { ok: false, error: 'Données invalides.' }
    }
    if (!raw.name.trim()) {
      return { ok: false, error: 'Tous les noms de catégories sont obligatoires.' }
    }
    // A non-uuid would be rejected by the column type as 22P02 — an error an
    // author can do nothing with. Refuse it here, by name.
    if (!UUID_RE.test(raw.id)) {
      return {
        ok: false,
        error: 'Identifiant de catégorie invalide. Rechargez la page et recréez l\'exercice.',
      }
    }
    if (seenCategoryIds.has(raw.id)) {
      return {
        ok: false,
        error: 'Deux catégories portent le même identifiant. Rechargez la page et recréez l\'exercice.',
      }
    }
    seenCategoryIds.add(raw.id)
    categories.push({
      id:          raw.id,
      name:        raw.name.trim(),
      color:       typeof raw.color === 'string' ? raw.color : '',
      order_index: categories.length,
    })
  }

  // ── Items ───────────────────────────────────────────────────────────────
  if (rawItems.length < 2) {
    return { ok: false, error: 'Au moins 2 éléments sont requis.' }
  }

  const items: ItemPayload[] = []
  const seenItemIds = new Set<string>()

  for (const raw of rawItems) {
    if (!isRecord(raw) || typeof raw.id !== 'string'
        || typeof raw.label !== 'string' || typeof raw.correctCategoryId !== 'string') {
      return { ok: false, error: 'Données invalides.' }
    }
    if (!raw.label.trim()) {
      return { ok: false, error: 'Tous les labels d\'éléments sont obligatoires.' }
    }
    if (!UUID_RE.test(raw.id) || seenItemIds.has(raw.id)) {
      return {
        ok: false,
        error: 'Identifiant d\'élément invalide. Rechargez la page et recréez l\'exercice.',
      }
    }
    seenItemIds.add(raw.id)

    if (!raw.correctCategoryId) {
      return { ok: false, error: 'Chaque élément doit avoir une catégorie correcte.' }
    }
    // THE DEFECT, refused by name. Every item must point at a category this
    // very payload is inserting — not at one that existed in some other render.
    if (!seenCategoryIds.has(raw.correctCategoryId)) {
      return {
        ok: false,
        error: `L'élément « ${raw.label.trim()} » référence une catégorie qui n'existe pas dans cet exercice. `
             + 'Resélectionnez sa catégorie puis réessayez.',
      }
    }

    items.push({
      id:                raw.id,
      label:             raw.label.trim(),
      correctCategoryId: raw.correctCategoryId,
      order_index:       items.length,
    })
  }

  return { ok: true, categories, items }
}
