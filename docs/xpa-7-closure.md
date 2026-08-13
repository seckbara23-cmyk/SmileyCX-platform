# XPA-7 — B2B Organizations / Corporate Licensing: CLOSED

**Status:** ✅ CLOSED — production PASS
**Baseline:** `688de87` (ratified brief) on `3fff251` (XPA-6C closed)
**Migration applied:** 040 — applied to `eqoqcxkdcxeosjqaafhs` on 2026-08-13
**Brief:** [xpa-7-brief.md](xpa-7-brief.md) · decisions D7-1 … D7-7

---

## Production verification — 32 checks, 0 failures

`scripts/security/verify-xpa-7.mjs`, run against production with real JWTs and
fixture-scoped cleanup.

### Isolation — the boundary this phase introduces

| Check | Result |
|---|---|
| org A admin sees exactly their own organization | 1 row |
| org A admin reads org B | **DENIED_EMPTY** |
| org A admin renames org B | refused, name **unchanged** |
| org A admin adds a member to org B | **`403 42501`**, org B still has 1 |
| org A admin reads org B membership | **DENIED_EMPTY** |

### The self-join defect, closed

| Check | Before 040 | After |
|---|---|---|
| outsider self-joins an organization | **`201`, row created** | **`403 42501`, rows 3 → 3** |
| outsider reads any organization | name/slug/plan returned | **DENIED_EMPTY** |

### Authority

| Check | Result |
|---|---|
| member self-promotes to `org_admin` | role `viewer` → `viewer` |
| org member has course access | **`false`** |
| org **admin** has course access | **`false`** |
| org admin creates an entitlement | **`403 42501`**, rows 6 → 6 |
| org admin reads `entitlements` | **REFUSED_BY_PRIVILEGE** |
| platform authority grants `CORPORATE_LICENSE` | **`201`** |
| licensed learner has access / reads content | **`true` / ALLOWED** |
| grant attributed to the organization | **`true`** |
| **perpetual `CORPORATE_LICENSE`** | **refused `400 23514`** (schema CHECK) |

### Expiry beats academic state

| Check | Result |
|---|---|
| licensed learner + enrollment | access |
| **expired licence** | **access DENIED** |
| …while the enrollment is still `active` | 1 active row |
| expired → content | DENIED_EMPTY |
| window reinstated | access returns |
| **revoked** licence | access DENIED |
| enrollment alone | denied |

### Lifecycle and multi-organization

| Check | Result |
|---|---|
| REMOVED member sees any organization | **DENIED_EMPTY** |
| PENDING invitee sees any organization | **DENIED_EMPTY** |
| dual member sees **both** their organizations | 2 rows |
| outsider still sees nothing | DENIED_EMPTY |
| `correct_answer` / `correct_category_id` | **`42501`** ×2 |

**Cleanup:** 0 fixtures left, 0 probe accounts, organizations back to 0. Real
rows reported informationally only — never asserted on.

### Other verifiers, re-run after 040

`verify-xpa-6a.mjs` **57/57** · `verify-xpa-6c.mjs` **30/30** ·
`verify-xpa-6d.mjs` **22/22**.

---

## The security finding this phase closed

The XPA-7 audit began by probing the legacy tables rather than trusting the
documentation, and found two things.

**First, the documentation was wrong.** `sec-1-identity-registration-forensic-audit.md`
records `organizations` as *"not deployed"*. It is deployed, along with
`organization_memberships`, `journeys`, and four SECURITY DEFINER helpers —
applied outside `migrations/` (D-LEDGER drift) and carried ever since.

**Second, membership isolation was inverted.** Migration 004's
`memberships_insert` permitted `user_id = auth.uid() AND role = 'viewer'` with
**no constraint on which `org_id`**. Proved against production:

```
learner self-joins an unrelated organization as viewer  → HTTP 201, row created
learner then reads that organization                    → name, slug, plan returned
learner then reads its membership list                  → visible
learner self-promotes to org_admin                      → correctly blocked
```

Any authenticated user could enrol themselves into any company and read it.
Harmless only because zero organizations existed — and XPA-7 is the phase that
makes them exist.

Migration 040 removes the self-service arm: membership is created by a platform
admin, or by an ACTIVE `org_admin` **of that same organization**, and never by
the person being added.

**A near-miss worth recording.** The first probe returned `200` on INSERT and
`204` on UPDATE/DELETE, which reads like a live exposure. Row counts taken
before and after each probe showed nothing created, mutated or deleted — the
DENIED_EMPTY/no-op shape this programme has now misread five times. The finding
was re-probed with counting before anything was reported.

---

## Architecture

**Reused, not recreated.** `organizations` and `organization_memberships` are
the deployed legacy tables (D-Q4). No `companies` table, no contract table, no
competing membership model, no change to `has_course_access()`.

