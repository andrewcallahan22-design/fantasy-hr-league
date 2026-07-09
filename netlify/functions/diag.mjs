// Per-league diagnostics + push notification debug.
// GET ?leagueId=ID          → diagnostic dump for that league
// GET ?leagueId=ID&push=1   → push subscription status for all members
import { loadLeague, ensureLegacyMigrated } from './lib/storage.mjs';
import { normName } from './lib/core.mjs';
import { getStore } from '@netlify/blobs';

const NO_CACHE = { 'Cache-Control': 'no-store' };

export default async (req) => {
  await ensureLegacyMigrated();
  const url = new URL(req.url);
  const leagueId = url.searchParams.get('leagueId');
  if (!leagueId) return Response.json({ ok: false, error: 'leagueId required' }, { status: 400 });
  const league = await loadLeague(leagueId);
  if (!league) return Response.json({ ok: false, error: 'League not found' }, { status: 404 });

  const key = league.currentMonth;

  // ── PUSH DEBUG MODE ──
  if (url.searchParams.get('push') === '1') {
    const store = getStore('league');
    const allSubs  = await store.get('pushSubs',  { type: 'json' }) || {};
    const allPrefs = await store.get('pushPrefs', { type: 'json' }) || {};
    const vapidConfigured = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

    const memberStatus = (league.members || [])
      .filter(m => m.status === 'active')
      .map(m => {
        const email = m.email?.toLowerCase() || null;
        const subs  = email ? (allSubs[email] || []) : [];
        const prefs = email ? (allPrefs[email] || {}) : {};
        return {
          manager:      m.manager,
          email:        email || '— not linked',
          subscribed:   subs.length > 0,
          deviceCount:  subs.length,
          notifyAll:    !!prefs.notifyAll,
          wouldReceiveHrNotif: subs.length > 0,
          wouldReceiveRivalNotif: subs.length > 0 && !!prefs.notifyAll,
        };
      });

    return Response.json({
      ok: true,
      vapidConfigured,
      leagueId,
      leagueName: league.name,
      memberStatus,
      summary: {
        totalActive: memberStatus.length,
        subscribed: memberStatus.filter(m => m.subscribed).length,
        notifyAllEnabled: memberStatus.filter(m => m.notifyAll).length,
        notLinked: memberStatus.filter(m => m.email === '— not linked').length,
      },
    }, { headers: NO_CACHE });
  }

  // ── STANDARD DIAG ──
  const players = [];
  if (key && league.months?.[key]) {
    for (const mgr of league.managers) {
      const roster = league.months[key].rosters?.[mgr] || [];
      roster.forEach((slot, idx) => {
        if (!slot.player) return;
        const nk  = normName(slot.player);
        const hits = (league.changeLog || []).filter(e => normName(e.player || '') === nk);
        players.push({
          manager: mgr, slotIndex: idx,
          rosterPlayer: slot.player, rosterHR: slot.hr,
          rosterTeam: slot.team, rosterPosition: slot.position,
          baselineSeasonHR: league.seasonBaseline?.[nk] ?? null,
          liveSeasonHR:     league.seasonHints?.[nk]    ?? null,
          last7Streak:      league.streaks?.[nk]        ?? null,
          mlbId:            league.playerIds?.[nk]      ?? null,
          health:           league.health?.[nk]         ?? null,
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
    leagueId, currentMonth: key,
    lastSync: league.lastSync ? new Date(league.lastSync).toISOString() : null,
    totalHistoryEntries: (league.changeLog || []).length,
    players,
  }, null, 2), { headers: { ...NO_CACHE, 'Content-Type': 'application/json' } });
};
