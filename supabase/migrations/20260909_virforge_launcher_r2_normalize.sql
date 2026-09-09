-- Accept a pasted pub- URL even if it has a path, junk chars, or a non-hex id.

CREATE OR REPLACE FUNCTION public.update_virforge_launcher_r2(p_config jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_admin   boolean;
  v_old_value  jsonb;
  v_bucket     text;
  v_url        text;
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
  v_url := regexp_replace(
    v_url,
    '[' || chr(160) || chr(8203) || chr(8204) || chr(8205) || chr(65279) || ']',
    '',
    'g'
  );
  v_url := trim(both '"' from trim(both '''' from v_url));
  v_url := lower(v_url);
  IF v_url ~ '^https://[^/?#]+' THEN
    v_url := substring(v_url from '^https://[^/?#]+');
  END IF;
  v_url := regexp_replace(v_url, '/+$', '');

  IF v_url = '' THEN
    RAISE EXCEPTION 'Paste the launcherstream Public Development URL (https://pub-….r2.dev)';
  END IF;
  IF v_url ~ 'cloudflarestorage\.com' THEN
    RAISE EXCEPTION 'That is the S3 API host. Use the pub- r2.dev URL from launcherstream Settings.';
  END IF;
  IF v_url ~ 'dc3c6d7c6ae448c5b0c3fdf2830f7664' THEN
    RAISE EXCEPTION 'That pub URL is viri-releases. Use the launcherstream Public Development URL.';
  END IF;
  IF v_url !~ '^https://pub-[a-z0-9][a-z0-9-]*\.r2\.dev$' THEN
    RAISE EXCEPTION 'Need a launcherstream host like https://pub-<id>.r2.dev (got: %)', left(v_url, 120);
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
