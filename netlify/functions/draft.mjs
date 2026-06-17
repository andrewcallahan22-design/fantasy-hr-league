// Draft endpoint — per-league. Requires ?leagueId=ID on every request.
//
// Rules enforced server-side:
//   • rosterSize picks per manager
//   • Team uniqueness governed by league.settings.teamRule
//   • Position rule governed by league.settings.positionRule
//   • Draft order: reverse of latest month's standings
//   • Picks are casual (no clock)
//
// On final pick: creates next month's rosters and switches currentMonth.

import { getStore } from '@netlify/blobs';
import { verifyAuth, isCommissioner, managerForUser } from './lib/auth.mjs';
import { loadLeague, saveLeague, ensureLegacyMigrated } from './lib/storage.mjs';
import { normName } from './lib/core.mjs';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

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
function nextMonthKey(latest) {
  const [m, y] = latest.split('-');
  let mi = MONTHS.indexOf(m) + 1, yi = parseInt(y);
  if (mi > 11) { mi = 0; yi++; }
  return `${MONTHS[mi]}-${yi}`;
}
function monthTotal(league, key, mgr) {
  return ((league.months[key]?.rosters?.[mgr]) || [])
    .reduce((s, p) => s + (parseInt(p.hr) || 0), 0);
}
export function positionsValid(positions, rule) {
  if (rule === 'unrestricted') return true;
  const counts = {};
  for (const p of positions) if (p) counts[p] = (counts[p] || 0) + 1;
  if (rule === 'all-unique') {
    return Object.values(counts).every(c => c <= 1);
  }
  // default: one-duplicate-allowed
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

function draftView(league, session) {
  const d = league.draft || null;
  let onClock = null, round = 0;
  if (d && d.status === 'active') {
    onClock = d.order[d.picks.length % d.order.length];
    round = Math.floor(d.picks.length / d.order.length) + 1;
  }
  const myManager = session ? managerForUser(league, session.email) : null;
  return { draft: d, onClock, round, me: myManager };
}

export default async (req) => {
  await ensureLegacyMigrated();
  const url = new URL(req.url);
  const leagueId = url.searchParams.get('leagueId') || (req.method === 'POST' ? (await req.clone().json().catch(() => ({}))).leagueId : null);
  if (!leagueId) return Response.json({ ok: false, error: 'leagueId required' }, { status: 400 });

  const league = await loadLeague(leagueId);
  if (!league) return Response.json({ ok: false, error: 'League not found' }, { status: 404 });

  const session = await verifyAuth(req);
  const myMgr = session ? managerForUser(league, session.email) : null;

  if (req.method === 'GET') {
    let pool = [], poolError = null;
    try { pool = await fetchPlayerPool(); }
    catch (e) { poolError = e.message; }

    const d = league.draft;
    const active = d && d.status === 'active';
    const takenTeams = active ? d.picks.map(p => p.team) : [];
    const takenPlayers = active ? d.picks.map(p => normName(p.player)) : [];
    const available = pool.filter(p => !takenPlayers.includes(normName(p.name)));

    return Response.json({
      ...draftView(league, session),
      pool: available,
      takenTeams,
      poolError,
      rosterSize: league.settings?.rosterSize || 6,
      positionsAllowed: league.settings?.positionsAllowed || league.positions || [],
      teamRule: league.settings?.teamRule || 'all-unique',
      positionRule: league.settings?.positionRule || 'one-duplicate-allowed',
    });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!session) return Response.json({ ok: false, error: 'Sign in required' }, { status: 401 });
  const body = await req.json().catch(() => ({}));

  if (body.action === 'open') {
    if (!isCommissioner(league, session.email) && !session.isAdmin) {
      return Response.json({ ok: false, error: 'Only the commissioner can open a draft' }, { status: 403 });
    }
    if (league.draft && league.draft.status === 'active') {
      return Response.json({ ok: false, error: 'A draft is already in progress' }, { status: 400 });
    }
    const keys = Object.keys(league.months).sort((a, b) => monthSortKey(a) - monthSortKey(b));
    const latest = keys[keys.length - 1] || league.currentMonth;
    const newMonth = nextMonthKey(latest);
    if (league.months[newMonth]) {
      return Response.json({ ok: false, error: `${newMonth} already exists` }, { status: 400 });
    }
    const order = [...league.managers].sort((a, b) => monthTotal(league, latest, a) - monthTotal(league, latest, b));
    league.draft = {
      month: newMonth, basedOn: latest, status: 'active', order, picks: [],
      createdAt: Date.now(), openedBy: session.email,
    };
    await saveLeague(league);
    return Response.json({ ok: true, ...draftView(league, session) });
  }

  if (body.action === 'pick') {
    const d = league.draft;
    if (!d || d.status !== 'active') return Response.json({ ok: false, error: 'No active draft' }, { status: 400 });
    const onClock = d.order[d.picks.length % d.order.length];
    if (myMgr !== onClock && !session.isAdmin) {
      return Response.json({ ok: false, error: `It's ${onClock}'s pick, not yours` }, { status: 403 });
    }
    const { player, team, pos, hr } = body.pick || {};
    if (!player || !team || !pos) return Response.json({ ok: false, error: 'Pick needs player, team, position' }, { status: 400 });
    if (!league.settings?.multiPlayerPerTeam) {
      if (d.picks.some(p => normName(p.player) === normName(player))) {
        return Response.json({ ok: false, error: `${player} has already been drafted` }, { status: 400 });
      }
    }
    if (league.settings?.teamRule === 'all-unique' && d.picks.some(p => p.team === team)) {
      return Response.json({ ok: false, error: `${team} is already taken — league uses unique-team rule` }, { status: 400 });
    }
    const myPositions = d.picks.filter(p => p.mgr === onClock).map(p => p.pos);
    if (!positionsValid([...myPositions, pos], league.settings?.positionRule || 'one-duplicate-allowed')) {
      return Response.json({ ok: false, error: 'Position rule violated for your roster' }, { status: 400 });
    }
    d.picks.push({ mgr: onClock, player, team, pos, hr: parseInt(hr) || 0, t: Date.now() });

    if (d.picks.length === d.order.length * (league.settings?.rosterSize || 6)) {
      const rosters = {};
      league.managers.forEach(m => { rosters[m] = []; });
      d.picks.forEach(p => rosters[p.mgr].push({ player: p.player, team: p.team, position: p.pos, hr: 0 }));
      league.months[d.month] = { rosters };
      league.currentMonth = d.month;
      d.status = 'complete';
      d.completedAt = Date.now();
    }
    await saveLeague(league);
    return Response.json({ ok: true, ...draftView(league, session) });
  }

  if (body.action === 'undo') {
    const d = league.draft;
    if (!d || d.status !== 'active' || !d.picks.length) {
      return Response.json({ ok: false, error: 'Nothing to undo' }, { status: 400 });
    }
    const last = d.picks[d.picks.length - 1];
    if (last.mgr !== myMgr && !session.isAdmin && !isCommissioner(league, session.email)) {
      return Response.json({ ok: false, error: 'Only the picker (or commissioner) can undo' }, { status: 403 });
    }
    d.picks.pop();
    await saveLeague(league);
    return Response.json({ ok: true, ...draftView(league, session) });
  }

  return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 });
};
