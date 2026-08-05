# XPA-2 — Production Database Reconciliation

**Status: ✅ RESOLVED — production initialization PASS** (independently re-verified)
**Reconciliation applied by operator · verified 2026-08-05 · no outstanding action**

> **Outcome:** the reported "partial migration 028" was a false alarm (wrong table
> name — `course_catalogues` is not part of the schema). All three migrations were
> already applied. The genuine finding underneath it — production running the
> **pre-fix RLS policies**, exposing the unproduced roadmap to anonymous callers —
> **has been corrected and independently verified closed.**

## ✅ Post-reconciliation verification (independent, 2026-08-05)

Re-run from this repository against project `eqoqcxkdcxeosjqaafhs` using both the
service-role key (counts) and the **public anon key** (exposure), so the result
reflects what an anonymous internet caller actually sees.

| Check | Expected | Actual | |
|---|---|---|---|
| `catalogues` | 3 | 3 | PASS |
| `course_codes` | 17 | 17 | PASS |
| `learning_paths` | 15 | 15 | PASS |
| `learning_path_courses` | 71 | 71 | PASS |
| Courses with immutable codes | 6 | 6 | PASS |
| **Anon read — `catalogues`** | 0 rows | **0 rows** | **PASS** |
| **Anon read — `course_codes`** | 0 rows | **0 rows** | **PASS** |
| **Anon read — `learning_paths`** | 0 rows | **0 rows** | **PASS** |
| **Anon read — `learning_path_courses`** | 0 rows | **0 rows** | **PASS** |
| Control: published courses still anon-readable | 6 | 6 | PASS |
| `launch` status assigned | none (D-Q1) | **none** | PASS |
| `backlog` status | C2-F6 only | C2-F6 | PASS |
| C1-F1 first in all 15 paths | 0 exceptions | 0 | PASS |
| Professional / sector split | 9 / 6 | 9 / 6 | PASS |
| All 6 slugs unchanged vs XPA-0 | no drift | no drift | PASS |
| Enrollments / progress / certificates / attempts | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | PASS |

**The roadmap exposure is closed:** all 11 previously-visible unproduced course
codes now return zero rows to the anon key, while the public course catalogue
continues to work — confirming the fix was surgical, not a blanket lockdown.

---

## Historical record — the original diagnosis

*(Retained below for the audit trail. The state it describes has been corrected.)*

---

## 1. Verified production project reference

```
eqoqcxkdcxeosjqaafhs
```

**Verified from the live production JavaScript bundle**, not inferred from local
config: `https://www.xpclient-academy.com/_next/static/chunks/9372-db5e5ef49ed6ed7b.js`
contains `https://eqoqcxkdcxeosjqaafhs.supabase.co`. That is the project Vercel
actually talks to.

| Source | Ref | Agrees? |
|---|---|---|
| Live production bundle (authoritative) | `eqoqcxkdcxeosjqaafhs` | — |
| `.env.local` `NEXT_PUBLIC_SUPABASE_URL` | `eqoqcxkdcxeosjqaafhs` | ✅ |
| `supabase/.temp/project-ref` | *absent* | CLI unlinked — matches the reported error |
| `.vercel/` directory | *absent locally* | n/a |

Because local config matches the live bundle, the service-role key in
`.env.local` addresses the same project — so every probe below is authoritative
for production.

## 2. Partial-state diagnosis — the report was inaccurate

The reported state listed `public.course_catalogues` as missing and concluded the
model was partially applied. **That table name does not exist in any migration.**
Migration 028 creates `public.catalogues`. Checking for `course_catalogues` will
always return "does not exist", on a fully-migrated database.

Direct probe of production:

| Object | Reported | **Actual** |
|---|---|---|
| `courses.code` | exists | ✅ exists, all 6 rows populated |
| `course_catalogues` | missing | ✅ correctly missing — **never part of the schema** |
| `catalogues` | (not checked) | ✅ **EXISTS — 3 rows** |
| `course_codes` | missing | ✅ **EXISTS — 17 rows** |
| `learning_paths` | missing | ✅ **EXISTS — 15 rows** |
| `learning_path_courses` | missing | ✅ **EXISTS — 71 rows** |

**Nothing is missing. No table needs creating. No reconciliation script is
required for structure.**

The most likely cause of the false report: checking one wrong table name,
concluding it was absent, and inferring the rest — or running the check in the
Supabase SQL Editor while it was pointed at a different project.

## 3. Migration 028 — statements already applied

All of them. Verified by direct probe:

