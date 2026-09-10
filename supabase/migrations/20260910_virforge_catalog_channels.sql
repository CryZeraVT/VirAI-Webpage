-- Launcher catalog: Release (stable) and Beta channels + default license endpoint.

CREATE OR REPLACE FUNCTION public.get_virforge_catalog()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  catalog jsonb;
  airi jsonb;
  channels jsonb;
  stable jsonb;
  license text := 'https://rgigtqpesabuyaumibaj.supabase.co/functions/v1/validate-license';
BEGIN
  SELECT value INTO catalog
  FROM public.system_config
  WHERE key = 'virforge_launcher_catalog';

  IF catalog IS NULL THEN
    RETURN jsonb_build_object(
      'licenseEndpoint', license,
      'launcherUrl', '',
      'products', jsonb_build_object(
        'airi', jsonb_build_object(
          'version', '1.4.3',
          'url', '',
          'sha256', '',
          'bytes', 3306303279,
          'channels', '{}'::jsonb
        ),
        'vircast', jsonb_build_object('version', null, 'url', '', 'sha256', '', 'bytes', 0)
      )
    );
  END IF;

  airi := COALESCE(catalog #> '{products,airi}', '{}'::jsonb);
  channels := COALESCE(airi -> 'channels', '{}'::jsonb);
  IF channels -> 'stable' IS NULL AND COALESCE(airi ->> 'url', '') <> '' THEN
    stable := jsonb_build_object(
      'url', airi ->> 'url',
      'sha256', COALESCE(airi ->> 'sha256', ''),
      'bytes', COALESCE(NULLIF(airi ->> 'bytes', '')::bigint, 0),
      'version', COALESCE(airi ->> 'version', '')
    );
    channels := channels || jsonb_build_object('stable', stable);
  END IF;
  airi := airi || jsonb_build_object('channels', channels);
  catalog := jsonb_set(catalog, '{products,airi}', airi, true);
  IF COALESCE(catalog ->> 'licenseEndpoint', '') = '' THEN
    catalog := jsonb_set(catalog, '{licenseEndpoint}', to_jsonb(license), true);
  END IF;
  RETURN catalog;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_virforge_catalog() TO anon, authenticated, service_role;
