# Effitrans — reusable Vercel/Supabase security baseline

**Derived from:** XP Client Academy (XP-SEC-01), 2026-10-27
**Status:** template. **Not validated against Effitrans.** Nothing here may be enforced before §6 is complete.

> ## ⚠ Do not copy XP Client Academy's rules into Effitrans
> XP Client Academy is a public learning site whose only machine caller is one payment IPN. Effitrans is the opposite: a back-office platform whose traffic is substantially **machine-originated** — telematics ingestion, partner webhooks, document uploads. A ruleset tuned for a marketing site will silently drop freight data.
>
> **Effitrans requires its own endpoint inventory and its own compatibility testing before any enforcement.** That is §6, and it is mandatory, not advisory.

---

## 1. What transfers unchanged

These are platform-shaped, not product-shaped, and apply to any Vercel + Supabase deployment.

**Deployment Protection.** Keep Vercel Authentication on `all_except_custom_domains`: previews authenticated, production public. The consequence to internalise — and the single most expensive lesson from XP Client Academy — is that **this blocks every unauthenticated machine callback to a preview URL.** Any webhook, IPN or telematics feed must be given a documented exception *before* integration testing, not discovered during it.

**Secret management.**
* Every credential server-only. Nothing sensitive behind `NEXT_PUBLIC_`.
* A build-time scan that fails the build if a secret reaches the client bundle (XPCA's `scan:bundle`).
* Credential names derived from a resolved mode (`<PROVIDER>_<MODE>_<KEY>`), never a single shared key, so test and live are structurally incapable of crossing.
* A config boundary that **refuses to resolve** rather than defaulting. Absent or misspelled fails closed.

**Supabase RLS verification.** RLS enabled on every table holding tenant data; policy sets asserted in CI rather than attested by hand; service-role usage confined to named server modules; a migration lint gate (`lint:sql`) that fails on a new `FOR UPDATE` policy without `WITH CHECK`.

**Environment isolation.** Preview must never share a database with Production. Audit *all* shared-scope variables, not just the database three — on XPCA, Preview also shared the admin allowlist and two billable third-party API keys.

**Observation-first rollout.** Every rule starts in LOG mode; enforce only after logs show zero false positives. Capture the baseline before changing anything. Document rollback per change.

**Monitoring.** Configure a log drain *before* enforcement, or false positives are invisible. XPCA has none, which is why its rules stay in LOG mode.

---

## 2. What must change, per Effitrans workflow

### Customs dossier workflows
Long-lived, multi-step, document-heavy. Rate limits keyed per-IP will punish a clerk working a dossier queue.
* Key limits on **authenticated user**, not IP — a freight office is behind one NAT address.
* Exclude dossier-mutation routes from bot protection; they are authenticated back-office actions.
* RLS must scope by **dossier ownership and organisation**, not merely by user id.

### Finance and invoice issuance
* **Never** place a challenge on invoice-generation or payment-reconciliation endpoints.
* Reuse XPCA's payment architecture wholesale: transport/authority separation, one completion chokepoint, provider-verified settlement, a UNIQUE provider reference as the replay key, idempotent repeat handling.
* **Carry over the hard-won lesson:** a provider signature proves only what it *covers*. Enumerate the signed fields before trusting any webhook. XPCA shipped a defect because a signature covered amount and reference but **not the outcome**, and the outcome was read from the unsigned payload.
* Invoice numbering needs a DB-level uniqueness constraint, not application logic.

### HR imports and sensitive documents
* Import endpoints accept large multipart bodies — size limits must be raised deliberately, and a firewall body-size rule would block them.
* Personal data demands RLS plus column-level restriction; mirror XPCA's technique of withholding sensitive columns from the browser role entirely rather than filtering in the query.
* Audit every read, not only writes.

### Document malware scanning
Not a Vercel control. Scan **out of band**: upload to a quarantine bucket, scan asynchronously, promote on a clean verdict. Serve nothing from quarantine. A Vercel firewall rule cannot inspect file content — do not pretend otherwise.

### GPS / telematics ingestion
**The highest-risk surface for a copied ruleset.** High-frequency, machine-originated, no browser.
* **Exclude from every challenge, bot check and per-IP rate limit.** A device fleet reporting from a handful of egress IPs looks exactly like an attack.
* Authenticate with a per-device credential or mTLS, verified server-side; never by IP allowlist alone.
* Rate-limit **per device**, generously, in the application.
* Ingestion must be idempotent — devices retry; use a device-supplied sequence or timestamp as the dedup key.

### Live vehicle tracking and route APIs
* Long-polling or streaming connections tolerate firewall rules badly; verify before enforcing.
* Third-party routing APIs are billable: cap spend and alert, as a security control rather than a finance one.

### Third-party integration webhooks
* Inventory **every** inbound webhook path before enabling protection; each needs its own documented exception.
* For each: enumerate exactly which fields the signature covers; require a timestamp or nonce for replay defence, and if the provider offers none, defeat replay with a uniqueness constraint plus idempotent handling.
* Prefer a provider's server-to-server verification endpoint over trusting any notification body. **Check that one exists before designing around its absence** — XPCA wrongly concluded none existed and built on a weaker signature as a result.

---

## 3. Proposed Effitrans rule set (all LOG first)

| # | Surface | Rule | Mode |
|---|---|---|---|
| 1 | auth routes | rate limit per IP | LOG |
| 2 | back-office mutations | rate limit per **user** | LOG |
| 3 | admin routes | monitor + alert | LOG only |
| 4 | public forms | bot protection | LOG |
| 5 | **telematics ingestion** | **explicit exclusion** | enforce exclusion |
| 6 | **partner webhooks** | **explicit exclusion, per path** | enforce exclusion |
| 7 | **finance/invoice endpoints** | **no challenge, ever** | enforce exclusion |
| 8 | document upload | size + type limits in-app | enforce in-app |

Never: Attack Mode, geographic blocking (freight is cross-border by definition), or any enforcement before §6.

---

## 4. Secrets inventory to complete before launch

Per credential record: name, scope (prod/preview/dev), owner, rotation interval, blast radius if leaked, and whether it is billable. XPCA's gap was billable third-party keys shared into Preview — cost exposure that no security rule would have caught.

## 5. Monitoring and incident alerts

Log drain configured **before** enforcement. Alert on: auth failure spikes, admin-route access from new sources, webhook signature failures (the signal that a provider rotated a secret *or* that someone is probing), ingestion volume collapse (a false positive looks like silence), and spend thresholds.

## 6. Mandatory pre-enforcement checklist

1. [ ] Complete endpoint inventory — every path, its caller, whether it is browser or machine.
2. [ ] Every machine caller's egress behaviour documented (IP ranges, frequency, retry policy).
3. [ ] Exceptions configured for all of §3 rows 5–8.
4. [ ] Log drain live, with a baseline traffic profile captured.
5. [ ] Each rule run in LOG mode across a full business cycle including month-end finance load.
6. [ ] False-positive review signed off.
7. [ ] Rollback rehearsed, not merely documented.
8. [ ] Preview/Production database isolation proven.

**Enforcement before every box is ticked is a self-inflicted outage.** On a freight platform that means stale vehicle positions and missed customs deadlines, which is materially worse than the attack most of these rules mitigate.

---

## 7. Effitrans rule matrix (XP-SEC-02 Phase 8)

Derived from XP Client Academy's matrix, re-scoped for a back-office freight platform. **Not validated against Effitrans.** Every row stays in LOG until §6's checklist is complete.

| # | Surface | Method | Match | Proposed action | Verification | Rollback |
|---|---|---|---|---|---|---|
| 1 | auth routes | POST | >10 req / 5 min / IP | **LOG** | a freight office shares one NAT address — expect clustering | remove rule, publish |
| 2 | customs dossier mutations | POST/PATCH | >60 req / 5 min / **user** | **LOG** | must not fire on a clerk working a dossier queue | as above |
| 3 | finance / invoice issuance | POST | — | **EXCLUSION, no challenge ever** | confirm invoice generation and reconciliation still complete | remove only when the module is retired |
| 4 | HR import upload | POST | body size, type | **enforce in-app, not at the edge** | large multipart must survive; a firewall body rule would block it | relax the in-app limit |
| 5 | document upload | POST | type allow-list | **enforce in-app** + out-of-band malware scan | quarantine bucket → async scan → promote on clean verdict | disable promotion, keep quarantine |
| 6 | **GPS / telematics ingestion** | POST | — | **EXCLUSION from every challenge, bot check and per-IP limit** | a device fleet behind a few egress IPs looks exactly like an attack | never remove without a device-level limit in place |
| 7 | vehicle tracking / streaming | GET/WS | — | **EXCLUSION** | long-polling and streaming tolerate edge rules badly | as above |
| 8 | **third-party webhooks** | POST | per path | **EXCLUSION, one per inventoried path** | each needs its own documented exception | as above |
| 9 | admin routes | ALL | any | **LOG + alert** | RBAC/RLS remain the authority | remove rule |
| 10 | public forms | POST | bot score | **LOG** | verify server-side token checks | remove rule |

**The three rows that would cause an outage if copied from XP Client Academy:** 6, 7 and 8. XP Client Academy has exactly one machine caller; Effitrans has continuous machine traffic from vehicles, partners and integrations. A per-IP limit tuned for a marketing site will drop freight telemetry, and the symptom — stale vehicle positions, missed customs deadlines — is materially worse than the attack the rule mitigates.

**Rate-limit keys differ by platform.** XP Client Academy keys on IP for anonymous surfaces because its users are individuals on varied connections. Effitrans must key on **authenticated user** for back-office work and on **device identity** for telematics, because its users share office egress addresses and its devices share fleet egress addresses.

**Application-layer isolation gate.** Effitrans should carry its own copy of `scripts/security/verify-uat-isolation.mjs`, with its own hard-coded production project ref and its own live-credential list (payment processor, customs filing endpoint, telematics provider). The technique that matters is reading the project ref out of the **credential itself**, not only out of the URL — a URL can look isolated while the keys beside it are production.
