-- =====================================================================
-- Subscription lifecycle state on `licenses`
-- =====================================================================
-- Adds three columns so the account page can render an accurate
-- "Your subscription will end on X" banner, and we can audit when a
-- cancellation was initiated vs. when it actually took effect.
--
-- Written by:  stripe-webhook (service role) via `customer.subscription.updated`
--              and `customer.subscription.deleted` events. Never written
--              by the client or by user-facing edge functions.
--
-- Read by:    account.html Billing tab; admin panel (future).
--
-- Safety:     All three columns are nullable / default-safe, so existing
--             rows remain valid after this migration. No data backfill
--             required — Stripe will fire `customer.subscription.updated`
--             for each existing subscription on the next billing cycle
--             and populate them automatically.
-- =====================================================================

BEGIN;

ALTER TABLE public.licenses
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS current_period_end   timestamptz,
  ADD COLUMN IF NOT EXISTS canceled_at          timestamptz;

COMMENT ON COLUMN public.licenses.cancel_at_period_end IS
  'True when user has requested cancellation via Stripe Customer Portal. '
  'License remains active until current_period_end, then webhook flips status=inactive. '
  'Clearing this flag (reactivation) is handled by Stripe customer.subscription.updated.';

COMMENT ON COLUMN public.licenses.current_period_end IS
  'Stripe subscription.current_period_end — the date access is paid through. '
  'Used to render "Your subscription will end on <date>" banner.';

COMMENT ON COLUMN public.licenses.canceled_at IS
  'Audit: timestamp when customer.subscription.deleted fired (i.e. the '
  'period-end moment that actually ended the subscription). Null while active.';

-- Partial index for admin "show me all pending cancellations" queries.
-- Small table anyway, but future-proof.
CREATE INDEX IF NOT EXISTS idx_licenses_cancel_pending
  ON public.licenses (current_period_end)
  WHERE cancel_at_period_end = true;

COMMIT;
