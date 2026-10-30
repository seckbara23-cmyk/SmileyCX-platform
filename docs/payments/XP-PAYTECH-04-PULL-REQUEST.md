# XP-PAYTECH-04: make PayTech checkout reachable, idempotent, reconcilable and environment-safe

| | |
|---|---|
| **Base** | `main` @ `e90746b` |
| **Migration** | `063_payment_state_machine.sql` is applied separately from deployment, under the procedure in the file. It requires migrations through 062. |
| **Dev dependency** | `@electric-sql/pglite` `0.3.7` (exact), so the real-PostgreSQL suite runs in CI |
| **Evidence it builds on** | [XP-PAYTECH-READY-01-SUMMARY.md](XP-PAYTECH-READY-01-SUMMARY.md) |

> **Merging this does not enable payments.**
> * With the PayTech variables unset, checkout shows *"Inscription bientôt disponible"*.
> * Even with credentials, **no payment can complete until PayTech documents its status response.** The settlement contract is `null` by design (safeguard 3). Paid attempts would wait in `processing`, visible in the admin "À rapprocher" queue, until the contract is filled.

---

## 1. Summary

| # | Workstream | What changed | Findings closed |
|---|---|---|---|
| 1 | **Checkout UI** | `/checkout` renders one **"Payer avec PayTech"** button that sends only the course id and redirects to PayTech's hosted page. The card/CVV selector is deleted, the legacy intent action refuses, and `/checkout/confirm` redirects to `/payment/success`. Availability is decided on the **server**: `NEXT_PUBLIC_PAYMENTS_ENABLED` is retired. | C1, C2 |
| 2 | **Idempotent checkout** | At most one chargeable attempt per learner and course. An **opened** attempt is never superseded on a guess. Each attempt gets its own `ref_command`, and every write is compare-and-set. Migration 063 enforces the state machine in the database. | F1, F2, X1 |
| 3 | **Reconciliation** | One decision procedure (`lib/payments/paytech-reconcile.ts`) shared by the IPN, a daily cron sweep, two admin actions ("Vérifier auprès de PayTech" and "Clôturer comme non abouti") and checkout's own re-check. Unresolved outcomes now answer **503**. | P2 |
| 4 | **Environment separation** | Production requires `PAYTECH_MODE=prod`; everything else refuses it. Separate switches for new sales (`PAYTECH_CHECKOUT_ENABLED`) and for processing existing payments. A PayTech section in the deploy gate. A database-level live/sandbox marker. | E1, E3, K1 |
| 5 | **Database guard** | `lib/payments/payment-database-guard.ts`: outside production, every payment write refuses unless the database itself declares that it is a sandbox. | E1 |
| 6 | **Eligibility** | Checkout refuses exactly where `complete_payment()` would, *before* money moves. | F3 |
| 7 | **Admin view** | Correct labels for all 7 statuses; provider, mode, `failure_reason` and `last_ipn_at` columns; test sales excluded from revenue; an "À rapprocher" filter. | A1 |
| 8 | **Small fixes** | Chokepoint parsing of 062's camelCase result; stale code comments; the *"Aucun montant n'a été débité"* overclaim; a refunded state on `/payment/success`; PGlite as a dev dependency. | F6, D1 |
| 9 | **Settlement parser** | The guessed allow-list is removed. Settlement is read through a **written contract**, `null` until PayTech confirms it. While `null`, nothing is inferred and no status request is made. | P1, F8 |

**One new defect was found by the new tests and fixed before handover.** The concurrency test caught a race in the rebuilt checkout: an earlier attempt completing *between* the learner's access check and the in-flight lookup let checkout open a second chargeable checkout for someone who already owned the course. Access is now re-checked **after** the in-flight read (`app/actions/paytech-checkout.ts`, step 7).

## 2. The eight mandatory safeguards

