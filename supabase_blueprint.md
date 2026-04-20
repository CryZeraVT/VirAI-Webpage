# Supabase Blueprint — AiRi / viritts.com
> Last mapped: April 18, 2026. Update before schema changes.
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
- `standard` — base tokens per 30-day period (currently **3M**, admin-editable via `system_config.tier_limits`), boost pool available
- `test` — manually set, used to test quota functionality (currently **50k**, admin-editable via `system_config.tier_limits`)

> Tier token allocations are **data-driven** since 2026-04-18. Source of truth: `public.system_config` row `key='tier_limits'` (jsonb, e.g. `{"standard": 3000000, "test": 50000}`). Edit via the **Tier Limits** tab in `admin.html` (backed by `update_tier_limits` RPC). Edge functions (`ai-proxy`, `get-quota`) cache the value for 60s, so changes go live within a minute. In-code fallback (`3_000_000 / 50_000`) protects against a missing/malformed row.

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
| `base_limit` | bigint | 2,000,000 ⚠ dead default | Upserted per-call by `ai-proxy` from `system_config.tier_limits[tier]`. **The `2000000` column default is dead code as of 2026-04-18** — no live code path inserts without supplying `p_base_limit` via `increment_token_quota`, so the default would only fire if someone ran a raw `INSERT`. Runtime value is always whatever the active `tier_limits` row says (currently 3M for standard). Documented on the column via `COMMENT ON COLUMN`. Safe to change to `3000000` or drop the default in a future migration — not doing it now to avoid Tier 3 churn for zero behavioural change. |
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
  - `ai_api_keys` — provider API keys object
  - `tier_limits` — per-tier AI token allocation (jsonb, e.g. `{"standard": 3000000, "test": 50000}`). Added 2026-04-18. Written exclusively via `update_tier_limits()` RPC (admin-gated, validated, audited). Read by `admin.html` (via `get_tier_limits()`) and by `ai-proxy` / `get-quota` edge functions (direct table read, 60s in-memory cache).

---

### `system_config_audit`
> Append-only audit log for every change to `system_config`. Added 2026-04-18.

| Column | Type | Notes |
|---|---|---|
| `id` | bigserial | PK |
| `config_key` | text | Which key was changed (e.g. `"tier_limits"`) |
| `old_value` | jsonb | Previous value (null on first insert) |
| `new_value` | jsonb | Value written |
| `changed_by` | uuid | FK → `auth.users(id)` (SET NULL on delete) |
| `changed_at` | timestamptz | now() |

Indexed on `(config_key, changed_at DESC)`. RLS: enabled. Admins (`profiles.is_admin = true`) have SELECT. No direct INSERT/UPDATE/DELETE grant — rows are written exclusively by `SECURITY DEFINER` RPCs (currently only `update_tier_limits`).

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

### `increment_token_quota(p_license_key text, p_tokens bigint, p_license_active boolean DEFAULT true, p_base_limit bigint DEFAULT 2000000)`
Returns `jsonb`: `{ allowed, using_boost, tokens_used, boost_remaining, base_limit, quota_percent }`

**Logic:**
1. **Upsert row with tier-correct `base_limit`:** `INSERT (license_key, base_limit) VALUES (…, p_base_limit) ON CONFLICT DO UPDATE SET base_limit = p_base_limit`. This is how tier config changes propagate to existing customers lazily on their next call.
2. If `period_end` passed + license active → reset `tokens_used=0`, new 30-day window
3. Try to fit tokens in base pool
4. If base overflows → drain from boost pool
5. If both exhausted → record usage, `allowed=false`

> **Fix 2026-04-18:** A legacy 3-arg overload (without `p_base_limit`) was dropped. It was left behind when the 4-arg version was introduced, and PostgREST/supabase-js overload resolution was occasionally routing calls to it — meaning `tokens_used` was incremented correctly but `base_limit` was never updated from the tier config. Any 3-arg callers now resolve to the 4-arg version's default (`p_base_limit = 2000000`), which matches the historical hardcoded behavior, so there's no regression. The sole authoritative signature now is the one above.

### `handle_new_user()`
Trigger function — creates `profiles` row on new auth user signup.

