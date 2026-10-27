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
