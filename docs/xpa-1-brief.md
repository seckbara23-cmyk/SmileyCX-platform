# XPA-1 — Brand, Domain and Public-Asset Migration

**Status:** brief only — not implemented. Awaiting GO.
**Inputs:** [XPA-0 audit](xpa-0-audit.md) · [decision register](xpa-decision-register.md)
**Scope discipline:** branding, domain and public-asset handling **only**. No catalogue
schema, no course codes, no path model, no B2B, no payments, no auth changes.

---

## 1. Objective

Complete the SmileyCX → XP Client Academy transition so that every user-facing
surface — UI, metadata, Open Graph, certificates, emails, contact details — carries
the XP Client Academy identity on the canonical domain
`https://www.xpclient-academy.com`, and no internal source document is publicly served.

**Explicitly out of scope:** `courses.code`, catalogues, paths, `path_courses`,
C2-F2 unpublishing (data change — D-Q3 → XPA-2), B2B/org UI (D-Q4 → XPA-7),
random quizzes (D-Q7 → XPA-4), payments (XPA-9).

## 2. Preconditions (hard gates — do not start without these)

| # | Precondition | Why it is a gate |
|---|---|---|
| P-1 | **Q-C answered** — the new contact address exists and receives mail | Changing `bonjour@smileycx.com` to an unrouted address silently drops contact + waitlist mail |
| P-2 | **Q-D answered** — Resend has verified the new sending domain; DNS owner identified | `EMAIL_FROM` on an unverified domain makes **all** transactional email fail |
| P-3 | **Q-A answered** — transparent/vector logo master supplied, *or* explicit acceptance of the opaque-logo limitation | Both current candidates are fully opaque → white box on the dark footer and admin sidebar |

P-1 and P-2 are genuine outage risks, not paperwork. P-3 may be waived with a
documented "light surfaces only" constraint.

## 3. Workstreams

### W1 — Canonical domain correction

Replace wrong-domain fallbacks. Env values win; the **fallbacks** are what change.

| File | Current fallback | Target |
|---|---|---|
| `app/layout.tsx:8` | `https://academy.smileycx.com` (`metadataBase`) | `https://www.xpclient-academy.com` |
| `app/actions/enrollment.ts:109` | `https://smileycx.com` | `https://www.xpclient-academy.com` |
| `app/(admin)/admin/certificates/page.tsx:12` | `https://smiley-cx-platform.vercel.app` | `https://www.xpclient-academy.com` |
| `app/(admin)/admin/certificates/[certificateId]/page.tsx:11` | same | same |
| `app/(admin)/admin/users/[id]/page.tsx:71` | same | same |

The three admin files build **certificate verification URLs**. Today they default to
the *private admin portal* hostname — a certificate a learner shares would point at a
host that redirects strangers to `/login`. This is the highest-value fix in XPA-1.

**Do not touch** `lib/hosts.ts` / `middleware.ts` — their `smiley-cx-platform.vercel.app`
references are the admin-host boundary (D-DOMAIN carve-out).

Also set `NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_APP_URL` in Vercel production to the
canonical domain, and document both in `.env.example` (`NEXT_PUBLIC_SITE_URL` is read
in code but currently undocumented).

### W2 — Contact identity

Five surfaces carry `bonjour@smileycx.com`: `app/(public)/contact/page.tsx:44-45`,
`app/(public)/contact/actions.ts:42-43` (`EMAIL_FROM`/`CONTACT_EMAIL` fallbacks),
`app/(public)/terms/page.tsx:36`, `app/(platform)/checkout/confirm/page.tsx:97`,
`components/layout/Footer.tsx:92-93`, plus `app/actions/waitlist.ts:21-22`.

Replace with the P-1 address. Prefer routing all of them through the existing
`CONTACT_EMAIL` env var rather than hardcoding a second literal.

### W3 — Email branding