| Safeguard | How it is met | Proof (tests) |
|---|---|---|
| **1. No second chargeable attempt while an earlier one may have settled** | An opened attempt (token stored, URL handed out) is only replaced once the provider **reliably** reports it failed or cancelled, or after a human's manual reconciliation. If the provider says `pending`, the **same** URL is offered again. If paid, the learner goes in. If **unknown**, nothing is opened and the learner gets the order reference. An attempt never opened (no URL handed out) is closed and replaced. | `READY-F1 closed` ×5; checkout suite *"an OPENED live intent is never superseded"*; admin *"with NO contract, a human attestation closes…"* |
| **2. Processing continues when checkout is disabled** | `paytechProcessingAvailability()` needs only credentials and a mode matching the environment; it ignores the sales switch. The IPN, sweep and admin actions use it. | IPN *"closing CHECKOUT does not stop processing"*; sweep *"keeps reconciling when new checkout is switched off"*; provider-selection tests |
| **3. No settlement from an undocumented or ambiguous response** | `PAYTECH_SETTLEMENT_CONTRACT = null`. With a contract, exactly one status path is read, with no fallbacks; lists must be disjoint and the echoed reference must match. A paid answer must carry the promised amount. Anything else is `unknown`. | `READY-P1 FIXED` ×7; `READY-F8 / SAFEGUARD 3` ×5; IPN *"reads ONLY the contract's status path"*, *"with NO confirmed contract nothing is inferred"* |
| **4. Test payments cannot grant production entitlements** | Three layers. The app refuses test mode on production (both availabilities). Reconciliation refuses a test row on production. Migration 063 refuses **in the database**: a database marked `live` (the default) rejects entering `completed` with `provider_mode='test'`, so 062's whole transaction rolls back, whichever deployment performs the write. The application cannot change the marker. | `SAFEGUARD 4` ×5 (real 062 + 063); deploy-gate matrix |
| **5. Transitions validated against concurrent retries, webhooks and reconciliation** | 063's transition guard; compare-and-set writes; 062's row lock and idempotency; the post-in-flight access re-check. | `T13 / SAFEGUARD 5` ×4, including IPN×2 + sweep + admin verify + checkout retry at once giving exactly one completion and one row |
| **6. 063 compatible with 062; schema assumptions flagged** | 063 is executed **whole** on top of 062's **verbatim** function; every completion in the suite goes through both. 062's definition and ACL are asserted unchanged inside 063. Assumptions A1–A7 are listed in §4 and each is asserted by 063's preflight. | `M063` ×6, and every completion test |
| **7. Card form unreachable; no card data collected** | `PaymentMethodSelector` is deleted. No shipped `.tsx` renders a card, CVV, expiry or phone field. The legacy action refuses and reads no metadata. The button collects nothing; payment details are entered only on PayTech. | `READY-C2 FIXED` ×4 |
| **8. Server-authoritative amounts, XOF only** | Price is read from `courses`; the action accepts only `courseId`; a non-XOF or non-integer price is refused; the stored amount is what is billed, signed and completed. | T06 *"the browser cannot set the price or currency"*, *"a course priced in anything but XOF cannot be bought"* |

## 3. Changed files

**New:**
* `lib/payments/paytech-settlement-contract.ts`: the contract type, `null`, and its validator.
* `lib/payments/paytech-reconcile.ts`: the shared reconciliation procedure and the manual-close rule.
* `lib/payments/paytech-callbacks.ts`: the callback URLs and `mintReference()` (CSPRNG), moved out of the `'use server'` file.
* `lib/payments/purchase-eligibility.ts`: a mirror of 062 §7.
* `lib/payments/payment-database-guard.ts`: the check every payment write passes outside production.
* `app/api/payments/paytech/reconcile/route.ts`: the cron sweep, authenticated with `CRON_SECRET`.
* `app/(admin)/admin/payments/reconcile-actions.ts`: verify and close; admin-only, rate-limited, audited.
* `components/payment/PaytechCheckoutButton.tsx`
* `supabase/migrations/063_payment_state_machine.sql`
* `vercel.json`: one daily cron, and this branch's opt-out from automatic deployment (§7).
* `docs/payments/XP-PAYTECH-READY-01-SUMMARY.md` and this document.

**Rewritten:**
* `app/actions/paytech-checkout.ts`
* `app/api/payments/paytech/ipn/route.ts`
* `lib/payments/providers.ts`
* `lib/payments/payment-completion.ts`
* `app/(admin)/admin/payments/page.tsx`
* the settlement section of `lib/payments/paytech-client.ts`

**Edited:**
* `app/(platform)/checkout/page.tsx`
* `app/(platform)/checkout/confirm/page.tsx`: now a redirect.
* `app/(public)/courses/[slug]/page.tsx`: the CTA gate is now server-side.
* `app/actions/payment.ts`: now a refusal.
* `app/payment/success/page.tsx`
* `app/payment/cancel/page.tsx`
* `lib/payments/paytech-ipn.ts`: documentation only.
* `lib/hosts.ts`: the sweep is public on the cron host.
* `lib/audit/log.ts`: two event types.
* `lib/pilot.ts`: `PAYMENTS_ENABLED` retired.
* `scripts/security/verify-prod-config.mjs`: PayTech section.
* `.env.example`
* `package.json`, `package-lock.json`

