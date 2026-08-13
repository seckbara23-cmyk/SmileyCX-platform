# XPA-7 — B2B Organizations / Corporate Licensing

**Status:** ✅ **RATIFIED** — decisions D7-1…D7-7 received. Implementation proceeds W1–W6.
**Baseline:** `3fff251` (XPA-6B, 6C, 6D, UAT-ROUTE-01/02, UAT-ACCESS-01 all closed)

---

## 0. The two findings that change the plan

### A. The legacy organization tables are **deployed in production**

`docs/security/sec-1-identity-registration-forensic-audit.md` records:

> *"Single-tenant LMS. `organizations` exists in `cx_saas_schema.sql` but that
> file is **not** in `migrations/` and is not deployed."*

**That is wrong.** Probed against `eqoqcxkdcxeosjqaafhs`:

| Object | State | Rows |
|---|---|---|
| `organizations` | **deployed** | 0 |
| `organization_memberships` | **deployed** | 0 |
| `journeys` | **deployed** | 0 |
| `actions`, `feedback` | not deployed | — |
| `get_org_role(uuid)` | **deployed** | returns `null` |
| `is_org_member(uuid)` | **deployed** | returns `false` |
| `has_org_role(uuid, text)` | **deployed** | returns `false` |
| `is_platform_admin()` | **deployed** | returns `false` |

Migration `004_security_fixes.sql` already patched
`memberships_insert_admin`, which is consistent: the tables were applied outside
`migrations/` (the D-LEDGER class of drift) and have been carried since.

**XPA-7 therefore starts from an existing, empty, RLS-protected model — not a
blank page.** D-Q4's "preserve the legacy org tables, no competing model" is
directly actionable.

**Their RLS was verified, not assumed:**

| Probe as `anon` | HTTP | Actual effect |
|---|---|---|
| INSERT `organizations` | `401 42501` — *new row violates row-level security policy* | **0 rows created** |
| SELECT (against a service-role-seeded row) | `200` | **0 rows — RLS-empty** |
| UPDATE | `204` | name **unchanged** |
| DELETE | `204` | row **still present** |

The `200`/`204` responses are the DENIED_EMPTY/no-op shape this programme has
misread four times. Row counts were taken before and after every probe; nothing
was created, mutated or deleted. **No exposure.**

### B. `external_ref` cannot be backfilled — there is nothing in it

XPA-6C's closure proposed *"add `organization_id` to `entitlements` and backfill
from `external_ref`"*. Audited against production:

| Fact | Value |
|---|---|
| Entitlement rows | 6 |
| Rows with a non-null `external_ref` | **0** |
| `BUSINESS_EVALUATION` rows | **0** (all six are `MANUAL_ADMIN`) |

**The backfill is vacuously safe and completely pointless.** It has no rows to
operate on, and the column has no established production semantics — only the
free-text convention the XPA-6C verifier exercised with a synthetic fixture.

Per §3's instruction, the backfill is **not proven** and must not be forced.
`external_ref` should remain **historical free-text metadata**, and
`organization_id`, if added, should be populated **forward only**.

---

## 1. Ratified requirements found in the repository

Sparse. XPA-7 has never been briefed.

| Source | Statement |
|---|---|
| `xpa-0-audit.md:299` | *"XPA-7 — B2B organization enrollment (legacy org tables preserved, D-Q4). Depends on XPA-2, XPA-6."* |
| `xpa-0-audit.md:301` | XPA-9 payments **depends on** XPA-7 |
| **D-Q4** (register) | *"preserve the existing `organizations`/`organization_memberships` tables. Do not create a competing B2B model. Do not extend the legacy SmileyCX organization UI yet."* |
| `lib/entitlements/index.ts` | `CORPORATE_LICENSE` awaits *"XPA-7 corporate licences"* |
| `037_entitlements.sql` | `CORPORATE_LICENSE` requires `expires_at` (CHECK) |
| `xpa-0-audit.md:235` | the org model *"powers the legacy SmileyCX product (`/app/[orgSlug]`), untested, and branded SmileyCX"* |

**Implied by code/schema:** the organization shape, the five-role membership
model, the role-rank helpers, and the entitlement integration point.

