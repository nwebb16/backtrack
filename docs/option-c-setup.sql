-- Backtrack Option C: Supabase syncs Strava itself (no Claude involved).
-- Run once in the Supabase dashboard: Backtrack project -> SQL Editor -> Run.

-- scheduler + outbound web requests from the database
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- private home for the Strava login (only the sync function can read it)
create table if not exists public.backtrack_strava_auth (
  id integer primary key default 1 check (id = 1),
  access_token text,
  refresh_token text,
  expires_at bigint,
  updated_at timestamptz default now()
);
alter table public.backtrack_strava_auth enable row level security;
revoke all on public.backtrack_strava_auth from anon, authenticated;
grant select, insert, update on public.backtrack_strava_auth to service_role;

-- explicit grants for the sync function (runs as service_role)
grant select, insert, update on public.backtrack_activities to service_role;
grant select on public.backtrack_sync_status to service_role;
grant execute on function public.backtrack_record_sync(integer, text) to service_role;

-- run the sync at 7:05am and 7:05pm Brisbane (21:05 and 09:05 UTC)
select cron.unschedule(jobid) from cron.job where jobname = 'backtrack-strava-sync';
select cron.schedule(
  'backtrack-strava-sync',
  '5 9,21 * * *',
  $$
  select net.http_post(
    url := 'https://fmmltsrmyhxtmqseuxck.supabase.co/functions/v1/backtrack-strava-sync',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
