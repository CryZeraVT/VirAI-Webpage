-- Atomic fixed-window limits for public Edge Functions.
-- No existing data is changed or deleted.

begin;

create table if not exists public.edge_rate_limits (
  endpoint text not null,
  key_hash text not null,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 1 check (request_count > 0),
  primary key (endpoint, key_hash)
);

alter table public.edge_rate_limits enable row level security;
revoke all on table public.edge_rate_limits from public, anon, authenticated;
grant all on table public.edge_rate_limits to service_role;

create or replace function public.consume_edge_rate_limit(
  p_endpoint text,
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if length(trim(coalesce(p_endpoint, ''))) = 0
     or length(trim(coalesce(p_key_hash, ''))) < 32
     or p_limit < 1
     or p_window_seconds < 1 then
    raise exception 'invalid rate-limit arguments';
  end if;

  insert into public.edge_rate_limits (
    endpoint,
    key_hash,
    window_started_at,
    request_count
  )
  values (p_endpoint, p_key_hash, now(), 1)
  on conflict (endpoint, key_hash) do update
  set
    window_started_at = case
      when edge_rate_limits.window_started_at
        <= now() - make_interval(secs => p_window_seconds)
      then now()
      else edge_rate_limits.window_started_at
    end,
    request_count = case
      when edge_rate_limits.window_started_at
        <= now() - make_interval(secs => p_window_seconds)
      then 1
      else edge_rate_limits.request_count + 1
    end
  returning request_count into v_count;

  return v_count <= p_limit;
end;
$$;

revoke execute on function public.consume_edge_rate_limit(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_edge_rate_limit(text, text, integer, integer)
  to service_role;

commit;
