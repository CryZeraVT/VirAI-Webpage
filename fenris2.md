# Fenris II — VirAI-Webpage Workspace Review

**Date**: 2026-02-20  
**Repo**: `CryZeraVT/VirAI-Webpage`  
**Domain**: `viritts.com`  
**Branch**: `main` (48 commits, up-to-date with origin)  
**Phase**: 1 — Early Traction (AEGIS)  
**Blast Radius Tier**: Mixed (Tier 0–4 surfaces coexist)

---

## TL;DR

VirAI-Webpage is a static-hosted SaaS frontend for **ViriTTS**, an AI-powered Twitch stream companion sold at $12/month. The site handles marketing, authentication, license management, admin operations, analytics, and secure downloads. Stack: vanilla HTML/CSS/JS + Supabase (auth, DB, edge functions, storage) + Stripe (payments) + Cloudflare R2 (binary hosting). The codebase is functional but carries structural debt — hardcoded credentials, placeholder links, no build pipeline, and tables referenced in code but missing from the migration SQL.

---

## Architecture

```
viritts.com (GitHub Pages)
    │
    ├── index.html .............. Landing page / marketing
    ├── account.html ............ User portal (auth + license mgmt)
    ├── admin.html .............. Admin dashboard (versions, R2, licenses)
    ├── admin-usage.html ........ Token usage / revenue analytics
    ├── buy.html ................ Stripe redirect (placeholder)
    ├── callback.html ........... Twitch OAuth token capture
    ├── changelog.html .......... Public version history
    ├── download.html ........... Secure download via token
    ├── success.html ............ Post-payment license delivery
    ├── vircast.html ............ VirCast companion product page
    ├── style.css ............... Global stylesheet
    ├── supabase_setup.sql ...... DB schema (partial)
    ├── supabase/
    │   └── functions/
    │       ├── stripe-webhook/ .. Stripe checkout → license + purchase
    │       ├── validate-license/  License validation + machine binding
    │       └── reset-license/ ... PC unbind (auth-gated)
    └── images/ ................. Product screenshots + logos
```

### External Dependencies

| Service         | Role                          | Status       |
|-----------------|-------------------------------|--------------|
| Supabase        | Auth, PostgreSQL, Edge Fns, Storage | Active (`rgigtqpesabuyaumibaj`) |
| Stripe          | Payment processing            | Integrated (webhook live) |
| Cloudflare R2   | App binary hosting            | Configured via admin |
| GitHub Pages    | Static hosting                | Active (CNAME set) |
| Google Fonts    | Typography (Inter)            | Loaded via CDN |
| Chart.js        | Analytics charts              | ESM import |

---

## Pages — Functional Breakdown

### `index.html` — Landing Page
- Hero with tilted dashboard screenshot, particle background
- Feature sections: Custom Commands, AI Persona, TTS Pet, Moderation, Voice Control, Community Memory
- About section (creator story), Roadmap, Pricing card
- Pricing button **disabled** ("Coming Soon")
- Fetches latest version from `announcements` table to update download button text

### `account.html` — User Portal
- Supabase Auth: sign-in, sign-up (with mandatory Twitch username), password reset
- Lists user's licenses with status, expiry, machine binding
- Copy license key, reset PC binding (calls `reset-license` edge function)
- Download link for active versions
- Admin link visible if `profiles.is_admin = true`

### `admin.html` — Admin Dashboard (Tier 3–4)
Tabs: Publish Update | Announcements | AI Engine | Licenses | Storage (R2)
- **Publish**: Set active version from uploaded R2 files
- **Announcements**: Create/manage changelog entries
- **AI Engine**: Global AI provider/model configuration via `system_config`
- **Licenses**: Generate beta keys, view/manage all licenses
- **Storage**: Configure R2 credentials, upload new app versions (AWS Sig v4 signing in-browser)

