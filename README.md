# Fantasy HR League — Shared Scoreboard + Draft + Push Notifications

## What's new in this version (v5)
- **Push notifications**: get a phone/browser notification when one of your
  players homers or when someone takes the league lead. Quiet hours: 11 PM-9 AM PT.
- **5-minute sync during game hours**: instead of 5 PM and 11 PM only, the
  scheduled sync now runs every 5 minutes from 9 AM to 11 PM PT so notifications
  feel live. Quiet overnight.
- **Stale-save bug fix** from v4 (per-slot conflict resolution).
- **Diagnostics panel** in Settings showing per-player sync state.

## One-time setup BEFORE deploying v5
Web Push requires a cryptographic keypair (VAPID). The package includes a
script to generate one — takes 5 seconds:

1. On your Mac, open Terminal in the unzipped folder and run:
   ```
   node generate-vapid-keys.mjs
   ```
2. It prints three values like:
   ```
   VAPID_PUBLIC_KEY  = BLah...
   VAPID_PRIVATE_KEY = xyz...
   VAPID_SUBJECT     = mailto:andrewcallahan22@gmail.com
   ```
3. In Netlify: Site → **Site configuration → Environment variables → Add**.
   Add each of the three as a new variable (name on the left, value on the right).
4. Then upload the files to GitHub as usual.

The site works without these keys — you just won't get push notifications until
they're set. After adding them in Netlify, trigger a redeploy from the Deploys
tab so the functions pick up the new env vars.

## Uploading the update
Same as before:
1. Open your GitHub repo
2. "Add file → Upload files", drag in everything from this package
   (keeping folder structure — drag the `netlify/` folder, don't unpack it)
3. Commit; Netlify redeploys in ~1 minute
4. **Do NOT upload `generate-vapid-keys.mjs` to GitHub** if you'd rather keep
   the keys local — but it's harmless either way since the secrets are stored
   in Netlify env vars, not in the script

## Each manager enables notifications once
1. Sign in to the site
2. Go to Settings → Notifications → "Enable notifications on this device"
3. Allow the browser permission prompt
4. **On iPhone**: first add the site to your Home Screen (Share → Add to
   Home Screen), then open it from that icon, then enable notifications.
   (Apple requires home-screen installation before push works.)
5. Repeat on each device (phone, laptop) you want to receive notifications on.

## Notification rules
- HR on your roster → only you get the ping
- New league leader → everyone gets the ping
- Quiet hours 11 PM – 9 AM Pacific
- Notifications skip silently overnight; the HR is still recorded in History

## Cost
All free. Netlify scheduled functions run unlimited times on the free tier;
push notifications are sent free by Apple/Google/Mozilla.
