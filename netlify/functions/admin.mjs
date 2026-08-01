// Admin dashboard endpoint — only accessible to isAdmin users.
// Returns full data on all leagues for the super admin backdoor view.
//
// GET  ?action=leagues          → all leagues with summary stats
// GET  ?action=league&id=ID     → full detail on one league
// POST { action: 'delete-league', leagueId }  → hard delete a league

import { listLeagues, loadLeague, saveLeague } from './lib/storage.mjs';
import { verifyAuth, isAdminEmail } from './lib/auth.mjs';
import { normName } from './lib/core.mjs';
import { getStore } from '@netlify/blobs';

const NO_CACHE = { 'Cache-Control': 'no-store' };

export default async (req) => {
  // Admin only — reject everyone else immediately
  const session = await verifyAuth(req);
  if (!session || !isAdminEmail(session.email)) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 403, headers: NO_CACHE });
  }

  const url    = new URL(req.url);
  const action = url.searchParams.get('action') || (req.method === 'POST' ? (await req.clone().json().catch(() => ({}))).action : null);

  // ── LIST ALL LEAGUES ──
  if (req.method === 'GET' && action === 'leagues') {
    const index  = await listLeagues();
    const leagues = await Promise.all(index.map(async entry => {
      const lg = await loadLeague(entry.id);
      if (!lg) return null;
      const months       = Object.keys(lg.months || {});
      const activeMonth  = lg.currentMonth;
      const totalHR      = activeMonth && lg.months[activeMonth]
        ? Object.values(lg.months[activeMonth].rosters || {})
            .flat().reduce((s, p) => s + (parseInt(p.hr) || 0), 0)
        : 0;
      const members = lg.members || [];
      return {
        id:            lg.id,
        name:          lg.name,
        commissioner:  lg.commissioner,
        createdAt:     lg.createdAt,
        currentMonth:  lg.currentMonth,
        monthCount:    months.length,
        memberCount:   members.filter(m => m.status === 'active').length,
        pendingCount:  members.filter(m => m.status === 'pending').length,
        managers:      (lg.managers || []),
        lastSync:      lg.lastSync || null,
        draftStatus:   lg.draft?.status || null,
        totalHRThisMonth: totalHR,
        members:       members.map(m => ({
          manager:  m.manager,
          realName: m.realName || '',
          email:    m.email || '',
          status:   m.status,
          joinedAt: m.joinedAt,
        })),
      };
    }));
    return Response.json({
      ok: true,
      leagues: leagues.filter(Boolean).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
      total: leagues.filter(Boolean).length,
    }, { headers: NO_CACHE });
  }

  // ── FULL LEAGUE DETAIL ──
  if (req.method === 'GET' && action === 'league') {
    const id = url.searchParams.get('id');
    if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });
    const lg = await loadLeague(id);
    if (!lg) return Response.json({ ok: false, error: 'Not found' }, { status: 404 });
    return Response.json({ ok: true, league: lg }, { headers: NO_CACHE });
  }

  // ── FEEDBACK SUBMISSIONS ──
  if (req.method === 'GET' && action === 'feedback') {
    const store = getStore('league');
    const entries = (await store.get('feedback', { type: 'json' })) || [];
    return Response.json({
      ok: true,
      feedback: [...entries].reverse(), // newest first
      total: entries.length,
    }, { headers: NO_CACHE });
  }

  // ── POST ACTIONS ──
  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));

    // Pure currentMonth pointer flip — no roster data touched at all. For
    // recovering a league that got auto-promoted to a month too early (e.g.
    // the UTC-vs-Eastern timezone bug): both months already have real roster
    // data, so the normal set-current-month action's merge/migrate logic
    // would incorrectly overwrite one month's data with the other's. This
    // just moves the pointer back, leaving every month bucket untouched.
    // Surgically set a specific roster slot's hr value — does NOT touch
    // currentMonth, other players, or anything else. For reconciling HR
    // credit after a data-correction incident (e.g. moving/zeroing HRs that
    // got attributed to the wrong month's roster), where the blunt
    // emergency-restore action (which force-sets currentMonth as a side
    // effect) would be the wrong tool.
    if (body.action === 'patch-roster-hr') {
      const { leagueId, month, patches } = body;
      if (!leagueId || !month || !Array.isArray(patches)) {
        return Response.json({ ok: false, error: 'leagueId, month, patches[] required' }, { status: 400 });
      }
      const lg = await loadLeague(leagueId);
      if (!lg) return Response.json({ ok: false, error: 'League not found' }, { status: 404 });
      const results = [];
      for (const { mgr, player, hr } of patches) {
        const roster = lg.months?.[month]?.rosters?.[mgr];
        const slot = roster?.find(s => normName(s.player) === normName(player));
        if (!slot) { results.push({ mgr, player, ok: false, error: 'slot not found' }); continue; }
        const from = slot.hr;
        slot.hr = parseInt(hr) || 0;
        results.push({ mgr, player, ok: true, from, to: slot.hr });
      }
      await saveLeague(lg);
      return Response.json({ ok: true, results }, { headers: NO_CACHE });
    }

    if (body.action === 'set-current-month-only') {
      const { leagueId, month } = body;
      if (!leagueId || !month) {
        return Response.json({ ok: false, error: 'leagueId and month required' }, { status: 400 });
      }
      const lg = await loadLeague(leagueId);
      if (!lg) return Response.json({ ok: false, error: 'League not found' }, { status: 404 });
      const from = lg.currentMonth;
      lg.currentMonth = month;
      await saveLeague(lg);
      return Response.json({ ok: true, from, to: month }, { headers: NO_CACHE });
    }

    // Approve all pending members in a league
    if (body.action === 'approve-all-pending') {
      const lg = await loadLeague(body.leagueId);
      if (!lg) return Response.json({ ok: false, error: 'League not found' }, { status: 404 });
      let approved = 0;
      for (const m of (lg.members || [])) {
        if (m.status === 'pending') {
          m.status = 'active';
          if (!lg.managers.includes(m.manager)) lg.managers.push(m.manager);
          const cm = lg.currentMonth;
          if (cm && lg.months?.[cm] && !lg.months[cm].rosters[m.manager]) {
            lg.months[cm].rosters[m.manager] = Array(lg.settings?.rosterSize || 6)
              .fill(null).map(() => ({ player: '', team: '', position: '', hr: 0 }));
          }
          approved++;
        }
      }
      await saveLeague(lg);
      return Response.json({ ok: true, approved }, { headers: NO_CACHE });
    }

    // Force-add a member (by email) as active, even without invite flow
    if (body.action === 'force-add-member') {
      const { leagueId, email, manager } = body;
      if (!leagueId || !email || !manager) {
        return Response.json({ ok: false, error: 'leagueId, email, manager required' }, { status: 400 });
      }
      const lg = await loadLeague(leagueId);
      if (!lg) return Response.json({ ok: false, error: 'League not found' }, { status: 404 });
      // Check if already a member
      const existing = (lg.members || []).find(m => m.email?.toLowerCase() === email.toLowerCase());
      if (existing) {
        // If pending, just approve them
        if (existing.status === 'pending') {
          existing.status = 'active';
          existing.manager = manager;
        } else {
          return Response.json({ ok: false, error: `${email} is already an active member as "${existing.manager}"` }, { status: 400 });
        }
      } else {
        lg.members.push({ manager, email: email.toLowerCase(), status: 'active', joinedAt: Date.now() });
      }
      if (!lg.managers.includes(manager)) lg.managers.push(manager);
      const cm = lg.currentMonth;
      if (cm && lg.months?.[cm] && !lg.months[cm].rosters[manager]) {
        lg.months[cm].rosters[manager] = Array(lg.settings?.rosterSize || 6)
          .fill(null).map(() => ({ player: '', team: '', position: '', hr: 0 }));
      }
      await saveLeague(lg);
      return Response.json({ ok: true }, { headers: NO_CACHE });
    }

    if (body.action === 'delete-league') {
      const id = body.leagueId;
      if (!id) return Response.json({ ok: false, error: 'leagueId required' }, { status: 400 });
      const store = getStore('league');
      await store.delete(`league:${id}`);
      return Response.json({ ok: true }, { headers: NO_CACHE });
    }
  }

  return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 });
};