### `admin-usage.html` — Revenue Analytics (Tier 4)
Tabs: Revenue | By User | Daily Breakdown | By Model | API Costs | Model Pricing
- Revenue breakdown: subscriptions, API costs, profit, 30% tax reserve
- Per-user token usage by Twitch channel
- Daily cost line charts, model cost doughnut charts
- Subscription plan CRUD, model pricing config
- Calls `openai-usage` edge function (not in repo — deployed separately)

### `buy.html` — Payment Redirect
- Redirects to Stripe payment link after 2s
- **Placeholder URL** — needs real Stripe link

### `callback.html` — Twitch OAuth
- Captures OAuth token from URL hash
- Displays for user to copy into ViriTTS desktop app

### `changelog.html` — Public Changelog
- Reads active entries from `announcements` table
- Markdown-style bullet rendering, critical badges, version tags

### `download.html` — Secure Download
- Validates `token` URL param against `purchases` table
- Calls `get_download_url()` RPC → signed Supabase Storage URL
- Token single-use, 24h expiry

### `success.html` — Post-Payment
- Polls `purchases` table for Stripe session ID (up to 10 attempts)
- Shows license key + download link once webhook completes

### `vircast.html` — VirCast Product Page
- Separate product: UDP audio routing for 2-PC stream setups
- Features: 6 lanes, mono fix, network discovery, local mixer
- Purple/cyan color scheme variant
- Pricing TBD

---

## Database Schema

### Defined in `supabase_setup.sql`

**`purchases`**
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | auto |
| email | TEXT | NOT NULL |
| stripe_session_id | TEXT | UNIQUE |
| stripe_customer_id | TEXT | |
| stripe_subscription_id | TEXT | |
| stripe_price_id | TEXT | |
| license_key | TEXT | |
| download_token | UUID | UNIQUE |
| download_used | BOOLEAN | default FALSE |
| created_at | TIMESTAMPTZ | |
| expires_at | TIMESTAMPTZ | NOT NULL |

**`licenses`**
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | auto |
| license_key | TEXT | UNIQUE |
| email | TEXT | |
| status | TEXT | default 'active' |
| expires_at | TIMESTAMPTZ | |
| machine_id | TEXT | bound on first activation |
| created_at | TIMESTAMPTZ | |
| last_seen | TIMESTAMPTZ | |

**RLS**: Users see own licenses via `email = auth.email()`. Purchases readable via token secrecy.

**RPC**: `get_download_url(token UUID)` → validates token, marks used, returns signed URL.

### Referenced in Code but NOT in Migration SQL

| Table | Referenced By | Purpose |
|-------|---------------|---------|
| `profiles` | account.html, admin.html | `is_admin` flag, user metadata |
| `announcements` | admin.html, changelog.html, index.html | Version announcements |
| `r2_versions` | admin.html | App version metadata from R2 |
| `system_config` | admin.html | AI provider, R2 config |
| `token_usage` | admin-usage.html | AI token consumption tracking |
| `subscription_plans` | admin-usage.html | Plan config |
| `model_pricing` | admin-usage.html | Per-model cost data |

**Gap**: These tables were likely created manually or via Supabase dashboard. No migration files exist.

---

## Edge Functions (Deno)

### `stripe-webhook`
- Verifies Stripe signature → processes `checkout.session.completed`
- Generates `VIRI-XXXX-XXXX-XXXX-XXXX` license key (crypto-random, 16 chars)
- Inserts `licenses` row (active) + `purchases` row (with 24h download token)
- Uses `upsert` on `stripe_session_id` for idempotency

### `validate-license`
- POST with `license_key` + optional `machine_id`
- Checks: exists → active → not expired → machine match
- First activation binds `machine_id`; updates `last_seen`
- Returns `valid: true/false` with message

### `reset-license`
- Requires Auth header (Bearer token)
- Verifies user owns the license (`email` match)
- Clears `machine_id`, `last_seen`; sets status back to `active`
- CORS-enabled

---

## Frontend Stack

