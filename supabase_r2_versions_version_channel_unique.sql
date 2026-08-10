-- r2_versions_unique_version_channel
-- Applied via Supabase MCP 2026-08-09. Kept here for repo history.
-- Allows the same version string on both stable and beta (twin rows).

ALTER TABLE public.r2_versions
  DROP CONSTRAINT IF EXISTS r2_versions_version_key;

DROP INDEX IF EXISTS public.r2_versions_version_key;

ALTER TABLE public.r2_versions
  DROP CONSTRAINT IF EXISTS r2_versions_version_channel_key;

ALTER TABLE public.r2_versions
  ADD CONSTRAINT r2_versions_version_channel_key
  UNIQUE (version, channel);

COMMENT ON CONSTRAINT r2_versions_version_channel_key ON public.r2_versions IS
  'Version string unique per channel; same MSI can be active on both stable and beta as twin rows.';

CREATE UNIQUE INDEX IF NOT EXISTS r2_versions_one_active_per_channel
  ON public.r2_versions (channel)
  WHERE (is_active = true);
