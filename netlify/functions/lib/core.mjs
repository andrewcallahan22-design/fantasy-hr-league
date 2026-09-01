// Sync core — runs against a single explicit league.
// All HR detection, baseline tracking, change logging, streak calculation,
// and 24h HR tracking happen inside the league record itself.
import { loadLeague, saveLeague, listLeagues, ensureLegacyMigrated } from './storage.mjs';

export function normName(n) {
  return (n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

// Some code paths produce a team abbreviation from this app's own hardcoded
// TEAM_ABBR table (draft.mjs, player.mjs), others pull it straight from
// MLB's live API \u2014 and the two disagree for 3 teams (confirmed against MLB's
// API directly): Arizona (ARI vs real AZ), San Francisco (SFG vs real SF),
// and the Chicago White Sox (CHW vs real CWS). Any plain string-equality
// team-uniqueness check silently misses a conflict when one side used one
// form and the other used the synonym \u2014 which is exactly how two managers
// ended up with a White Sox player each despite an all-unique team rule.
// Normalize at comparison time so this is safe regardless of which form any
// given piece of code or already-stored data happens to use.
const TEAM_SYNONYMS = { ARI: 'AZ', SFG: 'SF', CHW: 'CWS' };
export function normTeam(t) {
  const up = (t || '').trim().toUpperCase();
  return TEAM_SYNONYMS[up] || up;
}

const MONTHS = ['January','February','March','April','May','June','July','August',
                'September','October','November','December'];
function monthKey(ts) {
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}
// Month-boundary checks (auto-promotion, redraft reminders) must NOT use raw
// server UTC time — the server can be up to ~10 hours ahead of US Pacific,
// which caused every league to flip to the new month hours before any real
// US user's calendar actually turned over, cutting off late West Coast games
// mid-sync. Use Hawaii-Aleutian time (UTC-10, no DST) instead — the last US
// timezone to reach any given day. The month only rolls over once it's
// already ~2-3am on the US mainland's west coast, by which point even
// extra-inning West Coast games have finished and synced. Not a mathematical
// guarantee for every conceivable case, but eliminates the realistic ones.
function lastTimezoneDateParts(ts) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Pacific/Honolulu', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date(ts));
  const get = t => parseInt(parts.find(p => p.type === t).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}
function lastTimezoneMonthKey(ts) {
  const { month, year } = lastTimezoneDateParts(ts);
  return `${MONTHS[month - 1]}-${year}`;
}
// Days remaining in the reference-timezone calendar month — used for the
// redraft reminder threshold, same timezone reasoning as above.
function lastTimezoneDaysLeftInMonth(ts) {
  const { year, month, day } = lastTimezoneDateParts(ts);
  const daysInMonth = new Date(year, month, 0).getDate(); // pure calendar math, no timezone involved
  return daysInMonth - day;
}
function monthSortKey(k) {
  const [m, y] = k.split('-');
  return parseInt(y) * 12 + MONTHS.indexOf(m);
}
function nextMonthKey(k) {
  const [m, y] = k.split('-');
  let mi = MONTHS.indexOf(m) + 1, yi = parseInt(y);
  if (mi > 11) { mi = 0; yi++; }
  return `${MONTHS[mi]}-${yi}`;
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

    // Get schedule for yesterday through tomorrow. Using "yesterday" (not
    // just "today") matters: raw UTC "today" can already be a new calendar
    // day while a game that started last evening in US time is still live —
    // querying from today onward would miss that game entirely and fall
    // through to the next scheduled one instead (confirmed live tonight:
    // a Giants game in progress was invisible to this query once the
    // server's UTC date ticked over past midnight while it was still
    // evening on the US west coast).
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const schedUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${yesterday}&endDate=${tomorrow}&teamId=${teamId}&hydrate=linescore`;
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


function logChange(league, player, delta, mgr, month, src, total) {
  if (!league.changeLog) league.changeLog = [];
  league.changeLog.push({ t: Date.now(), player, delta, mgr, month, src, total });
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
export async function runSyncForLeague(leagueId, sharedStatsCache = null) {
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
  // draftClosedAt must update on every completed draft, not just the league's
  // very first one ever — a league completes a new draft every redraft period,
  // and "Last draft completed" should reflect the most recent one, not be
  // frozen at whenever this code first ran for that league.
  if (league.draft && league.draft.status !== 'active') {
    console.log(`[sync:${leagueId}] Clearing stale draft object (status: ${league.draft.status})`);
    const completedMonth = league.draft.month;
    const completedAt = league.draft.completedAt || Date.now();
    league.draft = null;
    league.draftClosedAt = completedAt;
    if (completedMonth && league.months?.[completedMonth]) {
      league.months[completedMonth].rostersLiveAt = league.months[completedMonth].rostersLiveAt || completedAt;
    }
    await saveLeague(league);
  }

  // Auto-promote a pre-drafted future month once the real calendar reaches
  // it — this is the only place currentMonth changes based on real time.
  // A month can be pre-drafted while still in the future (see draft.mjs);
  // it just sits in league.months waiting until its calendar month arrives.
  const realMonth = lastTimezoneMonthKey(Date.now());
  if (realMonth !== league.currentMonth && league.months?.[realMonth] &&
      monthSortKey(realMonth) > monthSortKey(league.currentMonth)) {
    console.log(`[sync:${leagueId}] Promoting pre-drafted month ${realMonth} to current`);
    league.currentMonth = realMonth;
    if (!league.months[realMonth].rostersLiveAt) {
      league.months[realMonth].rostersLiveAt = Date.now();
    }
    await saveLeague(league);
  }

  // Lock a month that has already ended in real life but has nowhere to
  // promote to — i.e. the commissioner never opened next month's draft, so
  // the block above had no pre-drafted bucket to switch currentMonth into.
  // Without this, currentMonth just stays stuck on the ended month forever,
  // and every sync cycle keeps fetching live MLB stats and crediting new HR
  // to a month that's already over (confirmed in the Ghost of Peavy league:
  // no September draft was opened, so August kept accumulating HR straight
  // through September with no promotion to ever stop it). Once the
  // commissioner does open the next draft, the block above resumes
  // promoting normally — this only guards the gap in between.
  if (monthSortKey(realMonth) > monthSortKey(league.currentMonth)) {
    console.log(`[sync:${leagueId}] ${league.currentMonth} has ended (real month is ${realMonth}) with no next month drafted — locked, skipping sync until the next draft is opened`);
    delete league.lastSyncStartedAt;
    await saveLeague(league);
    return { ok: true, locked: true, month: league.currentMonth };
  }

  // Redraft reminder — nudge the commissioner (push notification) once per
  // league per target month when the current month is about to end and next
  // month hasn't been (pre-)drafted yet. Only applies to monthly-cadence
  // leagues. Deduped via redraftReminderSentFor so this fires exactly once
  // per target month, not every 3-minute sync cycle. Mirrors the same
  // in-app banner check in index.html's renderLeague.
  if ((league.settings?.redraftCadence || 'monthly') === 'monthly') {
    const daysLeftInMonth = lastTimezoneDaysLeftInMonth(Date.now());
    const nextMonth = nextMonthKey(league.currentMonth);
    const nextMonthDrafted = !!league.months?.[nextMonth];
    const nextMonthDraftInProgress = league.draft?.status === 'active' && league.draft?.month === nextMonth;
    if (daysLeftInMonth <= 2 && !nextMonthDrafted && !nextMonthDraftInProgress && league.redraftReminderSentFor !== nextMonth) {
      try {
        const { dispatchCommissionerNotification } = await import('./notify.mjs');
        await dispatchCommissionerNotification({
          league,
          title: `⏰ ${league.currentMonth.split('-')[0]} ends soon`,
          body: `Open ${nextMonth.split('-')[0]}'s draft so rosters are ready when it starts.`,
          url: `/league/${league.id}/draft`,
          tag: `redraft-reminder-${league.id}-${nextMonth}`,
        });
        console.log(`[sync:${leagueId}] Sent redraft reminder for ${nextMonth}`);
      } catch (e) {
        console.warn(`[sync:${leagueId}] Redraft reminder notification failed (non-fatal):`, e.message);
      }
      league.redraftReminderSentFor = nextMonth;
      await saveLeague(league);
    }
  }

  const key = league.currentMonth;
  if (!key || !league.months?.[key]) return { ok: false, error: 'No active month' };
  if (!league.seasonBaseline) league.seasonBaseline = {};
  if (!league.streaks)        league.streaks = {};
  if (!league.seasonHints)    league.seasonHints = {};
  if (!league.last24h)        league.last24h = {};
  if (!league.nextGame)       league.nextGame = {};
  if (!league.lastSyncedAt)   league.lastSyncedAt = {};

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

  // Fetch stats + next game + health in parallel. When multiple leagues
  // roster the same player, they should see the exact same live numbers —
  // and there's no reason to hit MLB's API once per league for identical
  // data. sharedStatsCache is one Map shared across every league synced in
  // this cron pass (see runSyncForAllLeagues): whichever league gets to a
  // given player first does the real fetch and populates it; every other
  // league that rosters the same player this pass reuses that result.
  const results = await Promise.all(players.map(async (p) => {
    const nk = normName(p);
    if (sharedStatsCache?.has(nk)) {
      return { player: p, ...sharedStatsCache.get(nk), ok: true };
    }
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
      const result = { ...stats, nextGame, health };
      sharedStatsCache?.set(nk, result);
      return { player: p, ...result, ok: true };
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
    const lastSyncedAt = league.lastSyncedAt[nk];
    const now = Date.now();
    // A player who sat on nobody's roster in this league for a real stretch
    // (dropped, or just never re-drafted) stops being synced entirely — their
    // baseline freezes at whatever it was. If they're later added to a
    // roster again, blindly diffing against that stale baseline would dump
    // every HR they hit during the ENTIRE untracked gap onto whoever just
    // added them, misattributed as if it happened the instant they were
    // added (confirmed: Juan Soto sat unrostered in "Jeff Thinks He Will
    // Win" for all of August, then got credited a HR the moment he was
    // drafted for September). A month-boundary promotion also stops and
    // restarts tracking, but within the same sync pass (see the auto-promote
    // block above) — so a genuinely continuous re-draft never sees more than
    // one cron cycle's gap. 20 minutes safely separates "just crossed a
    // month boundary or cron hiccupped" from "was actually off every roster
    // for a while" — anything past it re-anchors cleanly instead of crediting
    // the gap.
    const GAP_THRESHOLD_MS = 20 * 60 * 1000;
    const isStaleReentry = baseline !== undefined && lastSyncedAt !== undefined && (now - lastSyncedAt) > GAP_THRESHOLD_MS;

    // Set baseline if first time seeing this player, or re-anchor after a gap
    if (baseline === undefined || isStaleReentry) {
      if (isStaleReentry) {
        console.log(`[sync:${league.id}] ${r.player} re-entered a roster after ${Math.round((now - lastSyncedAt) / 60000)}min untracked — re-anchoring baseline instead of crediting the gap`);
      }
      league.seasonBaseline[nk] = r.seasonHR;
    }
    league.lastSyncedAt[nk] = now;

    const delta = (baseline !== undefined && !isStaleReentry) ? r.seasonHR - baseline : 0;
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
          logChange(league, slot.player, delta, mgr, key, 'sync', slot.hr);
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
  // Shared across every league synced in this pass — see the comment at its
  // use site in runSyncForLeague for why this exists.
  const sharedStatsCache = new Map();
  for (const entry of index) {
    try {
      const r = await runSyncForLeague(entry.id, sharedStatsCache);
      results.push(r);
    } catch (e) {
      results.push({ ok: false, leagueId: entry.id, error: e.message });
    }
  }
  return { ok: true, leagues: results.length, results };
}
