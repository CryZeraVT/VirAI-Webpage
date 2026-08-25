# Supabase Blueprint — AiRi / viritts.com
> Last mapped: Aug 25, 2026 (`get_usage_summary` / `get_live_users` / `get_license_activity`; kind=paid|beta|test|orphan; admin-only execute). Update before schema changes.
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
| `last_seen` | timestamptz | null | Heartbeat from `validate-license` (coalesced ~1h). **This is the signal that the desktop app is running**, including users on their own API keys who never hit `token_usage`. Admin rollup: `get_license_activity()`. |
| `cancel_at_period_end` | boolean | `false` | **Set to `true` when user has scheduled cancellation via Stripe Customer Portal. Written exclusively by `stripe-webhook` on `customer.subscription.updated` events. Cleared on reactivation (Stripe fires `.updated` with `cancel_at_period_end=false`) or on actual period-end cancellation (Stripe fires `.deleted`). License remains `status='active'` until that deletion event.** Added 2026-04-17. |
| `current_period_end` | timestamptz | null | Mirror of Stripe `subscription.current_period_end`. The date a subscriber's paid access runs through; read by `account.html` Billing tab for the "ending on X" banner. Written by `stripe-webhook` on `customer.subscription.updated`. Added 2026-04-17. |
| `canceled_at` | timestamptz | null | Audit-only: timestamp of `customer.subscription.deleted` (the moment access actually ended). Remains `null` while active. Added 2026-04-17. |
| `product` | text | `'retail'` | **retail** (sold MSI) or **alwayson** (24/7 showcase SKU). Keys do not cross-activate. Missing/empty client `product` is treated as retail so 1.4.2 MSI still validates. Added 2026-08-21. |

**Tier logic:**
- `beta` — free testers. Tokens logged in `token_usage` for cost; **not** counted against `token_quotas`.
- `standard` / `studio` — **paid**. Quota enforced. Count as paying keys on admin Money tab.
- `test` — internal quota tests. Not revenue.

> Tier token allocations are **data-driven** since 2026-04-18. Source of truth: `public.system_config` row `key='tier_limits'` (jsonb, e.g. `{"standard": 3000000, "test": 50000}`). Edit via the **Tier Limits** tab in `admin.html` (backed by `update_tier_limits` RPC). Edge functions (`ai-proxy`, `get-quota`) cache the value for 60s, so changes go live within a minute. In-code fallback (`3_000_000 / 50_000`) protects against a missing/malformed row.

| `product` | text | `'retail'` | **retail** (sold MSI) or **alwayson** (24/7 showcase SKU). Keys do not cross-activate. Added 2026-08-21. |

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
- `twitch_channel` may be null when the desktop omits it (offline / Kick / not connected). Admin rollups group by `license_key`, not by this field.

### `get_usage_summary(start_time timestamptz, end_time timestamptz)`
Admin-only (`profiles.is_admin`, `authenticated` + `service_role` execute; **anon revoked**). Returns jsonb:
- `by_user` — one row per license: `display_name`, `twitch_channel` (last non-empty), `kind`, `tier`, tokens, stored `cost`
- `by_kind` — `paid` (standard/studio) / `beta` / `test` / `orphan`
- `by_day` / `by_model` — include `cost_paid` and `cost_beta`

`kind`: `paid` = standard|studio; `test` = test; missing license = `orphan`; else `beta`.

### `get_live_users(window_minutes int DEFAULT 10)`
Admin-only. One row per license in the last N minutes of **built-in proxy AI**. Same identity fields as `by_user`. Does **not** include own-key users.

### `get_license_activity()`
Admin-only (`profiles.is_admin`; **anon revoked**). Who is running the desktop app via `licenses.last_seen`. Returns jsonb:
- counts: `online_2h`, `seen_24h`, `seen_7d`, `seen_30d`, `never_seen`
- `rows`: `display_name` (twitch username or truncated key — **never the full key**), `kind`, `tier`, `last_seen`, `recency` (`online` | `today` | `week` | `month` | `stale` | `never`)

