# XPA-8 WC-2 — Storage path and legacy URL disclosure

~~Status: RECORDED · PROPOSAL ONLY. No policy, grant, migration, data or application code has
changed.~~ This is a separate work item from WC-1 (migration 050) and must not be folded into it.

~~Status (16 September 2026): REVALIDATED · SEQUENCING CORRECTED · WC-2A (migration 054) PREPARED,
NOT APPLIED.~~ Sections 0.1–0.5 below supersede this document wherever they disagree with it.

**Status (25 September 2026): ✅ CLOSED — production PASS.** All three steps are live: 054
(derived fields, applied 17 September), WC-2B (application cutover, merge `d52cf67`) and 055
(column restriction, merge `bf5975a`, applied and verified 65/65 with zero discrepancies).
Anonymous callers can no longer read any of the six raw lesson media columns — every attempt,
including `select *`, a mixed select, a filter and an embed, answers SQLSTATE 42501. Evidence:
[xpa-8-wc-2-closure.md](xpa-8-wc-2-closure.md).
**Recorded:** 14 September 2026, from the WC-1 Phase 0 findings.
**Owner ruling (14 September 2026):**

> Internal storage object paths must NOT be disclosed to anonymous visitors or to
> authenticated-but-unentitled users. Prefer that entitled learners also do not receive raw
> internal storage paths in browser-visible data when protected server-side delivery can
> provide the required media access. The legacy `video_url`, `pdf_url` and `subtitle_url`
> columns are to be assessed for the same treatment.

---

## 0.1 Revalidation — 16 September 2026 (after WC-1 / PR #20, `main` at `d0dba74`)

Read-only: repository audit plus GET-only production probes. Nothing was written.

**Corpus, today** (the 14 September figures in section 2 are superseded):

| | 14 Sep | 16 Sep |
|---|---|---|
| `video_object_path` / `pdf_object_path` / `subtitle_object_path` | 125 / 5 / 0 | 125 / **7** / 0 |
| `video_url` / `pdf_url` / `subtitle_url` | 83 / 3 / 0 | **77** / 3 / 0 |
| legacy URL values in total | 86 | **80** — every one a dead (HTTP 400) public `course-media` URL beside an object path |
| URL-only rows (a legacy URL with no object path) | 0 | 0 |
| external (non-Supabase) URLs | 0 | 0 |
| preview rows visible to `anon` | 22 | **28**, carrying **28** video and **4** PDF object paths |

The change from 24 to 28 preview rows, and a new C1-F3 module and lesson (19:09–19:10 UTC), are
concurrent owner authoring, not WC-2 drift. The database shows *what* changed, not *why*.

**Legacy URL attrition (observed, accepted).** The admin lesson editor seeds each asset field
from `object_path ?? url` and the save action (`splitAsset`) stores a path in `*_object_path`
and `null` in `*_url`. Saving any migrated lesson therefore clears its dead legacy URL. That is
how 86 became 80. WC-2 neither restores nor clears these values.

**Exposure matrix**

| Caller | Rows | Raw columns received | Can a path fetch the file? |
|---|---|---|---|
| anonymous | published preview rows (28) | all six | no — every storage endpoint 400; media route 401 |
| signed in, unentitled | the same rows (policy analysis; not probed) | all six | no — media route 403 |
| entitled learner | the whole course | all six, into browser memory and the sidebar | only through `/api/media` (by design) |
| platform admin, own session | all | all six | yes |
| admin authoring pages | service role on the server, then **passed to the admin browser** | all six | trusted/admin exposure — see 0.2, decision 5 |
| service role (media route, admin actions) | all | all six | signs URLs |

- The only browser reader of the raw columns is the `'use client'` learn player (both of its
  `modules → lessons(...)` selects) and the `LessonSidebar` row type. Every other lesson read in
  `app/`, `components/` and `lib/` selects ids and titles, or runs with the service role.
- `public_course_lessons`, `public_course_modules` and `my_course_access` carry no media column.
- `is_preview` is deliberately not a delivery authority (W3), so the paths sent to anonymous and
  unentitled callers serve no function at all.