**Deleted:** `components/payment/PaymentMethodSelector.tsx`.

**Tests:**
* Two suites rebuilt: `xp-paytech-ready-01-integration` (real PostgreSQL) and `xp-paytech-ready-01-readiness`.
* `xp-paytech-01-checkout` and `-ipn` updated.
* 25 earlier guard suites **re-expressed, not weakened**. Every "nothing above 062" now admits **063 by name**. Every pinned `lib/payments` listing names the five new modules. Every "exactly these writers/readers/routes" list stays exact. Where a guard pinned the retired legacy flow, it now pins the stronger property (for example, "no browser-role payment reader exists at all").

## 4. Migration 063: the payment state machine

### What it enforces

The guard is a `BEFORE UPDATE OR DELETE` trigger on `public.payments`. It applies to **every** role, `service_role` included.

| Rule | Detail |
|---|---|
| Status | `pending → processing\|completed\|failed\|cancelled\|expired`; `processing → completed\|failed\|cancelled\|expired`; `completed → refunded`. Everything else is final. |
| Identity | `id`, `reference`, `amount`, `currency`, `method` and `created_at` are immutable. `user_id` and `course_id` may only become NULL (their FKs are ON DELETE SET NULL). |
| Provider | `provider` and `provider_mode` are write-once. `provider_token` is write-once, and only onto a `pending` row. `provider_reference` is fixed once the payment leaves flight. |
| Completion | `completed_at` and a non-NULL `entitlement_id` are written only in the transition **into** `completed`. |
| Environment | Entering `completed` requires `provider_mode` to match `public.payment_environment`: `live` (the default) accepts only live payments, `sandbox` only test payments. Refusal reasons: `test_payment_in_live_database` / `live_payment_in_sandbox_database`. |
| Delete | A payment that carries a provider token, or is completed or refunded, is never deleted. |
| Forensics | `failure_reason`, `last_ipn_at` and `metadata` stay writable. |

Every refusal raises `P0001` with a JSON `reason` in DETAIL, the convention 062 established. The application records it in `failure_reason`.

### Compatibility with 062

062's only write to `payments` is its final UPDATE: `status → completed`, `completed_at`, `entitlement_id`, `provider_reference` (coalesced), and `metadata` (merged on the duplicate branch). It runs from a row 062 has already required to be `pending` or `processing`. Every one of those columns is allowed in exactly that transition. 063:
* adds **no column**, so 062's `public.payments` row type is unchanged;
* does not edit, replace or re-grant 062;
* asserts 062's definition hash and ACL are unchanged before committing.

The guard can refuse a 062 completion in one case only: a provider mode that does not belong to the database. 062's transaction then rolls back whole. **Proven by executing both**, not by reading them.

### Schema assumptions (each asserted by 063's preflight)

If any of these is false, 063 refuses to run and changes nothing.

| | Assumption |
|---|---|
| A1 | 062 is applied and `complete_payment` is INVOKER |
| A2 | `payments` has the 19 columns 060 and 062 expect |
| A3 | 060's 7-value status vocabulary and 058's mode vocabulary exist |
| A4 | 060's replay key and 058's in-flight index exist |
| A5 | No FK into `payments` is ON DELETE CASCADE |
| A6 | No trigger already exists on `payments` |
| A7 | Roles `service_role`, `anon` and `authenticated` exist |

### Self-test and assertions

Inside its own transaction, 063 exercises 12 rules on two scratch rows. It then rolls those writes back with a sentinel exception, so there are **zero net writes**. Afterwards it asserts:
* the trigger shape (BEFORE, ROW, UPDATE and DELETE, enabled);
* the function is INVOKER with a pinned `search_path`, and not executable by browser roles;
* the marker is a single `live` row, with no browser privilege and **SELECT only for service_role**;
* payment, entitlement, enrollment and audit counts and fingerprints are unchanged.

### Applying and rolling back

The operator procedure is at the foot of the file. Paste the whole file into the SQL editor in an off-peak window; "Success. No rows returned." means every assertion passed. Only an isolated test database is ever switched to `sandbox`.

The commented block at the foot drops the trigger, the function and the marker. It changes no row and proves payment counts unchanged. **Tested:** the integration suite uncomments and executes it, then re-applies 063.

## 5. Checkout and webhook security evidence

