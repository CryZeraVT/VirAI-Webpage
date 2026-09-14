-- Production security hotfix.
-- Non-destructive: no rows, tables, functions, users, licenses, or objects are deleted.
--
-- Rollback notes:
--   1. Remove r2_storage_config from the public policy exclusion only after
--      replacing it with a non-secret public configuration row.
--   2. Re-grant RPC execution only to the exact role/caller that needs it.
--   3. Restore the old newsletter policies only if non-admin uploads are an
--      intentional product feature and are protected by a separate boundary.

begin;

-- Keep the public catalog/config behavior while making storage credentials
-- unreadable to anonymous and ordinary authenticated clients.
alter policy "Allow public read access to system config"
  on public.system_config
  using (
    key <> all (
      array[
        'ai_api_keys'::text,
        'proxy_ai_provider'::text,
        'studio_ai_provider'::text,
        'builtin_ai_provider'::text,
        'ai_failover_chains'::text,
        'alert_settings'::text,
        'virforge_launcher_r2'::text,
        'r2_storage_config'::text
      ]
    )
  );

-- SECURITY DEFINER quota functions are server internals. PUBLIC must be
-- revoked because anon/authenticated otherwise inherit its EXECUTE grant.
revoke execute on function public.get_token_usage(timestamptz, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.add_boost_tokens(text, bigint)
  from public, anon, authenticated;
revoke execute on function public.increment_token_quota(text, bigint, boolean, bigint)
  from public, anon, authenticated;

grant execute on function public.get_token_usage(timestamptz, timestamptz)
  to service_role;
grant execute on function public.add_boost_tokens(text, bigint)
  to service_role;
grant execute on function public.increment_token_quota(text, bigint, boolean, bigint)
  to service_role;

-- Existing newsletter images remain public/readable. Only the two mutation
-- policies change, preserving the admin workflow while blocking ordinary users.
alter policy "Authenticated users can upload newsletter images"
  on storage.objects
  with check (
    bucket_id = 'newsletter-images'
    and exists (
      select 1
      from public.profiles
      where profiles.id = auth.uid()
        and profiles.is_admin = true
    )
  );

alter policy "Authenticated users can delete newsletter images"
  on storage.objects
  using (
    bucket_id = 'newsletter-images'
    and exists (
      select 1
      from public.profiles
      where profiles.id = auth.uid()
        and profiles.is_admin = true
    )
  );

commit;
