// Shared league data endpoint.
// GET  -> league state (no-cache so browsers don't serve stale)
// POST -> save state. Sign-in required. Non-admins can only modify their OWN roster.
//
// Critical merge rule for non-admin saves: we accept manual edits, but we must
// not let a manager's stale local state overwrite a fresh sync update. So for
// each slot, the incoming HR is accepted ONLY if it differs from the value the
// manager started with (tracked via a hidden _baseHr field the client stamps on
// load). Otherwise the server keeps whatever the latest sync wrote.
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

    // Non-admin write: per-slot conflict resolution prevents stale saves from
    // clobbering server-side sync updates.
    if (!session.isAdmin) {
      const myMgr = session.manager;
      const safeMonths = {};
      for (const [mKey, mVal] of Object.entries(incoming.months || {})) {
        const baseMonth = current.months?.[mKey] || { rosters: {} };
        const safeRosters = { ...(baseMonth.rosters || {}) };

        if (mVal?.rosters?.[myMgr]) {
          const myIncomingRoster = mVal.rosters[myMgr];
          const serverRoster = baseMonth.rosters?.[myMgr] || [];
          // Per-slot reconciliation: keep server's HR if the manager hasn't
          // actually changed it from what they originally loaded.
          safeRosters[myMgr] = myIncomingRoster.map((incSlot, i) => {
            const serverSlot = serverRoster[i] || {};
            const result = { ...incSlot };
            // Accept the incoming HR only if the manager actually edited it
            // (i.e., it differs from the _baseHr they pulled from the server).
            // If they didn't touch it, keep whatever sync wrote on the server.
            if (
              incSlot._baseHr !== undefined &&
              parseInt(incSlot.hr) === parseInt(incSlot._baseHr)
            ) {
              result.hr = serverSlot.hr;
            }
            delete result._baseHr;
            return result;
          });
        }
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

    // Admin: similar per-slot protection across all managers, since admin saves
    // can also race against the scheduled sync.
    const incomingMonths = incoming.months || {};
    const safeMonths = {};
    for (const [mKey, mVal] of Object.entries(incomingMonths)) {
      const baseMonth = current.months?.[mKey] || { rosters: {} };
      const safeRosters = {};
      const allMgrs = new Set([
        ...Object.keys(baseMonth.rosters || {}),
        ...Object.keys(mVal.rosters || {}),
      ]);
      for (const mgr of allMgrs) {
        const incomingRoster = mVal.rosters?.[mgr];
        const serverRoster = baseMonth.rosters?.[mgr] || [];
        if (!incomingRoster) {
          safeRosters[mgr] = serverRoster;
          continue;
        }
        safeRosters[mgr] = incomingRoster.map((incSlot, i) => {
          const serverSlot = serverRoster[i] || {};
          const result = { ...incSlot };
          if (
            incSlot._baseHr !== undefined &&
            parseInt(incSlot.hr) === parseInt(incSlot._baseHr)
          ) {
            result.hr = serverSlot.hr;
          }
          delete result._baseHr;
          return result;
        });
      }
      safeMonths[mKey] = { ...baseMonth, ...mVal, rosters: safeRosters };
    }
    for (const [mKey, mVal] of Object.entries(current.months || {})) {
      if (!safeMonths[mKey]) safeMonths[mKey] = mVal;
    }

    const oldLog = current.changeLog || [];
    const incomingLog = incoming.changeLog || [];
    const finalLog = incomingLog.length >= oldLog.length
      ? incomingLog.slice(-500)
      : oldLog.slice(-500);
    await saveLeagueState({
      ...incoming,
      months: safeMonths,
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
