-- Keep the VirForge desktop installer on the catalog without overlaying
-- r2_versions (that table remains the slim AiRi account download).

CREATE OR REPLACE FUNCTION public.get_virforge_catalog()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  catalog jsonb;
  license text := 'https://rgigtqpesabuyaumibaj.supabase.co/functions/v1/validate-license';
  launcher jsonb;
BEGIN
  SELECT value INTO catalog
  FROM public.system_config
  WHERE key = 'virforge_launcher_catalog';

  IF catalog IS NULL THEN
    catalog := jsonb_build_object(
      'licenseEndpoint', license,
      'launcherUrl', '',
      'products', jsonb_build_object(
        'airi', jsonb_build_object('version', '', 'url', '', 'sha256', '', 'bytes', 0, 'channels', '{}'::jsonb),
        'vircast', jsonb_build_object('version', null, 'url', '', 'sha256', '', 'bytes', 0),
        'launcher', jsonb_build_object('version', '', 'url', '', 'sha256', '', 'bytes', 0, 'channels', '{}'::jsonb, 'history', '[]'::jsonb)
      )
    );
  END IF;

  catalog := public.merge_active_r2_into_catalog(catalog);

  IF catalog #> '{products,launcher}' IS NULL THEN
    catalog := jsonb_set(
      catalog,
      '{products,launcher}',
      jsonb_build_object('version', '', 'url', '', 'sha256', '', 'bytes', 0, 'channels', '{}'::jsonb, 'history', '[]'::jsonb),
      true
    );
  END IF;

  launcher := catalog #> '{products,launcher}';
  IF COALESCE(catalog ->> 'launcherUrl', '') = '' AND COALESCE(launcher ->> 'url', '') <> '' THEN
    catalog := jsonb_set(catalog, '{launcherUrl}', to_jsonb(launcher ->> 'url'), true);
  ELSIF COALESCE(launcher ->> 'url', '') = '' AND COALESCE(catalog ->> 'launcherUrl', '') <> '' THEN
    catalog := jsonb_set(catalog, '{products,launcher,url}', to_jsonb(catalog ->> 'launcherUrl'), true);
  END IF;

  IF COALESCE(catalog ->> 'licenseEndpoint', '') = '' THEN
    catalog := jsonb_set(catalog, '{licenseEndpoint}', to_jsonb(license), true);
  END IF;
  RETURN catalog;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_virforge_catalog() TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_virforge_catalog() IS
  'Public launcher catalog. r2_versions overlays products.airi only. products.launcher is the VirForge Setup.exe channel.';