Use this for product usage. Use `get_live_users` / `get_usage_summary` for built-in AI spend.

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
  - `beta_renewal_config` — beta activity keep-alive settings (jsonb, e.g. `{"grace_days": 3, "renewal_days": 7}`). Added 2026-05-12. Written exclusively via `update_beta_renewal_config()` RPC (admin-gated, validated, audited). Read by `validate-license` and `ai-proxy` (direct table read, 60s in-memory cache). **Renew rule (2026-08-16):** for `tier='beta'` + `status='active'` on successful validate / authenticated AI use, snap `expires_at = now + renewal_days` unless the current expiry is already within 24h of that target (coalesce). Idle keys are not touched. `grace_days` is retained in config for admin compatibility but is **not** used as the renew gate. Non-beta tiers unchanged (hard expiry). Configurable in `admin.html` Tier Limits tab → "Beta Auto-Renewal" section.
  - `alert_settings` — admin ops email alerting (jsonb). Added 2026-08-06. Shape: `{recipients[], enabled, enabled_classes:{p0_downtime,p1_failover,p1_stripe,p2_digest}, min_severity, mute_until, dedupe_window_sec}`. Written exclusively via `update_alert_settings()` (admin-gated, validated, audited). Read by admin UI via `get_alert_settings()` and by `notify-admin` (service role). **RLS:** included in the public SELECT deny-list alongside `ai_api_keys` / `ai_failover_chains` — recipients must never be anonymously readable.

Public SELECT deny-list on `system_config`: `ai_api_keys`, `proxy_ai_provider`, `studio_ai_provider`, `builtin_ai_provider`, `ai_failover_chains`, `alert_settings`.

### `alert_dedupe`
> Storm-control timestamps for `notify-admin`. Added 2026-08-06. PK `dedupe_key`, `last_sent_at`. RLS enabled; no anon/authenticated grants — service role only.

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

Indexed on `(config_key, changed_at DESC)`. RLS: enabled. Admins (`profiles.is_admin = true`) have SELECT. No direct INSERT/UPDATE/DELETE grant — rows are written exclusively by `SECURITY DEFINER` RPCs (`update_tier_limits`, `update_beta_renewal_config`, `update_alert_settings`, …).

---

### `model_pricing`
- `provider`, `model`, `input_cost_per_million`, `output_cost_per_million`
- 21 rows. Added 2026-05-13: `grok / grok-4.3` → $1.25/$2.50 per million tokens (xAI official pricing).

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

### `kick_links`
> Maps a Kick broadcaster `user_id` to an AiRi `license_key` so `kick-webhook` can route events. Added 2026-08-18. Service role only (RLS on, no anon policies). Unique on `kick_user_id`.

### `kick_inbox`
> Short-lived Kick webhook mailbox for the desktop drain. TTL 15 minutes. Unique `message_id` (Kick-Event-Message-Id). Not a chat archive — rows are deleted on drain or expiry. Added 2026-08-18. Service role only.

### Other tables
- `announcements` — in-app announcements
- `beta_signups` — beta waitlist (28 entries)
- `r2_versions` — download versions/URLs from R2 storage. **Unique (2026-08-09):** `(version, channel)` via `r2_versions_version_channel_key` — same version string can exist on both channels as twin rows sharing one MSI/URL. (Dropped former global `r2_versions_version_key`.) **Channels (2026-07-31):** `channel` text NOT NULL DEFAULT `stable` (`stable`|`beta`); partial unique index `r2_versions_one_active_per_channel` (one active per channel). Admin can activate a build as Stable, Beta, or Both (Both upserts/activates twins). Re-upload upserts by `(version, channel)` and syncs artifact fields to any existing twin. Account page: beta-tier licenses get active beta build if present, else stable; all other tiers get stable. Activating beta does not overwrite public `announcements` (stable activate still does). Admin Storage: Upload new vs Use existing (assign/activate without re-upload).
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

### `get_beta_renewal_config()`
`SECURITY DEFINER` SQL function. Returns `jsonb` — the current `system_config.beta_renewal_config` row (`{grace_days, renewal_days}`), or the safe default `{"grace_days": 3, "renewal_days": 7}` if the row is missing. EXECUTE granted to `authenticated`, revoked from `anon`. Used by `admin.html` Beta Auto-Renewal section. Added 2026-05-12. Default renewal length changed 30 → 7 on 2026-08-16.

### `update_beta_renewal_config(p_config jsonb)`
`SECURITY DEFINER` RPC. **Admin-only** (checks `profiles.is_admin = true`). Validates: `grace_days` and `renewal_days` must be integers between 1 and 365. On success: upserts `system_config.beta_renewal_config`, writes an audit row to `system_config_audit`. Returns `{success, new_config}`. EXECUTE granted to `authenticated`. Added 2026-05-12.

