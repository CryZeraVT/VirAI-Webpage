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
