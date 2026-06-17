// Sync core — runs against a single explicit league.
// All HR detection, baseline tracking, change logging, and streak calculation
// happens inside the league record itself.
import { loadLeague, saveLeague, listLeagues, ensureLegacyMigrated } from './storage.mjs';

export function normName(n) {
  return (n || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

const VERIFIED_IDS = {
  'aaron judge': 592450,
  'shohei ohtani': 660271,
  'nick kurtz': 701762,
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
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  let last7 = 0, seasonHR = 0;
  for (const s of splits) {
    const hr = parseInt(s?.stat?.homeRuns) || 0;
    seasonHR += hr;
    if ((s.date || '') >= cutoff) last7 += hr;
  }
  return { last7, seasonHR };
}

function logChange(league, player, delta, mgr, month, src) {
  if (!league.changeLog) league.changeLog = [];
  league.changeLog.push({ t: Date.now(), player, delta, mgr, month, src });
  if (league.changeLog.length > 500) league.changeLog = league.changeLog.slice(-500);
}

function computeLeader(league) {
  const key = league.currentMonth;
  if (!key || !league.months?.[key]) return null;
  const totals = {};
  for (const mgr of league.managers) {
    totals[mgr] = (league.months[key].rosters[mgr] || [])
      .reduce((s, p) => s + (parseInt(p.hr) || 0), 0);
  }
  let leader = null, max = -1;
  for (const [m, t] of Object.entries(totals)) {
    if (t > max) { max = t; leader = m; }
  }
  return leader ? { name: leader, hr: max } : null;
}

// Sync a single league.
export async function runSyncForLeague(leagueId) {
  const league = await loadLeague(leagueId);
  if (!league) return { ok: false, error: 'League not found' };

  const key = league.currentMonth;
  if (!key || !league.months?.[key]) return { ok: false, error: 'No active month' };
  if (!league.seasonBaseline) league.seasonBaseline = {};
  if (!league.streaks) league.streaks = {};
  if (!league.seasonHints) league.seasonHints = {};

  const [, mYear] = key.split('-');
  const seasonYear = mYear || String(new Date().getFullYear());

  const playerSet = new Set();
  for (const mgr of league.managers) {
    for (const p of (league.months[key].rosters[mgr] || [])) {
      if (p.player) playerSet.add(p.player);
    }
  }
  const players = [...playerSet];
  if (!players.length) return { ok: false, error: 'No players on roster' };

  const hrEvents = [];
  const leaderBefore = computeLeader(league);

  const results = await Promise.all(players.map(async (p) => {
    try {
      const { last7, seasonHR } = await fetchGameLogStats(league, p, seasonYear);
      return { player: p, last7, seasonHR, ok: true };
    } catch (e) {
      return { player: p, ok: false, err: e.message };
    }
  }));

  let added = 0;
  const failed = [];

  for (const r of results) {
    const nk = normName(r.player);
    if (!r.ok) { failed.push(r.player); continue; }

    league.streaks[nk] = r.last7;
    league.seasonHints[nk] = r.seasonHR;

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
              hrEvents.push({ player: slot.player, delta, mgr });
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

  // Notification dispatch (fire-and-forget, scoped to this league)
  if (hrEvents.length || (leaderAfter && leaderBefore && leaderAfter.name !== leaderBefore.name)) {
    try {
      const { dispatchNotifications } = await import('./notify.mjs');
      await dispatchNotifications({ league, hrEvents, leaderBefore, leaderAfter });
    } catch (e) {
      console.warn('Notification dispatch failed (non-fatal):', e.message);
    }
  }

  return { ok: true, added, failed, ts: league.lastSync, leagueId };
}

// Sync every league. Used by the scheduled job.
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
