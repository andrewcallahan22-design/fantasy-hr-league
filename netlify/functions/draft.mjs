// Draft endpoint — the monthly draft portal backend.
//
// League rules enforced SERVER-SIDE on every pick:
//   • 6 players per manager, 24 picks total
//   • Every player league-wide must come from a DIFFERENT MLB team (24 unique teams)
//   • Within a roster: positions all different, with at most ONE duplicate allowed
//   • Draft order: reverse of last month's standings (lowest HR total picks first),
//     same order every round; picks are casual — no clock
//
// GET  -> { draft, onClock, round, me, pool, takenTeams }
//         pool = top available HR hitters from the official MLB Stats API
//                (cached 10 min, drafted players filtered out)
// POST -> { action: 'open' | 'pick' | 'undo' }  (sign-in required)
//
// When the 24th pick lands, the new month's rosters are created automatically
// and the league switches to the new month.

import { getStore } from '@netlify/blobs';
import { verifyAuth } from './lib/auth.mjs';
import { loadLeagueState, saveLeagueState, normName } from './lib/core.mjs';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const ROSTER_SIZE = 6;

// Official MLB team IDs -> abbreviations (stable, from statsapi.mlb.com)
const TEAM_ABBR = {
  108:'LAA',109:'ARI',110:'BAL',111:'BOS',112:'CHC',113:'CIN',114:'CLE',115:'COL',
  116:'DET',117:'HOU',118:'KC',119:'LAD',120:'WSH',121:'NYM',133:'ATH',134:'PIT',
  135:'SD',136:'SEA',137:'SFG',138:'STL',139:'TB',140:'TEX',141:'TOR',142:'MIN',
  143:'PHI',144:'ATL',145:'CHW',146:'MIA',147:'NYY',158:'MIL'
};

function monthSortKey(k) {
  const [m, y] = k.split('-');
  return parseInt(y) * 12 + MONTHS.indexOf(m);
}

function nextMonthKey(latestKey) {
  const [m, y] = latestKey.split('-');
  let mi = MONTHS.indexOf(m) + 1, yi = parseInt(y);
  if (mi > 11) { mi = 0; yi++; }
  return `${MONTHS[mi]}-${yi}`;
}

function monthTotal(state, key, mgr) {
  return ((state.months[key]?.rosters?.[mgr]) || [])
    .reduce((s, p) => s + (parseInt(p.hr) || 0), 0);
}

export function positionsValid(positions) {
  const counts = {};
  for (const p of positions) { if (p) counts[p] = (counts[p] || 0) + 1; }
  let dups = 0;
  for (const c of Object.values(counts)) {
    if (c > 2) return false;
    if (c === 2) dups++;
  }
  return dups <= 1;
}

async function fetchPlayerPool() {
  const store = getStore('league');
  const cached = await store.get('playerPool', { type: 'json' });
  if (cached && Date.now() - cached.t < 10 * 60 * 1000) return cached.pool;

  const url = 'https://statsapi.mlb.com/api/v1/stats/leaders?leaderCategories=homeRuns&statGroup=hitting&season=2026&sportId=1&limit=150';
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`MLB leaders ${resp.status}`);
  const data = await resp.json();
  const leaders = data?.leagueLeaders?.[0]?.leaders || [];
  const pool = leaders.map(l => ({
    name: l?.person?.fullName || '',
    team: TEAM_ABBR[l?.team?.id] || l?.team?.abbreviation || '?',
    pos: l?.position?.abbreviation || '',
    hr: parseInt(l?.value) || 0,
    rank: l?.rank || 0,
  })).filter(p => p.name);

  await store.setJSON('playerPool', { t: Date.now(), pool });
  return pool;
}

function draftView(state, session) {
  const d = state.draft || null;
  let onClock = null, round = 0;
  if (d && d.status === 'active') {
    onClock = d.order[d.picks.length % d.order.length];
    round = Math.floor(d.picks.length / d.order.length) + 1;
  }
  return { draft: d, onClock, round, me: session ? session.manager : null };
}

