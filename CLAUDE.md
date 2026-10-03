# Backtrack

Personal back-pain and rehab diary (L5/S1). Used daily from Nat's iPhone home
screen.

- Live: https://nwebb16.github.io/backtrack/
- Repo: https://github.com/nwebb16/backtrack (branch `main`)

## How Nat wants to work

- **Before writing any code, settle three things with Nat: where it runs, where
  the data lives, and how it deploys.** Hours have been lost building first and
  hitting an architecture problem later. If asked to start coding before those
  are clear, push back and settle them first.
- Plain English, short bullet summaries. Make changes in small rounds that can
  be tested on the phone between rounds.

## Architecture

| | |
|---|---|
| **Runs** | Static page on GitHub Pages, opened from the iPhone home screen (Safari → Add to Home Screen). |
| **Data** | Supabase project `fmmltsrmyhxtmqseuxck` (Postgres). |
| **Deploy** | Push to `main`. Pages rebuilds in about a minute. No build step, no CI. |

- Everything is in one self-contained `index.html`: CSS, markup and JS inline.
  No bundler, no npm, no framework.
- `supabase-js` v2 loads from jsDelivr (`@supabase/supabase-js@2`, not pinned
  to a minor version).
- The publishable (anon) key is embedded in `index.html`. That's intended: it
  is a publishable key, not a secret. Never embed a service-role / secret key.
- There is no login. Both tables have RLS on, but the policies allow
  everything (`ALL`, `using true`) for everyone. Anyone with the page URL can
  read, change or delete the diary. This is a known trade-off. Don't
  tighten it without a plan for how the app and the Strava sync will
  authenticate.
- `manifest.json`, `icon-192.png`, `icon-512.png` and the `apple-*` meta tags
  give the home-screen icon and standalone display. Keep paths relative (the
  site is served under `/backtrack/`).

### Don't move it back to a Claude Artifact

It started as one. The iPhone home-screen icon can never work there, because
Artifacts serve the app in an iframe under a wrapper page. It stays on GitHub
Pages.

## Data model

**The split (agreed 3 Oct 2026):** anything that changes through the day is a
**check-in**. Whole-day facts go in the **nightly entry**. Don't add
in-the-moment things (triggers, timing, meds) back onto the day row.

### `backtrack_checkins`: many per day

`id`, `entry_date`, `taken_at` (timestamptz, written as `<date>T<hh:mm>:00+10:00`;
Brisbane has no daylight saving), `pain_score` 0–10, `stiffness_score` 0–10,
`context` ("what are you doing", one trigger key or null), `note`,
`cause_triggers` text[] + `cause_other_text` + `cause_when`
(`earlier-today` | `yesterday` | `2-plus-days`) for "Think it's from something
earlier?", `med_taken` / `med_name` / `med_dose`, and
`kind` (`checkin` | `bedtime`; a unique index allows one bedtime per day).

- Saved **immediately** from the sheet (insert or, when a row is tapped, update).
- The nightly **"How is it now?"** sliders are the `bedtime` check-in, saved
  when Nat taps Save entry (`saveBedtime`, then the entry upsert).
- **A day's pain/stiffness = the peak of its check-ins.** The peak drives
  triggers; averages are deliberately not used, because they depend on how
  often Nat checks in. Save entry also writes the peak to `backtrack_entries`.
- It's a separate table on purpose: a 5am check-in must not create a
  `backtrack_entries` row (pain_score defaults to 0).

### `backtrack_entries`: one row per day, PK `date` (whole-day facts)

**Written now:** `date`, `activity_impact` (`none` | `modified` | `skipped`),
`activity_impact_note`, `rehab_session_done`, `rehab_notes`, `stretch_done`,
`office_hours`, `sitting_breaks`, `sleep_hours`, `notes`, `updated_at`, plus
`pain_score` / `stiffness_score` = the check-in peak when there are check-ins.
Saved with `upsert(..., {onConflict: "date"})`. Only the columns in
`docToEntryRow` are sent, so the others are never touched.

**Legacy, read-only** (from before 3 Oct 2026; the report still counts them):
`pain_triggers`, `pain_trigger_other_text`, `pain_timing`, `delayed_onset`,
`delayed_onset_note`, `delayed_triggers`, `delayed_trigger_other_text`,
`delayed_days_ago`, `medication_*`. Never write these, or re-saving an old day
would wipe its history.

**Unused:** `stiffness_timing`, `stiffness_eased` (existed for one day),
and `sleep_asleep_min`, `sleep_deep_min`, `sleep_rem_min`, `sleep_core_min`,
`sleep_in_bed_min`, `sleep_start`, `sleep_end`, `sleep_source` (an abandoned
Garmin idea). The planned Apple Health sleep import should get its **own
`backtrack_sleep` table**.