| Change | Why |
|---|---|
| `entitlements.organization_id` | attribution only — nullable, `ON DELETE SET NULL`, **never backfilled** |
| `organization_memberships.status` | `PENDING`/`ACTIVE`/`REMOVED`, default `ACTIVE` |
| `is_org_member` / `get_org_role` / `has_org_role` | filter `status = 'ACTIVE'` — otherwise the lifecycle is decoration |
| `memberships_insert` | self-join arm removed |
| membership + organization UPDATE policies | `WITH CHECK` added (the F-2 defect class) |
| organization creation | platform-admin only; `orgs_insert_authenticated` dropped |
| privileges | `revoke all … from anon` on both tables (D-GRANT) |

`ON DELETE SET NULL` rather than CASCADE is deliberate: deleting an organization
must never delete a learner's commercial history.

### Application

`lib/organizations/index.ts` (roles, lifecycle, transitions, slug) ·
`app/actions/organizations.ts` (create, add member, change status — every one
behind `requirePlatformAdmin()`) · `app/(admin)/admin/organizations/` list,
create form, detail with members, lifecycle controls and read-only access
reporting · `CORPORATE_LICENSE` added to `ADMIN_SELECTABLE_SOURCES` with an
organization selector in the existing grant form.

**There is deliberately no `grantCorporateLicense` action.** D7-3: an
organization administrator manages a roster; a platform administrator issues
commercial rights. `grantEntitlement` stays behind `requirePlatformAdmin()` and
gained no org-scoped bypass — asserted by test and proved in production.

---

## Ratified decisions, as implemented

| # | Implemented as |
|---|---|
| **D7-1** | The partial unique index is untouched; 040 neither drops nor references it. Transitions are explicit revoke → grant. |
| **D7-2** | `plan` / `plan_status` kept, never read for access; shown greyed and labelled "non contractuels" in the UI. Asserted absent from the seam. |
| **D7-3** | No org-scoped granting action exists. Org admin creating an entitlement: `42501`, rows unchanged. |
| **D7-4** | `PENDING`/`ACTIVE`/`REMOVED`; REMOVED is terminal; helpers filter ACTIVE; illegal transitions refused, not applied. |
| **D7-5** | No global one-org-per-user constraint. A dual member sees both organizations and nothing else. |
| **D7-6** | No seat, capacity, allocation or overage concept anywhere — asserted by test over both the migration and the actions. |
| **D7-7** | Reporting is a read of `organization_memberships`, `entitlements` and existing progress tables. No new storage, no analytics. |

---

## Local results

| Gate | Result |
|---|---|
| Typecheck | ✅ |
| Lint | ✅ 0 errors |
| Full suite | ✅ **675 tests / 23 files** (was 636 / 22) |
| XPA-7 regressions | ✅ **39** |
| Migration lint | ✅ 40 scanned, 4 baseline |
| Secret scan | ✅ |
| Production build | ✅ |

---

## Operating-mode independence

`has_course_access()`, `entitlement_accessible()` and the organization helpers
are SQL and read no environment variable. Every organization surface is behind
`requirePlatformAdmin()`. No XPA-7 workflow depends on pilot or free-access
semantics, and `PLATFORM_MODE` was **not** changed.

**Legacy enrollment debt** (checkout routing, course-page `isEnrolled`,
`enrollForFree`) cannot interfere: none is an access authority after
UAT-ACCESS-01, and none is consulted by any organization or corporate-licence
path. Left documented, not touched.

---

## Residual risks

1. **No production organization exists yet.** Every result above comes from
   synthetic fixtures, cleaned deterministically. The first real customer will
   be the first non-synthetic exercise of this model.
2. **Invitations are minimal.** `PENDING` is a state, not a delivery mechanism —
   no email is sent and no acceptance link exists. A platform admin creates the
   PENDING row and moves it to ACTIVE. A real invitation flow needs the
   invitation module `audit_log.invitation_id` still reserves.
3. **`organizations.plan` remains** as dormant legacy metadata (D7-2), a second
   thing in the schema that looks commercial but is not. Documented and
   asserted-against rather than removed; a later cleanup should retire it.
4. **The legacy `/app/[orgSlug]` product still exists** and is untested,
   SmileyCX-branded, and now reads tables whose policies XPA-7 changed. It was
   not touched (D-Q4). It should be audited or retired before any customer sees it.
5. **D-LEDGER drift persists** — 040 is versioned, but the tables it reconciles
   were not, and migrations 001–034 remain unreconciled.
6. **Org admins cannot yet manage their own roster through a UI.** The policies
   permit it; only the platform-admin surface was built. Deliberate — D7-3 keeps
   authority central and no requirement asked for a customer-facing console.

---

## Explicit exclusions

XPA-8 launch readiness · XPA-9 payments, Wave, invoices, reconciliation ·
seats, contracts, capacity · departments, teams, manager hierarchy · bulk
upload · corporate dashboards · employee performance reporting · XPA-1 asset
remediation. The migration 037 comment edit and the six untracked `public/`
assets remain excluded and untouched.

---

## Is XPA-8 safe to begin?

Not assessed — XPA-7 stops here by instruction. What XPA-7 leaves for it: the
access model is now consistent across individual, evaluation and corporate
sources, all resolving through one seam; and residual risks 2, 3 and 4 above are
the natural candidates for launch-readiness scope.
