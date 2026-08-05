# RELEASE-1 — Production Readiness & Technical Debt Audit

**Platform:** XP Client Academy (CX Academy)
**Date:** 2026-07-26
**Scope:** Full repository audit. Documentation only — no code was modified, no commits created.
**Method:** Every finding below cites a file and line, or is explicitly marked *could not be verified*.

---

## 1. Executive Summary

XP Client Academy is a Next.js 14 / Supabase learning platform that has been
through a pilot, a three-phase security remediation (SEC-1/2/3), three hotfixes,
and a transition to invite-only development mode. The security posture is
genuinely strong for a platform of this size: fail-closed registration enforced
at deploy time, RLS with an anti-escalation trigger, audit logging, rate
limiting, and a clean secret-scanning + CI pipeline.

However, the platform is **not a finished v1.0 commercial product**. It is a
**secure, well-built pilot** with two categories of unfinished work that are
openly marked in the code itself: **payments are stubbed** (`lib/payments/index.ts`
is entirely `TODO`) and a **second, separate product surface** (`/app/[orgSlug]`
— a B2B "CX operations" tool) exists alongside the academy with no visible
completion. Test coverage is 11% overall, and there are latent RLS write-policy
holes that are harmless today only because payments are off.

The good news for the stated goal — **entering maintenance mode while focus
returns to Effitrans** — is that the platform is safe to *leave running* in its
current invite-only configuration. It is not safe to *onboard paying customers*
against without completing the high-priority list.

### Readiness score: **68 / 100**

| Band | Meaning |
|---|---|
| 90–100 | Ship to paying customers |
| 75–89 | Ship to controlled/onboarded customers |
| **60–74** | **Safe to operate invite-only; not ready for paid onboarding** ← we are here |
| 40–59 | Pilot-grade; significant gaps |
| <40 | Not production-viable |

### Recommendation: **CONDITIONAL GO**

GO for continued invite-only operation during Effitrans focus.
NOT GO for paid customer onboarding until §4 (High) items are closed.

The single condition that makes this a *conditional* rather than a full GO: **the
platform's paid-mode code paths (payments, paid enrollment, the `payments`/`enrollments`
RLS policies) have never been exercised and contain a known latent access-control
hole.** As long as `NEXT_PUBLIC_PLATFORM_MODE` is not `public` and
`NEXT_PUBLIC_PAYMENTS_ENABLED` is not `true`, that risk is dormant.

---

## 2. Platform Maturity

Rated 1 (absent) – 5 (production-grade), with evidence.

