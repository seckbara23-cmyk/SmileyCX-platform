# SEC-3 — DevSecOps & CI Hardening

**Classification:** Internal — Security
**Date:** 2026-07-04
**Phase:** Implementation (automation + supply chain)
**Predecessors:** [SEC-1 forensic audit](./sec-1-identity-registration-forensic-audit.md) · [SEC-2 remediation](./sec-2-remediation.md)

---

## 1. Executive summary

SEC-1 and SEC-2 both closed with the same line: **"CI status: no CI configured."** Every gate — typecheck, lint, tests, build, secret scan, bundle scan — was executed by hand, by me, once per phase. That is not a control; it is a habit that ends the moment someone else pushes.

SEC-3 turns those habits into enforced automation, and in doing so surfaced two findings that no amount of application review would have caught.

### Headline finding — critical authorization bypass in the framework

`next@14.2.14` was vulnerable to **GHSA-f82v-jwr5-mffw / CVE-2025-29927 — Authorization Bypass in Next.js Middleware**: a crafted `x-middleware-subrequest` header causes middleware to be skipped entirely.

This is severe *specifically here*, because **this platform's entire route authorization lives in `middleware.ts`**:

- the private-mode allowlist gate,
- the auth-required route list,
- the `/admin/*` `scx_admin` cookie gate.

A middleware bypass defeats all three at once — and it silently invalidated an assumption both prior phases relied on. SEC-1 reviewed middleware and found it "well-constructed and not the weak point"; that was true of the *code* and irrelevant against a framework that could be told not to run it.

**Fixed:** upgraded to `next@14.2.35` (patched in 14.2.25). A patch-level move within 14.2.x — no breaking changes. Verified: typecheck ✅, 96/96 tests ✅, build ✅. Both critical `next` advisories are gone.

### Second finding — three more instances of the F-2 bug class, found by the new linter on its first run

The RLS linter built in this phase (§4.3) was written to catch the exact defect behind SEC-1 finding F-2: a write policy with `USING` but no `WITH CHECK`. On its first execution it found **three more live instances** that SEC-1's manual review missed:

| Policy | Risk | Severity |
|---|---|---|
| `payments_update_own` | A learner can `UPDATE payments SET status='completed' WHERE user_id = auth.uid()` | **High (latent)** |
| `cert_service_update` | Scoped only by `bucket_id` — any authenticated user can update **any** certificate object | **Medium-high** |
| `enrollments_update` | A learner can rewrite their own enrollment row | **Medium** |

Full analysis in §5. **None are fixed in this phase** (scope), all are tracked in a baseline that fails CI on anything new.

### What shipped

| Area | Delivered |
|---|---|
| CI pipeline | `.github/workflows/ci.yml` — typecheck · lint · tests · build · bundle secret scan |
| Security pipeline | `.github/workflows/security.yml` — secret scan · RLS lint · dependency audit, **plus a weekly schedule** so new CVEs surface without a code change |
| Secret scanning | `scripts/security/check-secrets.mjs` — 7 credential shapes, tracked files **and full git history** |
| Bundle scanning | `scripts/security/check-bundle-secrets.mjs` — 12 patterns, automating the manual SEC-1/SEC-2 grep |
| RLS linting | `scripts/security/check-migrations.mjs` + baseline ratchet |
| Supply chain | `next` 14.2.14 → 14.2.35; audit gate on production dependencies |
| Local parity | `npm run verify` runs the same gates developers' CI will run |

---

## 2. The gap this phase closes

| Gate | Before SEC-3 | After |
|---|---|---|
| Typecheck | Manual | ✅ CI, every push/PR |
| Lint | Manual | ✅ CI |
| Unit tests (incl. SEC-2 security regressions) | Manual | ✅ CI |
| Production build | Manual | ✅ CI |
| Client-bundle secret scan | Manual grep, by me, 3 times | ✅ CI, automated |
| Secret scan of repo + history | **Never performed** | ✅ CI + weekly |
| RLS / migration safety | **Never performed** | ✅ CI + weekly |
| Dependency vulnerabilities | **Never performed** | ✅ CI + weekly |

The last three rows are the ones that mattered: each found a real issue on first run.

---

## 3. Supply chain remediation

### Applied

`next` **14.2.14 → 14.2.35** (latest 14.2.x; stays on the same minor, no migration required).

| Advisory | Severity | Status |
|---|---|---|
| GHSA-f82v-jwr5-mffw — Authorization Bypass in Middleware | **Critical** | ✅ Fixed |
| GHSA-7gfc-8cq8-jh5f — Authorization bypass | High | ✅ Fixed |
| Several DoS / cache-poisoning advisories | High/Moderate | ✅ Partly fixed |

Criticals across the whole tree dropped **3 → 2**; the one remaining is `@vitest/coverage-v8`, **dev-only tooling** that is never shipped.

