# Fantasy HR League — Shared Scoreboard

One shared scoreboard for the whole league. Data lives on the server, every
manager sees the same numbers, and the sync runs automatically at 5 PM and
11 PM Pacific on Netlify's servers — nobody needs to keep the page open.

## What's in here
- `index.html` — the scoreboard app
- `netlify/functions/data.mjs` — shared league data (GET/POST)
- `netlify/functions/run-sync.mjs` — manual ⟳ Sync trigger (updates everyone)
- `netlify/functions/scheduled-sync.mjs` — the 5 PM / 11 PM automatic sync
- `netlify/functions/lib/core.mjs` — sync logic (official MLB Stats API, delta tracking)
- `netlify/functions/lib/initial-state.mjs` — your league's starting data (June 10 baseline)
- `netlify.toml` — schedule + functions config
- `package.json` — one dependency (@netlify/blobs, Netlify's built-in storage)

## Deploy (one-time, ~10 minutes)
Scheduled functions need a Git-connected deploy (drag-and-drop won't run them):

1. Create a free account at github.com (if you don't have one)
2. Create a new repository, e.g. `fantasy-hr-league`
3. Click "uploading an existing file" and upload ALL files/folders from this
   package, keeping the folder structure (netlify/functions/lib/...)
4. In Netlify: **Add new site → Import an existing project → GitHub** and pick
   your repo. Build settings are auto-detected from netlify.toml — just Deploy.
5. Your site goes live at your-site-name.netlify.app — share that link

## Notes
- The cron schedule is in UTC: `0 0,6 * * *` = 5 PM & 11 PM Pacific Daylight
  Time. When clocks fall back in November, change it to `0 1,7 * * *` in
  netlify.toml to stay at 5/11 PM.
- The ⟳ Sync button runs the same server-side sync immediately — one click
  updates the scoreboard for everyone.
- Anyone with the link can edit rosters and HR numbers (it's a friends league —
  there's no login). The History tab logs every change.
