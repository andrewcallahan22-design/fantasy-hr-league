// Sync core — runs against a single explicit league.
// All HR detection, baseline tracking, change logging, streak calculation,
// and 24h HR tracking happen inside the league record itself.
import { loadLeague, saveLeague, listLeagues, ensureLegacyMigrated } from './storage.mjs';

export function normName(n) {
  return (n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

const VERIFIED_IDS = {
  'aaron judge':  592450,
  'shohei ohtani': 660271,
  'nick kurtz':   701762,
};

async function resolvePlayerId(league, playerName) {
  const key = normName(playerName);
  if (VERIFIED_IDS[key]) return VERIFIED_IDS[key];
  if (!league.playerIds) league.playerIds = {};
  if (league.playerIds[key]) return league.playerIds[key];

  const url = `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(playerName)}&sportIds=1&active=true`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`MLB search ${resp.status}`);
  const data = await resp.json();
  const person = (data.people || [])[0];
  if (!person) throw new Error(`No MLB match for "${playerName}"`);
  league.playerIds[key] = person.id;
  return person.id;
}

async function fetchGameLogStats(league, playerName, season) {
  const id = await resolvePlayerId(league, playerName);
  const url = `https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=gameLog&group=hitting&season=${season}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`MLB gameLog ${resp.status}`);
  const data = await resp.json();
  const splits = data?.stats?.[0]?.splits || [];

  const now = Date.now();
  const cutoff7d  = new Date(now - 7  * 86400000).toISOString().slice(0, 10);
  const cutoff24h = new Date(now - 1  * 86400000).toISOString().slice(0, 10);

  let last7 = 0, last24h = 0, seasonHR = 0;
  for (const s of splits) {
    const hr   = parseInt(s?.stat?.homeRuns) || 0;
    const date = s.date || '';
    seasonHR += hr;
    if (date >= cutoff7d)  last7   += hr;
    if (date >= cutoff24h) last24h += hr;
  }
  return { last7, last24h, seasonHR };
}

// Fetch today's schedule and find if this player's team has a game today or
// in the next 24 hours. Returns null if no upcoming game found.
async function fetchNextGame(league, playerName, teamAbbr) {
  try {
    const id = await resolvePlayerId(league, playerName);
    // Get player's current team from their profile
    const profileUrl = `https://statsapi.mlb.com/api/v1/people/${id}?hydrate=currentTeam`;
    const profileResp = await fetch(profileUrl);
    if (!profileResp.ok) return null;
    const profile = await profileResp.json();
    const teamId = profile?.people?.[0]?.currentTeam?.id;
    if (!teamId) return null;

    // Get schedule for today + tomorrow
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const schedUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${today}&endDate=${tomorrow}&teamId=${teamId}&hydrate=linescore`;
    const schedResp = await fetch(schedUrl);
    if (!schedResp.ok) return null;
    const sched = await schedResp.json();

    const games = (sched.dates || []).flatMap(d => d.games || []);
    if (!games.length) return null;

    // Find the first non-Final game, or the currently live one
    const liveStates   = new Set(['I', 'Live', 'In Progress']);
    const finalStates  = new Set(['F', 'Final', 'Game Over', 'FT']);
    const preStates    = new Set(['P', 'Pre-Game', 'S', 'Scheduled', 'Preview']);

    for (const g of games) {
      const state = g.status?.abstractGameState || '';
      const detail = g.status?.detailedState || '';
      const linescore = g.linescore || {};

      if (liveStates.has(state) || detail.includes('In Progress')) {
        // Game is live — return current inning info
        const inning = linescore.currentInning || '?';
        const half   = linescore.isTopInning ? 'Top' : 'Bot';
        return { status: 'live', label: `${half} ${inning}` };
      }

      if (!finalStates.has(state)) {
        // Upcoming game
        const gameTime = g.gameDate ? new Date(g.gameDate) : null;
        if (!gameTime) return { status: 'upcoming', label: 'Today' };
        const now = new Date();
        const diffHours = (gameTime - now) / 3600000;
        if (diffHours < 0) continue; // already started/final
        if (diffHours < 1) return { status: 'upcoming', label: 'Soon' };
        const localTime = gameTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
        return { status: 'upcoming', label: localTime };
      }
    }
    return null; // all games today are final
  } catch (e) {
    return null; // non-fatal
  }
}

function logChange(league, player, delta, mgr, month, src) {
  if (!league.changeLog) league.changeLog = [];
  league.changeLog.push({ t: Date.now(), player, delta, mgr, month, src });
  if (league.changeLog.length > 500) league.changeLog = league.changeLog.slice(-500);
}

// Returns { names: string[], hr: number } — names has multiple entries on a tie.
function computeLeader(league) {
  const key = league.currentMonth;
  if (!key || !league.months?.[key]) return null;
  const totals = {};
  for (const mgr of league.managers) {
    totals[mgr] = (league.months[key].rosters[mgr] || [])
      .reduce((s, p) => s + (parseInt(p.hr) || 0), 0);
  }
  let max = -1;
  for (const t of Object.values(totals)) if (t > max) max = t;
  if (max < 0) return null;
  const names = Object.entries(totals).filter(([, t]) => t === max).map(([m]) => m);
  return { names, hr: max };
}

// ── Main sync ──
export async function runSyncForLeague(leagueId) {
  const league = await loadLeague(leagueId);
  if (!league) return { ok: false, error: 'League not found' };

  const key = league.currentMonth;
  if (!key || !league.months?.[key]) return { ok: false, error: 'No active month' };
  if (!league.seasonBaseline) league.seasonBaseline = {};
  if (!league.streaks)        league.streaks = {};
  if (!league.seasonHints)    league.seasonHints = {};
  if (!league.last24h)        league.last24h = {};
  if (!league.nextGame)       league.nextGame = {};

  const [, mYear] = key.split('-');
  const seasonYear = mYear || String(new Date().getFullYear());

  // Collect unique players across all rosters for this month
  const playerSet = new Set();
  for (const mgr of league.managers) {
    for (const p of (league.months[key].rosters[mgr] || [])) {
      if (p.player) playerSet.add(p.player);
    }
  }
  const players = [...playerSet];
  if (!players.length) return { ok: false, error: 'No players on roster' };

  const hrEvents  = [];
  const leaderBefore = computeLeader(league);

  // Fetch stats + next game in parallel
  const results = await Promise.all(players.map(async (p) => {
    try {
      // Find the team abbreviation for this player from any roster slot
      let teamAbbr = null;
      for (const mgr of league.managers) {
        const slot = (league.months[key].rosters[mgr] || []).find(s => s.player === p);
        if (slot?.team) { teamAbbr = slot.team; break; }
      }
      const [stats, nextGame] = await Promise.all([
        fetchGameLogStats(league, p, seasonYear),
        fetchNextGame(league, p, teamAbbr),
      ]);
      return { player: p, ...stats, nextGame, ok: true };
    } catch (e) {
      return { player: p, ok: false, err: e.message };
    }
  }));

  let added = 0;
  const failed = [];

  for (const r of results) {
    const nk = normName(r.player);
    if (!r.ok) { failed.push(r.player); continue; }

    league.streaks[nk]     = r.last7;
    league.last24h[nk]     = r.last24h;
    league.seasonHints[nk] = r.seasonHR;
    if (r.nextGame !== null) league.nextGame[nk] = r.nextGame;

    const baseline = league.seasonBaseline[nk];
    if (baseline === undefined) {
      league.seasonBaseline[nk] = r.seasonHR;
      continue;
    }
    const delta = r.seasonHR - baseline;
    if (delta !== 0) {
      for (const mgr of league.managers) {
        for (const slot of (league.months[key].rosters[mgr] || [])) {
          if (slot.player && normName(slot.player) === nk) {
            slot.hr = Math.max(0, (parseInt(slot.hr) || 0) + delta);
            logChange(league, slot.player, delta, mgr, key, 'sync');
            if (delta > 0) {
              added += delta;
              hrEvents.push({
                player:        slot.player,
                delta,
                mgr,
                baselineAfter: r.seasonHR,   // used for stable notification tag
              });
            }
          }
        }
      }
      league.seasonBaseline[nk] = r.seasonHR;
    }
  }

  const leaderAfter = computeLeader(league);
  league.lastSync = Date.now();
  await saveLeague(league);

  // Dispatch notifications — fire-and-forget
  const needsNotification =
    hrEvents.length > 0 ||
    (leaderBefore && leaderAfter &&
     JSON.stringify(leaderBefore.names.sort()) !== JSON.stringify(leaderAfter.names.sort()));

  if (needsNotification) {
    try {
      const { dispatchNotifications } = await import('./notify.mjs');
      await dispatchNotifications({ league, hrEvents, leaderBefore, leaderAfter });
    } catch (e) {
      console.warn('Notification dispatch failed (non-fatal):', e.message);
    }
  }

  return { ok: true, added, failed, ts: league.lastSync, leagueId };
}

export async function runSyncForAllLeagues() {
  await ensureLegacyMigrated();
  const index = await listLeagues();
  const results = [];
  for (const entry of index) {
    try {
      const r = await runSyncForLeague(entry.id);
      results.push(r);
    } catch (e) {
      results.push({ ok: false, leagueId: entry.id, error: e.message });
    }
  }
  return { ok: true, leagues: results.length, results };
}
