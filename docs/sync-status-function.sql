-- Backtrack: let the nightly Strava sync stamp its health check using the
-- app's public key, so it no longer needs Claude's Supabase connector.
-- Run once in the Supabase dashboard: Backtrack project -> SQL Editor -> Run.
-- (Applied 22 Oct 2026.)

create or replace function public.backtrack_record_sync(p_count integer, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_error is null then
    insert into backtrack_sync_status (id, last_run_at, last_success_at, last_error, last_count)
    values ('strava', now(), now(), null, p_count)
    on conflict (id) do update
      set last_run_at = now(), last_success_at = now(), last_error = null, last_count = excluded.last_count;
  else
    insert into backtrack_sync_status (id, last_run_at, last_error)
    values ('strava', now(), left(p_error, 500))
    on conflict (id) do update
      set last_run_at = now(), last_error = excluded.last_error;
  end if;
end;
$$;

-- explicit grants: only this one function is callable with the public key;
-- the status table itself stays read-only to it
revoke all on function public.backtrack_record_sync(integer, text) from public;
grant execute on function public.backtrack_record_sync(integer, text) to anon, authenticated;
