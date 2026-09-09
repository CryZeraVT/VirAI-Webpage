-- Persist launcherstream public base URL for Admin only.
-- Not world-readable: the launcher uses get_virforge_catalog, not this row.

DROP POLICY IF EXISTS "Allow public read access to system config" ON public.system_config;
CREATE POLICY "Allow public read access to system config"
  ON public.system_config
  FOR SELECT
  USING (
    key <> ALL (ARRAY[
      'ai_api_keys'::text,
      'proxy_ai_provider'::text,
      'studio_ai_provider'::text,
      'builtin_ai_provider'::text,
      'ai_failover_chains'::text,
      'alert_settings'::text,
      'virforge_launcher_r2'::text
    ])
  );

CREATE OR REPLACE FUNCTION public.get_virforge_launcher_r2()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_admin boolean;
  v_default  jsonb := '{"bucket":"launcherstream","public_url":""}'::jsonb;
BEGIN
  SELECT is_admin INTO v_is_admin FROM public.profiles WHERE id = auth.uid();
  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  RETURN COALESCE(
    (SELECT value FROM public.system_config WHERE key = 'virforge_launcher_r2'),
    v_default
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_virforge_launcher_r2(p_config jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_admin  boolean;
  v_old_value jsonb;
  v_bucket    text;
  v_url       text;
  v_normalized jsonb;
BEGIN
  SELECT is_admin INTO v_is_admin FROM public.profiles WHERE id = auth.uid();
  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'launcher R2 config must be a JSON object';
  END IF;

  v_bucket := lower(trim(COALESCE(p_config ->> 'bucket', 'launcherstream')));
  IF v_bucket = '' THEN
    v_bucket := 'launcherstream';
  END IF;
  IF v_bucket !~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' THEN
    RAISE EXCEPTION 'bucket must be a valid R2 bucket name';
  END IF;

  v_url := trim(COALESCE(p_config ->> 'public_url', ''));
  v_url := regexp_replace(v_url, '/+$', '');
  IF v_url = '' THEN
    RAISE EXCEPTION 'Paste the launcherstream Public Development URL (https://pub-….r2.dev)';
  END IF;
  IF v_url ~* 'cloudflarestorage\.com' THEN
    RAISE EXCEPTION 'That is the S3 API host. Use the pub- r2.dev URL from launcherstream Settings.';
  END IF;
  IF v_url ~* 'dc3c6d7c6ae448c5b0c3fdf2830f7664' THEN
    RAISE EXCEPTION 'That pub URL is viri-releases. Use the launcherstream Public Development URL.';
  END IF;
  IF v_url !~* '^https://pub-[a-f0-9]+\.r2\.dev$' THEN
    RAISE EXCEPTION 'public_url must be https://pub-….r2.dev with no path';
  END IF;

  v_normalized := jsonb_build_object(
    'bucket', v_bucket,
    'public_url', v_url
  );

  SELECT value INTO v_old_value FROM public.system_config WHERE key = 'virforge_launcher_r2';

  INSERT INTO public.system_config (key, value)
  VALUES ('virforge_launcher_r2', v_normalized)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  INSERT INTO public.system_config_audit (config_key, old_value, new_value, changed_by)
  VALUES ('virforge_launcher_r2', v_old_value, v_normalized, auth.uid());

  RETURN jsonb_build_object('success', true, 'new_config', v_normalized);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_virforge_launcher_r2() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_virforge_launcher_r2() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_virforge_launcher_r2() FROM anon;

REVOKE ALL ON FUNCTION public.update_virforge_launcher_r2(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_virforge_launcher_r2(jsonb) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.update_virforge_launcher_r2(jsonb) FROM anon;

COMMENT ON FUNCTION public.get_virforge_launcher_r2() IS 'Admin-only read of launcherstream bucket + public base URL.';
COMMENT ON FUNCTION public.update_virforge_launcher_r2(jsonb) IS 'Admin-only write of launcherstream target with validation + system_config_audit.';
