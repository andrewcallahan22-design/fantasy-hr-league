// Scheduled sync — runs on Netlify's own cron schedule below, no external
// cron service required. Syncs every league: HR stats, next-game/inning
// status, health, and push notification dispatch all happen in this one pass
// (see runSyncForLeague in lib/core.mjs).
import { runSyncForAllLeagues } from './lib/core.mjs';

export const config = { schedule: '*/3 * * * *' }; // every 3 minutes

export default async () => {
  const result = await runSyncForAllLeagues();
  console.log('Scheduled sync:', JSON.stringify({ ok: result.ok, leagues: result.leagues }));
  return new Response(JSON.stringify(result));
};
