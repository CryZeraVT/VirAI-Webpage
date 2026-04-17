-- ============================================================================
-- Terms of Service acceptance tracking
-- Migration: 2026-04-17
-- Aegis tier: 3 (auth/consent/legal surface) — nullable additive columns + SECURITY DEFINER RPC
-- Rollback: see bottom of file
-- ============================================================================

-- 1. Add tracking columns to profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS tos_version     text,
  ADD COLUMN IF NOT EXISTS tos_accepted_at timestamptz;

COMMENT ON COLUMN public.profiles.tos_version     IS 'Version string of the ToS the user accepted (e.g. "1.0"). NULL = never accepted.';
COMMENT ON COLUMN public.profiles.tos_accepted_at IS 'Timestamp of most recent ToS acceptance.';

-- 2. Index for admin auditing / "who has not accepted current version"
CREATE INDEX IF NOT EXISTS idx_profiles_tos_version ON public.profiles (tos_version);

-- 3. RPC: the ONLY way a client writes these columns.
--    SECURITY DEFINER prevents users from escalating other columns (e.g. is_admin)
--    because direct UPDATE is NOT granted to the 'authenticated' role on profiles.
CREATE OR REPLACE FUNCTION public.accept_tos(p_version text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  IF p_version IS NULL OR length(trim(p_version)) = 0 THEN
    RAISE EXCEPTION 'version required' USING ERRCODE = '22023';
  END IF;

  UPDATE public.profiles
     SET tos_version     = p_version,
         tos_accepted_at = now()
   WHERE id = auth.uid();

  -- If no profile row exists yet (shouldn't happen — handle_new_user trigger creates one),
  -- surface that so it's visible rather than silent.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile row missing for user %', auth.uid();
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_tos(text) FROM public;
GRANT EXECUTE ON FUNCTION public.accept_tos(text) TO authenticated;

COMMENT ON FUNCTION public.accept_tos(text) IS
  'Records that the current authenticated user accepted ToS version p_version at now(). Only writes tos_version + tos_accepted_at on their own profile row.';

-- 4. SELECT-own-profile policy check.
--    The existing deployment already has "Users can view own profile" with the same
--    effective rule (auth.uid() = id). We keep that policy; this block is a safety net
--    for fresh environments that don't have any SELECT policy on profiles yet.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'profiles'
       AND cmd        = 'SELECT'
  ) THEN
    EXECUTE $p$
      CREATE POLICY "Users can read own profile"
        ON public.profiles
        FOR SELECT
        USING (id = auth.uid())
    $p$;
  END IF;
END $$;

-- ============================================================================
-- ROLLBACK (paste into SQL editor to fully revert):
-- ============================================================================
-- DROP FUNCTION IF EXISTS public.accept_tos(text);
-- DROP INDEX IF EXISTS public.idx_profiles_tos_version;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS tos_accepted_at;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS tos_version;
-- ============================================================================
