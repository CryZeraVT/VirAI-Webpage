# Viritts.com — Supabase Blueprint

> **Project URL**: `https://rgigtqpesabuyaumibaj.supabase.co`
> **Project Ref**: `rgigtqpesabuyaumibaj`
> **Last Updated**: 2026-02-26

---

## Tables (10)

### licenses (17 rows) — RLS: ON
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, `gen_random_uuid()` |
| license_key | text | UNIQUE |
| status | text | default `'active'` |
| expires_at | timestamptz | nullable |
| machine_id | text | nullable |
| created_at | timestamptz | nullable, default `now()` |
| last_seen | timestamptz | nullable |
| email | text | nullable |

### purchases (1 row) — RLS: OFF ⚠️
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, `gen_random_uuid()` |
| email | text | |
| stripe_session_id | text | UNIQUE |
| stripe_customer_id | text | nullable |
| stripe_subscription_id | text | nullable |
| stripe_price_id | text | nullable |
| license_key | text | nullable |
| download_token | uuid | UNIQUE |
| download_used | boolean | default `false` |
| created_at | timestamptz | nullable, default `now()` |
| expires_at | timestamptz | |

### announcements (3 rows) — RLS: ON
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, `gen_random_uuid()` |
| created_at | timestamptz | default `timezone('utc', now())` |
| version | text | |
| title | text | |
| content | text | |
| is_critical | boolean | nullable, default `false` |
| download_url | text | nullable |
| active | boolean | nullable, default `true` |

### profiles (24 rows) — RLS: ON
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, FK → `auth.users.id` |
| email | text | nullable |
| is_admin | boolean | nullable, default `false` |
| updated_at | timestamptz | nullable, default `now()` |
| twitch_username | text | nullable |

### system_config (2 rows) — RLS: ON
| Column | Type | Notes |
|--------|------|-------|
| key | text | PK |
| value | jsonb | |
| updated_at | timestamptz | nullable, default `now()` |

### token_usage (4508 rows) — RLS: ON
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, `gen_random_uuid()` |
| license_key | text | |
| provider | text | |
| model | text | |
| prompt_tokens | int4 | default `0` |
| completion_tokens | int4 | default `0` |
| total_tokens | int4 | generated: `prompt_tokens + completion_tokens` |
| cost_usd | numeric | default `0` |
| created_at | timestamptz | nullable, default `now()` |
| twitch_channel | text | nullable |

### model_pricing (14 rows) — RLS: ON
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, `gen_random_uuid()` |
| provider | text | |
| model | text | |
| input_cost_per_million | numeric | default `0` |
| output_cost_per_million | numeric | default `0` |
| updated_at | timestamptz | nullable, default `now()` |

### subscription_plans (1 row) — RLS: ON
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, `gen_random_uuid()` |
| name | text | |
| stripe_price_id | text | nullable, UNIQUE |
| price_monthly | numeric | default `0` |
| description | text | nullable |
| is_active | boolean | nullable, default `true` |
| created_at | timestamptz | nullable, default `now()` |
| updated_at | timestamptz | nullable, default `now()` |

### r2_versions (2 rows) — RLS: ON
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, `gen_random_uuid()` |
| version | text | UNIQUE |
| title | text | |
| content | text | nullable |
| file_name | text | |
| file_path | text | |
| download_url | text | |
| is_critical | boolean | nullable, default `false` |
| is_active | boolean | nullable, default `false` |
| uploaded_by | uuid | nullable, FK → `auth.users.id` |
| created_at | timestamptz | nullable, default `now()` |

### beta_signups (11 rows) — RLS: ON
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, `gen_random_uuid()` |
| name | text | |
| email | text | |
| twitch_username | text | |
| content_type | text | nullable |
| message | text | nullable |
| status | text | default `'pending'` |
| created_at | timestamptz | nullable, default `now()` |

---

## RLS Policies

