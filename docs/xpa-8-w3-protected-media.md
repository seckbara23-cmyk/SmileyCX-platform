# XPA-8 W3 — Protected Storage Delivery (F-2)

**Status:** 🟠 **IMPLEMENTED, NOT YET CLOSED** — closure requires operator steps
**Baseline:** `e9661ab` (XPA-8 W2 closed)
**Schema change:** migrations **041** and **042** — written, **NOT applied**
**Production state:** unchanged. No bucket flipped, no object moved or deleted.

**Invariants established:**

> knowing an object path or a historical URL is **not** authorization
> only the owner (or an authorized server path) may retrieve a certificate

---

## 1. Root cause

Row-level security protected the lesson **row**. Nothing protected the **file**.

`has_course_access()` decided who could read `lessons`. Delivery went straight
from the browser to Supabase Storage over a permanent public URL stored in
`lessons.video_url`, and Storage had never heard of entitlements.

**The mechanism, precisely.** For a bucket with `public = true`, the route
`/storage/v1/object/public/<bucket>/<path>` serves the object **without
evaluating `storage.objects` RLS at all**. This is why 018's `cert_owner_select`
policy — which is written correctly — never protected a single byte: the public
route never consulted it. Bucket privacy is not one layer of the model; it is
the precondition for the model existing.

Migration `007` states the original intent in a comment: *"Public read (anyone
can view files — URLs are used in lessons)"*. That was true of a pilot with no
paying learners. It survived into a platform selling six courses.

### Measured before any change

| Probe | Result |
|---|---|
| lesson with `is_preview = false`, API row visible to anon | **0 rows** (RLS correct) |
| …its video, `GET /object/public/…`, no credentials | **200 · video/mp4 · 15,197,486 bytes** |
| …the same object over the RLS route | **200** |
| anon `LIST course-media/video` | **200 — 149 objects enumerated** |
| anon `LIST course-media/pdf` · `/cover` | **3** · **24** |
| authenticated learner, `has_course_access() = false` | **200 — full download** |
| enrolled-but-unentitled learner | **200** |
| synthetic certificate for learner B, fetched anonymously | **200** |
| …fetched by a different signed-in learner | **200** |
| learner INSERTs a PDF into another learner's folder | **200 — folder went 0 → 1** |

The last one is not a read exposure. 018 created two policies with no `TO`
clause, so they applied to `PUBLIC` — every role:

```sql
cert_service_insert  FOR INSERT WITH CHECK (bucket_id = 'certificates')
cert_service_update  FOR UPDATE USING      (bucket_id = 'certificates')
```

Their names say "service". Their effect said "anyone". Any signed-in learner
could plant or overwrite a certificate in any other learner's folder. It is
harmless today only because zero certificates exist.

**"The URL is secret" was never true.** The anon key ships in the client bundle
by design, and it is enough to enumerate the whole bucket. There was no
obscurity to fall back on.

---

## 2. Bucket inventory

| Bucket | public | Objects | Purpose | Intended audience | Disposition |
|---|---|---|---|---|---|
| `course-media` | **true** | `cover/` 24 png · `pdf/` 3 · `video/` 149 | mixed course media | **split**: covers public, rest protected | **stays public, keeps `cover/` only** |
| `course-videos` | **true** | 5 mp4 at root | pilot-era videos | unknown | **orphan — see §9** |
| `certificates` | **true** | **0** | learner certificates | user-private | **→ private** |
| `course-content` | — | — | — | learner-protected | **NEW, private** |

**Storage policies found.** Only two migrations touch storage:

- `007` — `"course-media public read"`: `FOR SELECT USING (bucket_id = 'course-media')`.
  Unconditional, every role. Combined with `public = true` this is why anon can
  both read and list.
- `018` — `cert_owner_select` (correct, never ran), plus the two permissive
  write policies above.

`course-videos` is created by **no migration in the repository** — D-LEDGER
drift. It has no SELECT policy, which is why anon cannot LIST it, but
`public = true` still serves every object by path.

**Where the URLs live.** Every stored value is an absolute public URL:

| Column | Non-null | Points at |
|---|---|---|
| `lessons.video_url` | 90 | `public:course-media` ×90 |
| `lessons.pdf_url` | 3 | `public:course-media` ×3 |
| `lessons.subtitle_url` | 0 | — |
| `courses.cover_url` | 6 | `public:course-media` ×6 |
| `courses.intro_video_url` | 0 | — |
| `certificates.pdf_url` | 0 | — |