**Scores by date** (`refreshAllEntries`, constant `CHECKIN_START = 2026-10-03`):
- Days with check-ins use the check-in peak.
- Days before `CHECKIN_START` use their single nightly `pain_score`.
- Later days with no check-ins are "logged, not rated" (null; no calendar colour).
- Check-in-only days (no saved entry) still count.

### Trigger keys

Shared by check-in `context`, `cause_triggers` and the legacy columns: `sleep`,
`ride`, `run`, `swim`, `gym`, `office-chair` ("Sitting at work"),
`lounge-laptop`, `yard-work`, `other` (+ free text). `office-chair` is
deliberately work sitting only. Nat is testing whether long workdays are a
trigger. The report tally skips `sleep` as a *context*, but counts it as a
*cause*. Text enums have no DB check constraints, so options can be tweaked
without a migration.

### `backtrack_activities`: one row per activity

Columns used: `id`, `entry_date`, `source` (`strava` | `manual`), `type`,
`name`, `duration_min`, `distance_km`, `notes`, `created_at`.
`strava_activity_id` is the unique dedupe key for Strava rows. Rows are written
immediately (insert on Add, delete on ×).

### Strava sync (outside this repo)

A nightly **Claude scheduled task** (not on Nat's Windows machine's local
scheduled tasks; it runs elsewhere, so its prompt isn't visible from here) syncs Strava activities into
`backtrack_activities` at **7pm Brisbane**, using `strava_activity_id` to
dedupe. **Don't change the table shape (rename/drop columns, change the
dedupe key or `source` values) without updating that task too.**

While today's entry is open, the app polls every 45s and merges in any new
`source = 'strava'` rows without touching what's being typed.

## Code map (`index.html`)

- `rowToDoc` / `docToEntryRow` / `activityRowToObj`: the only place DB
  snake_case is mapped to the app's camelCase "doc". Add new day fields here
  and in `defaultDoc`, `renderForm`, `collectDoc`.
- Check-ins: `openCheckin(c)` (null = new), `saveCheckin`, `renderCheckins`,
  `renderWorst`, `makeCause(host, prefix)` (the "from something earlier?"
  block, used in the sheet and the bedtime card), `saveBedtime`.
- `loadEntry` (one day + activities + check-ins), `startTodayPoll`,
  `refreshAllEntries` (all entries + activity counts + check-in peaks; drives
  Trends, calendar and Report).
- `renderTrends` → `renderTiles`, `renderChart` (hand-built SVG),
  `renderHistory` (month calendar), `renderReport` (week/month/90d stats,
  trigger tally against high-pain days ≥ `HIGH_PAIN_THRESHOLD` = 6).

Conventions:
- ES5 style: `var`, `function`, IIFE, `"use strict"`, no modules or arrow
  functions. Match it.
- Dates are `YYYY-MM-DD` strings in **Australia/Brisbane** (`todayId()`). No
  logging into the future.
- Colours are CSS tokens on `:root`, with dark-mode overrides in both
  `prefers-color-scheme` and `[data-theme="dark"]`. Pain bands: 0–3 good,
  4–6 warn, 7–10 critical.
- Use `textContent` for user-entered text (some report HTML is built with
  string concatenation, so escape anything user-entered before it goes in).

## Supabase gotchas

- The Supabase MCP connector's `execute_sql` runs as a **read-only** database
  user. Use it for `SELECT` only. **All writes and schema changes go through
  `apply_migration`.**
- There's only one database, the live one. Testing the page locally (e.g. a
  static server on `index.html`) reads and writes **real diary data**. Test
  saves on a dummy date like `2000-01-01` (pick it in the date box; the app
  blocks future dates), then delete that row via `apply_migration`.

## Testing

No automated tests. Check changes by serving the folder locally and loading
`index.html` at phone width (375px), then on the iPhone after deploy.
Home-screen apps can cache the old version: close and reopen the app to pick
up a new deploy.

## Open items (as of 3 Oct 2026, night)

- **Round 2 (reporting):**
  - Per day: peak, end of day (bedtime) and next morning (first check-in the
    following day).
  - Per-activity averages from check-in `context` ("Running avg pain 7 over 6
    check-ins").
  - Recovery: peak → bedtime. Medication effect: pain at the next check-in
    after `med_taken`.
  - Automatic Strava look-back at the 1–2 days before bad mornings.
  - Stiffness line on the chart, plus tiles for avg stiffness,
    stiff-but-pain-free days and days limited.
- **Round 3:** Apple Health sleep. Nat says Garmin Connect already feeds Apple
  Health. Next: check Health → Browse → Sleep for stages vs total only.
  Before this round, decide whether to add a lock (no login today).
- **Maybe:** a faster check-in via an iPhone Shortcut (Action button / Back
  Tap) or a `?checkin` URL that opens the sheet directly.
- **Parked:** tidying the legacy Other texts ("Laptop & lounge" etc.). Less
  important now that triggers live in check-ins.
- Check: no Strava activity synced for Fri 2 Oct. Confirm whether Nat did one.