### Not applied, and why

`next` retains **5 high** advisories (Server Component DoS, SSRF via WebSocket upgrades / rewrites, cache confusion). npm reports the fix as `next@16.2.12` — a **two-major migration** (14 → 16). That is a substantial, breaking piece of work with real regression risk across App Router, middleware, and server actions, and it does not belong in a CI-hardening phase. It is recorded as the top follow-up in §6.

**Honest characterisation of residual risk:** these are availability and request-forgery issues, not authorization bypasses. The authorization-bypass class — the one that would undermine SEC-1/SEC-2 — is closed.

### Audit gate threshold — a deliberate ratchet

The production audit gate blocks on **critical**, not **high**.

Gating at `high` today would leave CI **permanently red**, because the 5 remaining highs can only be cleared by the Next 15/16 migration. A permanently-red pipeline is worse than no pipeline: it trains everyone to ignore failures, and the next *real* critical scrolls past unnoticed. So: block on critical, print all advisories on every run, and raise the threshold to `high` as the final step of the Next migration.

---

## 4. What was built

### 4.1 `ci.yml` — correctness gates

Two jobs (`quality`, `build`) on every push and PR to `main`, with `concurrency` cancellation and read-only `permissions`.

The build job uses **placeholder** Supabase credentials. That is a deliberate assertion, not a shortcut: every page touching Supabase is dynamic, so nothing fetches at build time. If this job ever starts failing on network errors, something began fetching during the build and should be reviewed.

The build job then runs the bundle secret scan — automating the check I ran by hand in SEC-1, SEC-2 and Phase 1B/2B.

### 4.2 `security.yml` — security gates

Three independent jobs (`secrets`, `rls`, `dependencies`) so one failure doesn't mask another. Runs on push, PR, **and a weekly cron** — the schedule matters because a dependency can become vulnerable with no change to this repository.

### 4.3 `check-migrations.mjs` — RLS linter

Detects:
- write policies (`UPDATE` / `INSERT` / `ALL`) with no `WITH CHECK` — the **F-2 defect class**;
- `DISABLE ROW LEVEL SECURITY`;
- `USING (true)` policies;
- `GRANT ALL … TO anon/public`.

Two implementation details worth recording, both found by testing the tool against the real repository rather than trusting it:

1. **SQL comments are masked, not stripped.** These migrations carry commented-out `ROLLBACK` blocks by convention. Without masking, that example SQL parsed as live statements and produced false positives — including against my own SEC-2 fix. Masking preserves character offsets so line numbers stay accurate *and* the `-- rls-lint-ignore` suppression (itself a comment) remains findable.
2. **It analyses each file in isolation.** It cannot know that migration 027 supersedes a policy defined in 001, so a fixed-but-historical policy still matches. This is a documented limitation, handled via the baseline rather than by pretending the tool is smarter than it is.

**Baseline ratchet:** findings listed in `rls-lint-baseline.json` are reported as tracked debt and do not fail the build; **anything new fails**. The linter also warns when a baseline entry stops matching, prompting its removal — so the ratchet tightens rather than rotting into a permanent exemption list.

### 4.4 `check-secrets.mjs` — credential scanner

Scans tracked files **and every blob in git history** for 7 credential shapes. History matters: a secret deleted in a later commit is still exposed and still requires rotation.

It matches credential **shapes**, not variable names, so `.env.example` and documentation mentioning `SUPABASE_SERVICE_ROLE_KEY` don't create noise while a real key is still caught.

**Verified working, not merely passing:** all 7 patterns were tested against sample credentials (6/6 shape-matched) and against benign code (no false positive). A scanner only ever observed returning "clean" is indistinguishable from a broken one.

**Result on this repository: clean** — no credential in any tracked file or anywhere in history.

Two bugs in the scanner were found and fixed during that verification, both worth noting because they would have made it silently useless:
- shell quoting mangled the regexes → replaced `execSync` with `execFileSync` and argument arrays (no shell);
- patterns beginning with `-` (the `-----BEGIN PRIVATE KEY-----` block) were parsed by git as command-line options, exiting 129 → fixed with `git grep -e`.

### 4.5 `check-bundle-secrets.mjs` — client bundle scanner

12 patterns across three categories: server-only env var names, live credential shapes, and server-only code artefacts (the audit helper; any client registration call, guarding SEC-2 finding F-1). Result: **clean, 92 files scanned**.

### 4.6 Local parity

```
npm run verify   # typecheck + lint + lint:sql + test:ci + scan:secrets
```

Plus `lint:sql`, `scan:secrets`, `scan:bundle`, `audit:prod` individually. Developers can run exactly what CI runs, so failures are discovered before the push, not after.

---

## 5. New findings from the tooling (require a follow-up phase)