**Nothing in the repository specifies:** seats, invitations, org reporting,
billing, conversion from evaluation, or whether a learner may belong to several
organizations. **None of these may be invented.**

---

## 2. Architecture reusable as-is

| Need | Existing | Note |
|---|---|---|
| Organization record | `organizations` | deployed, empty |
| Membership | `organization_memberships` | `UNIQUE(org_id,user_id)`, `invited_by` present |
| Org role checks | `get_org_role` / `is_org_member` / `has_org_role` | SECURITY DEFINER, deployed |
| Platform-vs-org separation | `is_platform_admin()` is independent | already correct |
| Corporate source | `CORPORATE_LICENSE` + mandatory-expiry CHECK | untouched by XPA-6C |
| Access authority | `has_course_access()` → `my_course_access` | **source-agnostic — needs no change** |
| Grant/revoke/suspend | `app/actions/entitlements.ts` | admin-gated, audited, rate-limited |
| Academic state | `ensureAcademicEnrollment()` | UAT-ACCESS-01 |
| Audit | `audit_log` + `logAuditEvent` | `invitation_id` column already reserved |
| Admin shell | `app/(admin)/admin/*` | organizations page can be added alongside entitlements |

**The access chain in the task description already works end-to-end today**:
`organization → membership → CORPORATE_LICENSE entitlement → has_course_access()`.
Only the first two links have no UI or actions; the entitlement link is proven.

---

## 3. Proposed organization model — reuse, do not recreate

`organizations` already has: `id, name, slug (unique), logo_url, industry,
country, plan, plan_status, created_at, updated_at`.

**One conflict must be decided.** `plan` (`trial|starter|growth|enterprise`) and
`plan_status` (`active|suspended|cancelled`) are a **subscription model from the
legacy SmileyCX SaaS product**. XPA-6B replaced commercial state with
entitlements. Keeping both means two places claim to say what a company has
bought. Options:

| Option | Consequence |
|---|---|
| **A. Ignore `plan`** (recommended) | entitlements remain the single commercial truth; the columns stay as dormant legacy, documented |
| B. Repurpose `plan` as a commercial tier label | risks becoming an authority again |
| C. Drop the columns | a destructive change to a deployed table for no functional gain |

**No new organization table is proposed.**

## 4. Proposed membership model — reuse

`organization_memberships` already has `role` ∈
`org_admin | cx_manager | team_manager | analyst | viewer`, ranked
`viewer=1 … org_admin=5` by `has_org_role`.

Five roles for a phase whose only ratified requirement is "B2B organization
enrollment" is more than the evidence supports — but they exist and D-Q4 says
preserve. **Recommendation: use only `org_admin` and `viewer` in XPA-7, leave
the other three unused rather than removing them.** No schema change.

**Missing and needed:** a membership `status` (invited/active/removed). The
table has `joined_at` but no lifecycle. That is the one genuine gap — and only if
invitations are in scope, which is undecided (§7).

## 5. CORPORATE_LICENSE model

Already fully specified by XPA-6B and unchanged by XPA-6C:

- source `CORPORATE_LICENSE`, **mandatory `expires_at`** (CHECK, three layers)
- `granted_by`, `granted_reason`, `starts_at`, revocation, timestamp-driven expiry
- **not** admin-selectable — deliberately withheld for XPA-7

**One corporate license row = one learner-course grant.** It is not a contract
object. A company buying 20 learners × 3 courses produces 60 entitlement rows.

**Seats: no evidence anywhere in the repository.** Not invented. If seat limits
are required they need a product decision and probably a contract table — which
would then be the natural home for `plan`.

## 6. Is `entitlements.organization_id` necessary?

**Not for access** — `has_course_access()` never needs it, and adding it must not
change the seam.

**Yes for attribution**, if organization reporting is in scope: "which grants
belong to this company" otherwise requires joining through membership, which is
wrong (a learner can leave a company while a grant remains). A nullable
`organization_id uuid references organizations(id) on delete set null` records
provenance at grant time and survives membership changes.

**Recommendation:** add it **nullable, forward-only, never backfilled**. All six
existing rows stay `NULL` — they are individual grants with no company behind
them, and inventing one would be fabricating provenance.

