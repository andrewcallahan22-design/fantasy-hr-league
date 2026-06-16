# Fantasy HR League — v7 (Multi-Tenant)

This is the **multi-tenant rebuild**. Designed for branch-deploy testing
alongside your existing live site at `main` — once you've poked it and
confirmed it works, merge to `main` to flip the public URL.

## What's new
- **Multi-league SaaS architecture** — any user can create their own league
- **Account system** — email/password, one account works across many leagues
- **Invite links** — commissioner shares a URL; friends join, commissioner approves
- **Commissioner tools** — roster size, scoring categories, position & team rules,
  rename, remove members, regenerate invite link
- **Onboarding checklist** for new commissioners on first league dashboard
- **New visual identity** — modern broadcast dark dashboard with diamond backdrop
  and the proper baseball diamond logo
- **Your existing league migrates automatically** as `andrews-league-2026` —
  rosters, HR counts, history, baselines all preserved intact

## Deployment as a Netlify branch preview (safe testing)

This is the recommended path for trialing v7 without disrupting the live site.

### Step 1 — Push to a `v7` branch on GitHub
1. Open your GitHub repo in a browser
2. Top-left branch dropdown → type `v7` → click "Create branch: v7 from main"
3. With `v7` selected as the active branch, click "Add file → Upload files"
4. Drag in everything from this package (keep folders — drag the `netlify`
   folder as a folder, not flattened)
5. Commit directly to the `v7` branch

### Step 2 — Branch preview URL
Netlify automatically builds every branch. After ~1 minute, your v7 preview
will be live at something like:

  `v7--<your-site-name>.netlify.app`

(Exact format shows up in Deploys → "Deploy preview" or "Branch deploys".)

### Step 3 — Test it
- Visit the v7 URL
- You should see the new homepage
- Sign in (your existing account works — same email/password)
- Click your existing league — all data should be there
- Try creating a brand new test league
- Try generating an invite link and joining it from a different email

### Step 4 — Promote to production
When you're satisfied:
1. Go to your GitHub repo
2. Open a pull request from `v7` → `main`
3. Merge it
4. Netlify redeploys `main`; the public URL is now v7

## Important notes

**Shared backend data.** The branch deploy hits the same Netlify Blobs storage
as your main site. Test leagues you create will persist (you can delete them
later through the commissioner tools). The migration of your existing league
runs automatically the first time the v7 site is opened.

**Sync continues working.** Your existing cron-job.org schedule will still hit
`/run-sync`, but you may need to update the URL to include a `?leagueId=...`
parameter, since sync is now per-league.

**Push notifications.** The same VAPID env vars work — no changes needed.