| Statement group | State |
|---|---|
| `create table catalogues` | applied |
| `create table course_codes` | applied |
| `alter table courses add column code` | applied |
| `create table learning_paths` | applied |
| `create table learning_path_courses` | applied |
| RLS policies | applied — **but the pre-fix version, see §5** |
| Triggers / constraints / indexes | not directly observable via the API — verify with §7 SQL |

### Migration 029 — seed verified directly

```
catalogues        : 3   → C1=Fondations, C2=Intermédiaire, C3=Avancé   ✓
course_codes      : 17  → C1-F1..C1-F3, C2-F1..C2-F6, C3-F1..C3-F8      ✓
  backlog         : C2-F6 only                                          ✓
  launch          : none — D-Q1 honoured, no launch status invented     ✓
learning_paths    : 15  → 9 professional + 6 sector                     ✓
learning_path_courses : 71 (expected 71)                                ✓
C1-F1 at position 1 in every path : yes, 0 exceptions                   ✓
```

### Migration 030 — all six mappings verified directly

| Code | Course slug |
|---|---|
| C1-F1 | `les-fondamentaux-de-l-experience-client` |
| C1-F2 | `les-fondamentaux-du-service-client` |
| C1-F3 | `communiquer-avec-les-clients-sur-les-canaux-digitaux` |
| C2-F1 | `manager-une-equipe-orientee-client` |
| C2-F2 | `mesurer-l-experience-client` |
| C2-F4 | `gerer-les-reclamations-et-transformer-l-insatisfaction-en-opportunite` |

No unproduced course was stubbed. Slugs and titles are unchanged.

## 4. Objects still missing

**None.** Structure and data are complete.

## 5. ⚠️ The real finding — production is running the PRE-FIX RLS policies

Verified using the **public anon key** (read-only, the same key embedded in every
page of the site):

```
catalogues             EXPOSED — 3 rows visible to anonymous
course_codes           EXPOSED — 17 rows visible to anonymous
learning_paths         EXPOSED — 15 rows visible to anonymous
learning_path_courses  EXPOSED — 71 rows visible to anonymous
```

During XPA-2 the first draft of 028 gave these tables public `SELECT`
(`USING (true)`). The SQL linter rejected it, and the committed file was changed
to **administrator-only** before the commit landed. **Production was migrated
with the earlier, public version.**

### What is currently exposed

**11 of 17 course codes have no produced course, and all are publicly readable** —
i.e. the product roadmap and backlog:

```
C2-F3 [undecided] Piloter la Voix du Client (VoC)
C2-F5 [undecided] Développer une culture client
C2-F6 [backlog]   Expérience digitale & omnicanale
C3-F1 [undecided] Customer Journey Mapping
C3-F2 [undecided] Customer Journey Design & Simplification
C3-F3 [undecided] Service Design
C3-F4 [undecided] Personas & segmentation client
C3-F5 [undecided] Culture client au cœur de la stratégie
C3-F6 [undecided] Outils CX & Vision Client 360°
C3-F7 [undecided] L'intelligence artificielle au service de l'expérience client
C3-F8 [undecided] Démontrer le ROI de l'expérience client
```

Plus all 15 path compositions and 71 relations — effectively the contents of the
V4 strategy document, served through the API.

**This contradicts ratified decision D-Q5**, which states that the V4 architecture
document must not be publicly served. Disclosure through PostgREST is the same
disclosure by another route.

**Severity: moderate.** No learner data, credentials or personal information is
involved — this is commercial/roadmap confidentiality, not a security breach.
It should be corrected promptly, but it is not an incident requiring the site to
be taken down.

## 6. Can the original migration 028 be safely rerun in full?

**Yes — and doing so IS the fix.** Every statement is idempotent:

| Construct | Idempotent? |
|---|---|
| `create table if not exists` (×4) | ✅ no-op |
| `alter table courses add column if not exists code` | ✅ no-op |
| Constraint adds, guarded by `if not exists (select 1 from pg_constraint …)` | ✅ no-op |
| `create index if not exists` (×4) | ✅ no-op |
| `create or replace function` (×2) | ✅ refresh |
| `drop trigger if exists` + `create trigger` | ✅ refresh |
| `drop policy if exists` + `create policy` | ✅ **replaces the exposing policies** |

Critically, the committed 028 drops the old policy names
(`*_public_select`) *and* creates the corrected ones (`*_admin_select`).
Re-running it therefore removes the public exposure with no other effect.

`courses.code` is **not** dropped or recreated: `add column if not exists` sees
the existing column and does nothing. Slugs, titles and IDs are untouched.

029 and 030 are also idempotent (`on conflict do update`; `update … where code is
null` behind a reassignment guard), so re-running the full set is safe.

## 7. Read-only diagnostic SQL — run this first

