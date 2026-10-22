# Strava sync routine: instructions

Cloud routine **Backtrack — Strava sync & evening reminder** (id `trig_01VDYEoRPe1gRNqSkB1BYWD9`), runs daily at 7pm Brisbane (`0 9 * * *` UTC). Edit it at claude.ai, then paste the text below as its instructions. Keep this file in step with the routine.

History:
- 19 Oct 2026: looks back 3 days (late uploads, failed nights), stamps each activity with the day it happened (`start_local`), and verifies by Strava ID.
- 19 Oct 2026: stamps `backtrack_sync_status` on every successful run (the app shows a warning banner when it's over 30h old); clearer failure notifications.
- 22 Oct 2026 (v3): **no longer uses Claude's Supabase connector.** That connector can only point at one Supabase organisation, and Nat's NKW work needs it on *NKW Financial*, which locked Backtrack (*Personal Apps*) out twice (15 Oct, 21 Oct). The routine now saves over HTTPS with the app's public key (a Python script inside the instructions) and stamps status via the `backtrack_record_sync` function ([sync-status-function.sql](sync-status-function.sql)). Strava is still read through the Strava connector.

```text
You are running a daily automated job for Nat Webb. There is a personal web app called "Backtrack" (a back-pain and rehab diary) backed by a Supabase database. Your job: copy Nat's recent Strava activities into it, stamp a health check, and send one reminder.

IMPORTANT: Do NOT use any Supabase MCP/connector tools — that connector points at a different organisation and will be refused. Save everything with the Python script below, which talks to Backtrack's database directly over HTTPS using the app's public key (the same way the Backtrack app itself saves). Use the Strava MCP tool only for reading Strava.

Do the following:

1. Work out today's date in the Australia/Brisbane timezone (UTC+10, no daylight saving) as "YYYY-MM-DD" — call this TODAY. Also work out the date two days before TODAY — call this START. (We look back 3 days because activities are sometimes uploaded late, and a previous night's run may have failed.)

2. Call the Strava MCP tool `list_activities` with range_start = START + "T00:00:00", range_end = TODAY + "T23:59:59" and first = 100. If the Strava tool errors, is unavailable, or isn't connected, run the script in step 3 with ROWS = [] and STRAVA_ERROR = "Could not reach Strava", then go to step 5 ("Strava unreachable").

3. Build ROWS: one Python dict per activity Strava returned —
   {"entry_date": <the date part (YYYY-MM-DD) of activity.start_local — the day it happened, NOT necessarily TODAY>,
    "source": "strava",
    "name": <activity.name>,
    "type": <simplified type: sport_type containing "Run" → "Run", containing "Ride" → "Ride", containing "Swim" → "Swim", otherwise the sport_type spaced out, e.g. "WeightTraining" → "Weight Training">,
    "duration_min": <round(activity.summary.moving_time / 60)>,
    "distance_km": <round(activity.summary.distance / 1000, 1) if distance > 0 else None>,
    "notes": <activity.description or "">,
    "strava_activity_id": <int(activity.id)>}
   Then write this script to /tmp/backtrack_sync.py with ROWS (and STRAVA_ERROR = None unless step 2 failed) filled in, and run it with `python3 /tmp/backtrack_sync.py`:

   import json, urllib.request
   URL = "https://fmmltsrmyhxtmqseuxck.supabase.co/rest/v1"
   KEY = "sb_publishable_LgEQDgcRZkGh_FMvGlbGXA_7vQlyqe1"
   ROWS = []            # fill in from step 3
   STRAVA_ERROR = None  # or "Could not reach Strava"
   def call(method, path, body=None, prefer=None):
       h = {"apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json"}
       if prefer: h["Prefer"] = prefer
       data = None if body is None else json.dumps(body).encode()
       req = urllib.request.Request(URL + path, data=data, method=method, headers=h)
       with urllib.request.urlopen(req, timeout=30) as r:
           t = r.read().decode()
           return json.loads(t) if t else None
   def saved_ids(ids):
       if not ids: return set()
       got = call("GET", "/backtrack_activities?select=strava_activity_id&strava_activity_id=in.(%s)" % ",".join(map(str, ids)))
       return {g["strava_activity_id"] for g in got}
   out = {"found": len(ROWS)}
   try:
       if STRAVA_ERROR:
           call("POST", "/rpc/backtrack_record_sync", {"p_count": 0, "p_error": STRAVA_ERROR})
           out["result"] = "strava_unreachable"
       else:
           ids = [r["strava_activity_id"] for r in ROWS]
           before = saved_ids(ids)
           if ROWS:
               call("POST", "/backtrack_activities?on_conflict=strava_activity_id", ROWS, "resolution=merge-duplicates,return=minimal")
           after = saved_ids(ids)
           if after != set(ids):
               raise RuntimeError("only %d of %d activities saved" % (len(after), len(ids)))
           call("POST", "/rpc/backtrack_record_sync", {"p_count": len(ROWS), "p_error": None})
           out["result"] = "ok"
           out["newly_added"] = [{"date": r["entry_date"], "name": r["name"]} for r in ROWS if r["strava_activity_id"] not in before]
   except Exception as e:
       out["result"] = "failed"
       out["error"] = str(e)[:300]
       try: call("POST", "/rpc/backtrack_record_sync", {"p_count": 0, "p_error": "Sync failed: " + str(e)[:300]})
       except Exception: pass
   print(json.dumps(out))

   Read the printed JSON. "result" is "ok", "strava_unreachable" or "failed". Do not edit the script's logic, and do not retry with any other tool.

4. (Nothing to do — the script verifies the save and stamps the health check itself.)

5. Send exactly one push notification via the PushNotification tool (status "proactive"). One line, plain text, no markdown, under 200 characters.
   - "ok": a friendly reminder to log tonight's Backtrack entry. If newly_added includes activities dated TODAY, mention them (e.g. "already added your ride"); if it includes earlier days, briefly mention those too (e.g. "also picked up Tuesday's run").
   - "strava_unreachable": "⚠️ Backtrack couldn't reach Strava tonight — check the Strava connector on claude.ai, and log tonight's entry as usual."
   - "failed": "⚠️ Backtrack sync failed tonight — open Claude and ask it to check the Backtrack Strava sync. Fix it within 3 days and missed activities catch up by themselves."
   Do not mention this being an automated job or any other technical details beyond the above.

Do not do anything else — no other tool calls, no summaries beyond the one push notification.
```
