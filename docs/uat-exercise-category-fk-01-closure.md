# UAT-EXERCISE-CATEGORY-FK-01 — exercise category foreign-key defect

**Reported by** Marième, in production admin authoring.
**Symptom** — "Créer l'exercice" failed with

```
insert or update on table "exercise_items" violates foreign key constraint
"exercise_items_correct_category_id_fkey"
```

**Status** — application fix implemented. No migration, no schema change, no
production write.

---

## Root cause

The exercise builder minted a `crypto.randomUUID()` per category **during
render**:

```tsx
const [categories, setCategories] = useState<CategoryDraft[]>([newCat(), newCat()])
```

A non-lazy `useState` initialiser is evaluated on every render pass, and SSR and
hydration are two passes. The server therefore emitted `<option value="A">`
while the hydrated React state held `B`. React does not rewrite that attribute
during hydration, so:

* selecting a category stored the **DOM's** value — the SSR uuid — in
  `item.correctCategoryId`;
* `categories_json` carried the **client's** uuids.

The action inserted the categories under the client uuids and the items pointing
at the server uuids, and PostgreSQL refused them. **The foreign key was correct
throughout; the application was wrong.**

### Why it looked intermittent

Arriving at `/admin/exercises/new` through an in-app `<Link>` mounts the form
client-side only — there is no server HTML to disagree with, so creation
succeeded. A hard load, a refresh or a new tab server-renders it and it failed.
That is the difference between the exercise that exists in production
(`Qui décide ?`, created 2026-09-25) and Marième's failures.

### Two contributing defects, both repaired

1. **No server-side referential validation.** Both actions checked only that
   `correctCategoryId` was non-empty, so an incoherent payload reached the
   database and returned a raw English constraint name to the author.
2. **Index-based category removal.** `removeCategory(idx)` read
   `categories[idx]` from the render-time array while the updater filtered the
   *running* one. Two trash clicks in a single React batch could clear one
   category's references while removing a different category — orphaning an item
   independently of SSR.

---

## What changed

| File | Change |
|---|---|
| `app/(admin)/admin/exercises/new/NewExerciseForm.tsx` | drafts carry a **local key** (`useId()` + a counter in lazy initialisers), stable across SSR and hydration; database uuids are minted once, in the submit handler; all mutations address rows by key |
| `lib/admin/exercise-payload.ts` *(new)* | one shared validator: uuid shape, duplicate ids, and every item's target ∈ the submitted categories |
| `app/(admin)/admin/exercises/new/actions.ts` | validates through the shared module before opening a client |
| `app/(admin)/admin/exercises/[id]/edit/actions.ts` | same — and it matters more here, because this path deletes before re-inserting |
| `app/(admin)/admin/exercises/[id]/edit/EditExerciseForm.tsx` | id-based removal and updates |

The database contract is untouched: `exercise_items.correct_category_id uuid NOT
NULL REFERENCES public.exercise_categories(id) ON DELETE RESTRICT`. A test pins
it, and pins that no migration drops or weakens it.

---

## Production data

No repair needed. At investigation time production held one exercise, 3
categories and 8 items, with **zero dangling `correct_category_id`**. The
failure was fail-safe: the foreign key rejected the items, the action deleted
the exercise row, and `ON DELETE CASCADE` removed the categories.

---

## Follow-up technical debt — NOT addressed in this slice

**EXERCISE-TXN-01 — the exercise write paths are not transactional.**

Neither action runs inside a database transaction; each issues a sequence of
PostgREST calls.

* `createExercise` compensates by hand: if the categories or items insert fails
  it deletes the exercise row and relies on `ON DELETE CASCADE`. That
  compensation is itself unchecked — if the delete fails, an empty exercise
  survives.
* `updateExercise` has **no compensation at all**. It deletes every item, then
  every category, then re-inserts. A failure between the delete and the
  re-insert — a network error, a crash, a rejected row — leaves the exercise
  stripped of its categories and items, and the author's content is gone.

This slice makes that far less likely, because the payload is now validated
before the first write, but it does not remove the window. The durable fix is a
single `SECURITY DEFINER` RPC that performs the whole replace in one
transaction, called by both actions.

Recorded here as debt by owner instruction; not implemented in
UAT-EXERCISE-CATEGORY-FK-01.

---

## Regression coverage

`__tests__/admin/uat-exercise-category-fk-01-builder.test.tsx` (10) renders for
real — `renderToString` → `hydrateRoot` → change event carrying the DOM's own
value → submit — because every file involved was internally consistent and only
the gap between two renders was wrong. `…-actions.test.ts` (13) proves an
incoherent payload is refused in French with **zero** database calls, and pins
the foreign key.

Against the pre-fix component, three of these fail: the orphaned-reference
reproduction, the "no uuid minted during render" pin, and the batched
double-delete. All 23 pass against the fix.
