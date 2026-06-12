# Fantasy HR League — Shared Scoreboard + Draft Portal

## What's new in this version
- **Manager logins** (email + password). Each manager claims their team once via
  "Claim Your Team"; after that it's sign-in only. You can only edit your own roster.
- **Monthly Draft tab**: open next month's draft, pick order = reverse of last
  month's standings (lowest total picks first, same order every round), casual
  picks with no clock. Shows your roster slots, filled/open positions (one
  duplicate allowed), MLB teams already taken league-wide, and a live
  "best available" top-HR board from the official MLB API. All league rules are
  enforced server-side; when the 24th pick lands, the new month's rosters are
  created automatically.
- Viewing is public (no login needed to check standings); editing and drafting
  require sign-in.

## Upgrading your existing site
Your league data is stored separately from the code, so this upgrade does NOT
touch your rosters, HR counts, or history.

1. Go to your GitHub repository
2. "Add file → Upload files" and drag in everything from this package,
   keeping the folder structure (GitHub overwrites files with the same names)
3. Commit — Netlify redeploys automatically in ~1 minute

## First steps after deploying
1. Each manager visits the site → "Sign in" → "Claim Your Team" → picks their
   name, enters email + password (6+ chars)
2. When July rolls around, anyone signed in hits Draft → "Open next month's draft"
3. Take turns picking — the page shows whose turn it is; refresh or wait for the
   60-second auto-refresh to see new picks
4. After the last pick, run a ⟳ Sync once to anchor baselines for the new month

## Notes
- Forgot password: there's no self-service reset (kept simple). Quick fix:
  ask here and you'll get a tiny admin script; or delete the 'users' blob in
  Netlify (Site → Blobs) and everyone re-claims.
- Cron schedule is UTC: "0 0,6 * * *" = 5 PM & 11 PM PDT. After clocks change
  in November, edit netlify.toml to "0 1,7 * * *" to stay at 5/11 PM.
