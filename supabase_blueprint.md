# Supabase Blueprint — AiRi / viritts.com
> Last mapped: April 17, 2026. Update before schema changes.
>
> **Stripe mode:** LIVE (cutover 2026-04-18). `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_BOOST_PRICE_ID` all on live values. Test-mode webhook endpoint retained disabled in Stripe for rollback.

## Project
- URL: `https://rgigtqpesabuyaumibaj.supabase.co`
- Anon key in `account.html` / all frontend pages

---

## Tables

### `licenses`
| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | uuid | gen_random_uuid() | PK |
| `license_key` | text | — | UNIQUE |
| `email` | text | null | Links to auth user |
| `status` | text | `'active'` | active / inactive |
| `expires_at` | timestamptz | null | null = never |
| `machine_id` | text | null | PC binding |
| `tier` | text | `'beta'` | **beta** / **standard** / **test** |
| `created_at` | timestamptz | now() | |
| `last_seen` | timestamptz | null | |
| `cancel_at_period_end` | boolean | `false` | **Set to `true` when user has scheduled cancellation via Stripe Customer Portal. Written exclusively by `stripe-webhook` on `customer.subscription.updated` events. Cleared on reactivation (Stripe fires `.updated` with `cancel_at_period_end=false`) or on actual period-end cancellation (Stripe fires `.deleted`). License remains `status='active'` until that deletion event.** Added 2026-04-17. |
| `current_period_end` | timestamptz | null | Mirror of Stripe `subscription.current_period_end`. The date a subscriber's paid access runs through; read by `account.html` Billing tab for the "ending on X" banner. Written by `stripe-webhook` on `customer.subscription.updated`. Added 2026-04-17. |
| `canceled_at` | timestamptz | null | Audit-only: timestamp of `customer.subscription.deleted` (the moment access actually ended). Remains `null` while active. Added 2026-04-17. |

**Tier logic:**
- `beta` — free, tokens not counted/tracked
- `standard` — 2M base tokens per 30-day period, boost pool available
- `test` — manually set, used to test quota functionality with 50k limit

RLS: enabled. Users can SELECT their own rows (`email = auth.email()`).

---

### `token_quotas`
> Comment: "Per-license rolling 30-day token quota with permanent boost pool"

| Column | Type | Default | Notes |
|---|---|---|---|
| `license_key` | text | — | PK / FK → licenses |
| `period_start` | timestamptz | now() | Resets every 30 days |
| `period_end` | timestamptz | now()+30d | Auto-reset by RPC |
| `tokens_used` | bigint | 0 | Usage in current period |
| `base_limit` | bigint | 2,000,000 | Synced from tier by ai-proxy |
| `boost_tokens_remaining` | bigint | 0 | **Permanent boost pool** — does NOT reset on period rollover |
| `updated_at` | timestamptz | now() | |

**How boost works:** `increment_token_quota` fills base first. When base is exhausted, overflow charges the boost pool. Boost pool is permanent (never auto-resets).

---

### `token_usage`
> Comment: "Tracks AI token usage per user/license for billing and monitoring"
- Per-call log: `license_key`, `provider`, `model`, `prompt_tokens`, `completion_tokens`, `cost_usd`, `twitch_channel`, `created_at`
- 18,303 rows as of blueprint date

---

### `purchases`
- Stripe checkout records: `email`, `stripe_session_id` (UNIQUE), `stripe_customer_id`, `stripe_subscription_id`, `license_key`, `download_token`, `download_used`, `expires_at`
- Used for initial license purchase + download flow

---

### `profiles`
- `id` (uuid, FK → auth.users), `is_admin` (bool), `twitch_username` (text)
- `tos_version` (text, nullable) — version of the Terms of Service the user accepted (e.g. `"1.0"`). `NULL` = never accepted. Added 2026-04-17.
- `tos_accepted_at` (timestamptz, nullable) — timestamp of most recent acceptance. Added 2026-04-17.
- 43 rows

RLS: `SELECT` own row via policy `"Users can read own profile"` (`id = auth.uid()`). No direct `UPDATE` grant to `authenticated` — ToS fields are written exclusively via `accept_tos(p_version)` RPC.

---

### `system_config`
- Key/value store. Known keys:
  - `builtin_ai_provider` — legacy tester AI config
  - `proxy_ai_provider` — prod AI config (provider, model, params)
  - `api_keys` — provider API keys object
- 4 rows

---

### `model_pricing`
- `provider`, `model`, `input_cost_per_million`, `output_cost_per_million`
- 20 rows

---

### `mailing_list`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `email` | text | NOT NULL |
| `name` | text | nullable |
| `subscribed` | boolean | NOT NULL, default true |
| `source` | text | nullable, default 'website' |
| `created_at` | timestamptz | nullable |
| `unsubscribe_token` | uuid | UNIQUE, NOT NULL, default gen_random_uuid() — added 2026-04-16 |

RLS: enabled. Policies:
- Service role → ALL
- Admin (via profiles.is_admin) → SELECT, UPDATE
- Authenticated user → SELECT + UPDATE where `email = auth.email()`

---

