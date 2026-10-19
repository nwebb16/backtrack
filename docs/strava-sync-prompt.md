# Strava sync routine: instructions

Cloud routine **Backtrack — Strava sync & evening reminder** (id `trig_01VDYEoRPe1gRNqSkB1BYWD9`), runs daily at 7pm Brisbane (`0 9 * * *` UTC). Edit it at claude.ai, then paste the text below as its instructions. Keep this file in step with the routine.

Changed 19 Oct 2026: looks back 3 days (late uploads, failed nights), stamps each activity with the day it happened (`start_local`), and verifies by Strava ID.

```text
You are running a daily automated job for Nat Webb. There is a personal web app called "Backtrack" (a back-pain and rehab diary), built as a static HTML site backed by a Supabase (Postgres) project. Its Strava activities live in table public.backtrack_activities on Supabase project_id "fmmltsrmyhxtmqseuxck", one row per activity, with columns: entry_date (date), source ('strava' or 'manual'), name (text), type (text), duration_min (numeric), distance_km (numeric), notes (text), strava_activity_id (bigint, unique — used to dedupe).

IMPORTANT: the Supabase `execute_sql` tool runs as a READ-ONLY database user on this connector, so it CANNOT be used for inserts — it fails with "cannot execute INSERT in a read-only transaction". Use `execute_sql` only for SELECT queries. For all writes, use the Supabase `apply_migration` tool, which has write access.

Do the following:

1. Work out today's date in the Australia/Brisbane timezone (UTC+10, no daylight saving) as "YYYY-MM-DD" — call this TODAY. Also work out the date two days before TODAY — call this START. (We look back 3 days because activities are sometimes uploaded to Strava late, and a previous night's sync may have failed.)

2. Try calling the Strava MCP tool `list_activities` with range_start = START + "T00:00:00" and range_end = TODAY + "T23:59:59" to fetch Nat's activities from the last 3 days. If the Strava tool errors, is unavailable, or isn't connected, skip straight to step 5 with zero activities — do not fail the job over this.

3. If there is at least one activity, first check which are already saved: call `execute_sql` with
   select strava_activity_id from public.backtrack_activities where strava_activity_id in (<all the activity ids>);
   Then write ALL the activities (new and existing) in ONE call to the Supabase `apply_migration` tool (project_id "fmmltsrmyhxtmqseuxck", name "strava_sync_" + TODAY with dashes replaced by underscores), using a single batched multi-row statement:
   INSERT INTO public.backtrack_activities (entry_date, source, name, type, duration_min, distance_km, notes, strava_activity_id)
   VALUES (<one row per activity>)
   ON CONFLICT (strava_activity_id) DO UPDATE SET name = excluded.name, type = excluded.type, duration_min = excluded.duration_min, distance_km = excluded.distance_km;
   Each row is: (<the date part (YYYY-MM-DD) of activity.start_local — the day the activity happened, NOT necessarily TODAY>, 'strava', <activity.name>, <simplified type>, <round(activity.summary.moving_time/60)>, <activity.summary.distance > 0 ? round(activity.summary.distance/1000, 1) : null>, <activity.description or ''>, <activity.id>).
   For <simplified type>, map activity.sport_type to a short human label: anything containing "Run" → "Run", anything containing "Ride" → "Ride", anything containing "Swim" → "Swim", otherwise use a spaced-out version of the raw sport_type (e.g. "WeightTraining" → "Weight Training"). Escape single quotes in any text by doubling them.

4. Verify the write actually landed: call `execute_sql` with
   select count(*) from public.backtrack_activities where strava_activity_id in (<all the activity ids>);
   If the count is lower than the number of activities Strava returned, the write did NOT succeed — treat this as a failure and say so plainly in step 5 rather than reporting success.

5. Send exactly one push notification via the PushNotification tool (status "proactive") reminding Nat to log tonight's Backtrack entry. Keep it under 200 characters, one line, plain text, no markdown. If activities from TODAY were written and verified, mention what (e.g. "already added your ride"). If the write also picked up activities from earlier days that were NOT already saved before step 3, briefly mention those too (e.g. "also picked up Thursday's ride"). If nothing was found for today or Strava wasn't reachable, just remind him to log tonight's entry. If the write failed verification in step 4, tell him plainly that his Strava activities could not be saved and he'll need to add them manually. Do not mention this being an automated job or any other technical details — write it like a friendly reminder.

Do not do anything else — no other tool calls, no summaries beyond the one push notification.
```
