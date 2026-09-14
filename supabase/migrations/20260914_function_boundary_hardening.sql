-- Harden function resolution and remove direct API execution from trigger-only
-- functions. Non-destructive: function bodies and all application data remain.

begin;

alter function public.get_token_usage(timestamptz, timestamptz)
  set search_path = public;
alter function public.tos_versions_block_mutations()
  set search_path = public;
alter function public.virforge_package_identity(text, jsonb)
  set search_path = public;
alter function public.merge_active_r2_into_catalog(jsonb)
  set search_path = public;
alter function public.alwayson_logs_prune()
  set search_path = public;

-- These execute through database triggers, not browser/REST calls. Trigger
-- execution uses the table owner's context and does not need API role grants.
revoke execute on function public.handle_new_user()
  from public, anon, authenticated;
revoke execute on function public.notify_virforge_catalog_updated()
  from public, anon, authenticated;
revoke execute on function public.sync_virforge_catalog_from_r2()
  from public, anon, authenticated;

commit;
