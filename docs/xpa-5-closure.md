# XPA-5 / XPA-5A — Voice Practice Productization: CLOSED

**Status: ✅ CLOSED — production PASS** (independently verified 2026-08-06)
**Commits:** `b890cdf` (XPA-5) · `9d9f24b` (XPA-5A) · `dce8200` (XPA-5A grant correction)
**Migrations applied:** 033, 034 (+ grant correction)

---

## Production verification — XPA-5A PASS

Verified from this repository against project `eqoqcxkdcxeosjqaafhs`, using the
**public anon key** for every boundary probe so the result reflects what an
anonymous internet caller actually gets. Write probes used filters matching zero
rows, so verification itself could not alter data.

| # | Check | Result |
|---|---|---|
| 1 | Privilege matrix — base table | `ai_scenarios` **42501** to anon ✅ |
| 1 | Privilege matrix — view | SELECT works, all writes refused ✅ |
| 2 | Anonymous **UPDATE** via view | **REFUSED 42501** ✅ |
| 3 | Anonymous **DELETE** via view | **REFUSED 42501** ✅ |
| 4 | Anonymous **INSERT** via view | **REFUSED 42501** — permission, *before* FK logic ✅ |
| 5 | Direct SELECT on `ai_scenarios` | **REFUSED 42501** ✅ |
| 6 | Anonymous SELECT on the view | 1 row ✅ |
| 7 | Only published scenarios visible | 1 of 5 (published = 1) ✅ |
| 8 | `prompt_template` / `agent_id` / `coach_prompt_overrides` | absent from the projection; explicit request **REFUSED 42703** ✅ |
| 9 | Five personas intact | 5 ✅ |
| 10 | Historical data | **11 sessions, 36 turns** ✅ |
| — | Four drafts still unpublished | 4 ✅ |
| — | Learner can still launch Ibrahima | `voice_configured = true`, 6/6 fields ✅ |
| 11 | GitHub / CI / Security / Vercel on `dce8200` | all **success** ✅ |
| 12 | Migration history | unchanged; no repair required beyond 033/034 |

**Item 4 is the one that matters most.** Before the correction, INSERT failed
with `23503` — a *foreign-key* error, meaning the write was permitted and only
stopped by validation. It now fails with `42501`, refused on permission before
any validation logic runs. That is the difference between "happened not to
succeed" and "cannot happen".

---

## What XPA-5A corrected, and why it was missed twice

### Defect A — numeric learner grading

`ClaudeCoachReport` rendered `{overall_score}/10` plus per-competency score bars.
The source document is explicit that the bot *"does not score the learner's
performance out of 10"*.

Removed, with no replacement scale — no percentage, stars, badge or ranking. The
`scoreColor`/`scoreBar` helpers were **deleted** rather than repurposed, because
colouring or sizing by score is the same ranking signal in a different costume.
The coach's per-competency **comment** is now the feedback.

**Non-destructive:** `overall_score` is not a column — it lives inside the stored
JSON report. Nothing was migrated, deleted or reinterpreted, and internal
reporting keeps every historical value. It drives nothing: zero uses in
completion, certificates, progress or ranking.

### Defect B — scenario confidentiality (two rounds)

**Round 1 (migration 034):** the anon key could read every column of a published
`ai_scenarios` row, including the 703-character `prompt_template` that states the
evaluation criteria. Root cause: RLS is **column-blind** — `USING (is_published
= true …)` decides which *rows* are visible, never which *columns*. Fixed with a
learner-safe view plus a revoke on the base table.

**Round 2 (the grant correction):** the view itself was **writable by anonymous
callers**. Root cause: Supabase applies `ALTER DEFAULT PRIVILEGES … GRANT ALL ON
TABLES TO anon, authenticated` to the `public` schema, so a newly created view is
born holding all seven privileges. The `grant select` was **additive and
restricted nothing**.

This was exploitable rather than untidy: the view is `security_invoker = false`
(required, so the learner projection can read past RLS) *and* auto-updatable, so
writes through it executed as the **view owner**, bypassing the base table's RLS
entirely.

**The lesson, recorded because it recurred:** three times in this programme a
statement that *reads* like a restriction turned out to only ever widen — RLS
`USING (true)` in XPA-2, `grant select` here, and column-blind RLS in round 1.
The fix in every case was to assert the resulting state rather than trust the
statement. Migration 034 now checks `information_schema.role_table_grants` at
apply time and raises if the matrix is anything other than: base **none**, view
**SELECT only**.

---

## XPA-5 deliverables (recap)

- Voice completion feeds the **existing** progress engine (`lesson_progress`),
  so module → course → certificate follow automatically. Lesson is resolved from
  the **scenario**, never client input; idempotent via `UNIQUE(user_id, lesson_id)`.
- Ibrahima re-linked from a C1-F1 lesson to **C1-F2 / Module 3 / Lesson 2**, as
  the source document specifies.
- Four remaining F2 personas seeded **unpublished, `agent_id NULL`** — no agent
  ID or prompt text invented.
- `/admin/voice` — read-only inventory + instructor reporting from the existing
  `ai_*` tables.
- Feedback qualitative only.

Nothing was rebuilt: ElevenLabs, the AI feedback pipeline, sessions, retry and
conversation history were all reused unchanged.

---

## Outstanding (not blockers to closure)

1. **Four ElevenLabs agents** for Amara, Fatou, Kader and Awa, configured per the
   source document's prompt-engineering rules, then UAT, then publish. They stay
   invisible until an agent is set — the migration refuses to leave a published
   scenario without one.
2. **D-Q1** — the launch subset remains unresolved and untouched.
3. **D-LEDGER** — migrations 001–027 remain local-only in the CLI ledger. Not
   repaired, by decision.
