-- Admin email alerting (Phase 0/1)
-- system_config key 'alert_settings' + RPCs + RLS deny-list + alert_dedupe

-- 1) Seed default alert_settings (empty recipients — admin must add)
INSERT INTO public.system_config (key, value)
VALUES (
  'alert_settings',
  '{
    "recipients": [],
    "enabled": true,
    "enabled_classes": {
      "p0_downtime": true,
      "p1_failover": true,
      "p1_stripe": true,
      "p2_digest": false
    },
    "min_severity": "P1",
    "mute_until": null,
    "dedupe_window_sec": 600
  }'::jsonb
)
ON CONFLICT (key) DO NOTHING;

-- 2) Harden public SELECT: deny alert_settings (recipients must not be anon-readable)
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
      'alert_settings'::text
    ])
  );

-- 3) Dedupe / storm control table (service role + SECURITY DEFINER only)
CREATE TABLE IF NOT EXISTS public.alert_dedupe (
  dedupe_key   text PRIMARY KEY,
  last_sent_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.alert_dedupe ENABLE ROW LEVEL SECURITY;

-- No public policies — deny by default for anon/authenticated.
-- Service role bypasses RLS. Edge notify-admin uses service role.

REVOKE ALL ON public.alert_dedupe FROM PUBLIC;
REVOKE ALL ON public.alert_dedupe FROM anon, authenticated;
GRANT ALL ON public.alert_dedupe TO service_role;

-- 4) get_alert_settings — admin-only (recipients are sensitive)
CREATE OR REPLACE FUNCTION public.get_alert_settings()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_admin boolean;
  v_default  jsonb := '{
    "recipients": [],
    "enabled": true,
    "enabled_classes": {
      "p0_downtime": true,
      "p1_failover": true,
      "p1_stripe": true,
      "p2_digest": false
    },
    "min_severity": "P1",
    "mute_until": null,
    "dedupe_window_sec": 600
  }'::jsonb;
BEGIN
  SELECT is_admin INTO v_is_admin FROM public.profiles WHERE id = auth.uid();
  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  RETURN COALESCE(
    (SELECT value FROM public.system_config WHERE key = 'alert_settings'),
    v_default
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_alert_settings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_alert_settings() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_alert_settings() FROM anon;

-- 5) update_alert_settings — admin-only, validated, audited
CREATE OR REPLACE FUNCTION public.update_alert_settings(p_settings jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_admin   boolean;
  v_old_value  jsonb;
  v_recipients jsonb;
  v_email      text;
  v_email_re   text := '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';
  v_classes    jsonb;
  v_min_sev    text;
  v_dedupe     int;
  v_mute       text;
  v_mute_json  jsonb;
  v_normalized jsonb;
  v_rec_arr    text[] := ARRAY[]::text[];
  v_seen       text[];
BEGIN
  SELECT is_admin INTO v_is_admin FROM public.profiles WHERE id = auth.uid();
  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  IF p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object' THEN
    RAISE EXCEPTION 'alert_settings must be a JSON object';
  END IF;

  -- recipients: array of valid emails, lowercased, deduped, max 20
  v_recipients := COALESCE(p_settings -> 'recipients', '[]'::jsonb);
  IF jsonb_typeof(v_recipients) <> 'array' THEN
    RAISE EXCEPTION 'recipients must be an array';
  END IF;
  IF jsonb_array_length(v_recipients) > 20 THEN
    RAISE EXCEPTION 'recipients: max 20 emails';
  END IF;

  v_seen := ARRAY[]::text[];
  FOR v_email IN SELECT lower(trim(value #>> '{}')) FROM jsonb_array_elements(v_recipients)
  LOOP
    IF v_email IS NULL OR v_email = '' THEN
      CONTINUE;
    END IF;
    IF v_email !~* v_email_re THEN
      RAISE EXCEPTION 'Invalid email: %', v_email;
    END IF;
    IF v_email = ANY (v_seen) THEN
      CONTINUE;
    END IF;
    v_seen := array_append(v_seen, v_email);
    v_rec_arr := array_append(v_rec_arr, v_email);
  END LOOP;

  v_classes := COALESCE(p_settings -> 'enabled_classes', '{}'::jsonb);
  IF jsonb_typeof(v_classes) <> 'object' THEN
    RAISE EXCEPTION 'enabled_classes must be an object';
  END IF;

  v_min_sev := upper(COALESCE(p_settings ->> 'min_severity', 'P1'));
  IF v_min_sev NOT IN ('P0', 'P1', 'P2') THEN
    RAISE EXCEPTION 'min_severity must be P0, P1, or P2';
  END IF;

  BEGIN
    v_dedupe := COALESCE((p_settings ->> 'dedupe_window_sec')::int, 600);
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'dedupe_window_sec must be an integer';
  END;
  IF v_dedupe < 60 OR v_dedupe > 86400 THEN
    RAISE EXCEPTION 'dedupe_window_sec must be between 60 and 86400';
  END IF;

  -- mute_until: JSON null, empty, or ISO timestamptz string
  IF p_settings -> 'mute_until' IS NULL
     OR p_settings -> 'mute_until' = 'null'::jsonb
     OR NULLIF(trim(COALESCE(p_settings ->> 'mute_until', '')), '') IS NULL THEN
    v_mute_json := 'null'::jsonb;
  ELSE
    v_mute := trim(p_settings ->> 'mute_until');
    PERFORM v_mute::timestamptz;
    v_mute_json := to_jsonb(v_mute);
  END IF;

  v_normalized := jsonb_build_object(
    'recipients', to_jsonb(v_rec_arr),
    'enabled', COALESCE((p_settings ->> 'enabled')::boolean, true),
    'enabled_classes', jsonb_build_object(
      'p0_downtime', COALESCE((v_classes ->> 'p0_downtime')::boolean, true),
      'p1_failover', COALESCE((v_classes ->> 'p1_failover')::boolean, true),
      'p1_stripe',   COALESCE((v_classes ->> 'p1_stripe')::boolean, true),
      'p2_digest',   COALESCE((v_classes ->> 'p2_digest')::boolean, false)
    ),
    'min_severity', v_min_sev,
    'mute_until', v_mute_json,
    'dedupe_window_sec', v_dedupe
  );

  SELECT value INTO v_old_value FROM public.system_config WHERE key = 'alert_settings';

  INSERT INTO public.system_config (key, value)
  VALUES ('alert_settings', v_normalized)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  INSERT INTO public.system_config_audit (config_key, old_value, new_value, changed_by)
  VALUES ('alert_settings', v_old_value, v_normalized, auth.uid());

  RETURN jsonb_build_object('success', true, 'new_config', v_normalized);
END;
$function$;

REVOKE ALL ON FUNCTION public.update_alert_settings(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_alert_settings(jsonb) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.update_alert_settings(jsonb) FROM anon;

COMMENT ON TABLE public.alert_dedupe IS 'Storm-control timestamps for notify-admin edge function. Service-role only.';
COMMENT ON FUNCTION public.get_alert_settings() IS 'Admin-only read of system_config.alert_settings (recipient emails are sensitive).';
COMMENT ON FUNCTION public.update_alert_settings(jsonb) IS 'Admin-only write of alert_settings with validation + system_config_audit.';
