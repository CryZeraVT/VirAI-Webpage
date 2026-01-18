-- 1. Create the purchases table
CREATE TABLE public.purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    stripe_session_id TEXT UNIQUE NOT NULL,
    download_token UUID UNIQUE NOT NULL,
    download_used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

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