| Domain | Rating | Evidence |
|---|---|---|
| **Authentication** | 4 / 5 | Supabase SSR v0.3.0 cookie API correct (`middleware.ts:85-99`); admin login rate-limited by IP *and* username, generic errors, 8h httpOnly cookie (`app/api/admin/login/route.ts`). Login/reset verified live in HOTFIX-3. |
| **Authorization** | 3.5 / 5 | Admin role re-verified server-side via service client (`app/(admin)/layout.tsx:30-40`); RLS is the primary tenant boundary. Loses points for latent write-policy holes (§3, §9). |
| **Security** | 4 / 5 | SEC-1/2/3 + HOTFIX-1/2/3 intact; deploy-time gate wired (`package.json` `prebuild`); secret + bundle scanners clean. Loses a point for the `payments_update_own` latent hole and permissive CSP (`middleware.ts:36-75`). |
| **Database** | 4 / 5 | 27 sequential migrations, RLS throughout, `SECURITY DEFINER` helpers avoid recursion, `audit_log` with no FK so records outlive users (027). |
| **Multi-tenancy** | 3 / 5 | Two tenancy models coexist: platform-level `platform_role` (academy) and org-level `organization_memberships` (the `/app` product). The academy side is coherent; the org side is unfinished (§8). |
| **Admin** | 4 / 5 | Comprehensive admin CRUD across courses/modules/lessons/quizzes/exercises/users/enrollments/payments/certificates/feedback (24 admin pages). Signed-URL uploads with MIME allowlist + rate limit (`app/api/admin/upload-url/route.ts`). |
| **AI** | 3.5 / 5 | Voice Practice (ElevenLabs) + Claude coach are well-architected, flag-gated OFF by default (`lib/ai/flags.ts`), server-only keys, idempotent one-shot evaluation. Not yet proven in production; flags off. |
| **Payments** | 1 / 5 | **Entirely stubbed.** `lib/payments/index.ts` is 7 `TODO` blocks for Orange Money, Wave, Stripe. No webhook routes exist. |
| **Learning** | 4 / 5 | Full learner flow: lessons, quizzes, module quizzes, final exam, certificates (PDF), progress tracking, server-side quiz scoring (`app/actions/quiz.ts` uses service client + DB-side correct answers). |
| **UX** | 3.5 / 5 | Polished, responsive, French-first, consistent design system (`components/ui/*`). A11y ESLint plugin enforced. No verified WCAG audit; several a11y rules are `warn` not `error` (`.eslintrc.json`). |
| **DevOps** | 4 / 5 | CI (quality + build), security workflow (secrets/rls/deps + weekly cron), deploy-time config gate. E2E not in CI (§11). |
| **Maintainability** | 3 / 5 | Clean lib structure, typed, documented. Dragged down by 11% test coverage, a 633-line lesson page, pilot remnants, and the dual-product ambiguity. |

---

## 3. Remaining Critical Issues

**None that block continued invite-only operation.**

To be precise about the classification: there is **no Critical issue in the
current running configuration**. The items that would be Critical *in a paid,
public configuration* are listed as High below because they are gated off today.
Marking them Critical now would be speculation about a mode the platform is not
in.

---

## 4. High-Priority Issues (before broad customer onboarding)

### H-1 — `payments_update_own` RLS policy is a latent payment bypass
- **Evidence:** `supabase/migrations/001_phase_a_rls_fix.sql:251`; documented in `scripts/security/rls-lint-baseline.json` as *"severity: high (latent)"*.
- A learner can `UPDATE payments SET status='completed' WHERE user_id = auth.uid()`. `payments.status` is CHECK-constrained to a list that includes `completed`, so the write is accepted. Harmless while payments are off; a **direct payment bypass** the moment gateways activate.
- **Blocks:** enabling payments.

### H-2 — Payment integration is entirely unimplemented
- **Evidence:** `lib/payments/index.ts:67,103,129,165,191,273` — every gateway is a `TODO`. No `/api/webhooks/*` route exists (`find app/api` shows only admin/health/certificates).
- The platform cannot take money. `createPaymentRecord` (`app/actions/payment.ts`) writes a pending row and stops.
- **Blocks:** any paid model.

### H-3 — `enrollments_update` RLS policy has no column constraint
- **Evidence:** `001_phase_a_rls_fix.sql` (policy `enrollments_update`); baseline severity *medium*, escalates once enrollment is paid/time-limited.
- A learner can UPDATE their own enrollment (status, expiry). Access-control bypass once enrollment means something.

### H-4 — Test coverage is 11% overall
- **Evidence:** `vitest run --coverage` → All files 11.14% lines, 15.71% functions. `app/actions` 0%, all `components/*` 0%, `lib/payments` 0%, `lib/auth` 0%, `lib/pdf` 0%.
- Security-critical libs *are* well covered (`lib/security` 98.7%, `lib/ai` 93%, `lib/validation` 100%), which is the right prioritization — but the coverage threshold in `vitest.config.ts` (60%) is not met and coverage is not enforced in CI. Server actions (enrollment, quiz, payment, feedback) have **zero** direct tests.

