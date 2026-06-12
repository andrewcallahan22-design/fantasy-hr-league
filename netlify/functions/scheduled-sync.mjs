// Scheduled sync — Netlify runs this automatically on the cron schedule in
// netlify.toml (00:00 & 06:00 UTC = 5 PM & 11 PM Pacific Daylight Time).
// Nobody needs to have the page open; this runs on Netlify's servers.
import { runSync } from './lib/core.mjs';

export default async () => {
  const result = await runSync();
  console.log('Scheduled sync result:', JSON.stringify(result));
  return new Response(JSON.stringify(result));
};