- Buckets: `course-content` private, `certificates` private, `course-media` **public** (covers, plus
  dead legacy objects), `course-videos` **public** (pilot-era orphan, created by no migration).

## 0.2 Owner decisions — 16 September 2026

1. **Split approved.** 054 adds derived fields only. 055 restricts `SELECT` later, after the
   compatible application is deployed and verified. 054 and 055 are never combined.
2. **Shape:** `*_source` (`protected` | `external` | NULL) plus `*_external_url`. No booleans.
3. **External rule, fail-closed:** only a genuinely non-Supabase http(s) host may be external.
   Supabase-hosted URLs and `/storage/v1/` URLs or paths are always internal and never populate
   `*_external_url`. Unknown, malformed, relative, non-http(s) or ambiguous values are never external.
4. **Grants:** WC-2 changes `SELECT` only; no INSERT / UPDATE / DELETE change.
5. **Admin editor:** its browser exposure is accepted for WC-2 as trusted/admin exposure, not
   anonymous or learner exposure. The editor is not redesigned.
6. **Legacy URLs:** attrition through the editor is accepted. The 80 values are not restored,
   rewritten, cleared, backfilled or preserved by WC-2.
7. **C1-F3 / C1-F2:** concurrent owner authoring; not modified or reversed.
8. **Production identities:** no accounts created and no mutating verifier run. At the production
   verification gate, exact manual tests for an existing entitled learner and an existing
   unentitled account are specified first.
9. **Out of scope** (separate follow-up security items, **not** resolved by WC-2): the public
   orphan `course-videos` bucket; certificates; narrowing `course-media` public access; general
   Storage architecture.
10. **Documentation** approved.

## 0.3 Corrected architecture and sequencing

The original single-migration design (section 4.1) had **no safe deployment order**: applied
first, the grant change makes the current player's whole `modules → lessons` select fail with
42501; deployed first, the new player selects columns that do not exist yet. It is replaced by
four gated steps, each leaving the system usable:

| Step | What | Safe because |
|---|---|---|
| **WC-2A — migration 054** | adds six generated, stored fields; no grant, policy or data change | nothing reads them yet; every existing read is unchanged |
| **WC-2B — application release** | the player selects `*_source` / `*_external_url` only; sidebar and shared types drop the raw fields; verifiers re-expressed | the fields exist, and the raw columns are still readable |
| **Production playback verification** | manual tests on existing accounts (decision 8) | — |
| **WC-2C — migration 055** | `SELECT` on the six raw columns withheld from `anon` and `authenticated` (038 pattern) | no deployed reader still uses them |

## 0.4 WC-2A — the 054 contract

Per kind *k* ∈ {video, pdf, subtitle}, first match wins:

| # | Condition | `k_source` | `k_external_url` |
|---|---|---|---|
| 1 | `k_object_path` non-empty | `protected` | NULL |
| 2 | `k_url` NULL or empty | NULL | NULL |
| 3 | `k_url` contains `supabase`, or `storage` + (`/`, `\`, `%2f`, `%252f`…) + `v1`, case-insensitive | `protected` (internal) | NULL |
| 4 | `k_url` ≤ 2048 chars and matches `^https?://` + DNS hostname (letter/digit/hyphen labels, alphabetic TLD) + optional `[/?#]` and RFC 3986 characters, to end of string | `external` | `k_url` |
| 5 | anything else | NULL | NULL |

Rule 4 therefore refuses userinfo (`@` in the authority), ports, IP literals, `localhost`,
whitespace and control characters, quotes and angle brackets, protocol-relative and relative
values, and every non-http(s) scheme. Rule 3 is deliberately broad: `https://supabase.com/...`
is also withheld. A lesson whose only value is an internal URL gets `protected`; the media route
only delivers object paths, so it has no playable asset, which is already true today.

Agreement with today's `resolveAssetSource()` is exact for every row except a URL-only value that
rules 3 or 5 withhold. The live corpus has none: **127 / 127 rows agree for every kind.**

**Verification.** The migration proves at apply time, in one REPEATABLE READ transaction:
- the table ACL, every column ACL and every policy on `lessons` are unchanged;
- lessons, modules, courses and storage buckets are fingerprinted unchanged;
- the six fields are generated and stored, each depends only on its own two raw columns, and
  the three kinds carry identical rules;
- every live row agrees with `resolveAssetSource()` (or is counted as withheld);
- no external field carries a Supabase host, storage path or object path;
- 47 adversarial cases × 3 kinds classify as specified through the real columns, re-derive on
  update and cannot be forged (428C9); the fixture is rolled back and proven gone.

Offline, on PostgreSQL 17 with production's policies, the file applies against a synthetic corpus
and against the live corpus (read GET-only, held in memory). The exact selects of the learn
player (anon, unentitled, entitled, admin, service), the media route and the admin editor return
identical rows and values before and after. 23 / 23 migration mutants and 19 / 19 suite mutants
are caught.

## 0.5a WC-2A — APPLIED (17 September 2026)

Migration 054 was applied to production on 17 September 2026 and verified GET-only: the six
derived fields exist and are text; the distribution is video 125/0/2, pdf 9/0/118, subtitle
0/0/127 protected/external/none; all 381 lesson × kind classifications agree with
`resolveAssetSource()`; every `*_external_url` is NULL; raw media, preview flags, content,
structure, modules, courses, publication, row counts, buckets and governance were all unchanged;
no fixture row and no snapshot table survived. The raw columns stayed readable, as 054 intends.

(An earlier attempt did not commit — it aborted on 054's own "existing lesson data changed"
check, consistent with concurrent authoring during the apply window. Nothing was applied by it.
The re-apply ran with authoring paused.)

## 0.5b WC-2B — application cutover (this release)

**The browser contract, before → after:**

| | Before | After |
|---|---|---|
| Player lesson select (both loaders) | `content, video_url, subtitle_url, video_object_path, subtitle_object_path, pdf_url, pdf_object_path, …` | `content, video_source, video_external_url, subtitle_source, subtitle_external_url, pdf_source, pdf_external_url, …` |
| Protected asset | path in the browser; `lessonAssetSrc()` mapped it to `/api/media/lesson/<id>/<kind>` | `*_source = protected` → the same route; **the location never reaches the browser** |
| External asset | legacy `*_url`, whatever it held | `*_source = external` → `*_external_url`, which the database guarantees is not an internal location |
| No asset | both columns null | `*_source = null` |
| `SidebarLessonRow` DTO | carried `video_object_path`, `subtitle_object_path`, `pdf_object_path`, `pdf_url`, `video_url`, `subtitle_url` | carries `*_source` / `*_external_url` only |

`lessonAssetSrcFromSource()` is the browser resolver. `resolveAssetSource()` and
`lessonAssetSrc()` remain for trusted server callers and as the reference 054 restates in SQL.

**Unchanged, deliberately:** `/api/media/lesson/[lessonId]/[kind]` still resolves the object path
itself with the service role and signs it; the admin editor page, save action and upload still
read and write all six raw columns through the service role; `certificates` is untouched.

**Proof that 055 is now safe** (offline, PostgreSQL 17, live corpus of 127 lessons): with the raw
columns revoked from `anon` and `authenticated` in a sandbox, the new player query still succeeds
as anonymous, as a signed-in unentitled learner and as an entitled learner; the old query and
`select *` are refused with 42501; anonymous callers still see their preview rows with a usable
media contract; and the service-role media route, admin editor and admin writes are unaffected.

## 0.5c WC-2B — DEPLOYED and verified (24 September 2026)

PR #22 merged as `d52cf67`; Vercel production READY on it; 5/5 CI and Security checks.
Verified GET-only against production: the learn-player chunk is the only client chunk carrying
the derived fields and the media route, and no learner-facing chunk carries a lesson location
(the admin editor chunk does, which Decision 5 accepts, and two certificate chunks carry
`certificates.pdf_url`, a different table). Anonymous requests to `/api/media/lesson/<id>/video`
and `/pdf` answer 401 without redirecting to storage; an absent asset and an unknown kind answer
404. All 381 derived values still agree with `resolveAssetSource()`.

## 0.5d WC-2C — migration 055 (prepared, NOT applied)

**What it does.** One transaction:

```
revoke select on public.lessons from anon, authenticated;
grant  select (id, module_id, slug, title, title_fr, content, duration_minutes, order_index,
               is_preview, created_at, video_source, video_external_url, pdf_source,
               pdf_external_url, subtitle_source, subtitle_external_url)
  on public.lessons to anon, authenticated;
```

The 16 columns are enumerated, never computed: a column added later is unreadable by the browser
roles until someone grants it deliberately. The six locations are **not dropped** — the service
role keeps them for signing, upload, replacement and administrative editing.

**What it asserts at apply time**, failing closed on any of them: 054 is live (6 generated
derived columns) and the raw columns still exist; the migration has not already been applied and
both roles currently hold table-level SELECT; after the change neither role holds table-level
SELECT nor any of the six locations, both hold all 16 granted columns, nothing is granted to
PUBLIC, no non-SELECT privilege moved, and `service_role`/`postgres` are untouched; as each role,
every location, a mixed select and `select *` are refused with **42501** while the WC-2B player
query, every content table and both public views still evaluate; policies, derived-column
definitions, the column set, lesson/module/course data, buckets and counts are unchanged; and
each role still sees the same number of lesson and module rows as before.

**Proven offline** (PostgreSQL 17, live corpus of 127 lessons, 050 + 054 applied from their
files): after the real 055 every location, mixed select and `select *` is refused with 42501 as
anon, as a signed-in unentitled learner and as an entitled learner; the WC-2B player query still
returns 38 / 38 / 58 rows; anonymous visibility stays at 38 lessons and 22 modules; the service
role still resolves 125 object paths, reads the admin editor shape and writes lessons; no lesson
data changes; no snapshot artifact survives. 18 mutants were written and all are caught —
including a neutered preflight, which only fails in a world where 054 is absent, and an
over-restriction that would break the player.

**Verifiers re-expressed.** `verify-xpa-6a` and `verify-publication-governance` previously read
the locations as anon or as a learner; they now assert the refusal (42501) instead, keeping the
storage-reachability check by resolving a path with the service role first.

**Exposure this closes.** At preparation time anonymous callers received 38 video and 9 PDF
object paths on the published preview rows. After 055 they receive none.

## 0.5e WC-2C — APPLIED and verified (see the closure record)

Migration 055 was applied in production after the 24 September 2026 20:43 UTC pre-apply baseline
and verified GET-only: **65/65 PASS, zero discrepancies**. The six locations, `select *`, mixed
selects, filters and embeds are all refused with 42501 for anonymous callers; the 16 granted
columns and the WC-2B player query still work (38 lessons); the raw columns remain physically
present and the service role still resolves 125 video and 9 PDF paths; derived distribution,
row visibility, publication, preview flags, counts, fingerprints, RLS, governance, RPCs and
storage buckets are unchanged; no artifact survived. Full record:
[xpa-8-wc-2-closure.md](xpa-8-wc-2-closure.md).

## 0.5 Verification plan for the later steps ~~(not yet executed)~~ — EXECUTED

- **054 in production:** GET-only. The six fields appear in the API schema, service-role values
  agree with `resolveAssetSource()` on every row, and anonymous reads return the same row count
  (raw columns still readable, as expected).
- **WC-2B (prepared, not deployed):** offline and Preview first. At the production gate, manual tests on an existing
  entitled learner (a protected video and PDF play through `/api/media`, and no `*_object_path`
  or legacy `*_url` appears in the browser's REST responses) and on an existing unentitled
  account. These are specified before any run.
- **055 (prepared; see 0.5d):** each raw column returns 42501 for `anon` and `authenticated`; the
  permitted list still reads; every content table and view still evaluates (no 42P17); answer keys
  (038) unchanged. After applying: re-run the two re-expressed verifiers, and confirm a protected
  video and PDF still play for an entitled learner.

---

## 1. The finding

`public.lessons` carries six asset columns:

| Column | Holds | Introduced |
|---|---|---|
| `video_object_path`, `pdf_object_path`, `subtitle_object_path` | object path inside the PRIVATE `course-content` bucket | 041 |
| `video_url`, `pdf_url`, `subtitle_url` | legacy URL — a Supabase public-bucket URL, or an external host | 006 / 007 / 009 |

RLS decides which **rows** a caller sees. Nothing decides which **columns**: `anon` and
`authenticated` hold table-wide `SELECT` on `public.lessons` (Supabase default grants), so every
row a caller may see arrives with all six columns. Migration 038 added column-level revocation for
answer keys; no equivalent exists for asset locations.

## 2. Measured (read-only census, 14 September 2026, 9 GET requests, no writes)

| Column | Rows with a value | Shape | Also has an object path | Still serves bytes anonymously |
|---|---|---|---|---|
| `video_object_path` | 125 (83 + 42) | private-bucket path | — | no (400) |
| `pdf_object_path` | 5 | private-bucket path | — | no (400) |
| `subtitle_object_path` | 0 | — | — | — |
| `video_url` | **83** | Supabase **public** `course-media` URL | **83 of 83** | **no — HTTP 400** |
| `pdf_url` | **3** | Supabase **public** `course-media` URL | **3 of 3** | **no — HTTP 400** |
| `subtitle_url` | 0 | — | — | — |

Anonymous reads of the 22 published preview rows today:

| Column | Rows returned | Carrying a value |
|---|---|---|
| `video_object_path` | 22 | **22** |
| `pdf_object_path` | 22 | **2** |
| `video_url` / `pdf_url` / `subtitle_url` | 22 | 0 — incidental: none of today's preview lessons has a legacy URL |

So the ruled disclosure is live today for object paths, and **latent** for legacy URLs: the moment
an older lesson (one of the 83) is flagged preview, its public-bucket URL is served to anonymous
callers too. The file itself is not retrievable (W3 moved the originals private; the legacy URLs
return 400), but the URL discloses the same bucket layout and object name the ruling protects.

## 3. Who reads these columns

| Reader | Client | Columns | Affected by a column restriction? |
|---|---|---|---|
| Lesson player — `loadCourse` (entitled learner) | **browser, user JWT** | all six | **yes — the only browser-visible reader** |
| Lesson player — `loadCourseAnon` | browser, anon key | all six | yes, but unreachable in production: `/learn` redirects anonymous callers to login (307) |
| `/api/media/lesson/[id]/[kind]` | service role, server | object paths | no |
| Admin lesson editor (`admin/modules/[id]/edit`) | service role, server | all six | no |
| Admin save action | service role, server | writes all six | no |
| `public_course_lessons` view (039) | definer view | none of the six | no |
| `verify-xpa-6a`, `verify-publication-governance` | anon key | select object path columns | **yes — must be re-expressed** |

The player uses the columns for one decision only: `resolveAssetSource()` — *a path means "we host
it, deliver through `/api/media/…`"; otherwise a URL means "someone else hosts it, use it as-is"*.
It never needs the path itself; it needs to know **that** one exists.

An unentitled authenticated learner never reaches the modules query (`loadCourse` redirects on
`my_course_access.has_access = false` first), but PostgREST does not care: the same JWT can call
`/rest/v1/lessons` directly and receive the columns for any preview row.

## 4. Recommended design

**Principle:** the browser learns *what kind* of asset a lesson has, never *where* it is stored.
The server resolves location, after the entitlement check it already performs.

### 4.1 Database (one forward migration — next free number, proposed **054**; 051 stays reserved)

> **Superseded 16 September 2026 (section 0.3).** Split into 054 (derived fields only) and a later
> 055 (column privileges), with the application release between them.

1. Add browser-safe derived columns, `GENERATED ALWAYS AS … STORED`:
   - `video_source`, `pdf_source`, `subtitle_source` — `'protected'` when the object path is set;
     `'external'` when only a legacy URL is set **and** it is not a Supabase storage URL;
     otherwise `null`.
   - `video_external_url`, `pdf_external_url`, `subtitle_external_url` — the legacy URL **only**
     when its host is not this project's Supabase storage; otherwise `null`.
2. Column privileges, the 038 pattern:
   `revoke select on public.lessons from anon, authenticated;` then
   `grant select (<every column except the three *_object_path and the three legacy *_url>) on public.lessons to anon, authenticated;`
3. Apply-time verification that **exercises** the grant: as `anon` and as `authenticated`,
   selecting any of the six raw columns must fail with `42501`, selecting the permitted list must
   succeed, and every content table must remain evaluatable (no `42P17` — the 050 discipline).

Service role and platform-admin server code are unaffected: they use the service-role client,
which does not go through these grants.

### 4.2 Application

- Player queries select `video_source, video_external_url, …` instead of the six raw columns.
- `lessonAssetSrc()` takes `(lessonId, kind, source, externalUrl)`: `'protected'` →
  `/api/media/lesson/<id>/<kind>`; `'external'` → the external URL; `null` → no asset.
- `LessonSidebar` / `LessonRow` types drop the raw columns.
- **Entitled learners therefore also stop receiving raw storage paths**, satisfying the owner's
  preference, with no loss of function: protected delivery already resolves the path server-side.

### 4.3 The legacy URL columns — assessment

| Question | Evidence | Conclusion |
|---|---|---|
| Do they still deliver anything? | 83 video + 3 PDF, all Supabase public-bucket URLs, all **400** | no — dead references |
| Is any lesson relying on them? | every one also has an object path; path wins in `resolveAssetSource()` | no |
| Do they disclose storage layout? | yes — bucket name and object name | **same treatment as object paths** |
| Are external (non-Supabase) URLs present? | 0 today | keep a browser-safe `*_external_url` so an external embed remains possible |

**Recommendation:** treat Supabase-hosted legacy URLs exactly like object paths (never browser
visible). Separately — and **only with an owner ruling**, because it is a data change — the 86 dead
legacy values could later be cleared; that is optional hygiene, not required for the disclosure
fix, and is **not** proposed as part of WC-2.

## 5. Regression tests

1. As `anon`: `select video_object_path` (and each of the other five) → **42501**, not 200.
2. As `authenticated` unentitled: same → **42501**.
3. As an **entitled** learner: raw columns → **42501**; `*_source` / `*_external_url` → readable.
4. Player, entitled learner: a protected lesson resolves to `/api/media/lesson/<id>/video` and
   plays; a PDF resolves to `/api/media/lesson/<id>/pdf`.
5. An external-URL fixture still renders as an external embed.
6. `anon` `select *` on `lessons` fails loudly rather than silently narrowing — and no application
   code issues `select *` on `lessons` through a user client (asserted).
7. Admin editor and save action unaffected (service role).
8. `verify-xpa-6a`: "anon lessons expose no object path" becomes a **privilege** assertion
   (`EXPECTED_DENIAL`), like `correct_answer` after 038; add the legacy URL columns.
9. `verify-publication-governance`: its anon probe stops selecting `video_object_path`.
10. Mutation tests: re-grant a raw column; drop the generated column; make `lessonAssetSrc`
    fall back to a raw path.

## 6. Migration requirement

**Yes.** Column privileges and generated columns are database state. Number proposed: **054**
(requires owner approval; 051 remains reserved; 046 remains withdrawn).

## 7. Compatibility impact

| Surface | Impact |
|---|---|
| Anonymous preview browsing | none in practice — no reachable anonymous player path uses these columns |
| Entitled learner playback | **requires the application change to ship with, or before, the migration**; migration first would make the player's query fail with 42501 |
| Admin authoring | none (service role) |
| Media delivery route | none (service role) |
| Public catalogue views | none |
| Production verifiers | two must be updated in the same release |

> **Corrected 16 September 2026:** this ordering was unsatisfiable while both changes shared one
> migration. See section 0.3.

**Ordering constraint:** application change deployed and verified **before** the grant change is
applied. Rollback is re-granting table-wide `SELECT`, which restores today's exposure.

## 8. Not in scope

- WC-1 / migration 050 (separate, already prepared).
- `certificates.pdf_object_path` — readable only by the certificate owner under RLS; not a
  disclosure to anonymous or unentitled callers. Record, do not change.
- Clearing legacy URL data (owner ruling required; see 4.3).
- Content holds: C2-F2 and C2-F5 (AUTHOR / COMPLETE), the 8th published course (HOLD).
