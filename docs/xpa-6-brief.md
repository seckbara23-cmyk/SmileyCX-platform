# XPA-6 — Authentication & Learner Accounts

**Status:** brief only — **not implemented**. Awaiting GO.
**Inputs:** [CX-AUTH-0 audit](cx-auth-0-architecture-audit.md) · [decision register](xpa-decision-register.md) · [XPA-5 closure](xpa-5-closure.md)
**Prerequisite:** XPA-0…XPA-5A closed; production verified.

---

## 1. Objective

Give **learners** real accounts. Administrator access is already solved
(CX-AUTH-1/2: `ADMIN_OWNER_EMAILS` allowlist on Supabase sessions, host-separated
portal). Learners are the gap: registration is closed platform-wide, and the
learning experience still runs largely on anonymous/pilot identity.

Concretely, this phase should end with a learner able to: obtain an account
through a governed path, sign in, see their own progress, resume where they left
off, and have their certificates attached to a durable identity.

**Out of scope:** B2B group enrollment (XPA-7), payments (XPA-9), admin auth
(done), catalogue/discovery (done), Voice Practice (done).

## 2. The state XPA-6 starts from

| Fact | Evidence |
|---|---|
| Public registration is **closed** | `disable_signup = true`; deploy-time gate in `prebuild` |
| `/signup` is an **access-request form** only | SEC-2 rewrite |
| Login, logout, password reset **work** | CX-AUTH-1 (F-2 callback fixed) |
| Admin auth is **Supabase sessions + allowlist** | CX-AUTH-1/2 |
| Learner tables are **empty** | 0 enrollments, 0 progress, 0 certificates, 0 attempts |
| Voice sessions are **all anonymous** | 11 sessions, every one `anon_id` |
| Pilot progress lives in **localStorage** | `PILOT_MODE`, `updateProgress()` |
| Certificates require a **profile row** | `certificates.user_id → profiles(id)` |

**The pivotal consequence:** because every learner table is empty, XPA-6 can
choose an identity model **without migrating anyone**. That freedom disappears
the moment real learners start accumulating progress, which makes this the right
moment to do it and the wrong moment to defer it.

## 3. The decision this phase must make first

Registration is closed by ratified decision, so "learners can sign up" is **not**
available by default. The programme has to choose how a learner legitimately
obtains an account:

| Option | Shape | Cost |
|---|---|---|
| **A. Admin-provisioned** | Extend the existing single `admin.createUser` path to bulk/learner use | Smallest; already audited, rate-limited, audited to `audit_log`. Does not scale to self-serve |
| **B. Invitation tokens** | Admin issues a token; learner redeems it to create their own account | Governed *and* self-serve. Needs a token table, expiry, single-use enforcement |
| **C. Open registration** | Re-enable `disable_signup` | **Contradicts the ratified invite-only posture and the SEC-1 incident path.** Requires a server-owned registration route first (register §6), never the client `auth.signUp` |

This is **Q-H** below. It determines the whole phase, and it is a product
decision, not an engineering one.

## 4. Scope (assuming B or A)

### 4.1 Learner identity
- A learner account maps 1:1 to a `profiles` row with `platform_role = 'user'`.
- **Never** grant `super_admin`; migration 027's trigger already blocks
  self-escalation and must not be weakened.

### 4.2 Anonymous → identified migration
The pilot stored progress in `localStorage` and voice sessions under `anon_id`.
Decide explicitly (**Q-I**): on first sign-in, do we **claim** that local
progress into `lesson_progress`, or start clean?

Claiming is friendlier but must be **server-authoritative** — the client cannot
be trusted to assert which lessons it completed, so a claim path needs a
verifiable token, not a list of lesson IDs.

### 4.3 Learner dashboard
`/dashboard` exists. It needs: enrolled courses, per-course progress from
`lesson_progress`, resume-where-you-left-off, and certificates.