### announcements
- **Admins can manage announcements** — ALL where `profiles.is_admin = true`
- **Allow public read access to active announcements** — SELECT where `active = true`

### beta_signups
- **Admins can read beta_signups** — SELECT where admin
- **Admins can update beta_signups** — UPDATE where admin
- **Service role full access on beta_signups** — ALL where `auth.role() = 'service_role'`

### licenses
- **Admins can view all licenses** — SELECT where admin (authenticated)
- **Admins can insert licenses** — INSERT where admin (authenticated)
- **Admins can update licenses** — UPDATE where admin (authenticated)
- **Admins can delete licenses** — DELETE where admin (authenticated)
- **Users can view their own licenses** — SELECT where `email = auth.email()`

### model_pricing
- **Anyone can view model pricing** — SELECT, open
- **Admins can insert model pricing** — INSERT where admin
- **Admins can update model pricing** — UPDATE where admin

### profiles
- **Users can view own profile** — SELECT where `auth.uid() = id`

### r2_versions
- **Admins can manage versions** — ALL where admin
- **Public can read versions** — SELECT, open

### subscription_plans
- **Admins can manage subscription plans** — ALL where admin
- **Anyone can view subscription plans** — SELECT, open

### system_config
- **Admins can manage system config** — ALL where admin
- **Allow public read access to system config** — SELECT, open

### token_usage
- **Admins can view all token usage** — SELECT where admin

### purchases — ⚠️ NO RLS

---

## Edge Functions (10)

| Function | JWT | Status |
|----------|-----|--------|
| `validate-license` | Yes | ACTIVE |
| `stripe-webhook` | No | ACTIVE |
| `reset-license` | Yes | ACTIVE |
| `log-usage` | No | ACTIVE |
| `openai-usage` | No | ACTIVE |
| `beta-signup` | Yes | ACTIVE |
| `send-beta-approval` | Yes | ACTIVE |
| `admin-users` | No | ACTIVE |
| `debug-user` | No | ACTIVE |
| `get-testers` | No | ACTIVE |

---

## Database Functions

| Function | Type | Returns |
|----------|------|---------|
| `handle_new_user` | FUNCTION | trigger |

---

## Installed Extensions

| Extension | Schema | Version |
|-----------|--------|---------|
| pgcrypto | extensions | 1.3 |
| pg_stat_statements | extensions | 1.11 |
| supabase_vault | vault | 0.3.1 |
| pg_graphql | graphql | 1.5.11 |
| uuid-ossp | extensions | 1.1 |
| plpgsql | pg_catalog | 1.0 |

---

## Migrations (13)

| Version | Name |
|---------|------|
| 20260124203117 | create_announcements_table |
| 20260124214424 | setup_admin_and_profiles |
| 20260124225021 | create_system_config_table |
| 20260124235606 | create_token_usage_table |
| 20260125000624 | fix_token_usage_insert_policy |
| 20260125000733 | add_twitch_channel_to_token_usage |
| 20260125001209 | secure_token_usage_insert |
| 20260125010850 | create_model_pricing_table |
| 20260125011008 | add_admin_pricing_policy |
| 20260125013125 | add_subscription_plans_table |
| 20260125034403 | create_r2_versions_table |
| 20260126055055 | allow_admins_to_manage_licenses |
| 20260205021841 | add_twitch_username_to_profiles |

---

## Foreign Keys

- `profiles.id` → `auth.users.id`
- `r2_versions.uploaded_by` → `auth.users.id`

---

## ⚠️ Flags

1. **`purchases` table has RLS disabled** — contains Stripe session IDs, customer IDs, and license keys. This is exposed without row-level security.
2. **Edge functions without JWT**: `stripe-webhook`, `log-usage`, `openai-usage`, `admin-users`, `debug-user`, `get-testers` — verify these have their own auth checks internally.
3. **`token_usage` has no INSERT policy visible** — inserts may only work via service_role or edge functions.
