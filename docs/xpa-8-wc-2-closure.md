# XPA-8 WC-2 — Storage path and legacy URL disclosure: CLOSED

**Status:** ✅ CLOSED — production PASS
**Closed:** 25 September 2026
**Design / debt record:** [xpa-8-wc-2-storage-path-disclosure.md](xpa-8-wc-2-storage-path-disclosure.md)
**Predecessor:** [xpa-8-wc-1-closure.md](xpa-8-wc-1-closure.md) (withdrawal contract, migration 050)

**The contract, now enforced in the database:**

> A browser learns WHAT KIND of asset a lesson has, never WHERE a protected one is stored.
> `anon` and `authenticated` cannot read the object paths or the legacy URLs at all. The service
> role keeps them, because the media route signs from them and the admin editor writes them.

---

## What was wrong

RLS decides ROWS, not COLUMNS. `anon` and `authenticated` held table-wide `SELECT` on
`public.lessons`, so every visible row arrived with `video/pdf/subtitle_object_path` and the legacy
`video/pdf/subtitle_url`. Anonymous visitors received the storage paths of every published preview
lesson — **38 video and 9 PDF paths** at the time 055 was prepared — although preview has never
authorized delivery: `/api/media/lesson/<id>/<kind>` re-checks the entitlement and signs
server-side, and `is_preview` is deliberately not a delivery authority (W3). The disclosure was
pure: nothing consumed it.

Migration 038 had already done column-level revocation for answer keys. WC-2 applies that pattern
to asset locations — but the application had to stop reading the columns first, which is why this
took three separately deployed steps.

## The chain

| Step | Change | PR | Reviewed head | Merge | Production |
|---|---|---|---|---|---|
| **WC-2A** | migration **054** — derived `*_source` / `*_external_url` fields, additive only | #21 | `1807b1d5c848a437860cf537acd1356b404d1a04` | `b78f860a3f8f3840d43abd9e4117c97ae705a533` | applied **17 September 2026** |
| **WC-2B** | application cutover: the learn player reads the derived contract | #22 | `ab212d6279537ddcd4356c99118fc42dd36afc7b` | `d52cf670cf9b8e3abc01ce43fe15c2a36c19f36e` | deployed, verified 24 September 2026 |
| **WC-2C** | migration **055** — withdraw `SELECT` on the six raw columns from the browser roles | #23 | `9aea4c7b29cca4bf825a31cef50bb16a748c5d37` | `bf5975ae14e1c6a7a8cc470c654211779a9f40f3` | applied, verified **65/65 PASS** |

The order was mandatory. The original single-migration design had **no safe deployment order**:
applied first, the grant change would have failed the player's whole `modules → lessons` query with
42501; deployed first, a player reading fields that did not exist yet would have failed too. The
revalidation of 16 September found that and split the work.

**055 is the final WC-2 database restriction. There is no migration 056 in WC-2.**

## What each step did

### WC-2A — migration 054 (blob `b0cdf55a28d0`)

Six `GENERATED ALWAYS … STORED` columns on `public.lessons`: `video/pdf/subtitle_source`
(`'protected'` | `'external'` | NULL) and `video/pdf/subtitle_external_url`. Per kind, first match
wins: an object path → `protected`; empty → NULL; a URL mentioning `supabase` or a `storage/v1`
segment in any spelling → `protected` (internal, fail-closed); a clean `http(s)` URL on a public DNS
host (no userinfo, no port, no IP literal, no whitespace, ≤ 2048 characters) → `external` with the
URL; anything else → NULL.

Additive only: no grant, policy, row or storage change. The values are derived by the database and
cannot be written or forged (`428C9`).

### WC-2B — the application (merge `d52cf67`)