`lib/email/index.ts:31` — `FROM` fallback `XP Client <noreply@smileycx.com>` →
verified sender on the new domain (gated by P-2). Review the French templates for
residual SmileyCX strings and stale URLs.

### W4 — Logo, favicon, OG and derived assets

1. Enumerate candidates — **already done**, recorded in D-Q6 (dimensions, size,
   colour type, measured transparency, references).
2. Establish **one** canonical master under a stable name; derive: favicon (a real
   multi-size `.ico` — today's `favicon.ico` is a PNG renamed, byte-identical to
   `XPlogo.png`), OG image (1200×630), email header, certificate mark, square avatar.
3. Retire the duplicate so only one active import remains.
4. **All four XP-branded images are currently untracked** (`XP Logo.png`, `XPlogo.png`,
   `A Propos.png`, `Nos Formations.png`) → they 404 in production. XPA-1 must **track**
   the canonical set. This is the step that actually puts XP branding on the live site.
5. `app/layout.tsx` — add explicit `openGraph.images` (none is set today) and confirm
   `twitter` card metadata.

### W5 — Source-document safety (D-Q5)

1. Create `docs/source-material/xp-client-academy/`.
2. Relocate `Architecture_…_V4.pdf` and `Voice-Training_F2_EN (1).pdf` out of `public/`
   (both untracked today, so this is a working-copy move — no production change).
3. **Remove `Certificate of Completion.pptx` from public delivery** — it is tracked and
   **live at HTTP 200 today**, and the audit proved zero code references it, so it is
   not an intentional learner download. `git rm --cached` + relocate; this changes
   production.
4. **Add the guard**: extend `scripts/security/` with a check that fails the build when
   a sensitive source format (`.pptx`, `.ppt`, `.docx`, `.xlsx`, `.key`, `.pdf` outside
   an allowlist) is tracked under `public/`. Wire into `npm run verify` and CI, matching
   the existing `check-secrets.mjs` / `check-bundle-secrets.mjs` pattern, including a
   baseline-style allowlist for any PDF genuinely meant for learners.

### W6 — Legacy wordmark and inactive links

- `app/app/orgs/page.tsx:24` renders a literal `Smiley<span>CX</span>` wordmark →
  wordmark-only correction (D-Q4 forbids extending that UI).
- `lib/logger.ts:31` — `app: 'smileycx'` log tag. **Operators grep this**; change it
  and note the cutover in `docs/security/operating-mode.md` §4.4.
- `package.json` name `smileycx-platform` → cosmetic, low risk.
- `PILOT.md` — SmileyCX-era guide contradicting `operating-mode.md` (it still instructs
  setting the retired `NEXT_PUBLIC_FREE_ACCESS_MODE`). Mark superseded or remove.
- Inactive links: none outstanding — the `/admin/login` footer link was fixed in CX-AUTH-2B.

## 4. Exact files expected to change

**Code (17):**

```
app/layout.tsx                                    W1, W4
app/actions/enrollment.ts                         W1
app/actions/waitlist.ts                           W2
app/(admin)/admin/certificates/page.tsx           W1
app/(admin)/admin/certificates/[certificateId]/page.tsx   W1
app/(admin)/admin/users/[id]/page.tsx             W1
app/(public)/contact/page.tsx                     W2
app/(public)/contact/actions.ts                   W2
app/(public)/terms/page.tsx                       W2
app/(platform)/checkout/confirm/page.tsx          W2
components/layout/Footer.tsx                      W2, W4
components/layout/Header.tsx                      W4 (logo import, if adopted)
lib/email/index.ts                                W3
lib/logger.ts                                     W6
app/app/orgs/page.tsx                             W6 (wordmark only)
package.json                                      W6
.env.example                                      W1, W2 (+ document NEXT_PUBLIC_SITE_URL)
```