### H-5 — The `/app/[orgSlug]` B2B product is of unknown completeness
- **Evidence:** `app/app/[orgSlug]/{dashboard,actions,feedback,journeys,settings}`, `app/app/onboarding`, `app/app/orgs`; queries real tables (`action_plans`, `touchpoints` — `app/app/[orgSlug]/dashboard/page.tsx:29,39`). Linked from admin nav and topbar (`app/(admin)/layout.tsx:76`, `components/layout/AppTopbar.tsx:111`).
- This is a **second product** (CX operations tooling) sharing the codebase. It is not part of the academy learning flow, has no tests, and its readiness could not be verified. It needs an explicit decision: ship, hide, or remove.

---

## 5. Medium Issues (safe to defer)

- **M-1 — `cert_service_update` RLS lacks WITH CHECK.** `supabase/migrations/018_certificates_pdf_bucket.sql:33`; baseline *medium-high*, cross-user certificate tampering risk. Deferred because cert writes currently go through server actions.
- **M-2 — Permissive CSP.** `middleware.ts:55` uses `'unsafe-inline' 'unsafe-eval'`. Self-documented as "tighten in a later pass once nonce-based CSP is wired up" (`middleware.ts:33`). Standard Next.js posture, but not hardened.
- **M-3 — Two rate-limiter implementations.** `lib/rate-limit.ts` exports both in-memory `rateLimit` (per-process, resets on cold start) and DB-backed `rateLimitDb`. The upload route uses the **in-memory** one (`app/api/admin/upload-url/route.ts:31`), which is ineffective on Vercel serverless. Low impact (admin-only, signed URLs), but inconsistent.
- **M-4 — No `robots.txt` / `sitemap.xml`.** `find app -name robots*/sitemap*` → none. Fine for invite-only; needed before public launch.
- **M-5 — 633-line lesson page.** `app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx` with 19 Supabase calls in one server component. Works, but a maintainability hotspot.
- **M-6 — Certificate learner email exposed on public verify page.** `app/(public)/verify-certificate/[certificateId]/page.tsx:22` selects `profiles(full_name, email)` and can fall back to displaying the email (`:34`). A public certificate verifier arguably should not surface the holder's email.

---

## 6. Low Issues (nice improvements)

- **L-1 — `dev.log` committed to the repo.** `git ls-files` shows `dev.log` (11 lines of dev-server output). Noise; should be gitignored.
- **L-2 — `tsconfig.tsbuildinfo` tracked.** Build artifact in version control.
- **L-3 — Stale pilot documentation.** `PILOT.md` still instructs setting `NEXT_PUBLIC_FREE_ACCESS_MODE=true`, a variable that `lib/pilot.ts:20` marks as legacy/derived. Contradicts current `operating-mode.md`.
- **L-4 — No `README.md`.** New maintainer has no entry point; onboarding relies on reading `docs/`.
- **L-5 — a11y rules set to `warn`.** `.eslintrc.json` — `click-events-have-key-events`, `media-has-caption`, `no-noninteractive-element-interactions` are warnings, so violations don't fail CI.
- **L-6 — Lint warnings carried.** Build shows unused-var warnings (`lib/pdf/CertificatePDF.tsx`, `lib/payments/index.ts`, `components/layout/AppTopbar.tsx`).

---

## 7. Technical Debt

| Debt | Evidence | Nature |
|---|---|---|
| Payment gateways stubbed | `lib/payments/index.ts` (7 TODOs) | Temporary implementation |
| `TEMP_FREE_ACCESS` enrollment via service-role | `app/actions/enrollment.ts:1-13` — self-documents "To remove when payments are re-enabled" | Pilot remnant (deliberate) |
| Dual tenancy model | `platform_role` vs `organization_memberships` | Architectural — two products, one repo |
| Legacy derived flags | `lib/pilot.ts:20-39` — `PILOT_MODE`/`FREE_ACCESS_MODE` "kept for backward compatibility" | Deprecated path retained |
| Two rate limiters | `lib/rate-limit.ts` | Duplicated logic / shortcut |
| RLS write-policy baseline | `scripts/security/rls-lint-baseline.json` (4 entries) | Explicitly tracked debt (good practice) |
| `PILOT.md` vs `operating-mode.md` | both in repo | Documentation drift |

