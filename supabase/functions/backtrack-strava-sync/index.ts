// Backtrack: Strava -> backtrack_activities sync, run by Supabase itself
// (pg_cron calls this twice a day). No Claude connectors involved.
//
// Secrets (Supabase dashboard -> Edge Functions -> Secrets), entered by Nat:
//   STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, and STRAVA_AUTH_CODE (one-time code
//   from approving the app; only used until the first refresh token is saved).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// Deployed with "Verify JWT" OFF so pg_cron can call it without a key. That's
// safe: all it can do is re-sync Nat's own Strava data, and it refuses to run
// more than once every 5 minutes.
import { createClient } from "npm:@supabase/supabase-js@2";

const LOOKBACK_DAYS = 7;
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Same labels the old sync used: Run / Ride / Swim, otherwise "WeightTraining" -> "Weight Training"
function simpleType(t: string): string {
  if (t.includes("Run")) return "Run";
  if (t.includes("Ride")) return "Ride";
  if (t.includes("Swim")) return "Swim";
  return t.replace(/([a-z])([A-Z])/g, "$1 $2");
}

// Strava access tokens last ~6 hours and refresh tokens rotate, so the latest
// pair is kept in backtrack_strava_auth (readable only by this function).
async function stravaToken(): Promise<string> {
  const clientId = Deno.env.get("STRAVA_CLIENT_ID");
  const clientSecret = Deno.env.get("STRAVA_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET not set in Supabase secrets");

  const { data: row, error: readErr } = await sb.from("backtrack_strava_auth").select("*").eq("id", 1).maybeSingle();
  if (readErr) throw new Error("Couldn't read saved Strava login: " + readErr.message);
  if (row?.access_token && Number(row.expires_at) > Date.now() / 1000 + 300) return row.access_token;

  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });
  if (row?.refresh_token) {
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", row.refresh_token);
  } else {
    const code = Deno.env.get("STRAVA_AUTH_CODE");
    if (!code) throw new Error("No saved Strava login and no STRAVA_AUTH_CODE secret");
    body.set("grant_type", "authorization_code");
    body.set("code", code);
  }
  const r = await fetch("https://www.strava.com/oauth/token", { method: "POST", body });
  const j = await r.json();
  if (!r.ok) throw new Error("Strava login failed (" + r.status + "): " + JSON.stringify(j).slice(0, 200));

  const { error: saveErr } = await sb.from("backtrack_strava_auth").upsert({
    id: 1, access_token: j.access_token, refresh_token: j.refresh_token,
    expires_at: j.expires_at, updated_at: new Date().toISOString(),
  });
  if (saveErr) throw new Error("Couldn't save Strava login: " + saveErr.message);
  return j.access_token;
}

Deno.serve(async () => {
  try {
    const { data: st } = await sb.from("backtrack_sync_status").select("last_run_at").eq("id", "strava").maybeSingle();
    if (st?.last_run_at && Date.now() - Date.parse(st.last_run_at) < 5 * 60 * 1000) {
      return reply({ result: "skipped", reason: "ran less than 5 minutes ago" });
    }

    const token = await stravaToken();
    const auth = { Authorization: "Bearer " + token };
    const after = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
    const r = await fetch(`https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=100`, { headers: auth });
    if (!r.ok) throw new Error("Strava activities request failed (" + r.status + ")");
    const acts: any[] = await r.json();

    const ids = acts.map((a) => a.id);
    const existing = new Map<number, string>();
    if (ids.length) {
      const { data, error } = await sb.from("backtrack_activities").select("strava_activity_id,notes").in("strava_activity_id", ids);
      if (error) throw new Error("Couldn't read saved activities: " + error.message);
      for (const e of data ?? []) existing.set(Number(e.strava_activity_id), e.notes ?? "");
    }

    const rows = [];
    for (const a of acts) {
      let notes = existing.get(a.id) ?? "";
      if (!existing.has(a.id)) {
        // the description only comes with the full activity, so fetch it for new ones
        const d = await fetch(`https://www.strava.com/api/v3/activities/${a.id}`, { headers: auth });
        if (d.ok) notes = (await d.json()).description || "";
      }
      rows.push({
        entry_date: String(a.start_date_local).slice(0, 10), // the day it happened, local time
        source: "strava",
        name: a.name,
        type: simpleType(a.sport_type || a.type || ""),
        duration_min: Math.round(a.moving_time / 60),
        distance_km: a.distance > 0 ? Math.round(a.distance / 100) / 10 : null,
        notes,
        strava_activity_id: a.id,
      });
    }

    if (rows.length) {
      const { error } = await sb.from("backtrack_activities").upsert(rows, { onConflict: "strava_activity_id" });
      if (error) throw new Error("Couldn't save activities: " + error.message);
    }
    const { error: stampErr } = await sb.rpc("backtrack_record_sync", { p_count: rows.length, p_error: null });
    if (stampErr) throw new Error("Saved, but couldn't stamp the health check: " + stampErr.message);

    const added = rows.filter((x) => !existing.has(x.strava_activity_id)).map((x) => x.entry_date + " " + x.name);
    return reply({ result: "ok", found: rows.length, added });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 300);
    await sb.rpc("backtrack_record_sync", { p_count: 0, p_error: msg });
    return reply({ result: "failed", error: msg }, 500);
  }
});
