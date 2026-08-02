-- r2_versions_add_channel_2026_07_31
-- Applied via Supabase MCP 2026-07-31. Kept here for repo history.

ALTER TABLE public.r2_versions
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'stable';

ALTER TABLE public.r2_versions
  DROP CONSTRAINT IF EXISTS r2_versions_channel_check;

ALTER TABLE public.r2_versions
  ADD CONSTRAINT r2_versions_channel_check
  CHECK (channel = ANY (ARRAY['stable'::text, 'beta'::text]));

COMMENT ON COLUMN public.r2_versions.channel IS
  'Release channel: stable (paid/studio/default) or beta (beta-tier license holders). Defaults to stable.';

CREATE UNIQUE INDEX IF NOT EXISTS r2_versions_one_active_per_channel
  ON public.r2_versions (channel)
  WHERE (is_active = true);

UPDATE public.r2_versions
SET channel = 'stable'
WHERE channel IS NULL OR btrim(channel) = '';