**Assessment:** The debt is unusually *honest* — nearly all of it is self-labeled
in the code (`TEMP_FREE_ACCESS`, `TODO`, the RLS baseline notes). That is a sign
of disciplined engineering, not neglect. The risk is that "temporary" scaffolding
(free-enrollment-via-service-role) becomes permanent by inertia.

---

## 8. Dead Code / Unfinished Surfaces

Distinguishing **dead** (unreachable) from **unfinished** (reachable, incomplete):

- **Not dead, but unfinished — `/app/[orgSlug]` product.** Reachable via admin nav; queries live tables. Cannot be called dead. See H-5.
- **`app/(auth)/signup/page.tsx`** — retained as an access-request form (SEC-2 rewrite). The e2e test `e2e/auth.spec.ts:9` still asserts a signup email field exists — **the e2e test is stale** relative to the invite-only rewrite and could not have passed as written; but e2e is not in CI so it never ran.
- **`components/payment/PaymentMethodSelector.tsx`** — exists for a payment flow that is stubbed; effectively dormant until H-2.
- **Could not verify** any fully-orphaned component: a spot check of `components/` against imports found each UI primitive referenced. A full dead-export sweep (e.g. `ts-prune`) was not run — **not verified**.
- **No obsolete migrations.** All 27 are sequential and forward-only; several are fixups (016/017 slug fixes, 021 backfill) but none are abandoned.

---

## 9. Security Review — SEC-1 → HOTFIX-3 Regression Check

| Control | Status | Evidence |
|---|---|---|
| SEC-2: no public `signUp` in source | **Intact** | Regression test `__tests__/security/registration.test.ts:62`; signup page is access-request only. |
| SEC-2: single provisioning path | **Intact** | One `admin.createUser` call site (`app/(admin)/admin/users/new/actions.ts`). |
| Migration 027: self-escalation blocked | **Intact** | `027_identity_hardening.sql` — `WITH CHECK` + BEFORE UPDATE trigger + `current_platform_role()`. |
| `audit_log` outlives users | **Intact** | 027 — no FK to `auth.users`. |
| Rate limiting (admin login, provisioning) | **Intact** | `app/api/admin/login/route.ts:17,42`. |
| HOTFIX-3: runtime gate never throws | **Intact** | `lib/security/auth-config.ts` `assertSignupDisabled` logs fatal, no throw; `instrumentation.ts` try/catch backstop. |
| HOTFIX-3: deploy gate enforces | **Intact** | `package.json` `prebuild`; `disable_signup=true` verified in HOTFIX-3. |
| Secret / bundle scanners | **Clean** | `scan:secrets`, `scan:bundle` pass. |

**No regressions found.** The one weakness inside the security surface is the
**latent RLS write policies (H-1, H-3, M-1)** — these predate SEC-1 (they live in
migration 001) and were *catalogued* by SEC-3's linter rather than introduced by
it. They are correctly tracked, not hidden.

---

## 10. Performance

- **No N+1 in the hot path.** The course detail and lesson pages batch with `Promise.all` (`app/(public)/courses/[slug]/page.tsx:169`, quiz scoring `app/actions/quiz.ts:52`).
- **Lesson page does 19 sequential-ish Supabase calls** in one render (`[lessonId]/page.tsx`). Not N+1, but heavy; a candidate for query consolidation. Impact unmeasured — **not profiled**.
- **In-memory rate limiter on serverless** (M-3) is a correctness issue more than performance.
- **No caching layer** (`unstable_cache`/React `cache()`) observed on repeated course/module reads; every request hits Supabase. Acceptable at pilot scale; **not load-tested**.
- **Slow-query analysis not possible** from the repository alone — **could not be verified** without production DB metrics.

---