Run in the Supabase SQL Editor **for project `eqoqcxkdcxeosjqaafhs`** (confirm the
project selector before running — a wrong project is the likeliest explanation of
the original report).

```sql
-- 7.1 Table registration (expect 4 rows: catalogues, course_codes,
--     learning_paths, learning_path_courses). course_catalogues is NOT expected.
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('catalogues','course_catalogues','course_codes',
                     'learning_paths','learning_path_courses')
order by table_name;

-- 7.2 courses.code column
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'courses' and column_name = 'code';

-- 7.3 Constraints on courses.code (expect courses_code_fkey + courses_code_unique)
select con.conname, con.contype,
       pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
join pg_namespace ns on ns.oid = rel.relnamespace
where ns.nspname = 'public' and rel.relname = 'courses'
  and con.conname in ('courses_code_fkey','courses_code_unique');

-- 7.4 Triggers (expect courses_code_immutable, course_codes_permanent)
select tgname, tgrelid::regclass as table_name, tgenabled
from pg_trigger
where not tgisinternal
  and tgname in ('courses_code_immutable','course_codes_permanent');

-- 7.5 Indexes on the new tables
select tablename, indexname
from pg_indexes
where schemaname = 'public'
  and tablename in ('catalogues','course_codes','learning_paths','learning_path_courses')
order by tablename, indexname;

-- 7.6 RLS enabled?  (expect relrowsecurity = true for all four)
select relname, relrowsecurity, relforcerowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('catalogues','course_codes','learning_paths','learning_path_courses');

-- 7.7 ⚠️ THE KEY QUERY — which policies are actually installed?
--     Expect *_admin_select with qual = is_platform_admin().
--     If you see *_public_select with qual = 'true', production is running the
--     PRE-FIX version and §8 is required.
select tablename, policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('catalogues','course_codes','learning_paths','learning_path_courses')
order by tablename, policyname;

-- 7.8 Seed counts (expect 3 / 17 / 15 / 71)
select 'catalogues' t, count(*) from public.catalogues
union all select 'course_codes',          count(*) from public.course_codes
union all select 'learning_paths',        count(*) from public.learning_paths
union all select 'learning_path_courses', count(*) from public.learning_path_courses;

-- 7.9 Backfill (expect exactly 6 coded courses, 0 uncoded)
select code, slug, is_published from public.courses order by code nulls last;

-- 7.10 C1-F1 first in every path (expect 0 rows)
select p.code
from public.learning_paths p
where not exists (
  select 1 from public.learning_path_courses lpc
  where lpc.path_code = p.code and lpc.course_code = 'C1-F1' and lpc.position = 1
);

-- 7.11 Launch status (expect: C2-F6 = backlog, everything else undecided, none launch)
select status, count(*), string_agg(code, ', ' order by code)
from public.course_codes group by status;

-- 7.12 Migration history — are 028/029/030 recorded?
--      Very likely NOT, if they were applied via the SQL Editor.
select version, name
from supabase_migrations.schema_migrations
order by version desc
limit 15;
```

## 8. Reconciliation — required only for §5 (the RLS policies)

**No structural reconciliation is needed.** The only corrective action is to
replace the four SELECT policies. Two equivalent options:

### Option A (recommended) — re-run the committed migration 028 in full

It is idempotent (§6), and it is the file already in git, so production ends up
byte-consistent with the repository.

```
supabase/migrations/028_academic_model.sql   ← paste the whole file
```

### Option B — targeted policy-only script

If you prefer the minimum possible change:

```sql
-- XPA-2 reconciliation: close public read on the academic model (D-Q5).
-- Structure and data are already correct; this ONLY replaces SELECT policies.
begin;

drop policy if exists "catalogues_public_select"     on public.catalogues;
drop policy if exists "catalogues_admin_select"      on public.catalogues;
create policy "catalogues_admin_select"
  on public.catalogues for select using (public.is_platform_admin());

drop policy if exists "course_codes_public_select"   on public.course_codes;
drop policy if exists "course_codes_admin_select"    on public.course_codes;
create policy "course_codes_admin_select"
  on public.course_codes for select using (public.is_platform_admin());

drop policy if exists "learning_paths_public_select" on public.learning_paths;
drop policy if exists "learning_paths_admin_select"  on public.learning_paths;
create policy "learning_paths_admin_select"
  on public.learning_paths for select using (public.is_platform_admin());

drop policy if exists "lpc_public_select"            on public.learning_path_courses;
drop policy if exists "lpc_admin_select"             on public.learning_path_courses;
create policy "lpc_admin_select"
  on public.learning_path_courses for select using (public.is_platform_admin());

commit;
```

Nothing is dropped or recreated except policies. `courses.code`, slugs, titles,
IDs, enrollments, progress and certificates are all untouched.