Both learn-player loaders select the derived fields; `lessonAssetSrcFromSource()` maps
`protected` → `/api/media/lesson/<id>/<kind>`, `external` → the external URL, NULL → no asset. The
sidebar DTO and the shared `Lesson` type separate the browser-safe fields from the trusted
server/admin locations. `resolveAssetSource()` and `lessonAssetSrc()` remain for trusted callers and
as the reference 054 restates in SQL. No migration, grant or policy changed.

### WC-2C — migration 055 (blob `4d1337e104d6`)

```sql
revoke select on public.lessons from anon, authenticated;
grant  select (id, module_id, slug, title, title_fr, content, duration_minutes, order_index,
               is_preview, created_at, video_source, video_external_url, pdf_source,
               pdf_external_url, subtitle_source, subtitle_external_url)
  on public.lessons to anon, authenticated;
```

The 16 columns are enumerated, never computed: a column added later is unreadable by the browser
roles until someone grants it deliberately. `SELECT` only — no write privilege moved. The six raw
columns are **not dropped**.

---

## Release evidence

| Gate | WC-2A (054) | WC-2B | WC-2C (055) |
|---|---|---|---|
| Offline proof | file applied to PostgreSQL 17 (PGlite) with production policies and the live corpus; 127/127 rows agree with `resolveAssetSource()` | new player query proven to work with the raw columns revoked in a sandbox; old query refused 42501 | real 055 applied to the live corpus; every location, mixed select and `select *` refused 42501 as anon, unentitled and entitled; player query 38/38/58 rows |
| Mutants | **23/23** caught | **19/19** suite mutants caught | **18/18** caught, including a neutered preflight and an over-restriction |
| Structural suite | `wc-2a-derived-media-source` (26) | `wc-2b-derived-media-cutover` (29) | `wc-2c-raw-media-column-restriction` (21) |
| Repository gates | verify exit 0 · ESLint 0 errors · build · bundle · audit | 47 files / 1357 tests | 48 files / 1378 tests |
| GitHub | 7/7 on the PR head; 5/5 on the merge | 7/7; 5/5 | 7/7; 5/5 |
| Vercel production | READY on `b78f860` | READY on `d52cf67` | READY on `bf5975a` |

Both migrations verify themselves at apply time inside one REPEATABLE READ transaction and roll
everything back on any failed assertion.

## Production application

**054 — 17 September 2026.** The first attempt did **not** commit: it aborted on 054's own
"existing lesson data changed" assertion, consistent with concurrent authoring during the apply
window. Nothing was applied by it, which is the fail-closed behaviour it was designed to have. A
fresh baseline was taken, authoring was paused, and the migration was re-applied and verified.

**055 — applied after the 24 September 2026 20:43 UTC pre-apply baseline**, in the Supabase SQL
Editor, reporting *Success. No rows returned*. Applying through the SQL Editor writes no CLI
migration-ledger row, consistent with the existing D-LEDGER practice.

## Post-apply verification — 65/65 PASS, zero discrepancies

Every probe was a GET; nothing was written.

**The disclosure is closed.** As `anon`, every one of these is refused with **HTTP 401, SQLSTATE
42501**:

| Probe | Result |
|---|---|
| each of the six raw columns, selected directly | 42501 ×6 |
| mixed select (granted column + a location) | 42501 |
| `select=*` | 42501 — refused, never silently narrowed |
| derived field + legacy URL together | 42501 |
| **filtering** on a location (`video_object_path=not.is.null`) | 42501 |
| embedded `lessons(video_object_path)` | 42501 |

The previously observed **38 video paths and 9 PDF paths** visible to anonymous callers are gone.

**Everything that had to keep working:**

| Check | Result |
|---|---|
| the 16 browser-granted columns | 16/16 readable |
| WC-2B player query (`modules → lessons` embed) | 200, **38 lessons**, none carrying a location |
| player rows resolving to the protected route | 38/38 with video |
| raw columns still physically present | 22 columns: 6 raw + 6 derived + 10 others |
| `service_role` on the six locations | 6/6 readable |
| media-route and admin-editor lookup shapes | resolvable |
| `service_role` protected locations | **125 video, 9 PDF paths** |
| derived distribution | video **125/0/2**, pdf **9/0/118**, subtitle **0/0/127** |
| agreement with `resolveAssetSource()` | **381/381** |
| internal location in any `*_external_url` | 0 (0 non-null values) |

