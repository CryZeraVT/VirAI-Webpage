# Supabase Blueprint — AiRi / viritts.com
> Last mapped: April 11, 2026. Update before schema changes.

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
- 43 rows

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
- `site_settings` — site-level config
- `subscription_plans` — plan pricing reference

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

---

## Edge Functions

| Function | Purpose |
|---|---|
| `ai-proxy` | Main AI proxy — validates license, quota pre-check, forwards to provider, increments quota |
| `get-quota` | Returns quota stats for a license key (tokens_used, boost_remaining, days_remaining, avg usage) |
| `stripe-webhook` | Handles Stripe `checkout.session.completed` → creates license + purchase record |
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