## 11. Testing

- **Unit/integration:** 129 tests, 9 files, all passing. Concentrated on security (`registration`, `auth-config-failclosed`), validation, AI report, competency engine, rate limit, middleware, admin login, and the HOTFIX-2 course-detail page.
- **Coverage: 11% lines overall** (`--coverage`), with security libs at 93–100% and everything else near 0. Threshold (60% in `vitest.config.ts`) is **not enforced in CI**.
- **Missing integration tests:** every server action (`app/actions/*` — enrollment, quiz submission, payment, feedback, waitlist) has no direct test.
- **E2E:** one spec (`e2e/auth.spec.ts`), **not wired into CI** (`grep e2e .github/workflows` → none), and **stale** (asserts a signup field removed by SEC-2). Effectively non-functional.
- **No tests** for: certificate PDF generation, admin CRUD flows, the `/app` product, learning-progress calculation end-to-end.

---

## 12. Documentation

**Strong where it exists:** `docs/security/` is exemplary (SEC-1/2/3, HOTFIX-1/2/3, operating-mode) and `docs/architecture/` covers the AI engine thoroughly.

**Missing operational docs:**
- No `README.md` / developer setup guide (L-4).
- No runbook: how to provision a user, rotate keys, restore from backup, respond to the `SEC2_SIGNUP_ENABLED` alert (operating-mode.md covers the last one partially).
- No payment activation checklist beyond inline TODOs.
- No data model / ERD document.
- `PILOT.md` is stale and contradicts current mode (L-3).
- No incident-response or on-call doc — relevant given the platform will be *unattended* during Effitrans focus.

---

## 13. Deployment

| Area | Status | Evidence |
|---|---|---|
| **Vercel** | Configured, healthy | Production verified 200 in HOTFIX-3; Node 24.x. |
| **Supabase** | Configured | `disable_signup=true` verified; RLS + migrations applied. |
| **Env vars** | Consistent | Code uses 22 vars; `.env.example` documents them. **Mismatch:** `.env.example` lists `ORANGE_MONEY_*`, `WAVE_*`, `STRIPE_*` that code doesn't yet read (payments stubbed) — expected, but means the example over-documents. `NEXT_PUBLIC_SITE_URL` is read in code but **not** in `.env.example`. |
| **Secrets** | Clean | Service-role key server-only; scanners green; `.env.local` gitignored + untracked (verified HOTFIX-3). |
| **Backups** | **Not verified** | No backup policy in repo. Supabase provides automatic backups by plan tier — **cannot confirm which tier / retention** from the repository. |
| **Monitoring** | Partial | `/api/health` reports `ok`/`degraded`; structured Pino logging with redaction (`lib/logger.ts`). **No external uptime monitor, alerting, or log drain configured** that is visible in the repo. Critical gap for an unattended platform. |

---

## 14. Operational Readiness — Would I hand this to a paying customer?

**Not yet — and the platform's own configuration agrees with me.** It is
deliberately in invite-only mode with payments disabled, which is the correct
posture for its actual maturity.

**Why I would confidently leave it running invite-only:** authentication,
authorization, RLS, audit logging, and the registration control are solid and
regression-tested; the site is verified up; secrets are clean; and the failure
mode that caused three hotfixes is now fixed at the right layer.

**Why I would not onboard a paying customer today:**
1. It cannot take payment (H-2).
2. The paid-mode RLS policies contain a latent bypass (H-1) that has never been exercised.
3. 11% test coverage means most non-security regressions would ship silently (H-4).
4. No alerting/uptime monitoring for a platform about to be left unattended (§13).
5. A second, unfinished product surface is reachable in the UI (H-5).

**The most important operational risk for the stated plan (maintenance mode):**
the platform will be *unattended* while attention is on Effitrans, yet has **no
external monitoring or alerting**. If it goes down, no one is paged. That is the
gap I would close first even before payments.

---

## 15. Release Blockers (genuine only)

