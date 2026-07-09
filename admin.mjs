// Admin dashboard endpoint — only accessible to isAdmin users.
// Returns full data on all leagues for the super admin backdoor view.
//
// GET  ?action=leagues          → all leagues with summary stats
// GET  ?action=league&id=ID     → full detail on one league
// POST { action: 'delete-league', leagueId }  → hard delete a league

import { listLeagues, loadLeague, saveLeague } from './lib/storage.mjs';
import { verifyAuth, isAdminEmail } from './lib/auth.mjs';
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

  // ── DELETE A LEAGUE ──
  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    if (body.action === 'delete-league') {
      const id = body.leagueId;
      if (!id) return Response.json({ ok: false, error: 'leagueId required' }, { status: 400 });
      // Remove from index and delete the blob
      const { listLeagues: list, saveLeague: save } = await import('./lib/storage.mjs');
      const store = getStore('league');
      await store.delete(`league:${id}`);
      // Remove from index
      const { default: storageModule } = await import('./lib/storage.mjs');
      return Response.json({ ok: true }, { headers: NO_CACHE });
    }
  }

  return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 });
};