### `accept_tos(p_version text)`
`SECURITY DEFINER` RPC. Updates `profiles.tos_version` + `profiles.tos_accepted_at` for the calling user (`auth.uid()`). Only the `authenticated` role has EXECUTE. This is the only supported write path for ToS columns — used by `account.html` signup flow and the post-signin ToS gate modal. Client constant `CURRENT_TOS_VERSION` in `account.html` drives re-acceptance; bump it whenever the Terms text materially changes.

### `get_tier_limits()`
`SECURITY DEFINER` SQL function. Returns `jsonb` — the current `system_config.tier_limits` row, or the safe default `{"standard": 3000000, "test": 50000}` if the row is missing. EXECUTE granted to `authenticated`. Used by `admin.html` Tier Limits tab; edge functions read the table directly to maintain their own 60s cache. Added 2026-04-18.

### `update_tier_limits(p_limits jsonb, p_apply_to_existing boolean DEFAULT false)`
`SECURITY DEFINER` RPC. **Admin-only** (checks `profiles.is_admin = true`). Validates: `p_limits` must be a jsonb object; every tier must be in the whitelist `('standard', 'test')`; every value must be `> 0` and `< 100_000_000`. On success:
1. Snapshots the existing `tier_limits` row,
2. Upserts `system_config.tier_limits = p_limits`,
3. Writes an audit row to `system_config_audit`,
4. If `p_apply_to_existing = true`, for each tier in the new config runs `UPDATE public.token_quotas SET base_limit = <new> WHERE license_key IN (SELECT license_key FROM licenses WHERE tier = <tier> AND status = 'active') AND base_limit <> <new>` and accumulates the affected row count.

Returns `{success, new_config, customers_updated, applied_to_existing}`. EXECUTE granted to `authenticated` (admin gate enforced inside). Added 2026-04-18.

> **Propagation semantics:** With `p_apply_to_existing = false`, changes reach existing customers lazily via `ai-proxy` → `increment_token_quota` on their next AI call (the RPC `ON CONFLICT DO UPDATE SET base_limit = p_base_limit` upserts the per-call tier value). New purchases get the new limit on their first call. With `true`, every active customer's row is backfilled immediately — use when a decrease might otherwise let existing customers exceed the new cap within the current period.

### `count_active_by_tier()`
`SECURITY DEFINER` SQL helper. Returns `jsonb` of `{tier: active_count}` from `licenses` where `status = 'active' AND tier IS NOT NULL`. Used by the Tier Limits admin UI to show "N active" badges and to size the confirmation dialog. EXECUTE granted to `authenticated`. Added 2026-04-18.

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
| `ai-proxy` | Main AI proxy — validates license, quota pre-check, forwards to provider, increments quota. Reads tier→token limits from `system_config.tier_limits` (60s in-memory cache, falls back to `{standard: 3M, test: 50k}` if missing/malformed). Passes the resolved limit to `increment_token_quota` as `p_base_limit`, which upserts it onto `token_quotas.base_limit`. |
| `get-quota` | Returns quota stats for a license key (tokens_used, boost_remaining, days_remaining, avg usage). Uses the same cached `system_config.tier_limits` read as `ai-proxy` for the fallback when no `token_quotas` row exists yet (new customer pre-first-call). |
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
| `send-newsletter` | Admin: sends newsletter email blast to selectable audiences. Body takes `{ subject, body, body_html, audiences?, dry_run? }`. `audiences` is an array of `"subscribers"` (default, reads `mailing_list` where `subscribed=true`) and/or `"beta_testers"` (reads `licenses` where `tier='beta' AND status='active'`). Recipients are deduped by lowercase email; subscriber footer (tokenised unsubscribe link) wins over beta footer (contact-to-opt-out) when the same email is in both pools. `dry_run: true` returns `{ counts: { subscribers, beta_testers, overlap, both_deduped } }` without sending — used by admin.html to live-update the recipient badge. Legacy zero-audience callers still work (default to subscribers). |
| `unsubscribe` | GET `?token=xxx` → token-based unsubscribe (email links); POST with JWT → auth-based unsubscribe (account page) |

---

## Auth
- Supabase Auth (email/password)
- `profiles` table mirrors `auth.users` via trigger
- `licenses.email` links licenses to accounts (case-insensitive ilike query in account.html)