### Other tables
- `announcements` — in-app announcements
- `beta_signups` — beta waitlist (28 entries)
- `r2_versions` — download versions/URLs from R2 storage
- `site_settings` — site-level config (see below for ToS-related keys)
- `subscription_plans` — plan pricing reference
- `tos_versions` — append-only store of legal document bodies, keyed by `(surface, version)`. Surfaces: `app`, `web`, `privacy`. `body_sha256` is computed by trigger; UPDATE/DELETE blocked by `tos_versions_block_mutations()`. Public SELECT allowed (legal docs are public by design).

### `site_settings` keys used by ToS surfaces
| key | purpose |
|---|---|
| `app_tos_current_version`     | Pointer → current In-App EULA version. Read by `validate-license` edge function, written by `publish_tos_version('app', …)` RPC. |
| `web_current_version`         | Pointer → current Website Terms version. Read by `account.html` + `terms.html` + `admin.html`. |
| `privacy_current_version`     | Pointer → current Privacy Notice version. Read by `privacy.html` + `admin.html`. Privacy is a *notice*, not a contract — no acceptance tracked. |

---

## RPCs (Functions)

### `increment_token_quota(p_license_key, p_tokens, p_license_active?)`
Returns `jsonb`: `{ allowed, using_boost, tokens_used, boost_remaining, base_limit, quota_percent }`

**Logic:**
1. Upsert row if new license
2. If `period_end` passed + license active → reset `tokens_used=0`, new 30-day window
3. Try to fit tokens in base pool
4. If base overflows → drain from boost pool
5. If both exhausted → record usage, `allowed=false`

### `handle_new_user()`
Trigger function — creates `profiles` row on new auth user signup.

### `accept_tos(p_version text)`
`SECURITY DEFINER` RPC. Updates `profiles.tos_version` + `profiles.tos_accepted_at` for the calling user (`auth.uid()`). Only the `authenticated` role has EXECUTE. This is the only supported write path for ToS columns — used by `account.html` signup flow and the post-signin ToS gate modal. Client constant `CURRENT_TOS_VERSION` in `account.html` drives re-acceptance; bump it whenever the Terms text materially changes.

### `publish_tos_version(p_surface text, p_version text, p_body_markdown text)`
`SECURITY DEFINER` RPC. **Admin-only** (checks `profiles.is_admin = true`). Atomically:
1. INSERTs a new row into `public.tos_versions` (append-only; `body_sha256` auto-computed by trigger `tos_versions_set_sha()` which qualifies `extensions.digest()` explicitly because pgcrypto lives in the `extensions` schema),
2. UPSERTs the matching `public.site_settings` pointer:
   - `app`     → `app_tos_current_version`
   - `web`     → `web_current_version`
   - `privacy` → `privacy_current_version`

Validation: surface must be `'app' | 'web' | 'privacy'` (also enforced by a table CHECK constraint); version must match `^\d+(\.\d+)*$` and be strictly greater than the current version; body ≤ 64 KB; `(surface, version)` must not already exist. Returns `{ok, surface, version, sha256}`. EXECUTE granted to `authenticated` only (`anon` explicitly revoked). Called by the "Publish New … Version" panel in `admin.html` with a typed-confirmation UI guard and a surface dropdown on top.

---

## Edge Functions

| Function | Purpose |
|---|---|
| `ai-proxy` | Main AI proxy — validates license, quota pre-check, forwards to provider, increments quota |
| `get-quota` | Returns quota stats for a license key (tokens_used, boost_remaining, days_remaining, avg usage) |
| `stripe-webhook` | Handles Stripe `checkout.session.completed` (new license + purchase record), `customer.subscription.updated` (syncs `cancel_at_period_end` + `current_period_end` to `licenses`), `customer.subscription.deleted` (flips `status='inactive'` + sets `canceled_at`), `invoice.payment_failed` (deactivates only when Stripe gives up retrying). Signature-verified. `verify_jwt=false` (called by Stripe, not by user). |
| `create-billing-portal-session` | User-facing. Requires Supabase JWT. Resolves `stripe_customer_id` server-side via `purchases.email ilike auth.email()`. Calls `stripe.billingPortal.sessions.create` and returns `{ success, url }`. Client redirects to the returned Stripe-hosted portal (cancel/reactivate/invoices/payment methods). Added 2026-04-17. |
| `validate-license` | Validates license key for app activation |
| `reset-license` | Clears `machine_id` to allow new PC binding |
| `admin-users` | Admin: list/manage users |
| `beta-signup` | Handles beta waitlist form submission |
| `debug-user` | Debug: inspect a user's license/quota state |
| `get-testers` | Returns list of beta testers |
| `mailing-list-signup` | Mailing list form handler |
| `send-beta-approval` | Sends beta approval email |
| `send-password-reset` | Sends password reset email |
| `send-newsletter` | Admin: sends newsletter to all subscribed users (v18) — per-subscriber HTML with tokenised unsubscribe link |
| `unsubscribe` | GET `?token=xxx` → token-based unsubscribe (email links); POST with JWT → auth-based unsubscribe (account page) |

---

## Auth
- Supabase Auth (email/password)
- `profiles` table mirrors `auth.users` via trigger
- `licenses.email` links licenses to accounts (case-insensitive ilike query in account.html)
