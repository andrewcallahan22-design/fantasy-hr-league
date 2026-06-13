// Shared league data endpoint.
// GET  -> league state (public read, no-cache headers so browsers never serve stale)
// POST -> save state. Sign-in required. Non-admins may only modify their OWN roster
//         entries; admins may modify any roster. Both can change settings shared
//         across the league (managers list, positions) — those are intentionally
//         editable by anyone signed in for a friends league.
import { loadLeagueState, saveLeagueState } from './lib/core.mjs';
import { verifyAuth } from './lib/auth.mjs';

const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Pragma': 'no-cache',
  'Expires': '0',
};

export default async (req) => {
  if (req.method === 'GET') {
    const state = await loadLeagueState();
    return Response.json(state, { headers: NO_CACHE });
  }

  if (req.method === 'POST') {
    const session = await verifyAuth(req);
    if (!session) {
      return Response.json({ ok: false, error: 'Sign in required to save changes' }, { status: 401 });
    }
    const incoming = await req.json().catch(() => null);
    if (!incoming || !incoming.managers || !incoming.months) {
      return Response.json({ ok: false, error: 'Invalid state payload' }, { status: 400 });
    }

    const current = await loadLeagueState();

    // Non-admin write: merge selectively so a manager can only edit their own
    // roster entries. Protects against a tampered frontend changing other rosters.
    if (!session.isAdmin) {
      const myMgr = session.manager;
      const safeMonths = {};
      for (const [mKey, mVal] of Object.entries(incoming.months || {})) {
        const baseMonth = current.months?.[mKey] || { rosters: {} };
        const safeRosters = { ...(baseMonth.rosters || {}) };
        if (mVal?.rosters?.[myMgr]) safeRosters[myMgr] = mVal.rosters[myMgr];
        safeMonths[mKey] = { ...baseMonth, ...mVal, rosters: safeRosters };
      }
      for (const [mKey, mVal] of Object.entries(current.months || {})) {
        if (!safeMonths[mKey]) safeMonths[mKey] = mVal;
      }
      const oldLog = current.changeLog || [];
      const incomingLog = incoming.changeLog || [];
      const newLog = incomingLog.length > oldLog.length
        ? oldLog.concat(incomingLog.slice(oldLog.length)).slice(-500)
        : oldLog;
      const merged = {
        ...current,
        ...incoming,
        months: safeMonths,
        seasonBaseline: current.seasonBaseline,
        playerIds: current.playerIds,
        draft: current.draft,
        lastSync: current.lastSync,
        changeLog: newLog,
      };
      await saveLeagueState(merged);
      return Response.json({ ok: true, role: 'manager' }, { headers: NO_CACHE });
    }

    // Admin write: trusted, but log is still append-only
    const oldLog = current.changeLog || [];
    const incomingLog = incoming.changeLog || [];
    const finalLog = incomingLog.length >= oldLog.length
      ? incomingLog.slice(-500)
      : oldLog.slice(-500);
    await saveLeagueState({
      ...incoming,
      seasonBaseline: incoming.seasonBaseline || current.seasonBaseline,
      playerIds: incoming.playerIds || current.playerIds,
      draft: incoming.draft || current.draft,
      lastSync: incoming.lastSync || current.lastSync,
      changeLog: finalLog,
    });
    return Response.json({ ok: true, role: 'admin' }, { headers: NO_CACHE });
  }

  return new Response('Method not allowed', { status: 405 });
};