- **No framework** — vanilla HTML/CSS/JS
- **No build step** — files served as-is from GitHub Pages
- **Supabase JS** imported via ESM (`esm.sh/@supabase/supabase-js@2`)
- **Chart.js** via CDN for analytics
- **CSS**: Custom properties, glassmorphism, responsive breakpoints at 768px
- **Design**: Purple/pink gradients, Inter font, particle backgrounds, lightbox, scroll animations

---

## Security Surface

| Area | Status | Notes |
|------|--------|-------|
| Supabase anon key | Exposed in client HTML | Normal for Supabase; RLS enforced |
| License validation | Edge function (service role) | Machine binding prevents sharing |
| Download tokens | 24h expiry, single-use | Adequate for current scale |
| Admin access | `profiles.is_admin` check | Client-side gate only — RLS critical |
| Stripe webhook | Signature verified | Correct implementation |
| Reset license | Auth + email ownership | Properly gated |
| R2 credentials | Stored in `system_config` table | Fetched client-side in admin — **risk if RLS misconfigured** |

---

## Technical Debt Ledger

| ID | Description | Risk | Why Taken | Trigger for Repayment |
|----|-------------|------|-----------|-----------------------|
| D1 | Supabase URL/anon key hardcoded in 6+ HTML files | Tier 1 | No build pipeline | Add env injection or config.js |
| D2 | Missing migration SQL for 5 tables (profiles, announcements, r2_versions, system_config, token_usage, subscription_plans, model_pricing) | Tier 2 | Created via dashboard | Before any DB rebuild or second env |
| D3 | Discord link placeholder (`discord.gg/yourdiscord`) | Tier 0 | Not set up yet | Before public launch |
| D4 | Stripe payment link placeholder in `buy.html` | Tier 2 | Subscription not live | Before enabling pricing |
| D5 | No build/bundle step (no minification, no tree-shaking) | Tier 1 | Prototype velocity | When page load time matters |
| D6 | R2 credentials fetched client-side in admin | Tier 3 | Admin-only page | Move to edge function proxy |
| D7 | Admin gate is client-side only | Tier 3 | Fast iteration | Verify RLS blocks non-admin writes |
| D8 | `openai-usage` edge function not in repo | Tier 1 | Deployed separately | Consolidate all functions in repo |
| D9 | No error monitoring / alerting | Tier 2 | Early phase | Add Sentry or equivalent at Phase 2 |
| D10 | Single-use download token — no re-download path | Tier 1 | Security-first approach | Add re-download via account portal |

---

## Git History Summary

**48 commits** on `main`. Recent trajectory:

1. Initial upload + CNAME setup
2. Landing page redesign (pricing, roadmap, about)
3. Account portal + licensing system
4. Admin dashboard (tabs, publish, storage)
5. R2 integration (native fetch + AWS Sig v4)
6. Revenue/analytics dashboard (Chart.js, tax calcs)
7. License management (beta keys, status toggles, download)
8. Bug fixes (JWT handling, brace mismatches, signup flow)

Latest commit: `ae7d093` — Fix ReferenceError for twitchUsernameEl in account.html

---

## Image Assets

| File | Purpose |
|------|---------|
| `Viritts1.png` | Logo icon |
| `virittstextonly.png` | Text-only logo |
| `logo.png` | Generic logo |
| `UI.png` | Dashboard screenshot (hero) |
| `communitymemory1.png`, `communitymemory2.png` | Community Memory feature |
| `CustomcommandsUI.png` | Custom commands UI |
| `simpleaipersonasettingsui.png` | AI persona settings |
| `ttspetsetupui.png` | TTS pet setup |
| `ModerationSupportui.png` | Moderation UI |
| `STTUI.png` | Voice control (STT) UI |
| `shoutoutui.png` | Shoutout command UI |
| `virittsplusmascot.png` | Mascot/branding |
| `VirCast.png` | VirCast product image |
| `The One-Click Mono Fix.png` | VirCast mono fix feature |
| `Scanyourlocalnetwork.png` | VirCast network scan |
| `SetupProfiles.png` | VirCast profiles |
| `localmixer.png` | VirCast local mixer |
| `multiple PC setup.png` | VirCast multi-PC diagram |
| `Labeling.png` | VirCast labeling |
| `Screenshot 2026-01-25 152858.png` | Misc screenshot |

