# XP Client Academy Platform — Pilot Deployment Guide

This document covers everything needed to deploy and run the free pilot program on Vercel.

---

## Pilot Mode Overview

During the pilot, payment is fully disabled. Any authenticated user can enroll in and access all course content for free. The payment architecture remains intact and can be re-enabled post-pilot by flipping a single environment variable.

**Pilot mode is controlled by:**
```
NEXT_PUBLIC_FREE_ACCESS_MODE=true
```

---

## Vercel Deployment Steps

### 1. Connect Repository

- Push this repository to GitHub (ensure `.gitignore` excludes `.env.local`, `.next`, `node_modules`)
- Import the repo into Vercel (vercel.com → Add New Project)
- Set **Root Directory** to the project root (where `package.json` lives)
- Vercel auto-detects Next.js — no framework override needed

### 2. Configure Environment Variables in Vercel

Add these in Vercel Dashboard → Project → Settings → Environment Variables:

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anon key (public) |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service role key — server-only, bypasses RLS |
| `NEXT_PUBLIC_APP_URL` | Yes | Your Vercel URL or custom domain |
| `NEXT_PUBLIC_FREE_ACCESS_MODE` | Yes | Set to `true` for pilot |
| `ADMIN_USERNAME` | Yes | Admin login username (e.g. `Admin`) |
| `ADMIN_EMAIL` | Yes | Admin Supabase account email |

Payment gateway variables (`ORANGE_MONEY_*`, `WAVE_*`, `STRIPE_*`) can be left blank during the pilot.

### 3. Build Settings (auto-detected)

```
Build Command:   npm run build   (or: next build)
Output Dir:      .next
Install Command: npm install
```

---

## Supabase Setup Checklist

Before the first deployment, ensure the following are configured in Supabase:

### Auth Settings
- Go to **Authentication → URL Configuration**
- Set **Site URL** to your production URL (e.g. `https://your-app.vercel.app`)
- Add to **Redirect URLs**: `https://your-app.vercel.app/auth/callback`

### Admin Account
1. Create a Supabase user with the email matching `ADMIN_EMAIL`
2. In the `profiles` table, set `platform_role = 'super_admin'` for that user
3. The admin logs in at `/admin/login` using `ADMIN_USERNAME` + password

### Row Level Security
- RLS policies must be enabled on `profiles`, `courses`, `enrollments`, `payments`, `lesson_progress`
- Free enrollment uses the service role key (bypasses RLS) — this is intentional and scoped to server actions only

---

## Pilot Mode — How it Works

| Scenario | Behavior |
|---|---|
| User visits `/checkout?course=ID` | Immediately enrolled for free, redirected to `/dashboard` |
| Payment UI (`PaymentMethodSelector`) | Only rendered when `FREE_ACCESS_MODE=false` — unreachable during pilot |
| Admin accesses `/admin` | Requires `platform_role = 'super_admin'` in Supabase profiles |
| Admin link in navbar | Visible only to logged-in super_admin users |
| Admin login | Always accessible at `/admin/login` (linked from footer) |

---

## Re-enabling Payments (Post-Pilot)

1. Set `NEXT_PUBLIC_FREE_ACCESS_MODE=false` in Vercel env vars
2. Configure real payment gateway credentials (`ORANGE_MONEY_*`, `WAVE_*`, or `STRIPE_*`)
3. Implement gateway logic in `lib/payments/index.ts` (stubs are in place)
4. Wire `unlockEnrollment()` in `app/actions/enrollment.ts` to payment webhook handlers
5. Search `// TEMP_FREE_ACCESS` in the codebase for all pilot-specific blocks

---

## Key File Locations

| Purpose | File |
|---|---|
| Pilot mode flag | `lib/pilot.ts` |
| Free enrollment action | `app/actions/enrollment.ts` |
| Payment stubs | `lib/payments/index.ts` |
| Auth middleware | `middleware.ts` |
| Admin login action | `app/(admin-auth)/admin/login/actions.ts` |
| Admin role check | `lib/auth/session.ts` |
| Supabase clients | `lib/supabase/{client,server,admin}.ts` |

---

## Admin Access

- **Navbar**: Profile dropdown shows "Administration" link only when logged in as `super_admin`
- **Footer**: Discreet "Admin" link always points to `/admin/login` (for initial login)
- **Direct URL**: `/admin/login`

The admin panel is protected at two layers:
1. `middleware.ts` checks `platform_role = 'super_admin'` for all `/admin/*` routes
2. `requirePlatformAdmin()` in `lib/auth/session.ts` re-validates in each admin page

---

## Local Development

```bash
# Copy and configure env
cp .env.example .env.local
# Edit .env.local with your Supabase credentials

# Install dependencies
npm install

# Start dev server
npm run dev
# → http://localhost:3000
```
