// Scheduled sync — Netlify or external cron triggers this. Syncs every league.
import { runSyncForAllLeagues } from './lib/core.mjs';

export default async () => {
  const result = await runSyncForAllLeagues();
  console.log('Scheduled sync:', JSON.stringify({ ok: result.ok, leagues: result.leagues }));
  return new Response(JSON.stringify(result));
};
