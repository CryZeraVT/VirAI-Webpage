-- ============================================================================
-- HOTFIX 2026-04-17: tos_versions_set_sha() couldn't resolve digest()
-- ============================================================================
-- Context:
--   The original tos_versions trigger function called `digest(...)` bare.
--   In Supabase, pgcrypto is installed in the `extensions` schema, not
--   `public`. When the trigger fires from inside the publish_tos_version
--   RPC (which has `SET search_path = public`), the trigger inherits that
--   restricted search_path and digest() is unreachable, producing:
--
--     ERROR: function digest(bytea, unknown) does not exist
--
-- Fix (two-layer):
--   1. Qualify the call explicitly as `extensions.digest(...)`.
--   2. Add `SET search_path = public, extensions` to the trigger function
--      itself so it's robust regardless of caller context.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.tos_versions_set_sha()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $function$
BEGIN
  NEW.body_sha256 := encode(
    extensions.digest(convert_to(NEW.body_markdown, 'UTF8'), 'sha256'),
    'hex'
  );
  RETURN NEW;
END;
$function$;

-- ROLLBACK (restores the broken version — do not use except for forensics):
-- CREATE OR REPLACE FUNCTION public.tos_versions_set_sha()
-- RETURNS trigger LANGUAGE plpgsql AS $function$
-- BEGIN
--   NEW.body_sha256 := encode(digest(convert_to(NEW.body_markdown, 'UTF8'), 'sha256'), 'hex');
--   RETURN NEW;
-- END;
-- $function$;
