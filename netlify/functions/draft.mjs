// Draft endpoint — per-league. Requires ?leagueId=ID on every request.
//
// GET  ?leagueId=ID          → draft state + player pool (400 hitters)
// POST { action: 'open',  leagueId, draftType, rounds, order? }
// POST { action: 'pick',  leagueId, pick: {player,team,pos,hr,mlbId} }
// POST { action: 'undo',  leagueId }
// POST { action: 'skip',  leagueId, manager }  (commissioner only)
// POST { action: 'close', leagueId }            (commissioner only)

import { getStore } from '@netlify/blobs';
import { verifyAuth, isCommissioner, managerForUser } from './lib/auth.mjs';
import { loadLeague, saveLeague, ensureLegacyMigrated } from './lib/storage.mjs';
import { normName } from './lib/core.mjs';

const MONTHS = ['January','February','March','April','May','June','July','August',
                'September','October','November','December'];

const TEAM_ABBR = {
  108:'LAA',109:'ARI',110:'BAL',111:'BOS',112:'CHC',113:'CIN',114:'CLE',115:'COL',
  116:'DET',117:'HOU',118:'KC', 119:'LAD',120:'WSH',121:'NYM',133:'ATH',134:'PIT',
  135:'SD', 136:'SEA',137:'SFG',138:'STL',139:'TB', 140:'TEX',141:'TOR',142:'MIN',
  143:'PHI',144:'ATL',145:'CHW',146:'MIA',147:'NYY',158:'MIL',
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
function prevMonthKey(latest) {
  const [m, y] = latest.split('-');
  let mi = MONTHS.indexOf(m) - 1, yi = parseInt(y);
  if (mi < 0) { mi = 11; yi--; }
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
  if (rule === 'all-unique') return Object.values(counts).every(c => c <= 1);
  let dups = 0;
  for (const c of Object.values(counts)) {
    if (c > 2) return false;
    if (c === 2) dups++;
  }
  return dups <= 1;
}

// ── Player pool ──
// Fetches top 400 hitters by season HR from the MLB Stats API.
// Pool is cached in Netlify Blobs for 5 minutes.
async function fetchPlayerPool() {
  const store = getStore('league');
  const cacheKey = `playerPool-v4`;
  const cached = await store.get(cacheKey, { type: 'json' });
  if (cached && Date.now() - cached.t < 5 * 60 * 1000) return cached.pool;

  const season = new Date().getFullYear();

  // Fetch top 400 hitters by HR — hydrate person with primaryPosition
  const hrUrl = `https://statsapi.mlb.com/api/v1/stats/leaders?leaderCategories=homeRuns&statGroup=hitting&season=${season}&sportId=1&limit=400&hydrate=person(primaryPosition),team`;
  const hrResp = await fetch(hrUrl);
  if (!hrResp.ok) throw new Error(`MLB leaders ${hrResp.status}`);
  const hrData = await hrResp.json();
  const leaders = hrData?.leagueLeaders?.[0]?.leaders || [];

  // Fetch full player roster with positions as a reliable fallback.
  // The leaders endpoint sometimes returns blank position for some players.
  let posMap = {};
  try {
    const rosterUrl = `https://statsapi.mlb.com/api/v1/sports/1/players?season=${season}&gameType=R&fields=people,id,primaryPosition,abbreviation`;
    const rosterResp = await fetch(rosterUrl);
    if (rosterResp.ok) {
      const rosterData = await rosterResp.json();
      for (const p of (rosterData.people || [])) {
        if (p.id && p.primaryPosition?.abbreviation) {
          posMap[p.id] = p.primaryPosition.abbreviation;
        }
      }
    }
  } catch {}

  // Fetch injury/roster status from the same endpoint
  let injuryMap = {};
  try {
    const ilUrl = `https://statsapi.mlb.com/api/v1/sports/1/players?season=${season}&gameType=R&fields=people,id,status,code`;
    const ilResp = await fetch(ilUrl);
    if (ilResp.ok) {
      const ilData = await ilResp.json();
      for (const p of (ilData.people || [])) {
        injuryMap[p.id] = p.status?.code || 'A';
      }
    }
  } catch {}

  const pool = leaders.map(l => {
    const id = l?.person?.id;
    const statusCode = id ? (injuryMap[id] || 'A') : 'A';
    let health = 'Active';
    if (statusCode.startsWith('D') || statusCode === 'DL') health = 'IL';
    else if (statusCode !== 'A') health = statusCode;

    // Position resolution — try 3 sources in order of reliability:
    // 1. Full player roster endpoint (most reliable)
    // 2. Leader entry position field
    // 3. Person primaryPosition from hydration
    const pos = (id && posMap[id])
      || l?.position?.abbreviation
      || l?.person?.primaryPosition?.abbreviation
      || '?';

    return {
      id,
      name:   l?.person?.fullName || '',
      team:   TEAM_ABBR[l?.team?.id] || l?.team?.abbreviation || '?',
      pos,
      hr:     parseInt(l?.value) || 0,
      prevHR: 0,
      health,
      rank:   l?.rank || 0,
    };
  }).filter(p => p.name);

  await store.setJSON(cacheKey, { t: Date.now(), pool });
  return pool;
}

function snakeOrder(managers, rounds) {
  const order = [];
  for (let r = 0; r < rounds; r++) {
    const row = r % 2 === 0 ? [...managers] : [...managers].reverse();
    order.push(...row);
  }
  return order;
}
function straightOrder(managers, rounds) {
  const order = [];
  for (let r = 0; r < rounds; r++) order.push(...managers);
  return order;
}

function draftView(league, session) {
  const d = league.draft || null;
  let onClock = null, round = 0, pick = 0;
  if (d && d.status === 'active') {
    pick = d.picks.length;
    onClock = d.fullOrder ? d.fullOrder[pick] : d.order[pick % d.order.length];
    round = d.fullOrder
      ? Math.floor(pick / d.order.length) + 1
      : Math.floor(pick / d.order.length) + 1;
  }
  const myManager = session ? managerForUser(league, session.email) : null;
  return { draft: d, onClock, round, pickNumber: (d?.picks?.length || 0) + 1, me: myManager };
}

export default async (req) => {
  await ensureLegacyMigrated();
  const url = new URL(req.url);
  const leagueId = url.searchParams.get('leagueId') ||
    (req.method === 'POST' ? (await req.clone().json().catch(() => ({}))).leagueId : null);
  if (!leagueId) return Response.json({ ok: false, error: 'leagueId required' }, { status: 400 });

  const league = await loadLeague(leagueId);
  if (!league) return Response.json({ ok: false, error: 'League not found' }, { status: 404 });

  const session = await verifyAuth(req);
  const myMgr = session ? managerForUser(league, session.email) : null;

  if (req.method === 'GET') {
    // Figure out which month to show prev-month HRs from.
    // "basedOn" is the most recent completed month (what draft order is based on).
    const keys = Object.keys(league.months || {}).sort((a, b) => monthSortKey(a) - monthSortKey(b));
    const basedOn = league.draft?.basedOn || (keys.length ? keys[keys.length - 1] : null);

    // Build a name → HR map from the league's own stored roster data for basedOn month.
    // This is fast, accurate, and already correct — no MLB API call needed.
    // Only covers players currently on rosters, but that's exactly who needs accurate
    // prev-month numbers for draft context. Everyone else shows 0 or — which is fine.
    const prevMonthRosterHR = {};
    if (basedOn && league.months?.[basedOn]) {
      for (const mgr of (league.managers || [])) {
        for (const slot of (league.months[basedOn].rosters?.[mgr] || [])) {
          if (slot.player) {
            const nk = normName(slot.player);
            prevMonthRosterHR[nk] = (prevMonthRosterHR[nk] || 0) + (parseInt(slot.hr) || 0);
          }
        }
      }
    }

    let pool = [], poolError = null;
    try { pool = await fetchPlayerPool(); }
    catch (e) { poolError = e.message; }

    // Overlay prev month HRs from league data onto the pool
    pool = pool.map(p => ({
      ...p,
      prevHR: prevMonthRosterHR[normName(p.name)] ?? p.prevHR ?? 0,
    }));

    const d = league.draft;
    const picks = d?.picks || [];
    const takenNorms  = picks.map(p => normName(p.player));
    const takenTeams  = new Set(picks.filter(p => !p.skipped).map(p => p.team));

    // Per-manager position counts — used for position rule enforcement
    const mgrPosCounts = {};
    for (const mgr of (league.managers || [])) {
      mgrPosCounts[mgr] = {};
      for (const pk of picks.filter(p => p.mgr === mgr && !p.skipped)) {
        mgrPosCounts[mgr][pk.pos] = (mgrPosCounts[mgr][pk.pos] || 0) + 1;
      }
    }

    const poolWithStatus = pool.map(p => {
      const isPlayerDrafted = takenNorms.includes(normName(p.name));
      const isTeamTaken     = takenTeams.has(p.team);
      const draftedBy = isPlayerDrafted
        ? (picks.find(pk => normName(pk.player) === normName(p.name))?.mgr || null)
        : isTeamTaken
          ? (picks.find(pk => pk.team === p.team && !pk.skipped)?.mgr || null)
          : null;

      return {
        ...p,
        drafted:      isPlayerDrafted || isTeamTaken,
        draftedBy,
        teamTaken:    isTeamTaken && !isPlayerDrafted, // team taken but not this specific player
      };
    });

    // Build per-manager roster view for the draft
    const rosterViews = {};
    if (d) {
      for (const mgr of league.managers) {
        const mgrPicks = picks.filter(p => p.mgr === mgr);
        const slots = Array.from({ length: d.rounds || league.settings?.rosterSize || 6 }, (_, i) => mgrPicks[i] || null);
        rosterViews[mgr] = slots;
      }
    }

    return Response.json({
      ok: true,
      ...draftView(league, session),
      pool: poolWithStatus,
      poolError,
      rosterViews,
      mgrPosCounts,
      takenTeams: [...takenTeams],
      managers: league.managers,
      rosterSize: league.settings?.rosterSize || 6,
      positionsAllowed: league.settings?.positionsAllowed || league.positions || [],
      teamRule: league.settings?.teamRule || 'all-unique',
      positionRule: league.settings?.positionRule || 'one-duplicate-allowed',
      isCommish: session ? isCommissioner(league, session.email) : false,
    });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!session) return Response.json({ ok: false, error: 'Sign in required' }, { status: 401 });
  const body = await req.json().catch(() => ({}));

  // ── OPEN DRAFT ──
  if (body.action === 'open') {
    if (!isCommissioner(league, session.email) && !session.isAdmin) {
      return Response.json({ ok: false, error: 'Only the commissioner can open a draft' }, { status: 403 });
    }
    if (league.draft?.status === 'active') {
      return Response.json({ ok: false, error: 'A draft is already in progress' }, { status: 400 });
    }
    const keys = Object.keys(league.months || {}).sort((a, b) => monthSortKey(a) - monthSortKey(b));
    const latest = keys[keys.length - 1] || league.currentMonth;
    const newMonth = nextMonthKey(latest);
    if (league.months?.[newMonth]) {
      return Response.json({ ok: false, error: `${newMonth} already exists` }, { status: 400 });
    }

    // Draft order: reverse of SEASON-LONG standings (worst total HR picks first).
    // Sums HR across all months so the manager who struggled all season gets
    // the first pick — fairer than just the prior month.
    const seasonTotals = (mgr) =>
      Object.keys(league.months || {}).reduce((s, k) => s + monthTotal(league, k, mgr), 0);

    const baseOrder = (body.order?.length === league.managers.length)
      ? body.order
      : [...league.managers].sort((a, b) => seasonTotals(a) - seasonTotals(b));

    // Default to straight draft (1-2-3-4 repeating), not snake.
    const draftType = body.draftType || league.settings?.draftType || 'straight';
    const rounds    = parseInt(body.rounds) || league.settings?.rosterSize || 6;
    const fullOrder = draftType === 'snake'
      ? snakeOrder(baseOrder, rounds)
      : straightOrder(baseOrder, rounds);

    league.draft = {
      month: newMonth, basedOn: latest, status: 'active',
      draftType, rounds,
      order: baseOrder,   // base order (without snake reversal)
      fullOrder,          // fully expanded pick-by-pick order
      picks: [],
      createdAt: Date.now(), openedBy: session.email,
    };
    await saveLeague(league);
    return Response.json({ ok: true, ...draftView(league, session) });
  }

  // ── MAKE A PICK ──
  if (body.action === 'pick') {
    const d = league.draft;
    if (!d || d.status !== 'active') {
      return Response.json({ ok: false, error: 'No active draft' }, { status: 400 });
    }
    const pickIdx = d.picks.length;
    const onClock = d.fullOrder ? d.fullOrder[pickIdx] : d.order[pickIdx % d.order.length];

    // Commissioner can pick for anyone; regular managers only pick for themselves
    if (myMgr !== onClock && !session.isAdmin && !isCommissioner(league, session.email)) {
      return Response.json({ ok: false, error: `It's ${onClock}'s pick, not yours` }, { status: 403 });
    }
    const { player, team, pos, hr, mlbId } = body.pick || {};
    if (!player || !team) {
      return Response.json({ ok: false, error: 'Pick needs player and team' }, { status: 400 });
    }
    // pos can be empty/unknown for some players (e.g. two-way players) — default to '?'
    const safePos = pos || '?';

    // Player uniqueness
    if (!league.settings?.multiPlayerPerTeam) {
      if (d.picks.some(p => normName(p.player) === normName(player))) {
        return Response.json({ ok: false, error: `${player} has already been drafted` }, { status: 400 });
      }
    }

    // Team rule
    if (league.settings?.teamRule === 'all-unique') {
      const allTeams = d.picks.map(p => p.team);
      if (allTeams.includes(team)) {
        return Response.json({ ok: false, error: `${team} is already taken — league uses unique-team rule` }, { status: 400 });
      }
    }

    // Position rule for this manager
    const myPos = d.picks.filter(p => p.mgr === onClock).map(p => p.pos);
    if (safePos !== '?' && !positionsValid([...myPos, safePos], league.settings?.positionRule || 'one-duplicate-allowed')) {
      return Response.json({ ok: false, error: 'Position rule violated for your roster' }, { status: 400 });
    }

    d.picks.push({ mgr: onClock, player, team, pos: safePos, hr: parseInt(hr) || 0, mlbId, t: Date.now() });

    // Draft complete when all picks are done
    const totalPicks = d.fullOrder ? d.fullOrder.length : d.order.length * d.rounds;
    if (d.picks.length >= totalPicks) {
      // Auto-populate the new month's rosters
      const rosters = {};
      league.managers.forEach(m => { rosters[m] = []; });
      for (const p of d.picks) {
        rosters[p.mgr] = rosters[p.mgr] || [];
        rosters[p.mgr].push({ player: p.player, team: p.team, position: p.pos, hr: 0 });
      }
      // Pad any short rosters to rosterSize
      const rs = league.settings?.rosterSize || 6;
      for (const m of league.managers) {
        while (rosters[m].length < rs) rosters[m].push({ player: '', team: '', position: '', hr: 0 });
      }
      league.months[d.month] = { rosters };
      league.currentMonth = d.month;
      d.status = 'complete';
      d.completedAt = Date.now();
    }
    await saveLeague(league);
    return Response.json({ ok: true, ...draftView(league, session) });
  }

  // ── UNDO LAST PICK ──
  if (body.action === 'undo') {
    const d = league.draft;
    if (!d || d.status !== 'active' || !d.picks.length) {
      return Response.json({ ok: false, error: 'Nothing to undo' }, { status: 400 });
    }
    const last = d.picks[d.picks.length - 1];
    if (last.mgr !== myMgr && !session.isAdmin && !isCommissioner(league, session.email)) {
      return Response.json({ ok: false, error: 'Only the picker or commissioner can undo' }, { status: 403 });
    }
    d.picks.pop();
    await saveLeague(league);
    return Response.json({ ok: true, ...draftView(league, session) });
  }

  // ── SKIP (commissioner advances past a stalled manager) ──
  if (body.action === 'skip') {
    if (!isCommissioner(league, session.email) && !session.isAdmin) {
      return Response.json({ ok: false, error: 'Only the commissioner can skip' }, { status: 403 });
    }
    const d = league.draft;
    if (!d || d.status !== 'active') {
      return Response.json({ ok: false, error: 'No active draft' }, { status: 400 });
    }
    const pickIdx = d.picks.length;
    const onClock = d.fullOrder ? d.fullOrder[pickIdx] : d.order[pickIdx % d.order.length];
    // Insert a "skipped" placeholder pick
    d.picks.push({ mgr: onClock, player: '— skipped —', team: '?', pos: '?', hr: 0, skipped: true, t: Date.now() });
    await saveLeague(league);
    return Response.json({ ok: true, ...draftView(league, session) });
  }

  // ── CLOSE DRAFT (commissioner resets) ──
  if (body.action === 'close') {
    if (!isCommissioner(league, session.email) && !session.isAdmin) {
      return Response.json({ ok: false, error: 'Only the commissioner can close the draft' }, { status: 403 });
    }
    league.draft = null;
    await saveLeague(league);
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 });
};