### 4.4 Session lifecycle
Supabase sessions already refresh in middleware. Confirm learner-facing
`AUTH_REQUIRED` behaviour under the current `PLATFORM_MODE` — it is
**mode-dependent** and in `pilot` covers only `/app` (`middleware.ts:8-10`).
Moving to identified learners likely means revisiting that list.

### 4.5 Account lifecycle
Password reset works. Still missing: account disable (`profiles.disabled_at`),
and admin-side deactivation. Both are additive.

## 5. Security requirements (non-negotiable)

- **No weakening of RLS**, migration 027, the signup gate, or the admin allowlist.
- Learners see **only their own** progress, attempts, sessions and certificates —
  `ai_sessions`/`ai_turns` policies already enforce this; extend the same shape.
- **Never** restore the client-side `supabase.auth.signUp()` call — that was the
  SEC-1 incident path. Any registration is server-owned: Zod → invitation check →
  `rateLimitDb` → `admin.createUser()` → `audit_log`.
- Provisioning stays **rate-limited and audited**.
- The `/admin` host boundary and the learner surface stay separate.

## 6. Files likely to change

| File | Change |
|---|---|
| `supabase/migrations/035_*.sql` | Invitation tokens and/or `profiles.disabled_at` (additive) |
| `app/actions/auth.ts` *(new)* | Server-owned redeem/registration path |
| `app/(auth)/signup/page.tsx` | Access-request → token redemption (if B) |
| `app/(platform)/dashboard/page.tsx` | Real progress, resume, certificates |
| `app/(admin)/admin/users/**` | Issue/revoke invitations |
| `middleware.ts` | Only if `AUTH_REQUIRED` changes — treat as high-risk |
| `lib/auth/session.ts` | Learner helpers alongside `requirePlatformAdmin` |

**Must not change:** `lib/hosts.ts`, admin auth, `ADMIN_OWNER_EMAILS`, migration
027, the catalogue/discovery projections, Voice Practice.

## 7. Tests

Learner isolation (cannot read another learner's progress/attempts/sessions/
certificates) · invitation single-use and expiry · no client `auth.signUp` (the
existing regression test already guards this) · rate limiting on redemption ·
audit rows on create and failure · `platform_role` self-escalation still blocked
· admin auth unaffected · dashboard shows only the signed-in learner's data ·
anonymous claim (if adopted) cannot be forged · full CI, zero skipped, zero
failed.

## 8. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R-1 | Re-opening registration re-creates the SEC-1 hole | **High** | Server-owned path only; never client `signUp`; keep the deploy gate |
| R-2 | A client-asserted progress claim lets a learner forge completion | **High** | Server-authoritative claim token, or start clean |
| R-3 | Touching `AUTH_REQUIRED` breaks public pages or the portal | **High** | Change nothing in middleware unless required; reuse the CX-AUTH test matrix |
| R-4 | Invitation tokens leak via logs or referrer | Medium | Single-use, short expiry, never logged |
| R-5 | Learner tables gain rows before the model is settled | Medium | This is why XPA-6 should precede any real cohort |

## 9. Open questions

| # | Question | Blocks |
|---|---|---|
| **Q-H** | Which registration model — admin-provisioned, invitation tokens, or open? Open contradicts the ratified posture. | Entire phase |
| **Q-I** | On first sign-in, claim pilot `localStorage` progress and anonymous voice sessions, or start clean? | §4.2 |
| Q-J | Should `PLATFORM_MODE` move off `pilot` as part of this, given learners become identified? | §4.4, middleware risk |
| Q-K | Is account disable in scope now, or XPA-8? | §4.5 |

## 10. GO / NO-GO

**NO GO pending Q-H.** Unlike previous phases, this one cannot start with a
sensible default: registration is closed by ratified decision, so the way a
learner obtains an account is a product choice with security consequences, and
picking one unilaterally would either contradict the invite-only posture or
build the wrong thing.

Everything else is well-understood and low-risk once Q-H is answered. Q-I should
be settled at the same time, because it determines whether a claim path exists at
all — retrofitting one after learners have accumulated progress is materially
harder than building it now.
