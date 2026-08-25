-- Token usage identity: one row per license (not per twitch_channel).
-- Adds kind = paid | beta | test | orphan so admin money can split
-- testers from purchased keys. Admin-only; revoke anon/public execute.

CREATE OR REPLACE FUNCTION public.get_usage_summary(
  start_time timestamp with time zone DEFAULT NULL,
  end_time timestamp with time zone DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.is_admin IS TRUE
  ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  WITH usage_filtered AS (
    SELECT
      u.license_key,
      u.provider,
      u.model,
      u.prompt_tokens,
      u.completion_tokens,
      u.cost_usd,
      u.twitch_channel,
      u.created_at,
      CASE
        WHEN l.license_key IS NULL THEN 'orphan'
        WHEN lower(coalesce(l.tier, '')) IN ('standard', 'studio') THEN 'paid'
        WHEN lower(coalesce(l.tier, '')) = 'test' THEN 'test'
        ELSE 'beta'
      END AS kind,
      coalesce(l.tier, 'unknown') AS tier,
      l.email
    FROM public.token_usage u
    LEFT JOIN public.licenses l ON l.license_key = u.license_key
    WHERE (start_time IS NULL OR u.created_at >= start_time)
      AND (end_time   IS NULL OR u.created_at <= end_time)
  ),
  per_key AS (
    SELECT
      uf.license_key,
      uf.kind,
      uf.tier,
      uf.email,
      COUNT(*) AS requests,
      SUM(uf.prompt_tokens)::bigint AS prompt_tokens,
      SUM(uf.completion_tokens)::bigint AS completion_tokens,
      (SUM(uf.prompt_tokens) + SUM(uf.completion_tokens))::bigint AS tokens,
      SUM(uf.cost_usd) AS cost,
      (
        array_agg(nullif(btrim(uf.twitch_channel), '') ORDER BY uf.created_at DESC)
        FILTER (WHERE nullif(btrim(uf.twitch_channel), '') IS NOT NULL)
      )[1] AS last_channel,
      COUNT(DISTINCT lower(nullif(btrim(uf.twitch_channel), ''))) AS channel_count
    FROM usage_filtered uf
    GROUP BY uf.license_key, uf.kind, uf.tier, uf.email
  ),
  named AS (
    SELECT
      pk.*,
      COALESCE(
        NULLIF(btrim(pr.twitch_username), ''),
        pk.last_channel,
        left(pk.license_key, 10) || '…'
      ) AS display_name,
      pk.last_channel AS twitch_channel
    FROM per_key pk
    LEFT JOIN public.profiles pr ON lower(pr.email) = lower(pk.email)
  )
  SELECT jsonb_build_object(
    'by_user', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'license_key', n.license_key,
        'kind', n.kind,
        'tier', n.tier,
        'display_name', n.display_name,
        'twitch_channel', n.twitch_channel,
        'channel_count', n.channel_count,
        'requests', n.requests,
        'prompt_tokens', n.prompt_tokens,
        'completion_tokens', n.completion_tokens,
        'tokens', n.tokens,
        'cost', n.cost
      ) ORDER BY n.tokens DESC), '[]'::jsonb)
      FROM named n
    ),
    'by_kind', (
      SELECT COALESCE(jsonb_agg(k ORDER BY k.tokens DESC), '[]'::jsonb)
      FROM (
        SELECT
          n.kind,
          COUNT(*)::bigint AS licenses,
          SUM(n.requests)::bigint AS requests,
          SUM(n.prompt_tokens)::bigint AS prompt_tokens,
          SUM(n.completion_tokens)::bigint AS completion_tokens,
          SUM(n.tokens)::bigint AS tokens,
          SUM(n.cost) AS cost
        FROM named n
        GROUP BY n.kind
      ) k
    ),
    'by_day', (
      SELECT COALESCE(jsonb_agg(d ORDER BY d.day DESC), '[]'::jsonb)
      FROM (
        SELECT
          to_char(date_trunc('day', uf.created_at), 'YYYY-MM-DD') AS day,
          COUNT(*) AS requests,
          (SUM(uf.prompt_tokens) + SUM(uf.completion_tokens))::bigint AS tokens,
          SUM(uf.prompt_tokens)::bigint AS prompt_tokens,
          SUM(uf.completion_tokens)::bigint AS completion_tokens,
          SUM(uf.cost_usd) AS cost,
          SUM(uf.cost_usd) FILTER (WHERE uf.kind = 'paid') AS cost_paid,
          SUM(uf.cost_usd) FILTER (WHERE uf.kind = 'beta') AS cost_beta,
          (SUM(uf.prompt_tokens + uf.completion_tokens) FILTER (WHERE uf.kind = 'paid'))::bigint AS tokens_paid,
          (SUM(uf.prompt_tokens + uf.completion_tokens) FILTER (WHERE uf.kind = 'beta'))::bigint AS tokens_beta
        FROM usage_filtered uf
        GROUP BY date_trunc('day', uf.created_at)
      ) d
    ),
    'by_model', (
      SELECT COALESCE(jsonb_agg(m ORDER BY m.requests DESC), '[]'::jsonb)
      FROM (
        SELECT
          uf.provider,
          uf.model,
          COUNT(*) AS requests,
          SUM(uf.prompt_tokens)::bigint AS prompt_tokens,
          SUM(uf.completion_tokens)::bigint AS completion_tokens,
          (SUM(uf.prompt_tokens) + SUM(uf.completion_tokens))::bigint AS tokens,
          SUM(uf.cost_usd) AS cost,
          SUM(uf.cost_usd) FILTER (WHERE uf.kind = 'paid') AS cost_paid,
          SUM(uf.cost_usd) FILTER (WHERE uf.kind = 'beta') AS cost_beta
        FROM usage_filtered uf
        GROUP BY uf.provider, uf.model
      ) m
    )
  ) INTO result;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_usage_summary(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_usage_summary(timestamptz, timestamptz) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_live_users(integer);

CREATE FUNCTION public.get_live_users(window_minutes integer DEFAULT 10)
RETURNS TABLE(
  twitch_channel text,
  license_key text,
  requests bigint,
  last_seen timestamp with time zone,
  display_name text,
  kind text,
  tier text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.is_admin IS TRUE
  ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH live AS (
    SELECT
      u.license_key,
      COUNT(*) AS requests,
      MAX(u.created_at) AS last_seen,
      (
        array_agg(nullif(btrim(u.twitch_channel), '') ORDER BY u.created_at DESC)
        FILTER (WHERE nullif(btrim(u.twitch_channel), '') IS NOT NULL)
      )[1] AS last_channel,
      CASE
        WHEN l.license_key IS NULL THEN 'orphan'
        WHEN lower(coalesce(l.tier, '')) IN ('standard', 'studio') THEN 'paid'
        WHEN lower(coalesce(l.tier, '')) = 'test' THEN 'test'
        ELSE 'beta'
      END AS kind,
      coalesce(l.tier, 'unknown') AS tier,
      l.email
    FROM public.token_usage u
    LEFT JOIN public.licenses l ON l.license_key = u.license_key
    WHERE u.created_at >= now() - (window_minutes || ' minutes')::interval
    GROUP BY u.license_key, l.license_key, l.tier, l.email
  )
  SELECT
    lv.last_channel,
    lv.license_key,
    lv.requests,
    lv.last_seen,
    COALESCE(
      NULLIF(btrim(pr.twitch_username), ''),
      lv.last_channel,
      left(lv.license_key, 10) || '…'
    ),
    lv.kind,
    lv.tier
  FROM live lv
  LEFT JOIN public.profiles pr ON lower(pr.email) = lower(lv.email)
  ORDER BY lv.last_seen DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_live_users(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_live_users(integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_usage_summary(timestamptz, timestamptz) IS
  'Admin-only usage rollup. One row per license_key. kind=paid|beta|test|orphan.';
COMMENT ON FUNCTION public.get_live_users(integer) IS
  'Admin-only live callers in the last N minutes, one row per license_key.';
