# XPA-8 WC-2 — Storage path and legacy URL disclosure

**Status: RECORDED · PROPOSAL ONLY.** No policy, grant, migration, data or application code has
changed. This is a separate work item from WC-1 (migration 050) and must not be folded into it.
**Recorded:** 14 September 2026, from the WC-1 Phase 0 findings.
**Owner ruling (14 September 2026):**

> Internal storage object paths must NOT be disclosed to anonymous visitors or to
> authenticated-but-unentitled users. Prefer that entitled learners also do not receive raw
> internal storage paths in browser-visible data when protected server-side delivery can
> provide the required media access. The legacy `video_url`, `pdf_url` and `subtitle_url`
> columns are to be assessed for the same treatment.

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

**Ordering constraint:** application change deployed and verified **before** the grant change is
applied. Rollback is re-granting table-wide `SELECT`, which restores today's exposure.

## 8. Not in scope

- WC-1 / migration 050 (separate, already prepared).
- `certificates.pdf_object_path` — readable only by the certificate owner under RLS; not a
  disclosure to anonymous or unentitled callers. Record, do not change.
- Clearing legacy URL data (owner ruling required; see 4.3).
- Content holds: C2-F2 and C2-F5 (AUTHOR / COMPLETE), the 8th published course (HOLD).
