// Manual sync trigger — runs sync for a single league.
import { runSyncForLeague } from './lib/core.mjs';
import { ensureLegacyMigrated } from './lib/storage.mjs';

export default async (req) => {
  await ensureLegacyMigrated();
  const url = new URL(req.url);
  let leagueId = url.searchParams.get('leagueId');
  if (!leagueId && req.method === 'POST') {
    try {
      const body = await req.json();
      leagueId = body?.leagueId;
    } catch {}
  }
  if (!leagueId) return Response.json({ ok: false, error: 'leagueId required' }, { status: 400 });
  const result = await runSyncForLeague(leagueId);
  return Response.json(result);
};
