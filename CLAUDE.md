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

### `backtrack_entries`: one row per day, PK `date`

Columns the app reads and writes: `date`, `pain_score` (0–10),
`pain_triggers` (array of trigger keys, see below), `pain_trigger_other_text`,
`pain_timing` (`morning` | `evening` | `consistent` | `variable` | null),
`delayed_onset`, `delayed_onset_note`, `rehab_session_done`, `rehab_notes`,
`stretch_done`, `office_hours`, `sitting_breaks`, `sleep_hours`,
`medication_taken`, `medication_name`, `medication_dose`, `medication_helped`
(`yes` | `no` | `unsure` | null), `notes`, `updated_at`.

Added Oct 2026 (all nullable, so older days read as "not recorded"):
- `stiffness_score` (0–10, **null = not recorded**, never coerce to 0),
  `stiffness_timing` (`morning` | `after-sitting` | `after-exercise` |
  `all-day`), `stiffness_eased` (`under-30` | `30-60` | `over-60` | `didnt`).
- `activity_impact` (`none` | `modified` | `skipped`), `activity_impact_note`.
- `delayed_triggers` (array of trigger keys, default `{}`),
  `delayed_trigger_other_text`, `delayed_days_ago` (1, 2, or 3 = "3+").
  The report counts these against the day the pain was *felt*, alongside
  same-day triggers, and shows "n delayed".

Trigger keys (shared by `pain_triggers` and `delayed_triggers`): `run`, `swim`,
`ride`, `yard-work`, `office-chair`, `lounge-laptop`, `other` (+ free text).
`office-chair` is deliberately work sitting only. Nat is testing whether
long workdays are a trigger, so don't merge it into a general "sitting".

Text enums have no DB check constraints on purpose, so options can be
tweaked after a few days of use without a migration.

Unused columns: `sleep_asleep_min`, `sleep_deep_min`, `sleep_rem_min`,
`sleep_core_min`, `sleep_in_bed_min`, `sleep_start`, `sleep_end`,
`sleep_source`. They were left over from an abandoned Garmin sleep idea and
are all empty. The planned Apple Health sleep import (iPhone Shortcut →
Supabase) should write to its **own `backtrack_sleep` table**, not here.
An upsert into `backtrack_entries` before Nat logs the day would create
a row with `pain_score` defaulting to 0, which looks like a logged pain-free
day.

Saved with `upsert(..., {onConflict: "date"})` when Nat taps **Save entry**.
The upsert only sends the columns in `docToEntryRow`, so columns it doesn't
list are left untouched.

### `backtrack_activities`: one row per activity

Columns used: `id`, `entry_date`, `source` (`strava` | `manual`), `type`,
`name`, `duration_min`, `distance_km`, `notes`, `created_at`.
`strava_activity_id` is the unique dedupe key for Strava rows.

- Activities are written **immediately** (insert on Add, delete on ×). They
  don't wait for Save entry.
- An activity on its own doesn't create a `backtrack_entries` row, so the
  calendar and trends only count days where Save entry was tapped.

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
  snake_case is mapped to the app's camelCase "doc". Add new fields here and
  in `defaultDoc`, `renderForm`, `collectDoc`.
- `loadEntry` (one day + its activities), `startTodayPoll`,
  `refreshAllEntries` (all entries + activity counts; drives Trends, calendar
  and Report).
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
