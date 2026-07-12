// Sync core — runs against a single explicit league.
// All HR detection, baseline tracking, change logging, streak calculation,
// and 24h HR tracking happen inside the league record itself.
import { loadLeague, saveLeague, listLeagues, ensureLegacyMigrated } from './storage.mjs';

export function normName(n) {
  return (n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

const VERIFIED_IDS = {
  // AL East
  'aaron judge':          592450,
  'juan soto':            665742,
  'cal raleigh':          663728,
  'junior caminero':      691406,
  'vladimir guerrero jr': 665489,
  // AL Central
  'jose ramirez':         608070,
  'mike trout':           545361,
  'yordan alvarez':       670541,
  'julio rodriguez':      677594,
  // AL West
  'shohei ohtani':        660271,
  'kyle tucker':          663656,
  // NL East
  'pete alonso':          624413,
  'bryce harper':         547180,
  'kyle schwarber':       656941,
  'matt olson':           621566,
  // NL Central
  'nick kurtz':           701762,
  // NL West
  'mookie betts':         605141,
  'freddie freeman':      518692,
  'nolan arenado':        571448,
  // Other commonly drafted
  'byron buxton':         621439,
  'bo bichette':          666182,
  'trea turner':          607208,
  'marcus semien':        543760,
  'teoscar hernandez':    606192,
  'austin riley':         663586,
  'william contreras':    661388,
  'adolis garcia':        666969,
  'gunnar henderson':     683002,
  'corey seager':         608369,
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

  // Fetch game log (finalized stats) and today's live game stats in parallel.
  // The game log only updates after a game ends, so for in-progress games we
  // also check the live boxscore endpoint which updates pitch-by-pitch.
  const today = new Date().toISOString().slice(0, 10);

  const [gameLogResp, liveResp] = await Promise.all([
    fetch(`https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=gameLog&group=hitting&season=${season}`),
    fetch(`https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=gameLog&group=hitting&season=${season}&startDate=${today}&endDate=${today}`),
  ]);

  if (!gameLogResp.ok) throw new Error(`MLB gameLog ${gameLogResp.status}`);
  const data = await gameLogResp.json();
  const splits = data?.stats?.[0]?.splits || [];

  // Also get today's live stats — the regular game log may not yet include
  // in-progress game HRs, but this endpoint does
  let todayHR = 0;
  if (liveResp.ok) {
    const liveData = await liveResp.json();
    const liveSplits = liveData?.stats?.[0]?.splits || [];
    todayHR = liveSplits.reduce((s, g) => s + (parseInt(g?.stat?.homeRuns) || 0), 0);
  }

  const now = Date.now();
  const cutoff7d = new Date(now - 7  * 86400000).toISOString().slice(0, 10);
  const cutoff3d = new Date(now - 3  * 86400000).toISOString().slice(0, 10);

  let last7 = 0, last24h = 0, seasonHR = 0;
  const countedDates = new Set();
  for (const s of splits) {
    const hr   = parseInt(s?.stat?.homeRuns) || 0;
    const date = s.date || '';
    seasonHR += hr;
    countedDates.add(date);
    if (date >= cutoff7d) last7   += hr;
    if (date >= cutoff3d) last24h += hr;
  }

  // Add today's live HRs only if the game log's count for today is LESS than
  // what the today-specific endpoint shows (game still finalizing) 
  if (todayHR > 0) {
    // Find today's HR count in the game log
    const todayInLog = splits
      .filter(s => s.date === today)
      .reduce((sum, s) => sum + (parseInt(s?.stat?.homeRuns) || 0), 0);
    if (!countedDates.has(today)) {
      // Today not in game log at all — game in progress, add live HR
      console.log(`[sync] Live HR detected for ${playerName}: ${todayHR} HR today (not yet in game log)`);
      seasonHR += todayHR;
      last7    += todayHR;
      last24h  += todayHR;
    }
    // If today IS in game log, don't add again — game log is authoritative
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
        // Upcoming game — store the raw UTC ISO string so the browser can
        // reformat it in each manager's own local timezone automatically.
        const gameTime = g.gameDate ? new Date(g.gameDate) : null;
        if (!gameTime) return { status: 'upcoming', label: 'Today' };
        const now = new Date();
        const diffHours = (gameTime - now) / 3600000;
        if (diffHours < 0) continue; // already started/final
        if (diffHours < 0.5) return { status: 'upcoming', label: 'Soon' };
        return { status: 'upcoming', label: g.gameDate }; // raw ISO — browser localizes
      }
    }
    return null; // all games today are final
  } catch (e) {
    return null; // non-fatal
  }
}