---

## Validate

- [ ] Confirm RLS policies on `profiles`, `system_config`, `r2_versions` block non-admin reads/writes
- [ ] Replace Discord placeholder link before public launch
- [ ] Wire real Stripe payment link into `buy.html`
- [ ] Consolidate `openai-usage` edge function into repo
- [ ] Create migration SQL for all 7 missing tables
- [ ] Test full flow: signup → purchase → webhook → license → download → activate

---

## Reflect

The project is structurally sound for Phase 1. The core loop — Stripe payment → license generation → machine-bound activation → secure download — is correctly implemented with proper separation (edge functions for sensitive ops, client-side for UX). The main tension is between shipping velocity and the growing admin surface area: R2 credentials in client-side JS, missing migrations, and the client-only admin gate are all acceptable debts at this phase but become blockers at Phase 2. The pricing button is still disabled, making this a controlled beta with manual license distribution. Next phase transition trigger: enabling the Stripe payment link and opening public subscriptions.

---

## Session: Beta Signup Page + Email Integration (2026-02-20)

### TL;DR

Created a beta signup page (`beta.html`) for viritts.com, wired up with a Supabase Edge Function that stores signups in a `beta_signups` table and sends email notifications via the Resend API. The "Get Started" hero button now routes to the beta page.

### Email Architecture Decision

**Chosen: Resend HTTP API via Supabase Edge Function**

The mail server at `192.168.1.198` (Postfix + Dovecot, domain `mail.virflowsocial.com`) already relays outbound mail through Resend (`smtp.resend.com:465`). Existing VirFlow Social accounts: `postmaster@`, `noreply@`, `support@`, `jimo@`, `mbrown@`, `cryzera@virflowsocial.com`. Rather than doing SMTP from an edge function (not possible in Deno), the new function calls Resend's HTTP API directly — zero new infrastructure, same relay provider.

Alternatives rejected:
- Proxy through VirFlow backend (`192.168.1.175`) — private IP, needs NAT/tunnel, CORS
- EmailJS — client-side credential exposure
- Formspree — third-party dependency, no domain control

### What Was Built

| File | Action | Description |
|------|--------|-------------|
| `beta.html` | **Created** | Beta signup page — form with Name, Email, Twitch Username, Content Type, Message; perks section; matches site design (purple/dark, Inter, particles, glassmorphism) |
| `index.html` | **Modified** | Hero button: `"Get Started" → #pricing` changed to `"Join the Beta" → beta.html` |
| `supabase/functions/beta-signup/index.ts` | **Created** | Edge function: validates input, dedupes on email, inserts `beta_signups` row, sends team notification + applicant acknowledgment via Resend API |
| `supabase_setup.sql` | **Modified** | Added `beta_signups` table (id, name, email, twitch_username, content_type, message, status, created_at) with unique email index and service-role-only RLS |

### Edge Function Flow

```
beta.html (form submit)
    → POST /functions/v1/beta-signup
        → Validate fields + email format
        → Check duplicate email in beta_signups
        → INSERT into beta_signups (service role)
        → Resend API → team notification (cryzera@virflowsocial.com)
        → Resend API → acknowledgment to applicant
        → Return { success: true }
```

### Deployment Checklist

- [ ] Run `beta_signups` SQL block in Supabase Dashboard → SQL Editor
- [ ] Deploy edge function: `supabase functions deploy beta-signup`
- [ ] Set secret: `supabase secrets set RESEND_API_KEY=re_xxxx`
- [ ] Verify `virflowsocial.com` domain is verified in Resend for API sends (not just SMTP relay)
- [ ] (Optional) Verify `viritts.com` in Resend to send from `@viritts.com` instead
- [ ] Update `NOTIFY_RECIPIENTS` in edge function if more team members needed
- [ ] Push to `main` → GitHub Pages auto-deploys
- [ ] Test: submit form → check Supabase table → check email delivery