### `count_active_by_tier()`
`SECURITY DEFINER` SQL helper. Returns `jsonb` of `{tier: active_count}` from `licenses` where `status = 'active' AND tier IS NOT NULL`. Used by the Tier Limits admin UI to show "N active" badges and to size the confirmation dialog. EXECUTE granted to `authenticated`. Added 2026-04-18.

### `get_alert_settings()`
`SECURITY DEFINER` RPC. **Admin-only** (`profiles.is_admin`). Returns `system_config.alert_settings` or safe default (empty recipients, enabled, P1 min, classes on except `p2_digest`). EXECUTE granted to `authenticated`; revoked from `anon`. Added 2026-08-06.

### `update_alert_settings(p_settings jsonb)`
`SECURITY DEFINER` RPC. **Admin-only**. Validates recipients (≤20 emails), classes, `min_severity` ∈ {P0,P1,P2}, `dedupe_window_sec` 60–86400, optional `mute_until`. Upserts `alert_settings`, writes `system_config_audit`. Returns `{success, new_config}`. EXECUTE granted to `authenticated`; revoked from `anon`. Added 2026-08-06.

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
| `ai-proxy` | Main AI proxy — validates license, quota pre-check, forwards to provider, increments quota. Reads tier→token limits from `system_config.tier_limits` (60s in-memory cache, falls back to `{standard: 3M, test: 50k}` if missing/malformed). Passes the resolved limit to `increment_token_quota` as `p_base_limit`, which upserts it onto `token_quotas.base_limit`. **Updated 2026-05-13 (v18):** Reads `reasoning_effort` from the active config row and forwards it to xAI chat completions when the model is classified as reasoning (`grok-4.x` without `non-reasoning`). Values: `none / low (default) / medium / high`. Configurable in `admin.html` AI Engine tab. **Updated 2026-08:** For `tier='beta'` only, runs coalesced activity keep-alive before the expiry gate (same `renewal_days/2` rule as `validate-license`); non-beta hard expiry unchanged. **Updated 2026-08-06 (v27):** Fire-and-forget P0 on all-hops-failed and P1 on `failover_used` via `notify-admin` + `ALERT_INTERNAL_SECRET`; **never** notifies when admin probe / `force_failover` authorized. |
| `get-quota` | Returns quota stats for a license key (tokens_used, boost_remaining, days_remaining, avg usage). Uses the same cached `system_config.tier_limits` read as `ai-proxy` for the fallback when no `token_quotas` row exists yet (new customer pre-first-call). **Updated 2026-08-22:** `avg_tokens_per_hour` / `total_hours_tracked` are derived from `token_quotas.tokens_used` ÷ elapsed period hours. JSON shape unchanged so current MSI builds keep working. Does **not** scan `token_usage`. |
| `stripe-webhook` | Handles Stripe `checkout.session.completed` (new license + purchase record), `customer.subscription.updated` (syncs `cancel_at_period_end` + `current_period_end` to `licenses`), `customer.subscription.deleted` (flips `status='inactive'` + sets `canceled_at`), `invoice.payment_failed` (deactivates only when Stripe gives up retrying). Signature-verified. `verify_jwt=false` (called by Stripe, not by user). **Updated 2026-08-06 (v40):** Fire-and-forget alerts — P0 license/purchase insert failures, P1 signature spikes + payment-failure deactivation — via `notify-admin`. |
| `notify-admin` | Ops email alerts via Resend (`RESEND_API_KEY`, from `AiRi Alerts <noreply@virflowsocial.com>`, subject prefix `[AiRi ALERT]`). Auth: header `x-airi-alert-secret` === Deno secret `ALERT_INTERNAL_SECRET` (edge→edge) **or** admin JWT + `profiles.is_admin` (Test send). `verify_jwt=false` (custom auth). GET / `{action:"health"}` = health ping (no email). Reads `alert_settings`, respects enabled/mute/classes/min_severity, dedupes via `alert_dedupe`. Added 2026-08-06 (v1). |
| `create-billing-portal-session` | User-facing. Requires Supabase JWT. Resolves `stripe_customer_id` server-side via `purchases.email ilike auth.email()`. Calls `stripe.billingPortal.sessions.create` and returns `{ success, url }`. Client redirects to the returned Stripe-hosted portal (cancel/reactivate/invoices/payment methods). Added 2026-04-17. |
| `validate-license` | Validates license key for app activation. **Beta activity keep-alive (2026-08):** skips hard `"License expired"` reject for `tier='beta'`; on successful validate, if expired or remaining life `< renewal_days/2`, sets `expires_at = now + renewal_days`, updates `last_seen`, returns `beta_renewed: true`. Non-beta hard expiry unchanged. Config cached 60 s. **Updated 2026-08-22:** `last_seen` writes coalesce to once per hour. Empty update skipped. |
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
| `kick-oauth` | AiRi Kick login hop. GET returns `{configured, client_id, redirect_uri, scopes}` (no secret). POST `action=exchange|refresh|unlink` after license+machine check. Adds `KICK_CLIENT_SECRET` server-side. Does **not** store user tokens. Upserts `kick_links`. `verify_jwt=false`. Secrets: `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET`, optional `KICK_REDIRECT_URI` (default `http://localhost:9881/kick/callback`). Scopes include `channel:rewards:read` (2026-08-18). |
| `x-oauth` | AiRi X/Twitter OAuth 2.0 hop. GET returns `{configured, client_id, redirect_uri, scopes}` (no secret). POST `action=exchange|refresh|unlink` after license+machine check. Adds `X_CLIENT_SECRET` server-side. Does **not** store user tokens (desktop encrypts them in `twitter.accounts.streaming` / `twitter.accounts.bot`). No `x_links` table. `verify_jwt=false`. Secrets: `X_CLIENT_ID`, `X_CLIENT_SECRET`, optional `X_REDIRECT_URI` (default `http://localhost:9882/x/callback`). Scopes: `tweet.read tweet.write users.read offline.access`. Added 2026-08-18. |
| `kick-webhook` | Public Kick event inbox. RSA-verifies `Kick-Event-Signature`, maps `broadcaster.user_id` → `kick_links.license_key`, inserts `kick_inbox`. `verify_jwt=false`. Added 2026-08-18. |
| `kick-drain` | Desktop poll. License-gated. Returns unread inbox rows then deletes them. Also deletes expired rows. `verify_jwt=false`. Added 2026-08-18. |