**Nothing else moved.** Row visibility 38 lessons / 22 modules — exactly the authorized
published-preview set. Counts unchanged: courses 8 (all published), modules 35, lessons 127,
entitlements 7, enrollments 6, lesson_progress 82, certificates 2, audit_log 14. All seven
fingerprints identical, including `lessons_media_columns` `c3e35949a7eb333f`, `lessons_derived`
`de655b36380aa96d`, preview flags, content, modules and publication. Preview flags per course
unchanged. RLS unchanged (quizzes, questions, exercises and certificates still empty to anon;
entitlements and the 038 answer keys still refused). Governance installed; `course_is_published`
still fail-closed; 18 RPCs; storage buckets unchanged (`course-content` and `certificates` private).

**No artifacts:** neither snapshot table exists (`PGRST205`), and no fixture course, module or
lesson remains from either migration.

**Application:** Vercel production is READY on **`bf5975a`**, the WC-2B-compatible build.

---

## Limits of the evidence — recorded, not hidden

- **A real authenticated entitled-learner session was not exercised in production.** Signing in
  writes auth rows, and `verify-xpa-6a` creates accounts by design; the owner ruling of
  16 September (Decision 8) forbids both until a test identity is authorised.
  Authenticated-role behaviour is covered by 055's own §2 and §3, which ran `SET ROLE
  authenticated` inside the committed transaction and asserted that table-level SELECT and all six
  locations are gone and that each location, a mixed select and `select *` answer 42501 — and by
  the offline proof, where an entitled learner kept 58 lesson rows and a working player query with
  the columns revoked. The grant is role-level, so the anonymous results hold identically.
- **Manual entitled video and PDF playback remains a launch / UAT verification item.** It is not an
  unresolved WC-2 implementation defect: anonymous requests to both answer 401 without redirecting
  to storage, the delivery architecture is unchanged, and the service role still resolves every
  object path.
- **Policy text was not read directly.** `pg_policy` is not reachable over the REST API; both
  migrations fingerprint the policies inside their own transactions instead.
- **The offline proofs ran on PostgreSQL 17 (PGlite).** No claim is made about the exact
  PostgreSQL version production runs; the work uses only long-standing features.

## Operational effect

A visitor or a signed-in learner receives, per asset, only "protected", "external" or nothing. A
protected asset is fetched from `/api/media/lesson/<id>/<kind>`, which re-checks the entitlement on
every request — each Range request included — and redirects to a URL valid for minutes. An external
embed still works, and the database guarantees an internal location can never appear in an external
field. Uploading, replacing, signing and administrative editing are untouched.

**Rollback** — the commented block at the foot of 055 restores table-wide `SELECT` for the two
roles, which re-opens the disclosure; the block at the foot of 054 drops the six derived fields and
is safe only if the application no longer reads them.

## Not in WC-2 — recorded as separate items, NOT resolved here

- The **public orphan `course-videos` bucket** (created by no migration; W3 §9).
- **`certificates`** — its own `pdf_url` / `pdf_object_path`, readable only by the owning learner
  under RLS, reached exclusively through service-role routes.
- **Narrowing `course-media`'s public read** to the `cover/` prefix (042's deferred final step).
- **General Storage architecture** review.
- The **68 remaining legacy lesson URLs** — untouched. They are dead (HTTP 400) and now unreadable
  by browsers; the admin editor clears one whenever an author saves a migrated lesson, which the
  owner accepted as natural attrition on 16 September.
- C2-F2 / C2-F5 content, the 8th-course HOLD, AUTH-LAUNCH, payment and email work.
