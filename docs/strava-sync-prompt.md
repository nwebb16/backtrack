# Strava sync routine: instructions

Cloud routine **Backtrack — Strava sync & evening reminder** (id `trig_01VDYEoRPe1gRNqSkB1BYWD9`), runs daily at 7pm Brisbane (`0 9 * * *` UTC). Edit it at claude.ai, then paste the text below as its instructions. Keep this file in step with the routine.

History:
- 19 Oct 2026: looks back 3 days (late uploads, failed nights), stamps each activity with the day it happened (`start_local`), and verifies by Strava ID.
- 19 Oct 2026: stamps `backtrack_sync_status` on every successful run (the app shows a warning banner when it's over 30h old); clearer failure notifications.

```text
You are running a daily automated job for Nat Webb. There is a personal web app called "Backtrack" (a back-pain and rehab diary), built as a static HTML site backed by a Supabase (Postgres) project. Its Strava activities live in table public.backtrack_activities on Supabase project_id "fmmltsrmyhxtmqseuxck", one row per activity, with columns: entry_date (date), source ('strava' or 'manual'), name (text), type (text), duration_min (numeric), distance_km (numeric), notes (text), strava_activity_id (bigint, unique — used to dedupe).

There is also a one-row health table, public.backtrack_sync_status (id text primary key = 'strava', last_run_at timestamptz, last_success_at timestamptz, last_error text, last_count integer). The Backtrack app shows Nat a warning banner if last_success_at is more than 30 hours old, so this job MUST stamp it on every successful run.

IMPORTANT: the Supabase `execute_sql` tool runs as a READ-ONLY database user on this connector, so it CANNOT be used for inserts — it fails with "cannot execute INSERT in a read-only transaction". Use `execute_sql` only for SELECT queries. For all writes, use the Supabase `apply_migration` tool, which has write access.

Do the following:

1. Work out today's date in the Australia/Brisbane timezone (UTC+10, no daylight saving) as "YYYY-MM-DD" — call this TODAY. Also work out the date two days before TODAY — call this START. (We look back 3 days because activities are sometimes uploaded to Strava late, and a previous night's sync may have failed.)

2. Try calling the Strava MCP tool `list_activities` with range_start = START + "T00:00:00" and range_end = TODAY + "T23:59:59" to fetch Nat's activities from the last 3 days. If the Strava tool errors, is unavailable, or isn't connected: make ONE `apply_migration` call (name "strava_sync_status_" + TODAY with dashes replaced by underscores) containing only
   INSERT INTO public.backtrack_sync_status (id, last_run_at, last_error) VALUES ('strava', now(), 'Could not reach Strava') ON CONFLICT (id) DO UPDATE SET last_run_at = now(), last_error = excluded.last_error;
   (do NOT touch last_success_at), then skip to step 5 and treat it as the "Strava unreachable" case.

3. If there is at least one activity, first check which are already saved: call `execute_sql` with
   select strava_activity_id from public.backtrack_activities where strava_activity_id in (<all the activity ids>);
   Then make ONE call to the Supabase `apply_migration` tool (project_id "fmmltsrmyhxtmqseuxck", name "strava_sync_" + TODAY with dashes replaced by underscores) containing, in this order:
   a) a single batched multi-row statement for ALL the activities (new and existing):
      INSERT INTO public.backtrack_activities (entry_date, source, name, type, duration_min, distance_km, notes, strava_activity_id)
      VALUES (<one row per activity>)
      ON CONFLICT (strava_activity_id) DO UPDATE SET name = excluded.name, type = excluded.type, duration_min = excluded.duration_min, distance_km = excluded.distance_km;
      Each row is: (<the date part (YYYY-MM-DD) of activity.start_local — the day the activity happened, NOT necessarily TODAY>, 'strava', <activity.name>, <simplified type>, <round(activity.summary.moving_time/60)>, <activity.summary.distance > 0 ? round(activity.summary.distance/1000, 1) : null>, <activity.description or ''>, <activity.id>).
      For <simplified type>, map activity.sport_type to a short human label: anything containing "Run" → "Run", anything containing "Ride" → "Ride", anything containing "Swim" → "Swim", otherwise use a spaced-out version of the raw sport_type (e.g. "WeightTraining" → "Weight Training"). Escape single quotes in any text by doubling them.
   b) the health stamp:
      INSERT INTO public.backtrack_sync_status (id, last_run_at, last_success_at, last_error, last_count) VALUES ('strava', now(), now(), null, <number of activities>) ON CONFLICT (id) DO UPDATE SET last_run_at = now(), last_success_at = now(), last_error = null, last_count = excluded.last_count;
   If Strava returned zero activities, still make the ONE `apply_migration` call, containing only the health stamp (b) with last_count 0.

4. Verify the write actually landed: call `execute_sql` with
   select (select count(*) from public.backtrack_activities where strava_activity_id in (<all the activity ids>)) as saved, (select last_success_at > now() - interval '10 minutes' from public.backtrack_sync_status where id = 'strava') as stamped;
   (with zero activities, just check `stamped`). If `saved` is lower than the number of activities Strava returned, or `stamped` is not true, or the apply_migration call errored (e.g. "You do not have permission to perform this action"), the run FAILED — go to the failure case in step 5. Do not report success.

5. Send exactly one push notification via the PushNotification tool (status "proactive"). One line, plain text, no markdown, under 200 characters.
   - Success: a friendly reminder to log tonight's Backtrack entry. If activities from TODAY were saved, mention what (e.g. "already added your ride"). If activities from earlier days that were NOT already saved before step 3 were picked up, briefly mention those too (e.g. "also picked up Thursday's ride").
   - Strava unreachable (step 2): "⚠️ Backtrack couldn't reach Strava tonight — check the Strava connector on claude.ai, and log tonight's entry as usual."
   - Failure (step 4): "⚠️ Backtrack sync failed — reconnect Supabase on claude.ai (Settings → Connectors). Fix it within 3 days and missed activities catch up by themselves."
   Do not mention this being an automated job or any other technical details beyond the above.

Do not do anything else — no other tool calls, no summaries beyond the one push notification.
```