* **Authentication is unchanged:** shared-secret check before any database read, then an HMAC built from **our** stored amount and reference. A forged notification, a wrong-secret HMAC, a different signed amount or another order's reference are all refused without asking the provider (T05, T06, T07/T08).
* **The notification never decides.** Its `type_event` is logged as a hint and used for nothing else. The provider's answer, read through the contract, decides (*"an AUTHENTIC notification with its outcome flipped cannot grant"*).
* **The provider's own facts are cross-checked:** amount, currency, and the echoed reference must match the row.
* **Browser surfaces decide nothing:** `/payment/success`, `/payment/cancel` and `/checkout/confirm` have no write path (T05).
* **Learner sessions** still cannot write payments or entitlements, call `complete_payment`, or read `provider_token` or `metadata` (T14–T15, against the migrations' own privilege statements).
* **No secret, key hash, token, phone number or cron secret** is logged, across checkout, refusals, completion, the sweep and the admin actions (LOGGING).

## 6. Idempotency and reconciliation evidence

| Situation | Behaviour | Test |
|---|---|---|
| Second click, earlier attempt **unknown** | nothing opened; same reference returned; **no status request** when the contract is `null` | READY-F1 |
| Second click, earlier attempt **pending** | the **same** checkout URL | READY-F1 |
| Second click, earlier attempt **paid** | completion, then sent into the course | READY-F1 |
| Second click, earlier attempt **cancelled/failed** | closed; a **new** attempt with a **new** `ref_command` | READY-F1, T03 |
| Provider timed out opening a checkout | attempt closed (`provider_request_timeout`); next click opens cleanly | READY-F1 |
| Retry racing a completion | completed payment stays completed with its original token; no second charge | READY-F2 |
| Duplicate, replay, 5 concurrent IPNs | exactly one completion, entitlement, enrolment and audit row | T09, T10, T13 |
| IPN×2 + sweep + admin verify + checkout retry concurrently | one completion, **one payment row**, no second checkout | T13 |
| Pending, then paid with no further IPN | the **sweep** completes it | T04 |
| Transient database or RPC failure | all-or-nothing, answered **503** | T12 |
| Sweep, never-opened intent older than 30 min | closed (`abandoned_unopened`) | SWEEP |
| Sweep, opened attempt with unknown settlement | **left untouched**, noted, counted | SWEEP, READY-F8 |
| Admin close when PayTech says paid or pending | **refused**; the row is not touched | ADMIN |
| Admin close with no contract | requires a reason (10–500 chars) and an attestation; audited; frees the learner; grants nothing | ADMIN |

The sweep answers with **counts only**. It refuses without a `CRON_SECRET` of at least 16 characters (503) and with a wrong one (401), comparing in constant time over SHA-256 digests.

## 7. Environment isolation verification

Each line below was executed: availability against real `providers.ts`, the gate as a subprocess run from an empty directory.

| Configuration | Checkout | Processing | Deploy gate |
|---|---|---|---|
| production, `PAYTECH_MODE=test` (+ `ALLOW_PRODUCTION`) | refused | refused | **blocked** |
| production, test keys present | — | — | **blocked** |
| production, `prod`, no `ALLOW_PRODUCTION` | refused | **allowed** | passes (with `CRON_SECRET`) |
| production, `prod`, `ALLOW_PRODUCTION`, `CRON_SECRET` | allowed | allowed | **passes** |
| production, PayTech configured, no `CRON_SECRET` | — | — | **blocked** |
| production, `PAYTECH_CALLBACK_BASE_URL` set | pin ignored | — | **blocked** |
| preview, `PAYTECH_MODE=prod` / live keys / `ALLOW_PRODUCTION` | refused | refused | **blocked** |
| any, `NEXT_PUBLIC_*PAYTECH*` | — | — | **blocked** |
| nothing configured | refused | refused | passes |

In the database, a `live` database refuses test completions and a `sandbox` one refuses live completions (SAFEGUARD 4).

### The database guard

Outside production, every payment operation first asks the database what it is:

| Database says | Checkout | IPN | Sweep | Admin verify and close | Direct calls to the chokepoint |
|---|---|---|---|---|---|
| `sandbox` | allowed | allowed | allowed | allowed | allowed |
| `live` | refused | 503 | 503 | refused | refused |
| no marker, or unreadable | refused | 503 | 503 | refused | refused |

On a refusal, no payment row changes, PayTech is not called, and no audit or rate-limit row is written (`DATABASE GUARD` ×19, real routes on real SQL, and ×6 structural). With the guard disabled as a negative control, 18 of those 19 tests fail; the remaining one is the case where the guard allows the work. A production deployment does not consult the marker.

### No automatic deployment of this branch

Review of this branch happens through CI on the pull request, so it does not need a deployed preview. `vercel.json` opts this branch out, and only this branch, with two independent settings:

* `git.deploymentEnabled` tells Vercel not to create a deployment for it.
* `ignoreCommand` exits 0 for this branch, which skips the build, and exits 1 for every other branch, which builds as usual. It was executed under `sh` for this branch, `main`, another branch and no branch at all.

**Remove both in a commit on `main` after merging, not on this branch.** A push to this branch without them would deploy it.

## 8. Test results

*Node 20 (CI's version) and Node 24, Vitest 1.6.1, PostgreSQL 17 (PGlite 0.3.7), in a clean checkout of this tree with CI's placeholder environment, pinned to 2 CPUs. These are local results. They do not stand in for CI, and they do not prove production readiness.*

| Gate | Command | Result |
|---|---|---|
| Full regression, Node 20 and Node 24 | `npx vitest run` | **2483 / 2483**, 82 files, 0 failed, on each |
| Payment and security suites | `npx vitest run __tests__/payments __tests__/security` | **1426 / 1426**, 41 files, 0 failed |
| Real-PostgreSQL suite (062 verbatim + 063 whole) | `xp-paytech-ready-01-integration` | **94 / 94** |
| Readiness suite | `xp-paytech-ready-01-readiness` | **45 / 45** |
| TypeScript | `npm run typecheck` | clean (exit 0) |
| ESLint (CI's command) | `npm run lint` | exit 0 |
| ESLint on every changed source file | `npx eslint <files>` | **0 errors**. 21 warnings on the modified files against **23** on the same files at `e90746b`; **0** on the new files. |
| SQL lint | `npm run lint:sql` | no new issues: 61 migrations scanned |
| Secret scan | `npm run scan:secrets` | no credentials, tracked files and history |
| Bundle scan | `npm run scan:bundle` after `npm run build` | client bundle clean: 110 files, 13 patterns |
| Public-asset scan | `npm run scan:public-assets` | no new sensitive files: 14 formats checked |
| Production config audit | `npm run verify:prod-config` | exit 0 with nothing configured. The PayTech section is exercised in 9 configurations (§7) |
| Dependency audit | `npm run audit:prod` | passes at the critical threshold. No production dependency changed |
| Production build | `npm run build` (prebuild gate included) | compiled; 44/44 static pages |

## 9. The provider answer that blocks completion

PayTech must document the JSON that `GET /payment/get-status?token_payment=` returns: the field path, every status value for a payment, the amount and currency fields, and the reference echo. Or it must confirm that `POST /payment/status {ref_command}` is the supported call. **This fills `PAYTECH_SETTLEMENT_CONTRACT`. Until then no payment completes.**

## 10. Before live payments

* **Migration 063** is applied, after migrations through 062.
* **The settlement contract** is filled in one reviewed change, with PayTech's literal example as a fixture. `contractProblems()` must return `[]`.
* **Sandbox testing** passes on a database declared `sandbox`, and the recorded notifications and status responses match the contract and the HMAC format.
* **The provider's merchant approval** is in place.
* **Production configuration** is set for Production only: `PAYTECH_MODE=prod` and `PAYTECH_PROD_API_KEY`/`_SECRET`; `CRON_SECRET` (≥ 16 characters); then `PAYTECH_ALLOW_PRODUCTION=true` and `PAYTECH_CHECKOUT_ENABLED=true`. The deploy gate must pass.

## 11. Known limitations and follow-ups

* **After merging:** remove the two `vercel.json` opt-out keys and the test block that pins them, in a commit on `main`.
* **Cron frequency.** `vercel.json` runs the sweep **daily** (`0 5 * * *`). `*/15 * * * *` is the intended live cadence. The IPN, the admin "Vérifier" button and checkout's own re-check settle payments in between.
* **Two-session lock contention** is not exercised: PGlite has one connection. Concurrency is proven at statement interleaving, and by 062's row lock plus 063's guard.
* **PayTech payments are stored with `method = 'card'`.** The legacy CHECK admits only `orange_money`/`wave`/`card`, and the payer chooses the instrument on PayTech. The admin view shows "PayTech" instead.
* **A paid report on a closed payment** is not completed. It is acknowledged and needs a manual decision.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
