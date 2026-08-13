# XPA-8 — Production Launch Readiness

**Status:** 🔴 **NO-GO** for the ratified invite-only launch as of 2026-08-13
**Baseline:** `9ccbd77` (XPA-7 closed)
**Scope of this pass:** audit only. No implementation.

**Launch criterion under test:**

> XP Client Academy can safely onboard real learners and real organizations in
> production under the ratified invite-only commercial model, without relying on
> legacy pilot behaviour, hidden stubs, unsafe public assets, stale SmileyCX
> surfaces, or unverified security assumptions.

**Verdict: NO-GO.** Not because the platform is insecure — the security posture
is the strongest part of it, with 141 production checks green across four
verifiers — but because **the ratified operating mode cannot currently be
enabled without locking out every real learner**, one published course is empty,
and an untested legacy product is reachable by any authenticated user.

None of the three blockers is large. All are precise.

---

## Score

| Dimension | State |
|---|---|
| Security / access model | 🟢 **Strong** — 141 production checks, 0 failures |
| Operating mode | ✅ **B-1 closed (W1)** — flip is safe once deployed; not yet flipped |
| Course content | 🔴 **Blocker** — one course published empty; no assessments anywhere |
| Legacy surfaces | 🔴 **Blocker** — `/app/[orgSlug]` reachable and partly broken |
| Voice practice | 🟠 **High** — 1 of 5 personas production-wired |
| Email / invitations | 🟠 **High** — sender defaults to the old domain |
| B2B / organizations | 🟡 **Medium** — sound, but MVP-thin |
| Assets / branding | 🟡 **Medium** — guard exists; known debt remains |
| Domain | 🟢 Canonical domain live and correct |
| Migration ledger | 🟡 **Medium** — D-LEDGER drift persists |
| Production data | 🟢 **Clean** — no synthetic residue |

---

## BLOCKERS

### B-1 — Enabling the ratified mode locks out every real learner · ✅ **CLOSED (W1)**

> Closed by XPA-8 W1 — see [xpa-8-w1-operating-mode.md](xpa-8-w1-operating-mode.md).
> The allowlist is deleted; admission now reads `profiles.account_status`. All
> three real accounts are admitted, none hardcoded. The mode also fails closed
> in production, and the public marketing site stays public as ratified.
> **SAFE TO FLIP: YES, after this commit deploys.** Production not yet flipped.

**Original finding, retained as the record:**

`middleware.ts` under `PLATFORM_MODE=private` locks the entire site except
`PRIVATE_MODE_EXEMPT`, requiring an authenticated **and allowlisted** session.
The allowlist is hardcoded in `lib/access-control.ts`:

```ts
export const ALLOWED_PRIVATE_EMAILS = [
  'seckbara23@gmail.com',
  'mariemelly@gmail.com',   // ← not a real account
]
```

Real accounts in production:

| Account | On the allowlist? |
|---|---|
| `seckbara23@gmail.com` | ✅ |
| **`mariemeify@gmail.com`** | ❌ — the list has `mariemelly@`, a different address |
| `bawizee22@gmail.com` | ❌ absent |

So flipping to the ratified mode today would lock out **Marième — who holds all
six entitlements and is the entire UAT account** — and `bawizee22`.

Structurally worse: an allowlist in source code means **every learner onboarded
requires a code change and a redeploy.** That is incompatible with the launch
criterion. `private` mode was built as a pre-launch lockdown, not as an
onboarding model, and it is being asked to serve as one.

**This must be resolved before the mode can be flipped, and the mode must be
flipped before launch.** The two are locked together.

### B-2 — A published course has no content

| Course | Modules | Lessons | Issues |
|---|---|---|---|
| C1-F1 | 3 | 17 | no quiz, no final exam |
| C1-F2 | 4 | 18 | no quiz, no final exam |
| C1-F3 | 4 | 17 | no quiz, no final exam |
| C2-F1 | 4 | 17 | no quiz, no final exam |
| **C2-F2** *Mesurer l'expérience client* | **4** | **0** | **NO LESSONS · 4 empty modules · no first-entry route** |
| C2-F4 | 4 | 13 | no quiz, no final exam |