## 7. Multi-source behaviour — the sharpest open question

```sql
create unique index entitlements_one_live_per_course_idx
  on public.entitlements (user_id, course_id)
  where status in ('PENDING','ACTIVE','SUSPENDED');
```

**Only one live entitlement per learner per course.** So the three cases in §9 of
the task description resolve as follows *today*:

| Case | Current behaviour |
|---|---|
| evaluation converts to corporate licence | the evaluation must be REVOKED/CANCELLED first — the index forbids both being live |
| corporate licence expires while a manual entitlement remains | **impossible** — they could never both be live |
| corporate licence revoked while another valid source exists | **impossible** for the same course |

This is a **deliberate XPA-6B invariant**, not an oversight. Weakening it means
`has_course_access()` must aggregate across rows and "revoke access" stops being
a single action — a materially larger security change.

**Recommendation: do not weaken it.** Conversion becomes an explicit, audited
two-step (revoke the evaluation, grant the licence), which preserves history
because revoked rows are never deleted. **This needs ratification** before any
schema work.

## 8. Conversion from BUSINESS_EVALUATION

Preferred, pending ratification, and consistent with §7:

1. The historical evaluation row is **not** modified — its `source`,
   `granted_reason` and `external_ref` remain original evidence.
2. It is **REVOKED** with a reason recording the conversion (an audited event).
3. A new `CORPORATE_LICENSE` is granted, with `organization_id` set.
4. `organization_id` is **not** attached retroactively to the evaluation —
   provenance is preserved, not rewritten.

Moot in production today: zero `BUSINESS_EVALUATION` rows exist.

## 9. Organization roles vs platform roles

Already separate and must stay so. `is_platform_admin()` reads
`profiles.platform_role`; `has_org_role()` reads `organization_memberships.role`.
Neither consults the other.

**Invariant:** an `org_admin` must never gain platform authority. Concretely,
`grantEntitlement` is gated on `requirePlatformAdmin()` — so if org admins are to
issue licences within their own organization, that requires a **separate,
org-scoped action**, not a relaxation of the existing guard. Whether org admins
may grant at all is **undecided**.

## 10. Security matrix (to be proven, not assumed)

| Actor | orgs | own org | other org | memberships | grant `CORPORATE_LICENSE` | grant `MANUAL_ADMIN` | `entitlements` table | answer keys |
|---|---|---|---|---|---|---|---|---|
| anonymous | none | none | none | none | no | no | **42501** | **42501** |
| unrelated learner | none | n/a | **none** | none | no | no | **42501** | **42501** |
| org member | read own org | read | **none** | read own | no | no | **42501** | **42501** |
| org admin | read own org | manage | **none** | manage own | **undecided** | **never** | **42501** | **42501** |
| platform admin | all | all | all | all | yes | yes | via service role | via service role |
| service role | all | all | all | all | yes | yes | yes | yes |

Must be proven: org A admin cannot see or manage org B; a member cannot
self-promote; a learner cannot self-grant `CORPORATE_LICENSE`; an org admin
cannot grant platform sources; XPA-6D answer-key protection is untouched.

## 11. Reporting scope

**Nothing is ratified.** The defensible minimum, all readable from existing
tables with no new storage: member list, each member's access status per course
(`entitlements`), progress (`lesson_progress`), completion and certificate state.

Explicitly **not** in scope without requirements: analytics warehouse, manager
scorecards, department dashboards, benchmarking, performance ratings.

## 12. Migration plan — deliberately minimal

| # | Change | Necessity |
|---|---|---|
| 1 | `entitlements.organization_id uuid null references organizations(id) on delete set null` | attribution only; **no backfill** |
| 2 | `organization_memberships.status` + CHECK | **only if invitations are in scope** |
| 3 | Bring `organizations` / `organization_memberships` under migration control with an idempotent no-op guard, and reconcile the D-LEDGER drift | they are deployed but unversioned |
| 4 | RLS/grant review of both tables against D-GRANT | verified safe today; must be re-asserted in-migration |

**Not proposed:** a `companies` table, a contract/licence table, seat tracking,
or any change to `has_course_access()`.