**Assets:** canonical logo + derived favicon/OG/email/certificate variants (tracked);
`public/images/{XP Logo.png, XPlogo.png}` consolidated; `hero-formation.jpng`
(unreferenceable typo'd extension) removed or corrected.

**Documents:** `docs/source-material/xp-client-academy/` (new) · `PILOT.md` (superseded) ·
`docs/security/operating-mode.md` (logger-tag note) · `.gitignore` if a private
source directory is chosen.

**New:** `scripts/security/check-public-assets.mjs` (W5 guard) + its allowlist.

**Explicitly unchanged:** `lib/hosts.ts`, `middleware.ts`, all auth/RLS/migrations,
`lib/pdf/CertificatePDF.tsx` layout (brand string only, if any), the entire learning model.

## 5. Tests

New:
1. **No `smileycx` literal** remains in `app/`, `components/`, `lib/` — excluding the
   `lib/hosts.ts` / `middleware.ts` admin-host carve-out (explicit allowlist, mirroring
   the SEC-2 regression-test style).
2. **No user-facing URL defaults to the Vercel host** — assert the three admin
   `SITE_URL` fallbacks are canonical.
3. **`metadataBase` is the canonical domain**; `openGraph.images` present.
4. **Public-asset guard**: fails on a tracked `.pptx` under `public/`; passes on the
   allowlisted set. Include a positive case so the guard cannot silently no-op.
5. **Canonical logo is tracked and resolvable** (guards the "untracked → 404" defect
   that hid XP branding from production).
6. **Contact address consistency** — one address across all five surfaces.

Regression (must stay green): 185 existing tests, notably the CX-AUTH host-boundary
suite (proves branding edits did not disturb the admin host) and the SEC-2/HOTFIX
security suites.

Gates: `npm run typecheck` · `npx vitest run` · `npm run lint:sql` · `npm run scan:secrets`
· `npm run scan:bundle` · `npm run build` (prebuild signup gate runs) · manual production
verification of both hostnames.

## 6. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R-1 | `EMAIL_FROM` changed to an unverified Resend domain → **all transactional email silently fails** | **High** | P-2 gate; verify domain first; `EMAIL_DRY_RUN` smoke test before flipping |
| R-2 | New contact address doesn't receive mail → contact/waitlist submissions vanish | **High** | P-1 gate; send a live test to the new address |
| R-3 | Editing `app/app/orgs/page.tsx` drifts into extending the legacy B2B UI | Medium | Wordmark-only; D-Q4 forbids more; diff review |
| R-4 | Changing the `app:'smileycx'` logger tag breaks operator log searches | Medium | Announce in `operating-mode.md` §4.4; keep stable `SEC2_*` codes unchanged |
| R-5 | Opaque logo on dark footer/admin sidebar renders a white box | Medium | P-3; light-surface-only constraint if waived |
| R-6 | Removing the live `.pptx` breaks an unknown external link | Low | Audit found zero code references; it was never a learner download |
| R-7 | Touching `lib/hosts.ts` while sweeping "smiley" strings breaks the admin boundary | **High** | Carve-out is explicit in D-DOMAIN, in the test allowlist, and in this brief |
| R-8 | Tracking previously-untracked images inflates the deploy bundle | Low | Track only the canonical derived set, not every candidate |

R-1, R-2 and R-7 are the ones that can cause real user-visible failure.

## 7. Definition of done

Public site and portal serve XP Client Academy branding from the canonical domain;
certificate URLs point at `www.xpclient-academy.com`; contact and transactional email
work end-to-end on the new identity and are verified by a live send; no internal source
document is publicly reachable and a CI guard prevents recurrence; exactly one canonical
logo asset with derived variants; all gates green; both hostnames verified in production.

## 8. GO / NO-GO

**CONDITIONAL GO.**

The scope is well-bounded and reversible, and the highest-value fix (certificates
pointing at the private portal) is unambiguous. But **XPA-1 must not begin until P-1
and P-2 are answered** — those two changes fail *silently and outward-facing*
(email to real people), which is exactly the class of change that should not be
guessed at. P-3 may be waived with a documented constraint.

Everything else in the brief can proceed the moment those land.