export default async (req) => {
  const state = await loadLeagueState();
  const session = await verifyAuth(req);

  if (req.method === 'GET') {
    let pool = [], poolError = null;
    try { pool = await fetchPlayerPool(); }
    catch (e) { poolError = e.message; }

    const d = state.draft;
    const active = d && d.status === 'active';
    const takenTeams = active ? d.picks.map(p => p.team) : [];
    const takenPlayers = active ? d.picks.map(p => normName(p.player)) : [];
    const available = pool.filter(p => !takenPlayers.includes(normName(p.name)));

    return Response.json({
      ...draftView(state, session),
      pool: available,
      takenTeams,
      poolError,
      latestMonth: Object.keys(state.months).sort((a, b) => monthSortKey(a) - monthSortKey(b)).pop() || null,
    });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!session) return Response.json({ ok: false, error: 'Sign in required' }, { status: 401 });
  const body = await req.json().catch(() => ({}));

  // ── OPEN a new draft for the next month ──
  if (body.action === 'open') {
    if (state.draft && state.draft.status === 'active') {
      return Response.json({ ok: false, error: 'A draft is already in progress' }, { status: 400 });
    }
    const keys = Object.keys(state.months).sort((a, b) => monthSortKey(a) - monthSortKey(b));
    const latest = keys[keys.length - 1];
    const newMonth = nextMonthKey(latest);
    if (state.months[newMonth]) {
      return Response.json({ ok: false, error: `${newMonth} already exists` }, { status: 400 });
    }
    // Reverse standings of the latest month: lowest total picks first
    const order = [...state.managers].sort((a, b) => monthTotal(state, latest, a) - monthTotal(state, latest, b));
    state.draft = {
      month: newMonth,
      basedOn: latest,
      status: 'active',
      order,
      picks: [],
      createdAt: Date.now(),
      openedBy: session.manager,
    };
    await saveLeagueState(state);
    return Response.json({ ok: true, ...draftView(state, session) });
  }

  // ── MAKE a pick ──
  if (body.action === 'pick') {
    const d = state.draft;
    if (!d || d.status !== 'active') {
      return Response.json({ ok: false, error: 'No active draft' }, { status: 400 });
    }
    const onClock = d.order[d.picks.length % d.order.length];
    if (session.manager !== onClock) {
      return Response.json({ ok: false, error: `It's ${onClock}'s pick, not yours` }, { status: 403 });
    }
    const { player, team, pos, hr } = body.pick || {};
    if (!player || !team || !pos) {
      return Response.json({ ok: false, error: 'A pick needs player, team, and position' }, { status: 400 });
    }
    if (d.picks.some(p => normName(p.player) === normName(player))) {
      return Response.json({ ok: false, error: `${player} has already been drafted` }, { status: 400 });
    }
    if (d.picks.some(p => p.team === team)) {
      return Response.json({ ok: false, error: `${team} is already taken this month — every pick league-wide must be from a different MLB team` }, { status: 400 });
    }
    const myPositions = d.picks.filter(p => p.mgr === session.manager).map(p => p.pos);
    if (!positionsValid([...myPositions, pos])) {
      return Response.json({ ok: false, error: 'Position rule: all positions different, with at most one duplicate' }, { status: 400 });
    }

    d.picks.push({ mgr: session.manager, player, team, pos, hr: parseInt(hr) || 0, t: Date.now() });

    // ── Finalize when the 24th pick lands ──
    if (d.picks.length === d.order.length * ROSTER_SIZE) {
      const rosters = {};
      state.managers.forEach(m => { rosters[m] = []; });
      d.picks.forEach(p => rosters[p.mgr].push({ player: p.player, team: p.team, position: p.pos, hr: 0 }));
      state.months[d.month] = { rosters };
      state.currentMonth = d.month;
      d.status = 'complete';
      d.completedAt = Date.now();
    }
    await saveLeagueState(state);
    return Response.json({ ok: true, ...draftView(state, session) });
  }

  // ── UNDO your own last pick (casual-league mercy rule) ──
  if (body.action === 'undo') {
    const d = state.draft;
    if (!d || d.status !== 'active' || !d.picks.length) {
      return Response.json({ ok: false, error: 'Nothing to undo' }, { status: 400 });
    }
    const last = d.picks[d.picks.length - 1];
    if (last.mgr !== session.manager) {
      return Response.json({ ok: false, error: 'Only the most recent picker can undo' }, { status: 403 });
    }
    d.picks.pop();
    await saveLeagueState(state);
    return Response.json({ ok: true, ...draftView(state, session) });
  }

  return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 });
};