Forward-only. **Migrations 037–039 are not edited.**

## 13. Implementation waves (after ratification)

| Wave | Content |
|---|---|
| W0 | Ratify the open decisions in §15 — **blocking** |
| W1 | Migration: `organization_id`, ledger reconciliation, RLS re-assertion |
| W2 | Platform-admin organization CRUD + membership management in the existing admin shell |
| W3 | `CORPORATE_LICENSE` becomes admin-selectable; grant path records `organization_id` |
| W4 | Organization detail view: members, access status, progress (reads only) |
| W5 | Regressions + `verify-xpa-7.mjs` (fixture-scoped, per the corrected 6D pattern) |
| W6 | Production verification, closure |

Invitations are **not** a wave until §15.4 is answered.

## 14. Operating-mode independence

`has_course_access()` and the org helpers are SQL and read no environment
variable. The admin shell is behind `requirePlatformAdmin()`. **No XPA-7 surface
should depend on pilot semantics**, and none of the proposed work does.

`PLATFORM_MODE=pilot` remains a standing finding and is not changed here.

**Legacy enrollment debt** (checkout routing, course-page `isEnrolled`,
`enrollForFree`) cannot interfere: none is an access authority after
UAT-ACCESS-01, and `enrollForFree` is closed behind two fail-closed flags. Left
documented, not touched.

## 15. Ratified decisions (D7-1 … D7-7)

| # | Decision | Consequence for this phase |
|---|---|---|
| **D7-1** | **One live entitlement per learner/course stays.** No simultaneous sources, no precedence, no multi-row aggregation in `has_course_access()`. | Source transitions are explicit **revoke → grant** with audit evidence. The partial unique index is untouched. |
| **D7-2** | **`organizations.plan` / `plan_status` are non-authoritative legacy metadata.** Not dropped, not repurposed. | Entitlements remain the sole course-access authority. Documented as pending a later cleanup. |
| **D7-3** | **Corporate licence authority stays platform-admin.** Org admins may not mint, extend, replace or revoke `CORPORATE_LICENSE`. | `requirePlatformAdmin()` is **not** weakened. No org-scoped granting action is created. Delegated allocation is a future seat/contract model, not XPA-7. |
| **D7-4** | **Minimal invitations are in scope.** | `organization_memberships` gains a `PENDING → ACTIVE → REMOVED` lifecycle. Reuses existing identity infrastructure. No plaintext-password provisioning, no bulk/HR onboarding. |
| **D7-5** | **Multi-organization membership allowed.** | No global one-org-per-user uniqueness. Uniqueness stays `(org_id, user_id)`. RLS must prevent org A seeing or managing org B. |
| **D7-6** | **No seats.** | No seat counts, pools, consumption, overages, capacity or seat billing. `CORPORATE_LICENSE` remains one explicit learner-course entitlement. |
| **D7-7** | **Minimal organization reporting.** | Members, access assignments, entitlement status/source/expiry, progress, completion, certificate state. No performance evaluation, benchmarking, department analytics, scorecards, warehouse or financial analytics. |

### Consequent architecture rulings

- Reuse the production `organizations` and `organization_memberships` tables. No competing model.
- `entitlements.organization_id`: **added**, nullable, FK to `organizations`, for forward corporate attribution. **Never backfilled.** Existing `MANUAL_ADMIN` rows and any `BUSINESS_EVALUATION` rows without an organization remain valid.
- `external_ref` stays historical free-text metadata.
- **Conversion:** preserve the `BUSINESS_EVALUATION` record and history → revoke the live evaluation where necessary → create the organization and membership → grant a new `CORPORATE_LICENSE` attributed to the organization → **never rewrite the original source or provenance.**
- XPA-9 payment/Wave work is entirely out of scope.

## 16. Acceptance gates

Full local suite · new XPA-7 regressions · `verify-xpa-6a` 57/57 ·
`verify-xpa-6c` 30/30 · `verify-xpa-6d` 22/22 · UAT-ROUTE-01/02 and
UAT-ACCESS-01 green · production probe with synthetic disposable actors and
**fixture-scoped cleanup** · CI green.
