-- ============================================================================
-- publish_tos_version — admin-only, atomic ToS version publisher
-- Migration: 2026-04-17 (Part 3 of the EULA / ToS work)
-- Aegis tier: 3  (legal/consent write; irreversible once a user accepts).
--
-- Design:
--   * Gated by profiles.is_admin. Any admin can publish. To gate to a
--     single person later, add a subrole column and tighten the check here.
--   * Runs as SECURITY DEFINER so it can INSERT into tos_versions even
--     though authenticated has no direct grants on that table.
--   * Single transaction: new tos_versions row + site_settings pointer
--     flip together, or neither. No partial-publish recovery nightmares.
--   * Monotonic version check — prevents accidental downgrade and blocks
--     re-publishing an already-used version number.
--   * Typed confirmation is enforced CLIENT-SIDE; server validates shape
--     and admin-role. The server doesn't need the confirm phrase because
--     calling this RPC is itself the deliberate act.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.publish_tos_version(
  p_surface       text,
  p_version       text,
  p_body_markdown text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller          uuid;
  v_is_admin        boolean;
  v_current_version text;
  v_sha             text;
BEGIN
  -- ── Auth ─────────────────────────────────────────────────────────────
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT is_admin INTO v_is_admin FROM public.profiles WHERE id = v_caller;
  IF v_is_admin IS NOT TRUE THEN
    RAISE EXCEPTION 'admin privilege required' USING ERRCODE = '42501';
  END IF;

  -- ── Input validation ─────────────────────────────────────────────────
  IF p_surface NOT IN ('app', 'web') THEN
    RAISE EXCEPTION 'surface must be app or web' USING ERRCODE = '22023';
  END IF;

  IF p_version IS NULL OR length(trim(p_version)) = 0 THEN
    RAISE EXCEPTION 'version required' USING ERRCODE = '22023';
  END IF;

  -- Require clean dot-numeric versions so lexicographic and numeric
  -- comparison agree. "1.0", "1.1", "2.5.3" → OK. "1.0-beta" → rejected.
  IF p_version !~ '^\d+(\.\d+)*$' THEN
    RAISE EXCEPTION 'version must be dot-numeric (e.g. 1.0, 1.1, 2.0)'
      USING ERRCODE = '22023';
  END IF;

  IF p_body_markdown IS NULL OR length(trim(p_body_markdown)) = 0 THEN
    RAISE EXCEPTION 'body_markdown required' USING ERRCODE = '22023';
  END IF;

  -- Soft cap: 64 KB. Legal text rarely exceeds this; larger bodies should
  -- be split or reviewed.
  IF length(p_body_markdown) > 65536 THEN
    RAISE EXCEPTION 'body_markdown exceeds 64KB cap' USING ERRCODE = '22023';
  END IF;

  -- ── Uniqueness & monotonicity ────────────────────────────────────────
  IF EXISTS (
    SELECT 1 FROM public.tos_versions
     WHERE surface = p_surface AND version = p_version
  ) THEN
    RAISE EXCEPTION 'version % already exists for surface %', p_version, p_surface
      USING ERRCODE = '23505';
  END IF;

  SELECT value INTO v_current_version
    FROM public.site_settings
   WHERE key = p_surface || '_tos_current_version';

  IF v_current_version IS NOT NULL AND length(trim(v_current_version)) > 0 THEN
    -- Array comparison works because we've validated both are dot-numeric.
    IF string_to_array(p_version,          '.')::int[]
         <= string_to_array(v_current_version, '.')::int[] THEN
      RAISE EXCEPTION
        'version % must be strictly greater than current %', p_version, v_current_version
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- ── Atomic publish: INSERT row, flip pointer ─────────────────────────
  -- body_sha256 is set by the BEFORE INSERT trigger on tos_versions.
  INSERT INTO public.tos_versions (surface, version, body_markdown, published_by, notes)
  VALUES (
    p_surface,
    p_version,
    p_body_markdown,
    v_caller,
    'Published via publish_tos_version RPC'
  );

  INSERT INTO public.site_settings (key, value)
  VALUES (p_surface || '_tos_current_version', p_version)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  SELECT body_sha256 INTO v_sha
    FROM public.tos_versions
   WHERE surface = p_surface AND version = p_version;

  RETURN json_build_object(
    'ok',      true,
    'surface', p_surface,
    'version', p_version,
    'sha256',  v_sha
  );
END;
$$;

REVOKE ALL    ON FUNCTION public.publish_tos_version(text, text, text) FROM public;
REVOKE EXECUTE ON FUNCTION public.publish_tos_version(text, text, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.publish_tos_version(text, text, text) TO   authenticated;

COMMENT ON FUNCTION public.publish_tos_version(text, text, text) IS
  'Admin-only atomic publisher for ToS/EULA versions. Validates monotonic version, INSERTs new tos_versions row, and flips site_settings pointer in a single transaction.';

-- ============================================================================
-- ROLLBACK (paste into SQL editor to fully revert):
-- ============================================================================
-- DROP FUNCTION IF EXISTS public.publish_tos_version(text, text, text);
-- ============================================================================