C2-F2 is **published and sellable** while containing nothing. A learner granted
access lands on the UAT-ROUTE-01 fallback (`/courses/…`) — the fail-safe works,
but it is protecting the learner from a content defect, not a routing one.

Either unpublish it or fill it. Do not route around it.

### B-3 — The legacy `/app/[orgSlug]` product is reachable and partly broken

- `middleware.ts` lists `/app` under `AUTH_REQUIRED` — so it is reachable by
  **any authenticated user**, not restricted to admins.
- `app/(admin)/layout.tsx:86` links to `/app/orgs` from the admin shell.
- `components/layout/AppSidebar.tsx` offers Dashboard / Feedback / Journeys /
  Actions.
- Its backing tables are **partly absent**: `journeys` is deployed and empty;
  **`feedback` and `actions` return `PGRST205` — they do not exist.** Those
  pages cannot render.
- It now reads `organizations`/`organization_memberships` whose policies XPA-7
  changed, and it has never been tested against them.

An untested parallel organization product, reachable by any learner, half of it
guaranteed to error. **Recommendation: guard it behind platform-admin or remove
the routes.** Retiring is cleanest; XPA-7 already provides the organization UX
this duplicates.

---

## HIGH

**H-1 — No assessments exist anywhere.** Zero quizzes and zero final exams
across all six courses. The single `quizzes` row has **both `course_id` and
`module_id` null**, so it is invisible to the module-quiz route, the final-exam
route, and the certificate completion check. Completion currently reduces to
"all lessons viewed", and no learner has ever completed anything
(`quiz_attempts` 0, `lesson_progress` 0, `certificates` 0). The certificate path
has never executed in production.

**H-2 — Voice practice is one-fifth wired.** Only **Ibrahima** is published with
an `agent_id`. **Amara, Fatou, Kader and Awa have no `agent_id` and are
unpublished.** XPA-5 closed knowing this; for launch it means four of the five
F2 scenarios do not exist for learners. Not assessed here: mobile microphone
behaviour and ElevenLabs failure/fallback states, neither of which has
production evidence.

**H-3 — Outbound email defaults to the wrong domain.**
`lib/email/index.ts:49` — `EMAIL_FROM ?? 'XP Client Academy <noreply@smileycx.com>'`,
and `app/actions/waitlist.ts` the same. If `EMAIL_FROM` is unset in Vercel,
invitations and password resets send from `smileycx.com`, which will not pass
SPF/DKIM for the academy domain. Email is also dry-run whenever `RESEND_API_KEY`
is absent, so **it may be silently sending nothing at all.** Neither variable is
present locally; production must be confirmed.

**H-4 — `lib/pilot.ts` fail-opens.** `PLATFORM_MODE` defaults to `'pilot'` — the
**most permissive** mode — when the variable is unset or misspelled. Every other
security flag in this codebase fails closed (`SELF_ENROLLMENT_OPEN`,
`disable_signup`, the admin allowlist). This one does not.

---

## MEDIUM

**M-1** `public/images/Certificate of Completion.pptx` is tracked and publicly
downloadable. The XPA-1 guard (`check-public-assets.mjs`) exists and carries it
as an accepted baseline item, scheduled for relocation under D-Q5. Not yet done.

**M-2** Two internal PDFs sit untracked in `public/` — the V4 architecture
reference and the Voice F2 source. Not served (untracked ⇒ not deployed), but
**one `git add -A` from exposure.** The guard would catch them at commit time;
they should be relocated regardless.

**M-3** Harvest-and-retry (XPA-6D accepted residual) is currently **moot** —
there are no quizzes to harvest. It becomes live the moment H-1 is addressed,
and should be decided as part of that work rather than after.

**M-4** `lib/logger.ts:31` tags every log line `app: 'smileycx'`. Operators grep
this; XPA-1 W6 flagged it and it is unchanged.

**M-5** Stale pilot copy remains in two files (`Phase pilote`). UAT-ROUTE-02
corrected the course page only.

**M-6** D-LEDGER drift persists. Migrations 037–040 are versioned; the
organization tables 040 reconciles were applied outside `migrations/`, and
001–034 remain unregistered. **`supabase db push` cannot be trusted to
reproduce production today.** Recommendation: `supabase migration repair` per
version after an object-by-object comparison — metadata only, never rewriting
history.