No canonical object paths existed anywhere. §6 of the brief asked whether they
should; they did not, and now they do.

---

## 3. Architecture — reused, not invented

```
private object  →  authorization check  →  short-lived delivery capability
```

**The authorization step is not new code.** Course media calls
`resolveCourseAccessById()`, the same seam the learn page, the course layout and
`has_course_access()` in SQL already use. There is no second access model.
Asserted by test: the delivery route contains no reference to `enrollment`,
`organization`, `is_org_member`, `PLATFORM_MODE`, `PILOT_MODE`,
`FREE_ACCESS_MODE` — **or `is_preview`**, so F-1 cannot become a second
authority over the file.

Certificates reuse the rule `/api/certificates/[id]/pdf` already enforced —
`cert.user_id === user.id` — plus the portal's existing `getOwnerSession()`.
A certificate is deliberately **not** gated on current course access: revoking a
course does not un-earn it, and the `access_ended` copy already promises the
learner keeps it.

### Why a redirect per request rather than one long-lived signed URL

Handing the page a one-hour signed URL has a property nobody wants: a learner
whose entitlement is revoked keeps watching for up to an hour. Instead
`<video src="/api/media/lesson/<id>/video">` points at the application, and
**every request — including each Range request a player makes while seeking —
re-enters the handler and is re-authorized against the live entitlement.**
Revocation lands on the next request.

Streaming bytes through the route was rejected: it would push 15 MB videos
through a serverless function, and it would hide the URL from devtools without
hiding it from the person reading devtools.

### Signed-URL lifetime, and why

Because the route re-mints on every request, a TTL only has to outlive the
single fetch that follows the redirect — not the viewing session.

| Kind | TTL | Reason |
|---|---|---|
| video, subtitle | **300 s** | must survive one Range request on a poor mobile connection; this platform's learners are largely in Senegal on mobile networks, where a multi-megabyte range can take minutes |
| pdf, certificate | **120 s** | a single download that begins immediately |

Not 30 s, because a slow range would fail. Not an hour, because the whole point
is that a leaked URL is near-worthless.

**Verified against this project** (throwaway private bucket, then deleted):

| Probe | Result |
|---|---|
| private bucket, `GET /object/public/…` | **400** Bucket not found |
| private bucket, RLS route as anon, no policy | **400** |
| anon LIST | **0 entries** |
| service-role signed URL, no SELECT policy needed | **200** |
| Range request | **206 · `bytes 0-9/35`** |
| object A's token used on object B | **400 InvalidSignature** — path-bound |
| signature byte flipped mid-string | **400 InvalidJWT** |
| `exp` extended without re-signing | **400 InvalidJWT** |
| embedded `url` repointed without re-signing | **400 InvalidJWT** |
| signed for 5 s, refetched at 7 s | **400** |
| valid token after the object is deleted | **400** |

*(An earlier run of this probe reported "tampered token → 200". That was my
probe, not Supabase: flipping the **last** base64url character can decode to
identical bytes. Redone against the middle of the signature, it is rejected.)*

---

## 4. What changed

| File | Change |
|---|---|
| `supabase/migrations/041_protected_media_storage.sql` | **new** — private `course-content`; 4 path columns + CHECKs; `certificates` → private; drops the two permissive write policies; self-verifies |
| `supabase/migrations/042_backfill_media_object_paths.sql` | **new** — backfill, refuses unless every object is already in the private bucket |
| `lib/media/paths.ts` | **new** — pure, isomorphic: identity, precedence, application URLs |
| `lib/media/storage.ts` | **new** — `server-only`; mints signed URLs; TTL table |
| `app/api/media/lesson/[lessonId]/[kind]/route.ts` | **new** — entitlement-checked 302 |
| `app/api/media/certificate/[certificateId]/route.ts` | **new** — ownership-checked 302 |
| `app/api/admin/upload-url/route.ts` | destination decided by kind; **no `publicUrl` for protected**; the `createBucket({public:true})` call on every request is gone |
| `app/api/certificates/[id]/pdf/route.ts` | persists `pdf_object_path`; returns the application URL; `getPublicUrl` removed |
| `app/(learn)/…/[lessonId]/page.tsx` | player resolves through `lessonAssetSrc` |
| `app/(admin)/…/edit/LessonEditor.tsx` + `actions.ts` | carries paths; server decides column from the value |
| `components/lms/LessonSidebar.tsx`, `types/index.ts` | path fields |
| `scripts/security/migrate-media-objects.mjs` | **new** — operator object migration |
| `scripts/security/verify-xpa-8-storage.mjs` | **new** — production verifier |
| `__tests__/security/xpa-8-w3-protected-media.test.ts` | **new** — 55 regressions |

