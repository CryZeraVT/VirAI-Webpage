-- Website Storage activate is the source of truth for live versions.
-- Overlay those rows into get_virforge_catalog and write the launcher
-- catalog when a version is marked active so running launchers refresh.

CREATE OR REPLACE FUNCTION public.virforge_package_identity(url text, prev jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  sha text := COALESCE(prev->>'sha256', '');
  bytes bigint := COALESCE(NULLIF(prev->>'bytes', '')::bigint, 0);
BEGIN
  IF COALESCE(prev->>'url', '') = url AND sha ~ '^[a-f0-9]{64}$' AND bytes > 0 THEN
    RETURN jsonb_build_object('sha256', sha, 'bytes', bytes);
  END IF;
  IF url LIKE '%/AiRi_1.4.2_x64_en-US.msi' THEN
    RETURN jsonb_build_object(
      'sha256', '0d6e8ae2b70bda8c71405c36d73da7bc5100d223f946002ec743c300e57eac14',
      'bytes', 1736532214
    );
  END IF;
  IF url LIKE '%/AiRi_1.4.3_x64-setup.exe' THEN
    RETURN jsonb_build_object(
      'sha256', '5477781464ccf69f57b2429cdaef55e4ff96462a7ecdfad109044322ddf4fa94',
      'bytes', 3306303279
    );
  END IF;
  RETURN jsonb_build_object('sha256', '', 'bytes', 0);
END;
$function$;

CREATE OR REPLACE FUNCTION public.merge_active_r2_into_catalog(catalog jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  merged jsonb := COALESCE(catalog, '{"products":{"airi":{"channels":{}}}}'::jsonb);
  rec record;
  ch text;
  url text;
  ident jsonb;
  pkg jsonb;
  prev jsonb;
BEGIN
  FOR rec IN
    SELECT version, channel, download_url
    FROM public.r2_versions
    WHERE is_active = true
      AND download_url LIKE 'https://%'
      AND COALESCE(version, '') <> ''
  LOOP
    ch := CASE WHEN rec.channel = 'beta' THEN 'beta' ELSE 'stable' END;
    url := trim(rec.download_url);
    prev := merged #> ARRAY['products','airi','channels', ch];
    IF prev IS NULL AND ch = 'stable' THEN
      prev := jsonb_build_object(
        'url', merged #>> '{products,airi,url}',
        'sha256', merged #>> '{products,airi,sha256}',
        'bytes', merged #>> '{products,airi,bytes}'
      );
    END IF;
    ident := public.virforge_package_identity(url, prev);
    IF COALESCE(ident->>'bytes', '0') = '0' THEN
      ident := public.virforge_package_identity(url, merged #> '{products,airi,channels,stable}');
    END IF;
    IF COALESCE(ident->>'bytes', '0') = '0' THEN
      ident := public.virforge_package_identity(url, merged #> '{products,airi,channels,beta}');
    END IF;
    pkg := jsonb_build_object(
      'url', url,
      'version', rec.version,
      'sha256', COALESCE(ident->>'sha256', ''),
      'bytes', COALESCE(NULLIF(ident->>'bytes', '')::bigint, 0)
    );
    merged := jsonb_set(merged, ARRAY['products','airi','channels', ch], pkg, true);
    IF ch = 'stable' THEN
      merged := jsonb_set(merged, '{products,airi,url}', to_jsonb(url), true);
      merged := jsonb_set(merged, '{products,airi,version}', to_jsonb(rec.version), true);
      merged := jsonb_set(merged, '{products,airi,sha256}', to_jsonb(COALESCE(ident->>'sha256', '')), true);
      merged := jsonb_set(merged, '{products,airi,bytes}', to_jsonb(COALESCE(NULLIF(ident->>'bytes', '')::bigint, 0)), true);
    END IF;
  END LOOP;
  RETURN merged;
END;
$function$;

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
        'vircast', jsonb_build_object('version', null, 'url', '', 'sha256', '', 'bytes', 0)
      )
    );
  END IF;

  catalog := public.merge_active_r2_into_catalog(catalog);
  IF COALESCE(catalog ->> 'licenseEndpoint', '') = '' THEN
    catalog := jsonb_set(catalog, '{licenseEndpoint}', to_jsonb(license), true);
  END IF;
  RETURN catalog;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_virforge_catalog() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sync_virforge_catalog_from_r2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  catalog jsonb;
BEGIN
  IF NEW.is_active IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  SELECT value INTO catalog FROM public.system_config WHERE key = 'virforge_launcher_catalog';
  catalog := public.merge_active_r2_into_catalog(catalog);
  catalog := jsonb_set(
    catalog,
    '{publishedAt}',
    to_jsonb(to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    true
  );
  UPDATE public.system_config
  SET value = catalog, updated_at = now()
  WHERE key = 'virforge_launcher_catalog';
  IF NOT FOUND THEN
    INSERT INTO public.system_config (key, value, updated_at)
    VALUES ('virforge_launcher_catalog', catalog, now());
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sync_virforge_catalog_from_r2 ON public.r2_versions;
CREATE TRIGGER trg_sync_virforge_catalog_from_r2
  AFTER INSERT OR UPDATE OF is_active, version, download_url, channel ON public.r2_versions
  FOR EACH ROW
  WHEN (NEW.is_active = true)
  EXECUTE FUNCTION public.sync_virforge_catalog_from_r2();