---

## Auth
- Supabase Auth (email/password)
- `profiles` table mirrors `auth.users` via trigger
- `licenses.email` links licenses to accounts (case-insensitive ilike query in account.html)

## AI failover chains

- `system_config.ai_failover_chains`: Core OpenAI `gpt-5.6-luna`→Gemini `gemini-3-flash-preview`→Grok `grok-4.3`; Studio Grok `grok-4.3`→OpenAI `gpt-5.6-luna`→Gemini `gemini-3-flash-preview`
- Edge function `ai-proxy` retries retryable provider failures across hops
- Admin probe requires Deno secret `AIRI_ADMIN_PROBE_SECRET` + header `x-airi-admin-probe`
- See `AI_PROXY_FAILOVER.md` for ops steps

## Admin email alerting (Phase 0/1)

- Config: `system_config.alert_settings` via admin **Alerts** tab (`admin.html`)
- Edge: `notify-admin` + call sites in `ai-proxy` / `stripe-webhook`
- Secrets: `RESEND_API_KEY` (existing), **`ALERT_INTERNAL_SECRET`** (required for edge→edge; set in Supabase Dashboard → Edge Functions → Secrets)
- Health / external uptime: `GET https://rgigtqpesabuyaumibaj.supabase.co/functions/v1/notify-admin` (no signup wired in code)
- Phase 2 leftovers: daily digest cron (`p2_digest`), Sentry, UptimeRobot account signup

## AlwaysOn showcase (2026-08-21)

- `licenses.product`: `retail` (default) or `alwayson`. `validate-license` rejects product mismatch and does not bind `machine_id` on mismatch. Missing client `product` = retail (1.4.2 MSI).
- `alwayson_instances`: one row per AlwaysOn key — heartbeat, runtime (`running`/`stopped`), hostname, last_error. Service role only.
- `alwayson_commands`: queue `start`/`stop`/`restart` with status pending→acked/done/failed. Service role only.
- `alwayson_logs`: recent lines; prune trigger keeps last 2000 per key. Service role only.
- Edge: `alwayson-agent` (license-key auth, JWT verify off), `alwayson-admin` (user JWT + `profiles.is_admin`).
- UI: `admin-alwayson.html`. Do not grant anon/authenticated SELECT on these tables.

