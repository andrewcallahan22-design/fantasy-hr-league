// Diagnostics endpoint — shows the full sync chain per rostered player so we can
// see exactly where HR updates are getting lost between sync → history → scores.
// Public read (no sensitive data) so any league member can sanity-check the system.
import { loadLeagueState, normName } from './lib/core.mjs';

const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Pragma': 'no-cache',
  'Expires': '0',
  'Content-Type': 'application/json',
};

export default async () => {
  const state = await loadLeagueState();
  const key = state.currentMonth;
  const monthData = state.months?.[key];

  const players = [];
  if (monthData) {
    for (const mgr of state.managers) {
      const roster = monthData.rosters?.[mgr] || [];
      roster.forEach((slot, idx) => {
        if (!slot.player) return;
        const nk = normName(slot.player);
        // How many History entries reference this player?
        const hits = (state.changeLog || []).filter(e => normName(e.player || '') === nk);
        const recent = hits.slice(-3).map(e => ({
          when: new Date(e.t).toISOString(),
          delta: e.delta,
          forMgr: e.mgr,
          forMonth: e.month,
          src: e.src,
        }));
        players.push({
          manager: mgr,
          slotIndex: idx,
          rosterPlayer: slot.player,
          rosterPlayerNormalized: nk,
          rosterHR: slot.hr,
          rosterTeam: slot.team,
          rosterPosition: slot.position,
          baselineSeasonHR: state.seasonBaseline?.[nk] ?? null,
          liveSeasonHR: state.seasonHints?.[nk] ?? null,
          last7Streak: state.streaks?.[nk] ?? null,
          mlbId: state.playerIds?.[nk] ?? null,
          historyEntriesForPlayer: hits.length,
          historyEntriesForThisMgrThisMonth: hits.filter(e => e.mgr === mgr && e.month === key).length,
          recentHistory: recent,
        });
      });
    }
  }

  return new Response(JSON.stringify({
    currentMonth: key,
    lastSync: state.lastSync ? new Date(state.lastSync).toISOString() : null,
    totalHistoryEntries: (state.changeLog || []).length,
    players,
  }, null, 2), { headers: NO_CACHE });
};