All three are the **same bug class as F-2** and none is fixed here — remediating RLS policies properly demands the SEC-2 treatment (verify intent, trace every app flow that writes the table, minimal fix, regression test), which is a phase of its own.

### N-1 · `payments_update_own` — latent payment bypass · **HIGH**

```sql
CREATE POLICY "payments_update_own" ON payments FOR UPDATE
  USING (user_id = auth.uid() OR is_platform_admin());   -- no WITH CHECK
```

`payments.status` is `CHECK (status IN ('pending','processing','completed','failed','refunded'))`. A learner can therefore mark their own pending payment `'completed'`. **Confirmed not superseded** — migration 011 redefines only the *INSERT* policies.

- **Impact today: low.** Payments are inactive during the pilot (`FREE_ACCESS_MODE`).
- **Impact on activation: high — a direct payment bypass.**
- **Must be fixed before payments are enabled.**
- Proposed fix: drop the learner `UPDATE` policy entirely. All payment mutations already run through service-role server actions (`app/actions/payment.ts`, `lib/payments/index.ts`) which bypass RLS, so the policy appears to grant capability nothing legitimately uses.

### N-2 · `cert_service_update` — cross-user certificate tampering · **MEDIUM-HIGH**

```sql
CREATE POLICY "cert_service_update" ON storage.objects FOR UPDATE
  USING (bucket_id = 'certificates');   -- no owner scoping, no WITH CHECK
```

The sibling `SELECT` policy correctly scopes to `(storage.foldername(name))[1] = auth.uid()::text`; this one does not. **Any authenticated user can update any object in the certificates bucket** — overwrite another learner's certificate PDF. Exploitable today.

Proposed fix: mirror the SELECT policy's owner scoping and add a matching `WITH CHECK`, or restrict the policy to the service role.

### N-3 · `enrollments_update` — self-modifiable enrollment · **MEDIUM**

A learner can rewrite their own enrollment row (status, expiry). Low impact while pilot grants free enrollment; an access-control bypass once enrollment is paid or time-limited.

> **Why these were missed in SEC-1.** That audit was scoped to *identity and registration* and examined the `profiles` policy in depth. These three sit in payments, storage and enrollments. This is the argument for automated invariants over manual review: the linter checks **every policy in every migration, every run**, and does not get tired or run out of scope.

---

## 6. Remaining work

| # | Item | Why | Priority |
|---|---|---|---|
| 1 | Fix N-1, N-2, N-3 (SEC-4) | Live RLS write-policy holes; N-1 blocks payment activation | **High** |
| 2 | Next.js 14 → 15/16 migration | Clears 5 remaining high advisories; then raise the audit gate to `high` | High |
| 3 | Enable branch protection (§7) | CI is advisory until merges are actually blocked | **High** |
| 4 | Upgrade `@vitest/coverage-v8` | Last remaining critical (dev-only) | Medium |
| 5 | E2E tests in CI | `playwright` exists but isn't wired to CI | Medium |
| 6 | Server-side login / password reset | Carried from SEC-2 §7 — enables real auth rate limiting | Medium |
| 7 | Dependabot / Renovate | Automated dependency PRs instead of weekly-audit-then-manual | Medium |

---

## 7. Manual step required — branch protection

**The CI added here does not block anything until this is configured.** GitHub does not enforce status checks by default; a red pipeline is merely a red mark next to a mergeable PR.

GitHub → Settings → Branches → add a rule for `main`:

- [ ] **Require status checks to pass before merging** — select: `Typecheck · Lint · Test`, `Production build`, `Secret scan`, `RLS / migration lint`, `Dependency audit`
- [ ] **Require branches to be up to date before merging**
- [ ] **Do not allow bypassing the above settings** (applies rules to administrators too)
- [ ] Require a pull request before merging (recommended: direct pushes to `main` skip PR-triggered checks entirely)

Until this is done, the workflows report but do not enforce.

---

## 8. Verification

| Gate | Result |
|---|---|
| `npm run typecheck` | ✅ Pass |
| `npm run lint` | ✅ Pass — no new warnings |
| `npm run lint:sql` | ✅ Pass — 27 migrations, 4 baselined, 0 new |
| `npm run test:ci` | ✅ **96 passed / 0 failed** |
| `npm run scan:secrets` | ✅ Clean — tracked files + full history |
| `npm run scan:bundle` | ✅ Clean — 92 files, 12 patterns |
| `npm run audit:prod` | ✅ Pass (0 critical in production deps) |
| `npm run build` | ✅ Compiled successfully |
| `npm run verify` | ✅ **exit 0** |
| Workflow YAML | ✅ Both parse; jobs resolve |

**Post-upgrade regression check:** the `next` upgrade was verified against the full suite before anything else was built — typecheck, 96/96 tests, and a clean production build.

---

**End of SEC-3 report.**