### Blast Radius

**Tier 1** — No auth, no money, no state mutation beyond a signup row. Edge function uses service role for DB writes (correct — prevents public table manipulation). Fire-and-forget email (signup success doesn't depend on delivery). Duplicate check on email prevents spam without rate limiting (acceptable at Phase 1 volume). Resend API key stored as Supabase secret, not in code.

### Tension to Watch

If `virflowsocial.com` is only verified in Resend for SMTP relay (Postfix relayhost) but not for API sends, the Resend HTTP API calls will fail silently. The edge function logs this but doesn't block signup success — correct tradeoff, but verify during deployment.

---

## Session: Beta Approval & License Visibility Fixes (2026-02-26)

### TL;DR

Fixed two bugs: (1) approved beta users had no password and were forced to reset before logging in, (2) users couldn't see their license keys after page refresh due to case-sensitive email matching in RLS.

### Bug 1: No Temp Password on Approval

**Root Cause**: `send-beta-approval` edge function used `inviteUserByEmail()` which creates a user with no password. Users clicked the invite link, got confirmed, but then had no credentials to sign in with.

**Fix**: Replaced `inviteUserByEmail()` with `admin.createUser()` + a generated temp password (`email_confirm: true`). The temp password is now included in the approval email alongside the license key.

**Changes**:
- `supabase/functions/send-beta-approval/index.ts` — rewritten (deployed as v8)
  - New user path: `admin.createUser({ email, password: tempPassword, email_confirm: true })`
  - `generateTempPassword()` creates 13-char password (10 alphanumeric + 1 special + 2 digits)
  - Temp password displayed in styled block in approval email
  - Emails normalized to lowercase throughout
  - Fallback magic link still generated for convenience

### Bug 2: License Keys Invisible to Users

**Root Cause**: Two issues compounding:
1. RLS policy on `licenses` used `email = auth.email()` — case-sensitive text comparison in Postgres. Admin entered `User@Example.com` but auth stored `user@example.com` → zero rows.
2. Frontend `account.html` passed `user.email` directly without normalizing case.

**Fix**:
1. Updated RLS policy to use `lower()` on both sides:
   ```sql
   DROP POLICY "Users can view their own licenses" ON public.licenses;
   CREATE POLICY "Users can view their own licenses" ON public.licenses
     FOR SELECT TO public USING (lower(email) = lower(auth.email()));
   ```
2. `account.html`: normalize email before query — `(user.email || "").trim().toLowerCase()`
3. `admin.html`: normalize email to lowercase when generating licenses

### Files Changed

| File | Change |
|------|--------|
| `supabase/functions/send-beta-approval/index.ts` | Rewritten: createUser + temp password instead of inviteUserByEmail |
| `account.html` | Lowercase email in loadKeys query |
| `admin.html` | Lowercase email in license generation |
| Supabase RLS (live) | `licenses` SELECT policy now uses `lower()` on both sides |

### Deployment Status

| Change | Status |
|--------|--------|
| Edge function `send-beta-approval` v8 | **Live** — deployed via MCP |
| RLS policy update | **Live** — applied via `execute_sql` |
| `account.html` + `admin.html` | **Pending** — needs GitHub push |

### Blast Radius

**Tier 3** — Auth surface. The edge function creates users and sets passwords. The RLS change affects license visibility for all users. Both changes are additive (no behavior removed). Rollback: redeploy previous edge function version, restore old RLS policy.

### Debt Update

- **D3** (Discord placeholder link) — **Resolved** in this branch. `discord.gg/yourdiscord` → `discord.gg/MkJVue2Rr4` across `beta.html`, `index.html`, `vircast.html`.

### Also Created

- `blueprint.md` — Full Supabase schema blueprint (10 tables, 10 edge functions, 13 migrations, all RLS policies) for context-saving reference.