### Verification after the fix

```sql
-- Expect four rows, all *_admin_select, all qual = is_platform_admin()
select tablename, policyname, qual
from pg_policies
where schemaname='public'
  and tablename in ('catalogues','course_codes','learning_paths','learning_path_courses')
  and cmd = 'SELECT';

-- Data must be unchanged: 3 / 17 / 15 / 71
select (select count(*) from public.catalogues)            as catalogues,
       (select count(*) from public.course_codes)          as codes,
       (select count(*) from public.learning_paths)        as paths,
       (select count(*) from public.learning_path_courses) as relations,
       (select count(*) from public.courses where code is not null) as coded_courses;
```

Then confirm from outside the database that anonymous access is closed — the
definitive test, since it exercises the real anon key:

```bash
curl -s "https://eqoqcxkdcxeosjqaafhs.supabase.co/rest/v1/course_codes?select=code" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY"
# expect: []   (currently: all 17 codes)
```

Also re-check `/admin/catalogue` still renders — it uses the service-role client,
so it is unaffected by these policies, but confirm rather than assume.

## 9. Supabase CLI linking

```bash
npx supabase link --project-ref eqoqcxkdcxeosjqaafhs
```

Then, **list only** — no repair, no push:

```bash
npx supabase migration list
```

## 10. Migration-history state and repair commands

**Expected finding:** 028, 029 and 030 will appear as *Local* only, with no
*Remote* entry, because they were applied through the SQL Editor rather than the
CLI. The database objects exist; the CLI's history table simply does not know.

**This is the trap to avoid:** with history out of sync, `supabase db push` would
attempt to replay 028–030. They are idempotent, so it would probably succeed —
but it would also silently re-apply, and any future non-idempotent migration in
the same push would be genuinely dangerous.

Run repair **only after** §7 confirms the objects and counts:

```bash
npx supabase migration repair --status applied 028
npx supabase migration repair --status applied 029
npx supabase migration repair --status applied 030

npx supabase migration list   # confirm all three now show Local + Remote
```

Order matters: repair marks history only; it executes none of the SQL.

## 11. XPA-2 database status — FINAL

| Item | Status |
|---|---|
| Schema (028) | ✅ Applied |
| Seed (029) | ✅ Applied and verified — 3 / 17 / 15 / 71, C1-F1 first everywhere |
| Backfill (030) | ✅ Applied and verified — 6 mappings, no invented courses |
| Launch status | ✅ D-Q1 honoured — only C2-F6 backlog, nothing marked launch |
| Slugs / titles / IDs | ✅ Unchanged |
| RLS policies | ✅ **Corrected — admin-only, anon reads return 0 rows** |
| CLI migration history 028–030 | ✅ local == remote |
| CLI migration history 001–027 | ⚠️ Local-only — **non-blocking ledger debt**, see §13 |

## 12. XPA-3 readiness

**Unblocked.** The policy fix landed before XPA-3 began, which was the important
sequencing: had discovery been built first, it would have sat on top of an
accidental public-read policy and the exposure would have become
indistinguishable from intended behaviour.

XPA-3 must add a **narrow, deliberate** public read policy — paths, plus only
those course codes that have a published course — never re-open the registry
wholesale. D-Q1 still gates any launch-cohort filtering.

## 13. Migrations 001–027 — historical ledger debt (non-blocking)

`supabase migration list` shows 001–027 as **Local only**. This is a
**bookkeeping** discrepancy, not a schema discrepancy: those migrations were
applied to production long before the CLI was linked, and their objects
demonstrably exist — the platform runs on them daily (RLS policies, `audit_log`,
migration 027's anti-escalation trigger, the certificates bucket, and so on, all
verified in earlier phases).

**Explicitly NOT to be repaired blindly.** `migration repair --status applied`
writes history without executing anything, so a blanket repair would assert
"applied" for 27 files nobody has verified object-by-object. If any one of them
was only partially applied, that assertion would permanently hide the gap — the
same class of error that produced the false 028 report, but silently and at 27×
the scope.

**Required before any repair:** a separate object-by-object audit per migration
(tables, columns, constraints, indexes, triggers, policies), then repair only
the ones proven complete.

**Why it is non-blocking:** the risk is confined to `supabase db push`, which
would attempt to replay unrecorded migrations. Since 028–030 are now correctly
recorded, the practical rule is simply: **do not run `supabase db push` against
production** until the ledger audit is done. Continue applying migrations
explicitly, as was done for 028–030.

Tracked as a standalone work item; it gates nothing in XPA-3.

---

**Production initialization: PASS.** No production change was made by this
document. XPA-3 has not begun.