For the **current invite-only mode**: **none.** It is running and safe.

For **paid public launch**, these are hard blockers:
1. **H-2** — implement at least one payment gateway + webhook.
2. **H-1** — fix `payments_update_own` WITH CHECK before payments go live.
3. **H-3** — fix `enrollments_update` before enrollment is paid/time-limited.
4. **Monitoring/alerting** — no paging on outage (§13).

No hypothetical blockers are listed. Everything above is tied to existing code.

---

## 16. Recommended Roadmap

### Immediate (before leaving for Effitrans)
- Wire an **external uptime monitor** against `/api/health` with alerting (the health endpoint already exists; nothing is watching it).
- Confirm **Supabase backup tier + retention**; document it.
- Delete/gitignore `dev.log`, `tsconfig.tsbuildinfo` (L-1/L-2); reconcile `PILOT.md` with `operating-mode.md` (L-3).
- Add a minimal `README.md` with setup + "how to provision a user" (L-4).

### Next month (before paid onboarding)
- Fix the three RLS write policies (H-1, H-3, M-1) — small, high-value migrations.
- Implement one payment gateway end-to-end + webhook (H-2).
- Decide the fate of `/app/[orgSlug]` (H-5): finish, feature-flag-hide, or remove.
- Raise server-action test coverage (H-4); enforce the 60% threshold in CI; fix or delete the stale e2e spec and add it to CI.

### Long term
- Nonce-based CSP (M-2); consolidate rate limiters to DB-backed (M-3); `robots.txt`/`sitemap.xml` (M-4); WCAG audit and promote a11y rules to `error` (L-5).
- Refactor the 633-line lesson page (M-5).
- Operational runbook + incident response doc.

---

## 17. Final Verdict

# READY WITH CONDITIONS

**Supported by repository evidence:**

XP Client Academy is a **secure, well-engineered platform that is production-ready
for its current purpose (invite-only, unpaid, controlled development)** and
**not yet ready for paid public customers.** The security work (SEC-1→HOTFIX-3)
is intact and verified; the learning platform is feature-complete; the admin
tooling is comprehensive. The conditions are concrete and code-bound, not
hypothetical: **payments are stubbed (`lib/payments/index.ts`), the paid-mode RLS
policies carry a known latent bypass (`rls-lint-baseline.json`), coverage is 11%,
there is no outage alerting, and a second product surface is unfinished.**

Hold in invite-only mode, close the Immediate roadmap before going unattended,
and treat the four §15 blockers as the gate to paid launch.

---

## Appendix — Metrics

**Readiness score:** 68 / 100

**Findings by severity:**

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 5 | H-1 … H-5 |
| Medium | 6 | M-1 … M-6 |
| Low | 6 | L-1 … L-6 |
| **Total** | **17** | |

**Top five priorities:**
1. External uptime monitoring + alerting before the platform is left unattended (§13).
2. H-1 — fix `payments_update_own` RLS before payments activate.
3. H-2 — implement one payment gateway + webhook.
4. H-4 — server-action test coverage + enforce threshold in CI.
5. H-5 — decide the fate of the `/app/[orgSlug]` product.

**Estimated effort to a clean, paid-capable v1.0:** roughly **3–5 focused
engineering weeks** — ~1 week payments + webhook, ~2 days RLS hardening + tests,
~1 week test-coverage lift + CI enforcement, ~2 days monitoring/backup/docs, and
~1 week to resolve or remove the `/app` product. This excludes any new feature
work and assumes the existing architecture is kept.

**Final recommendation:** **CONDITIONAL GO** — operate invite-only now; complete
§15 before paid onboarding.

---

*Audit performed against the repository at commit `f2536f5` (HEAD, main). No code
was modified and no commits were created, per the RELEASE-1 mandate. Items marked
"not verified" require production infrastructure access (Supabase metrics, Vercel
monitoring config, backup tier) that is outside the repository.*
