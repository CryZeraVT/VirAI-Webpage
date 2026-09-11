-- Kick running VirForge launchers whenever the stream catalog is written.
-- Admin browser broadcast was flaky; this is the durable path.

CREATE OR REPLACE FUNCTION public.notify_virforge_catalog_updated()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.key IS DISTINCT FROM 'virforge_launcher_catalog' THEN
    RETURN NEW;
  END IF;
  PERFORM realtime.send(
    jsonb_build_object(
      'publishedAt', COALESCE(NEW.value->>'publishedAt', NEW.updated_at::text),
      'source', 'system_config'
    ),
    'updated',
    'virforge-catalog',
    false
  );
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_notify_virforge_catalog_updated ON public.system_config;
CREATE TRIGGER trg_notify_virforge_catalog_updated
  AFTER INSERT OR UPDATE ON public.system_config
  FOR EACH ROW
  WHEN (NEW.key = 'virforge_launcher_catalog')
  EXECUTE FUNCTION public.notify_virforge_catalog_updated();
