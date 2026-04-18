-- 1. Create the purchases table
CREATE TABLE public.purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    stripe_session_id TEXT UNIQUE NOT NULL,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    stripe_price_id TEXT,
    license_key TEXT,
    download_token UUID UNIQUE NOT NULL,
    download_used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- License keys for app activation
CREATE TABLE public.licenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    license_key TEXT UNIQUE NOT NULL,
    email TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    expires_at TIMESTAMPTZ,
    machine_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen TIMESTAMPTZ
);

-- Ensure email column exists for older deployments
ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS email TEXT;

-- Enable RLS for licenses
ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to view their own licenses
CREATE POLICY "Users can view their own licenses"
ON public.licenses
FOR SELECT
USING (email = auth.email());

CREATE INDEX IF NOT EXISTS idx_licenses_email ON public.licenses (email);

-- Ensure purchases columns exist for older deployments
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS license_key TEXT;

-- 2. Enable Row Level Security (RLS)
ALTER TABLE public.purchases ENABLE ROW LEVEL SECURITY;

-- 3. Create a policy to allow public read access via download_token
-- (We'll use a stored procedure for secure access, but this allows basic querying if needed securely)
CREATE POLICY "Allow read access via download_token" 
ON public.purchases 
FOR SELECT 
USING (true); -- We rely on the unique token being secret

-- 4. Create a private bucket for the installer
-- Go to Storage -> New Bucket -> Name: "downloads" -> Public: OFF

-- 5. Create the secure download function (RPC)
CREATE OR REPLACE FUNCTION get_download_url(token UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    purchase_record RECORD;
    signed_url TEXT;
BEGIN
    -- Check if token exists, is unused, and not expired
    SELECT * INTO purchase_record
    FROM public.purchases
    WHERE download_token = token
      AND download_used = FALSE
      AND expires_at > NOW();

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invalid or expired token';
    END IF;

    -- Generate a signed URL for 1 hour (3600 seconds)
    -- NOTE: Requires 'storage' schema access
    signed_url := storage.create_signed_url('downloads', 'ViriTTS.exe', 3600);

    -- Mark token as used (optional: remove this if you want to allow multiple downloads within 24h)
    UPDATE public.purchases
    SET download_used = TRUE
    WHERE id = purchase_record.id;

    RETURN json_build_object('signed_url', signed_url);
END;
$$;

-- Beta signups for ViriTTS
CREATE TABLE IF NOT EXISTS public.beta_signups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    twitch_username TEXT NOT NULL,
    content_type TEXT,
    message TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_beta_signups_email
    ON public.beta_signups (email);

ALTER TABLE public.beta_signups ENABLE ROW LEVEL SECURITY;

-- Service role (edge functions) can insert; no public read
CREATE POLICY "Service role full access on beta_signups"
ON public.beta_signups
FOR ALL
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');

-- ── Token Boost (applied 2026-04-11) ─────────────────────────────────────────

-- Audit log for $5 token boost purchases
CREATE TABLE IF NOT EXISTS public.boost_purchases (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key       TEXT NOT NULL,
  stripe_session_id TEXT UNIQUE NOT NULL,
  tokens_added      BIGINT NOT NULL DEFAULT 2000000,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.boost_purchases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on boost_purchases"
ON public.boost_purchases FOR ALL
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS idx_boost_purchases_license_key
  ON public.boost_purchases (license_key);

-- Additive RPC — safely adds tokens to boost pool, never resets it
CREATE OR REPLACE FUNCTION public.add_boost_tokens(
  p_license_key TEXT,
  p_amount      BIGINT DEFAULT 2000000
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  UPDATE token_quotas
  SET boost_tokens_remaining = boost_tokens_remaining + p_amount,
      updated_at             = now()
  WHERE license_key = p_license_key;

  IF NOT FOUND THEN
    INSERT INTO token_quotas (license_key, boost_tokens_remaining)
    VALUES (p_license_key, p_amount)
    ON CONFLICT (license_key)
    DO UPDATE SET
      boost_tokens_remaining = token_quotas.boost_tokens_remaining + EXCLUDED.boost_tokens_remaining,
      updated_at             = now();
  END IF;
END;
$$;
