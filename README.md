# Go Yard (Fantasy HR League)

A multi-tenant fantasy baseball SaaS app that tracks home runs for fantasy leagues.

## Architecture
- **Frontend:** [index.html](index.html) — single-page app (markup, styles, and JS all in one file)
- **Backend:** Netlify Functions in `netlify/functions/` (ESM `.mjs`)
- **Storage:** Netlify Blobs (`@netlify/blobs`)
- **Deploy:** GitHub → Netlify auto-deploy on push to `main`

## Features
- **Multi-league SaaS architecture** — any user can create their own league
- **Account system** — email/password, one account works across many leagues
- **Invite links** — commissioner shares a URL; friends join, commissioner approves
- **Commissioner tools** — roster size, scoring categories, position & team rules,
  rename, remove members, regenerate invite link
- **Onboarding checklist** for new commissioners on first league dashboard
- **Push notifications** for HR events (VAPID web push)

## Functions (`netlify/functions/`)
| File | Purpose |
|---|---|
| `auth.mjs` | User accounts (signup/login), account-centric rather than league-coupled |
| `league.mjs` | Core league CRUD |
| `draft.mjs` | Draft logic |
| `join.mjs` | Invite-link joins |
| `admin.mjs` | Super-admin view across all leagues |
| `player.mjs` | Player profile lookups |
| `push.mjs` | Push subscriptions, keyed by lowercased email |
| `run-sync.mjs` / `scheduled-sync.mjs` | HR stat sync — manual trigger and cron (external cron-job.org hits `/run-sync?leagueId=...` per league) |
| `diag.mjs` | Per-league diagnostics / push debug |
| `data.mjs` | Legacy compatibility shim for old clients |
| `lib/` | Shared helpers: `core.mjs`, `storage.mjs`, `notify.mjs`, `auth.mjs`, `initial-state.mjs` |

## Notes
- **Sync:** an external cron-job.org schedule hits `/run-sync` per league; each league needs its own `?leagueId=...` in the URL.
- **Push notifications:** configured via VAPID env vars (see `generate-vapid-keys.mjs` to create new keys).
- **Pre-ship checks:** `audit.py` lints the inline `<script>` in `index.html` and auto-stamps `APP_VERSION` — run before shipping.
