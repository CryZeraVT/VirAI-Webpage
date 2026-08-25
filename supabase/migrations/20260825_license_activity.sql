-- Admin-only: who is running AiRi (licenses.last_seen heartbeat).
-- Complements token_usage, which only fires for built-in proxy AI.

CREATE OR REPLACE FUNCTION public.get_license_activity()
RETURNS jsonb
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

  RETURN (
    WITH rows AS (
      SELECT
        CASE
          WHEN lower(coalesce(l.tier, '')) IN ('standard', 'studio') THEN 'paid'
          WHEN lower(coalesce(l.tier, '')) = 'test' THEN 'test'
          ELSE 'beta'
        END AS kind,
        coalesce(l.tier, 'unknown') AS tier,
        l.last_seen,
        COALESCE(NULLIF(btrim(pr.twitch_username), ''), left(l.license_key, 10) || '…') AS display_name,
        CASE
          WHEN l.last_seen IS NULL THEN 'never'
          WHEN l.last_seen >= now() - interval '2 hours' THEN 'online'
          WHEN l.last_seen >= now() - interval '24 hours' THEN 'today'
          WHEN l.last_seen >= now() - interval '7 days' THEN 'week'
          WHEN l.last_seen >= now() - interval '30 days' THEN 'month'
          ELSE 'stale'
        END AS recency
      FROM public.licenses l
      LEFT JOIN public.profiles pr ON lower(pr.email) = lower(l.email)
      WHERE l.status = 'active'
    )
    SELECT jsonb_build_object(
      'online_2h',  (SELECT count(*) FROM rows WHERE recency = 'online'),
      'seen_24h',   (SELECT count(*) FROM rows WHERE recency IN ('online', 'today')),
      'seen_7d',    (SELECT count(*) FROM rows WHERE recency IN ('online', 'today', 'week')),
      'seen_30d',   (SELECT count(*) FROM rows WHERE recency IN ('online', 'today', 'week', 'month')),
      'never_seen', (SELECT count(*) FROM rows WHERE recency = 'never'),
      'rows', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'kind', r.kind,
          'tier', r.tier,
          'display_name', r.display_name,
          'last_seen', r.last_seen,
          'recency', r.recency
        ) ORDER BY r.last_seen DESC NULLS LAST), '[]'::jsonb)
        FROM rows r
      )
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_license_activity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_license_activity() TO authenticated, service_role;

COMMENT ON FUNCTION public.get_license_activity() IS
  'Admin-only. Who is running AiRi via licenses.last_seen (heartbeat), not only built-in AI.';
