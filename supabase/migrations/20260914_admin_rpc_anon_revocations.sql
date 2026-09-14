-- Keep authenticated account/admin RPCs available while removing anonymous
-- API execution. Each function also performs its own auth/admin check.

begin;

revoke execute on function public.accept_tos(text)
  from public, anon;
grant execute on function public.accept_tos(text)
  to authenticated;

revoke execute on function public.update_beta_renewal_config(jsonb)
  from public, anon;
grant execute on function public.update_beta_renewal_config(jsonb)
  to authenticated;

revoke execute on function public.update_tier_limits(jsonb, boolean)
  from public, anon;
grant execute on function public.update_tier_limits(jsonb, boolean)
  to authenticated;

commit;