**No applied migration was edited.** 037–040 are untouched, asserted by test.

### Database representation

New columns rather than rewriting `video_url`, because the two mean different
things and both are needed:

- `video_url` — an absolute URL to something **we do not host** (a YouTube
  embed, a partner CDN). The player already branches on file extension to
  choose `<video>` vs `<iframe>`, so external URLs are a supported case.
- `video_object_path` — an object in `course-content`, addressed by path.
  Delivery URLs are derived and expire; **the path is the durable identity.**

A CHECK constraint forbids a path column from ever holding a URL. Precedence
lives in exactly one function.

### The backfill refuses rather than skips

Storage lives in the same database, so 042 joins `storage.objects` and verifies
every object is **already in the private bucket** before recording its path. A
single missing object aborts the migration and changes nothing. A value that is
neither one of our URLs nor a plainly external URL also aborts it. External URLs
are matched explicitly and left alone — not an error, just not ours.

---

## 5. Historical URLs — the part that actually closes F-2

**Making a bucket private does not invalidate an object sitting in a different,
still-public bucket.** So the plan does not rely on that:

1. objects are **copied** to `course-content` (additive, reversible; every
   historical URL still works)
2. 042 backfills paths (players switch to signed delivery)
3. originals are **deleted** from `course-media` — *now* the historical URL dies

Proved on the throwaway bucket: after deletion even a **valid, unexpired signed
URL** returns 400. Deletion, not privacy, is what kills a path.

The operator script refuses to delete unless every object is both present in the
private bucket **and** referenced by a lesson row — deleting an object no row
points at is how a lesson breaks permanently.

**Residual risk:** Supabase's CDN may briefly serve a cached copy of a deleted
public object. The verifier's historical-URL check should be re-run a few
minutes after deletion to confirm the edge has dropped it.

---

## 6. Browser exposure

- `lib/media/storage.ts` is `server-only`; a test also walks every `'use client'`
  file and fails if any imports it.
- `lib/media/paths.ts` — the half a client legitimately needs — contains no key,
  no signing, no access decision.
- The player emits `src="/api/media/lesson/<id>/video"`. **No Storage URL and no
  permanent public URL appears in the learner payload.**
- A signed URL does appear in the network tab as the 302 target. That is the
  chosen architecture; it is valid for 300 s, bound to one object path, and
  re-minted per request.
- Client bundle scan: clean, 93 files against 12 patterns.
- Answer-key protection (XPA-6D) untouched; the delivery route reads no quiz or
  exercise table.

---

## 7. Test and verifier results

| Gate | Result |
|---|---|
| Typecheck · Lint | ✅ 0 errors |
| Full suite | ✅ **783 tests / 26 files** (was 728 / 25) |
| W3 regressions | ✅ **55** |
| SQL lint · assets · secrets · bundle · build | ✅ ✅ ✅ ✅ ✅ |

**38 of the 55 W3 assertions were confirmed to fail against pre-fix `e9661ab`.**
The 17 that pass there are the pure-function tests (the helper module was copied
into the worktree so the suite could load at all) and the stayed-in-lane
invariants.

### One pre-existing test corrected

`xpa-8-w2-legacy-org-surface.test.ts` asserted `migrations.length === 40` — the
count on the day it was written. W3 legitimately adds two. A fixed count would
fail forever for a reason unrelated to W2, so it now asserts the actual
invariant: no migration file claims to be W2 work. This is the same brittleness
recorded against `verify-xpa-6a` under F-1, caught in our own suite this time.

### Production verifier — pre-remediation baseline

`scripts/security/verify-xpa-8-storage.mjs` — deliberately runnable **before and
after**, so the two runs are comparable. It tests real Storage HTTP retrieval,
never bucket metadata.

Current run: **14 of 29 checks FAIL**, and every failure is the exposure this
wave exists to remove — anon public route, anon RLS route, anon enumeration
(150 objects), unentitled learner, enrolled-but-unentitled learner, anonymous
certificate download, cross-learner certificate download, cross-learner
certificate **write**, 153 protected objects still in the public bucket, and a
real historical URL still serving 4,074,127 bytes.