**M-7** B2B is sound but MVP-thin: no production organization exists, invitations
are a status field with no delivery, and org admins have no self-service roster
UI. All are accepted XPA-7 limitations; none is a security gap.

---

## LOW

`hero-formation.jpng` (typo'd extension, unreferenceable) · `organizations.plan`
dormant legacy metadata · `bonjour@smileycx.com` as the contact address — this
one is **deliberate and documented** in `lib/brand.ts`: the academy mailbox has
not been confirmed, and inventing an address would be worse.

---

## Security evidence — the strong part

Re-run against production at this baseline:

| Verifier | Result |
|---|---|
| `verify-xpa-6a.mjs` | ✅ **57 / 57** |
| `verify-xpa-6c.mjs` | ✅ **30 / 30** |
| `verify-xpa-6d.mjs` | ✅ **22 / 22** |
| `verify-xpa-7.mjs` | ✅ **32 / 32** |
| **Total** | **141 production checks, 0 failures** |

Local suite: **675 tests / 23 files**. Auth: **`disable_signup: true`** —
invite-only is genuinely enforced at Supabase, not merely in code. Entitlement
authority, answer-key protection, organization isolation and route invariants
are all proved by probe rather than assumed.

One item to confirm: `/auth/v1/settings` reports `mailer_autoconfirm: true`,
which appears to contradict XPA-6A's mandatory email verification. XPA-6A
verified the behaviour directly (`email_not_confirmed` on sign-in), so this is
likely a reporting artefact of the settings endpoint — but it should be
re-probed rather than assumed.

---

## Production data — clean

3 real accounts, **0 synthetic residue**. 6 courses / 23 modules / 82 lessons ·
6 entitlements + 6 enrollments (all Marième, `MANUAL_ADMIN`) · 0 organizations ·
0 exercises, quiz attempts, progress rows, certificates or payments · 5 AI
scenarios, 11 sessions · 6 audit events. Every verifier's fixtures cleaned up.

---

## Required launch UAT

To run against production once the blockers clear.

**Learner:** no access · manual access · evaluation access · corporate access ·
expired · revoked · full completion · certificate issued.
**Platform admin:** create org · add member · grant evaluation · grant corporate
licence · revoke · inspect progress.
**Org admin:** permitted own-org reads · denied cross-org reads · membership ops.
**Security:** self-join denied · self-promotion denied · answer-key denied ·
enrollment-only denied.

The last four are already automated in `verify-xpa-7.mjs` and should run as a
launch-day gate rather than being repeated by hand.

---

## Rollback and recovery — minimum runbook

Currently undocumented and needed before launch: Vercel instant rollback to the
prior deployment; Supabase PITR/backup window (unconfirmed); the fact that
**reverting a migration is not supported** — forward-only fixes only; and the
break-glass path (service-role SQL editor) with who holds it.

---

## Recommended fix waves

| Wave | Content | Gate |
|---|---|---|
| **W1** | **B-1** — replace the source-code allowlist with a data-driven check (entitlement- or profile-based), then prove the `private` flip admits all three real accounts | BLOCKER |
| **W2** | **B-3** — guard or retire `/app/[orgSlug]`; remove the admin-shell link | BLOCKER |
| **W3** | **B-2** — unpublish C2-F2 or fill it; add a published-course completeness check to CI | BLOCKER |
| **W4** | **H-3** confirm `EMAIL_FROM` / `RESEND_API_KEY` in Vercel and send a real invitation; **H-4** make `PLATFORM_MODE` fail closed | HIGH |
| **W5** | **H-1** decide the assessment model and the harvest-and-retry policy together; fix the orphan quiz | HIGH |
| **W6** | **H-2** wire the four remaining voice personas, or scope launch to Ibrahima explicitly | HIGH |
| **W7** | **M-1/M-2** relocate the PPTX and the two PDFs; **M-4/M-5** brand tag and pilot copy | MEDIUM |
| **W8** | **M-6** ledger reconciliation; runbook; launch UAT execution | MEDIUM |

**W1–W3 are the NO-GO set.** With those closed and W4 confirmed, this becomes a
**CONDITIONAL GO** — conditional on accepting H-1 (no assessments) and H-2
(single voice persona) as launch-scope limitations, which is a product decision,
not an engineering one.