// Fetch real-time health status for a player via team 40-man roster.
// Returns { status: 'Active'|'IL'|..., detail: string }
async function fetchHealth(league, playerName) {
  try {
    const id = await resolvePlayerId(league, playerName);
    // Get current team
    const profileResp = await fetch(`https://statsapi.mlb.com/api/v1/people/${id}?hydrate=currentTeam`);
    if (!profileResp.ok) return { status: 'Active', detail: '' };
    const profile = await profileResp.json();
    const teamId = profile?.people?.[0]?.currentTeam?.id;
    if (!teamId) return { status: 'Active', detail: '' };
    // Check 40-man roster for IL status
    const rosterResp = await fetch(`https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=40Man&season=${new Date().getFullYear()}`);
    if (!rosterResp.ok) return { status: 'Active', detail: '' };
    const rosterData = await rosterResp.json();
    const entry = (rosterData.roster || []).find(e => e?.person?.id == id);
    if (!entry) return { status: 'Active', detail: '' };
    const code = entry.status?.code || 'A';
    const desc = entry.status?.description || '';
    if (code.startsWith('D') || code === 'IL') return { status: 'IL', detail: desc || code };
    if (code !== 'A') return { status: code, detail: desc };
    return { status: 'Active', detail: '' };
  } catch {
    return { status: 'Active', detail: '' };
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

  // ── Sync lock ──
  // Prevent overlapping syncs from causing duplicate notifications.
  // If a sync started less than 50s ago, skip this run.
  const now = Date.now();
  if (league.lastSyncStartedAt && (now - league.lastSyncStartedAt) < 50000) {
    console.log(`[sync:${leagueId}] Skipping — sync already in progress (started ${Math.round((now - league.lastSyncStartedAt)/1000)}s ago)`);
    return { ok: true, skipped: true };
  }
  league.lastSyncStartedAt = now;
  await saveLeague(league); // write lock immediately

  // Auto-clear stale draft objects — if draft exists but status isn't 'active',
  // it's leftover data that causes the "Draft in progress" banner to show incorrectly.
  if (league.draft && league.draft.status !== 'active') {
    console.log(`[sync:${leagueId}] Clearing stale draft object (status: ${league.draft.status})`);
    league.draft = null;
    if (!league.draftClosedAt) {
      league.draftClosedAt = Date.now();
      if (league.currentMonth && league.months?.[league.currentMonth]) {
        league.months[league.currentMonth].rostersLiveAt = league.draftClosedAt;
      }
    }
    await saveLeague(league);
  }

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

  if (!league.health) league.health = {};

  // Fetch stats + next game + health in parallel
  const results = await Promise.all(players.map(async (p) => {
    try {
      let teamAbbr = null;
      for (const mgr of league.managers) {
        const slot = (league.months[key].rosters[mgr] || []).find(s => s.player === p);
        if (slot?.team) { teamAbbr = slot.team; break; }
      }
      const [stats, nextGame, health] = await Promise.all([
        fetchGameLogStats(league, p, seasonYear),
        fetchNextGame(league, p, teamAbbr),
        fetchHealth(league, p),
      ]);
      return { player: p, ...stats, nextGame, health, ok: true };
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
    league.health[nk]      = r.health || { status: 'Active', detail: '' };
    league.nextGame[nk]    = r.nextGame;

    const baseline = league.seasonBaseline[nk];

    // Set baseline if first time seeing this player
    if (baseline === undefined) {
      league.seasonBaseline[nk] = r.seasonHR;
    }

    const delta = baseline !== undefined ? r.seasonHR - baseline : 0;
    if (delta !== 0) {
      console.log(`[sync:${league.id}] HR delta for ${r.player}: ${baseline} → ${r.seasonHR} (+${delta})`);
    }

    // Update roster slots — manualHr ALWAYS wins regardless of delta or baseline state
    for (const mgr of league.managers) {
      for (const slot of (league.months[key].rosters[mgr] || [])) {
        if (!slot.player || normName(slot.player) !== nk) continue;

        if (slot.manualHr !== undefined) {
          // Commissioner set this manually — use exact value, ignore everything else
          console.log(`[sync:${league.id}] Respecting manual HR for ${r.player}: ${slot.manualHr} (delta was ${delta})`);
          slot.hr = slot.manualHr;
          delete slot.manualHr;
          delete slot.manualHrTs;
        } else if (delta > 0) {
          // Real new HR detected by sync
          slot.hr = Math.max(0, (parseInt(slot.hr) || 0) + delta);
          logChange(league, slot.player, delta, mgr, key, 'sync');
          added += delta;
          hrEvents.push({ player: slot.player, delta, mgr, baselineAfter: r.seasonHR });
        } else if (delta < 0) {
          // Correction (rare) — MLB API revised down
          slot.hr = Math.max(0, (parseInt(slot.hr) || 0) + delta);
        }
      }
    }

    // Always update baseline to current season total
    league.seasonBaseline[nk] = r.seasonHR;
  }

  const leaderAfter = computeLeader(league);
  league.lastSync = Date.now();
  delete league.lastSyncStartedAt; // release lock
  await saveLeague(league);

  // Dispatch notifications — fire-and-forget
  const needsNotification =
    hrEvents.length > 0 ||
    (leaderBefore && leaderAfter &&
     JSON.stringify(leaderBefore.names.sort()) !== JSON.stringify(leaderAfter.names.sort()));

  if (needsNotification) {
    try {
      console.log(`[sync:${league.id}] Dispatching notifications — ${hrEvents.length} HR events`);
      hrEvents.forEach(ev => console.log(`  HR: ${ev.player} +${ev.delta} for ${ev.mgr}`));
      const { dispatchNotifications } = await import('./notify.mjs');
      const notifResult = await dispatchNotifications({ league, hrEvents, leaderBefore, leaderAfter });
      console.log(`[sync:${league.id}] Notification result:`, JSON.stringify(notifResult));
    } catch (e) {
      console.warn('Notification dispatch failed (non-fatal):', e.message);
    }
  } else {
    console.log(`[sync:${league.id}] No notifications needed (no HR events, no leader change)`);
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
