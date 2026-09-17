-- Enable VirCast as a free VirForge-streamed product without publishing a
-- package. The admin page fills the stable channel after the installer upload.

BEGIN;

UPDATE public.system_config
SET
  value = jsonb_set(
    jsonb_set(
      value,
      '{products,vircast}',
      (
        jsonb_build_object(
          'version', '',
          'url', '',
          'sha256', '',
          'bytes', 0,
          'channels', '{}'::jsonb,
          'history', '[]'::jsonb
        )
        || COALESCE(value #> '{products,vircast}', '{}'::jsonb)
        || jsonb_build_object(
          'downloadable', true,
          'requiresKey', false,
          'channels', COALESCE(value #> '{products,vircast,channels}', '{}'::jsonb),
          'history', COALESCE(value #> '{products,vircast,history}', '[]'::jsonb)
        )
      ),
      true
    ),
    '{publishedAt}',
    to_jsonb(NOW()::text),
    true
  ),
  updated_at = NOW()
WHERE key = 'virforge_launcher_catalog';

COMMIT;
