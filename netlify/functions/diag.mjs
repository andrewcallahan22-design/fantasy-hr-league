// Per-league diagnostics.
// GET ?leagueId=ID → diagnostic dump for that league
import { loadLeague, ensureLegacyMigrated } from './lib/storage.mjs';
import { normName } from './lib/core.mjs';

const NO_CACHE = { 'Cache-Control': 'no-store' };

export default async (req) => {
  await ensureLegacyMigrated();
  const url = new URL(req.url);
  const leagueId = url.searchParams.get('leagueId');
  if (!leagueId) return Response.json({ ok: false, error: 'leagueId required' }, { status: 400 });
  const league = await loadLeague(leagueId);
  if (!league) return Response.json({ ok: false, error: 'League not found' }, { status: 404 });

  const key = league.currentMonth;
  const players = [];
  if (key && league.months?.[key]) {
    for (const mgr of league.managers) {
      const roster = league.months[key].rosters?.[mgr] || [];
      roster.forEach((slot, idx) => {
        if (!slot.player) return;
        const nk = normName(slot.player);
        const hits = (league.changeLog || []).filter(e => normName(e.player || '') === nk);
        players.push({
          manager: mgr,
          slotIndex: idx,
          rosterPlayer: slot.player,
          rosterHR: slot.hr,
          rosterTeam: slot.team,
          rosterPosition: slot.position,
          baselineSeasonHR: league.seasonBaseline?.[nk] ?? null,
          liveSeasonHR: league.seasonHints?.[nk] ?? null,
          last7Streak: league.streaks?.[nk] ?? null,
          mlbId: league.playerIds?.[nk] ?? null,
          historyEntriesForPlayer: hits.length,
          historyEntriesForThisMgrThisMonth: hits.filter(e => e.mgr === mgr && e.month === key).length,
          recentHistory: hits.slice(-3).map(e => ({
            when: new Date(e.t).toISOString(),
            delta: e.delta, forMgr: e.mgr, forMonth: e.month, src: e.src,
          })),
        });
      });
    }
  }
  return new Response(JSON.stringify({
    leagueId,
    currentMonth: key,
    lastSync: league.lastSync ? new Date(league.lastSync).toISOString() : null,
    totalHistoryEntries: (league.changeLog || []).length,
    players,
  }, null, 2), { headers: { ...NO_CACHE, 'Content-Type': 'application/json' } });
};