Already passing, and required to keep passing: an enrollment grants no access,
an entitled learner receives the content, Range requests work, a token is bound
to one object, delivery URLs expire, the owner can read their own certificate,
and public marketing covers stay public.

*(An earlier draft of this verifier reported "revocation does not remove access".
That was the verifier's fault: 037 enforces `(status='REVOKED') = (revoked_at is
not null)`, so setting the status alone is a CHECK violation, and the probe never
checked whether its own write landed. It now asserts the write landed before
believing its effect. Corrected, revocation and expiry both pass.)*

### Other verifiers

`verify-xpa-6c` 30/30 · `verify-xpa-6d` 22/22 · `verify-xpa-7` 32/32 ·
`verify-xpa-8-w2` 34/34 · `verify-xpa-6a` **52/57 — unchanged, F-1, not touched.**

---

## 8. ⚠ Deployment sequencing — ORDER IS MANDATORY

**The application code must NOT deploy before migration 041.** Measured against
production right now:

```
GET modules?select=…,lessons(…,video_object_path,…)
  → HTTP 400  {"code":"42703","message":"column lessons_1.video_object_path does not exist"}
```

The learn page treats that as "no modules" and renders *Leçon introuvable*.
Deploying first breaks **every lesson player**.

### Exact operator sequence

| # | Action | Effect if it stops here |
|---|---|---|
| 1 | Apply **041** in the Supabase SQL editor | Columns exist (all NULL); `course-content` created private; `certificates` private (0 objects); two permissive policies dropped. Deployed code doesn't use any of it. **Safe.** |
| 2 | Tell me — I push, CI runs, Vercel deploys | Paths are NULL, so every player falls back to its existing public URL. **Nothing changes for a learner.** |
| 3 | `node scripts/security/migrate-media-objects.mjs` (dry run), then `--copy` | 152 objects exist in **both** buckets. Historical URLs still work. **Reversible.** |
| 4 | Apply **042** | Paths recorded; players switch to signed delivery. Refuses if any object is missing. |
| 5 | `node scripts/security/verify-xpa-8-storage.mjs` | Everything passes **except** the historical-URL checks. |
| 6 | `node scripts/security/migrate-media-objects.mjs --delete-originals` | **Irreversible.** Historical URLs die. Refuses unless every object is copied *and* referenced. |
| 7 | Re-run the verifier | Historical-URL checks flip to DENIED. **F-2 closes here.** |

Rollback before step 6 is: revert the deploy. After step 6, the objects exist
only in the private bucket — still intact, but the public paths are gone.

**Step 1 is yours** (production migration) and **step 2 needs your go-ahead**
(push). Steps 3–7 are yours too (they move and delete production objects). I
have run none of them.

---

## 9. Out of scope, found anyway

- **`course-videos`** — public, 5 mp4 at root (`module-1-experience-client.mp4`
  and similar), created by no migration, referenced by **no code and no DB
  column**. Anonymously downloadable by path. It looks like abandoned pilot
  content. Recommend privatizing or deleting it, but it is not part of the
  lesson-delivery path and **I changed nothing**.
- **`courses.intro_video_url`** — 0 rows, rendered on the *public* course page.
  Marketing; correctly public if it is ever used.
- **F-1** (`is_preview` 20/20 on C2-F2) — untouched, as instructed. Note that
  it interacts with F-2: once media is protected, a preview lesson's row is
  public but its video is not. That is a deliberate product question, not a
  bug: preview currently exposes titles and structure, not files.
- **`cert_service_update` missing `WITH CHECK`** — the SQL linter's known
  baseline finding at `018:33`. 041 drops that policy entirely, so the finding
  disappears once applied. The linter reads files, not the database, so it will
  keep reporting it.

---

## 10. Residual risks

1. **CDN cache** after step 6 — re-verify a few minutes later.
2. **Serverless invocations**: each Range request now hits a function. Fine at
   this scale; worth watching if the catalogue grows.
3. **Safari and 302 for `<video>`** — redirects for media sources are widely
   supported but were not exercised in a real browser here. Step 5 should
   include one manual playback check on Safari/iOS.
4. **`course-videos`** stays publicly readable until someone decides (§9).
5. F-2 is **not closed** until step 7 passes.
