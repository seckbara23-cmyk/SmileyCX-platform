# XP-SEC-02 — Local UAT setup & Vercel firewall rule matrix

**Measured:** 2026-10-27 · **Baseline:** `e90746b` (PR #56) · **Stacked on PR #57**

> Companion to `xp-sec-01-vercel-baseline.md`. Nothing here has been applied to Vercel, Supabase or Production.

---

## 1. Local tooling — none of it is installed

| Tool | State |
|---|---|
| Docker / Docker Desktop | **NOT INSTALLED** (no `docker` binary, no daemon) |
| Supabase CLI | **NOT INSTALLED** (`npx` refuses without an install prompt) |
| `psql` / `pg_dump` | **NOT INSTALLED** |
| `supabase/config.toml` | **absent** — the project has never been configured for a local stack |
| Node / npm | present |

Installing Docker Desktop and the Supabase CLI is a **system configuration change requiring owner approval**, so Phase 2 stops here.

### Smallest viable local setup (needs approval)

1. **Docker Desktop** (WSL2 backend on Windows 11) — ~2 GB install, 4 GB RAM while running.
2. **Supabase CLI** — `npm i -D supabase` keeps it project-local and version-pinned with the repo, which is preferable to a global install.
3. `npx supabase init` → creates `supabase/config.toml`.
4. **Bind to loopback only.** In `config.toml` set every `*.ip` to `127.0.0.1`. The default already binds locally, but assert it — the stop condition is "no public exposure of local database services".
5. `npx supabase start` → local Postgres, Auth, Storage, PostgREST.
6. `npx supabase db reset` applies `supabase/migrations/*` in order (001 → 062).
7. Verify with the SQL in §3.
8. Seed synthetic data only (§4).

**Cost: $0.** No paid resource is involved.

---

## 2. Isolation gate — implemented and enforced

`scripts/security/verify-uat-isolation.mjs` · `npm run verify:uat-isolation`

A URL check alone is insufficient, because the mistake people actually make is pointing the URL at a local stack **while pasting production keys beside it** — the URL then looks isolated and every request still carries production credentials.

Supabase keys are JWTs whose payload carries a `ref` claim naming their project. The gate therefore reads the project ref from **three independent sources** and refuses if any names production:

```
NEXT_PUBLIC_SUPABASE_URL hostname  ·  anon key `ref`  ·  service-role key `ref`
```

The claim is **read, never verified** — we ask which project a credential belongs to, not whether a token is authentic. No key value is ever printed or stored.

It also refuses: `PAYTECH_MODE=prod`, any `PAYTECH_PROD_*`, `PAYTECH_ALLOW_PRODUCTION=true`, `PAYDUNYA_MODE=live`, a live mailer (`RESEND_API_KEY` without `EMAIL_DRY_RUN=true`), and billable AI keys whose feature flag is still `true`. `PRODUCTION_PROJECT_REF` is hard-coded so the gate cannot be disarmed by editing the configuration it polices.

**Verified against the current `.env.local`** (which holds production credentials): refused, exit 1, naming all three sources. 18 tests cover it.

---

## 3. Verification SQL (run after `db reset`)

```sql
select to_regprocedure('public.complete_payment(text,text,text,text,text,numeric,text)') is not null as fn_exists;
select to_regclass('public.payments_provider_token_unique') is not null as replay_key;
select relrowsecurity from pg_class where oid = 'public.payments'::regclass;          -- expect true
select polname, polcmd from pg_policy where polrelid='public.payments'::regclass order by polname;
select count(*) from information_schema.columns where table_name='payments';          -- expect 19
select proname, prosecdef from pg_proc where proname = 'complete_payment';            -- expect prosecdef = false (INVOKER)
select has_function_privilege('anon','public.complete_payment(text,text,text,text,text,numeric,text)','execute');        -- expect false
select has_function_privilege('authenticated','public.complete_payment(text,text,text,text,text,numeric,text)','execute'); -- expect false
```

Expected policy set: `payments_insert_service/a`, `payments_no_browser_delete/d`, `payments_no_browser_update/w`, `payments_own/r`.

**Do not execute `complete_payment()` during verification.**

---

## 4. Synthetic seed only

Invented learners, one published course with a non-zero XOF price, orders minted by the application. **Never** copy production users, learner progress, payments, certificates, storage objects or service-role secrets. Storage buckets start empty — course media will be absent, which does not block a payment test.

---

## 5. Vercel firewall rule matrix (Phase 6) — observation only

Current state: **Firewall not configured**; Attack Mode off; System Mitigations active. **No rule below is published.**

| # | Path | Method | Match | Proposed action | Verification | Rollback |
|---|---|---|---|---|---|---|
| 1 | `/login`, `/forgot-password`, `/reset-password` | POST | >10 req / 5 min / IP | **LOG** | review logs for shared-NAT offices | remove rule, `firewall publish` |
| 2 | `/signup` | POST | >5 req / 10 min / IP | **LOG** | compare against real signup volume | as above |
| 3 | `/contact`, waitlist action | POST | bot score, where supported | **LOG** | verify server-side token check still runs | as above |
| 4 | `/checkout`, `/api/payments/*` *(init only)* | POST | >5 req / 10 min / **user** | **LOG** | must not fire on a legitimate retry | as above |
| 5 | `/admin*` | ALL | any request | **LOG + alert** | RBAC/RLS stay the authority; never block here | as above |
| 6 | **`/api/payments/paytech/ipn`** | POST | — | **EXPLICIT EXCLUSION** from every challenge, bot check and rate limit | confirm a machine POST still reaches the route | remove exclusion only when PayTech is retired |
| 7 | generic automated traffic | ALL | UA/ASN heuristics | **LOG** | watch for uptime monitors and link previews | as above |

**Two things this matrix must not be read as saying.**

* **Rule 1 is not login protection.** Supabase Auth is called **directly from the browser to `*.supabase.co`** and never transits Vercel, so a Vercel rule protects only our own server actions. Credential-stuffing defence belongs in **Supabase's Auth rate limits**.
* **Rule 6 is not optional.** A PayTech IPN is an unauthenticated server-to-server POST. It cannot solve an interactive challenge, so any global challenge — Attack Mode included — silently breaks payment fulfilment.

Never: Attack Mode, geographic blocking, or per-IP limits on machine-to-machine integrations.

---

## 6. Deployment Protection (Phase 7)

| Setting | State | Action |
|---|---|---|
| Vercel Authentication (SSO) | **ENABLED**, `all_except_custom_domains` | **keep** — Preview stays authenticated |
| Production public access | **ENABLED** (custom domains exempt) | **keep** |
| Password protection | DISABLED | no change |
| Trusted IPs | DISABLED | no change |

**`uat.xpclient-academy.com` is approved in principle as the future UAT callback domain, and is deliberately NOT attached.** Attaching it would make that host publicly reachable — and because protection is `all_except_custom_domains`, exempt from SSO. That is exactly what a PayTech IPN needs, and exactly what must not exist until an isolated hosted UAT database is behind it. **Attach only after isolation is proven.**

The local stack is bound to `127.0.0.1` and is never exposed publicly.

---

## 7. XP-SEC-03 — installation status (2026-10-27)

### Workstation

| | |
|---|---|
| OS | Windows 11 **Home**, build 26200, 64-bit |
| RAM / free disk | 23.6 GB / 710 GB — ample |
| HypervisorPresent | `True` |
| **WSL** | **NOT INSTALLED** — `wsl.exe` is only the Windows shim; `wsl --status` reports the subsystem absent |
| Docker / Docker Desktop | **NOT INSTALLED** (no binary, no install dir, no appx package) |
| Shell elevation | **not elevated**; the account *is* in `Administrators` |
| Node / npm | v24.11.1 / 11.6.2 |

`Get-WindowsOptionalFeature` requires elevation and could not be queried.

### Docker Desktop licensing — owner decision required

Docker Desktop is free for a commercial organisation **only if both** conditions hold: **fewer than 250 employees AND less than $10M annual revenue**. The test is conjunctive — exceeding *either* requires a paid subscription (Pro ~$9, Team ~$15, Business ~$24 per user/month). Docker reserves the right to audit.

XP Client Consulting very likely qualifies, but that depends on two facts only the owner can confirm, so it is **reported, not assumed**.

**A licence-free alternative exists.** Only Docker *Desktop* carries the subscription; **Docker Engine is Apache-2.0 and free at any company size**. The Supabase CLI needs any Docker-compatible daemon, so installing Docker Engine inside a WSL2 Ubuntu distro avoids the question entirely. It costs one extra setup step and no GUI.

### Supabase CLI — INSTALLED ✅

`supabase@2.122.0`, pinned exactly, **devDependency only**, project-local (`node_modules/.bin/supabase`), no global install. `audit:prod` still exits 0 — the CLI is dev-only and does not touch the production dependency tree.

`supabase init` succeeded: `supabase/config.toml` (416 lines) and `supabase/.gitignore` created. **The 60 existing migrations were not touched.**

### ⚠ Loopback binding cannot be set in config.toml

The brief cautioned against assuming all services share one IP option. They share **none**: CLI 2.122.0's generated config exposes **no `ip` key for any service** — only `port`. The services and ports are:

| Service | Port | | Service | Port |
|---|---|---|---|---|
| API | 54321 | | Studio | 54323 |
| Database | 54322 | | local_smtp (web UI) | 54324 |
| DB shadow | 54320 | | Analytics | 54327 |
| DB pooler *(disabled)* | 54329 | | | |

Only `[studio]` carries an address at all, and it is `api_url`, not a bind address. Note **`[local_smtp]` has replaced Inbucket** in this CLI version.

Binding is therefore decided by how the CLI publishes Docker ports, which cannot be asserted from configuration and **cannot be verified until the stack runs**. On first start, verify empirically before trusting it:

```powershell
netstat -ano | Select-String ":5432[0-9]"   # expect 127.0.0.1, NOT 0.0.0.0
```

If any service publishes on `0.0.0.0`, stop and mitigate before seeding — do **not** open a firewall rule.

### Isolation gate — strengthened

A loopback URL now also refuses a key carrying **any** hosted-project `ref`, not just production's. Without that, a key for some *other* hosted project — a colleague's, a staging one — would have passed beside a local URL and every request would have left the machine. The production rule still fires first and by name; 23 tests cover both.

⚠ **Assumption to confirm on first local start:** that CLI-minted local keys carry no `ref` claim. It could not be verified without Docker. If a genuine local key does carry one, add it to `LOCAL_PROJECT_REFS` in the gate — **do not remove the check**.

### `.gitignore` gap, found and closed

`.env.uat.local` — exactly the file this UAT procedure tells an operator to create — **was not ignored**. The root `.gitignore` named env files one by one rather than using a wildcard. `.env*.local` has been added.

A second gate then caught a mistake of mine. I first shipped the UAT template as a separate `.env.uat.example`, and `scan:secrets` failed: it forbids **every** committed env file except the one exempted `.env.example`. The template now lives inside `.env.example` itself. The rule was not relaxed to accommodate a convenience file.

### Blocked: the exact user action required

Phase 2 stops here. `wsl --install` needs **administrator elevation**, enables **Windows optional features**, and requires a **reboot** — three of the brief's stop conditions. From an **elevated** PowerShell:

```powershell
wsl --install            # installs WSL2 + VirtualMachinePlatform, then REBOOT
# after reboot:
wsl --status             # expect: default version 2
```

Then either install **Docker Desktop** (licence question above) and enable its WSL2 backend, or install **Docker Engine** inside the WSL2 distro to avoid the licence entirely. Afterwards `docker run --rm hello-world` is the smoke test, and `npx supabase start` becomes possible.
