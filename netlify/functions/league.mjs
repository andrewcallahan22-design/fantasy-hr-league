// League endpoint — multi-tenant CRUD.
// GET  /.netlify/functions/league                 → list current user's leagues
// GET  /.netlify/functions/league?id=ID           → load full league state
// GET  /.netlify/functions/league?invite=TOKEN    → public preview for join page
// POST { action: 'create',   name }               → create a new league (auth required)
// POST { action: 'approve',  leagueId, email }    → commissioner approves pending member
// POST { action: 'decline',  leagueId, email }    → commissioner declines pending member
// POST { action: 'remove',   leagueId, manager }  → commissioner removes a manager
// POST { action: 'settings', leagueId, settings } → commissioner updates settings
// POST { action: 'rename',   leagueId, name }     → commissioner renames league
// POST { action: 'save-state', leagueId, state }  → save game state (roster/HR edits)
import {
  loadLeague, saveLeague, listLeagues, addLeagueToIndex,
  newLeagueId, newInviteToken, ensureLegacyMigrated,
  makeBlankSettings,
} from './lib/storage.mjs';
import {
  verifyAuth, managerForUser, isCommissioner,
} from './lib/auth.mjs';

const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Pragma': 'no-cache',
  'Expires': '0',
};

// Public league view — never include private data like email lists
function publicView(league) {
  return {
    id: league.id,
    name: league.name,
    createdAt: league.createdAt,
    managerCount: (league.members || []).filter(m => m.status === 'active').length,
  };
}

export default async (req) => {
  await ensureLegacyMigrated();
  const url = new URL(req.url);
  const session = await verifyAuth(req);

  if (req.method === 'GET') {
    const id = url.searchParams.get('id');
    const inviteToken = url.searchParams.get('invite');

    // Public join-page preview: just league name + manager count
    if (inviteToken) {
      const index = await listLeagues();
      for (const entry of index) {
        const lg = await loadLeague(entry.id);
        if (lg?.inviteToken === inviteToken) {
          return Response.json({ ok: true, league: publicView(lg) }, { headers: NO_CACHE });
        }
      }
      return Response.json({ ok: false, error: 'Invite link not found' }, { status: 404, headers: NO_CACHE });
    }

    // Specific league by id
    if (id) {
      const lg = await loadLeague(id);
      if (!lg) return Response.json({ ok: false, error: 'League not found' }, { status: 404, headers: NO_CACHE });

      // Add a hint about the current user's relationship to this league
      const myManager = session ? managerForUser(lg, session.email) : null;
      const isCommish = session ? isCommissioner(lg, session.email) : false;
      const isPending = session
        ? (lg.members || []).some(m => m.email?.toLowerCase() === session.email && m.status === 'pending')
        : false;
      // Strip emails from member list for non-commissioners
      const safeLeague = {
        ...lg,
        members: (lg.members || []).map(m => ({
          manager: m.manager,
          status: m.status,
          joinedAt: m.joinedAt,
          ...(isCommish ? { email: m.email } : {}),
        })),
      };
      return Response.json({
        ok: true,
        league: safeLeague,
        me: session ? { email: session.email, isAdmin: session.isAdmin } : null,
        myManager, isCommish, isPending,
      }, { headers: NO_CACHE });
    }

    // List the user's leagues
    if (!session) return Response.json({ ok: true, leagues: [] }, { headers: NO_CACHE });
    const index = await listLeagues();
    const mine = [];
    for (const entry of index) {
      const lg = await loadLeague(entry.id);
      if (!lg) continue;
      const member = (lg.members || []).find(m => m.email?.toLowerCase() === session.email);
      if (!member) continue;
      mine.push({
        id: lg.id, name: lg.name, createdAt: lg.createdAt,
        myManager: member.manager,
        myStatus: member.status,
        isCommissioner: isCommissioner(lg, session.email),
        memberCount: (lg.members || []).filter(m => m.status === 'active').length,
        pendingCount: (lg.members || []).filter(m => m.status === 'pending').length,
      });
    }
    return Response.json({ ok: true, leagues: mine }, { headers: NO_CACHE });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!session) return Response.json({ ok: false, error: 'Sign in required' }, { status: 401 });
  const body = await req.json().catch(() => ({}));

  // ── CREATE a league ──
  if (body.action === 'create') {
    const name = String(body.name || '').trim();
    if (!name || name.length > 60) {
      return Response.json({ ok: false, error: 'League name (1–60 chars) required' }, { status: 400 });
    }
    const managerName = String(body.managerName || '').trim() || name + ' Commish';
    const id = newLeagueId();
    const settings = makeBlankSettings();
    const now = Date.now();
    const month = monthKey(now);
    const league = {
      id,
      name,
      createdAt: now,
      commissioner: session.email,
      inviteToken: newInviteToken(),
      plan: 'free',
      tier: 'standard',
      settings,
      members: [{
        manager: managerName,
        email: session.email,
        status: 'active',
        joinedAt: now,
      }],
      pendingInvites: [],
      managers: [managerName],
      positions: settings.positionsAllowed,
      currentMonth: month,
      months: {
        [month]: {
          rosters: { [managerName]: emptyRoster(settings.rosterSize) },
        },
      },
      seasonBaseline: {},
      seasonHints: {},
      streaks: {},
      playerIds: {},
      changeLog: [],
      lastSync: null,
      draft: null,
      autoSync: true,
    };
    await saveLeague(league);
    await addLeagueToIndex(league);
    return Response.json({ ok: true, league }, { headers: NO_CACHE });
  }

  // For everything below, we need a league
  const league = body.leagueId ? await loadLeague(body.leagueId) : null;
  if (!league && body.action !== 'create') {
    return Response.json({ ok: false, error: 'League not found' }, { status: 404 });
  }

  // ── APPROVE a pending member ──
  if (body.action === 'approve') {
    if (!isCommissioner(league, session.email) && !session.isAdmin) {
      return Response.json({ ok: false, error: 'Only the commissioner can approve' }, { status: 403 });
    }
    const targetEmail = String(body.email || '').toLowerCase();
    const m = (league.members || []).find(x => x.email?.toLowerCase() === targetEmail && x.status === 'pending');
    if (!m) return Response.json({ ok: false, error: 'No pending join for that email' }, { status: 404 });
    m.status = 'active';
    // Promote them into the managers list and create an empty roster for current month
    if (!league.managers.includes(m.manager)) league.managers.push(m.manager);
    const cm = league.currentMonth;
    if (cm && league.months?.[cm] && !league.months[cm].rosters[m.manager]) {
      league.months[cm].rosters[m.manager] = emptyRoster(league.settings.rosterSize);
    }
    await saveLeague(league);
    return Response.json({ ok: true }, { headers: NO_CACHE });
  }

  // ── DECLINE a pending member ──
  if (body.action === 'decline') {
    if (!isCommissioner(league, session.email) && !session.isAdmin) {
      return Response.json({ ok: false, error: 'Only the commissioner can decline' }, { status: 403 });
    }
    const targetEmail = String(body.email || '').toLowerCase();
    league.members = (league.members || []).filter(
      x => !(x.email?.toLowerCase() === targetEmail && x.status === 'pending')
    );
    await saveLeague(league);
    return Response.json({ ok: true }, { headers: NO_CACHE });
  }

  // ── REMOVE an active member ──
  if (body.action === 'remove') {
    if (!isCommissioner(league, session.email) && !session.isAdmin) {
      return Response.json({ ok: false, error: 'Only the commissioner can remove members' }, { status: 403 });
    }
    const mgr = String(body.manager || '');
    if (!mgr) return Response.json({ ok: false, error: 'Manager required' }, { status: 400 });
    if (isCommissioner(league, league.members.find(x => x.manager === mgr)?.email || '')) {
      return Response.json({ ok: false, error: 'Cannot remove the commissioner' }, { status: 400 });
    }
    league.members = (league.members || []).filter(x => x.manager !== mgr);
    league.managers = (league.managers || []).filter(m => m !== mgr);
    // Leave their roster history intact — just remove going forward.
    await saveLeague(league);
    return Response.json({ ok: true }, { headers: NO_CACHE });
  }

  // ── SETTINGS update ──
  if (body.action === 'settings') {
    if (!isCommissioner(league, session.email) && !session.isAdmin) {
      return Response.json({ ok: false, error: 'Only the commissioner can change settings' }, { status: 403 });
    }
    const allowedKeys = ['rosterSize','scoringCategories','positionsAllowed','positionRule','teamRule','multiPlayerPerTeam','redraftCadence','maxManagers'];
    for (const key of allowedKeys) {
      if (body.settings && body.settings[key] !== undefined) {
        league.settings[key] = body.settings[key];
      }
    }
    // Keep positions list in sync with allowed positions
    if (body.settings?.positionsAllowed) league.positions = body.settings.positionsAllowed;
    await saveLeague(league);
    return Response.json({ ok: true, settings: league.settings }, { headers: NO_CACHE });
  }

  // ── RENAME a league ──
  if (body.action === 'rename') {
    if (!isCommissioner(league, session.email) && !session.isAdmin) {
      return Response.json({ ok: false, error: 'Only the commissioner can rename' }, { status: 403 });
    }
    const newName = String(body.name || '').trim();
    if (!newName || newName.length > 60) {
      return Response.json({ ok: false, error: 'Name 1–60 chars required' }, { status: 400 });
    }
    league.name = newName;
    await saveLeague(league);
    return Response.json({ ok: true, name: newName }, { headers: NO_CACHE });
  }

  // ── REGENERATE invite token (security feature) ──
  if (body.action === 'regenerate-invite') {
    if (!isCommissioner(league, session.email) && !session.isAdmin) {
      return Response.json({ ok: false, error: 'Only the commissioner can regenerate the invite' }, { status: 403 });
    }
    league.inviteToken = newInviteToken();
    await saveLeague(league);
    return Response.json({ ok: true, inviteToken: league.inviteToken }, { headers: NO_CACHE });
  }

  // ── SAVE-STATE: legacy compatibility for HR edits, roster changes, etc. ──
  // The frontend posts a "delta" — slot edits keyed by manager + slotIndex.
  // We accept the change only if the user is allowed to edit that manager's roster.
  if (body.action === 'save-state') {
    const edits = body.edits || []; // array of { manager, slotIndex, field, value }
    for (const edit of edits) {
      const targetMgr = edit.manager;
      const targetEmail = (league.members || []).find(m => m.manager === targetMgr)?.email;
      const allowedOwn = session.email === targetEmail?.toLowerCase();
      const allowedCommish = isCommissioner(league, session.email);
      if (!allowedOwn && !allowedCommish && !session.isAdmin) continue; // silently skip unauthorized edits

      const cm = body.month || league.currentMonth;
      if (!league.months[cm]?.rosters?.[targetMgr]) continue;
      const slot = league.months[cm].rosters[targetMgr][edit.slotIndex];
      if (!slot) continue;

      if (edit.field === 'hr') {
        const before = parseInt(slot.hr) || 0;
        const newVal = Math.max(0, parseInt(edit.value) || 0);
        if (before !== newVal) {
          slot.hr = newVal;
          if (!league.changeLog) league.changeLog = [];
          league.changeLog.push({ t: Date.now(), player: slot.player || '?', delta: newVal - before, mgr: targetMgr, month: cm, src: 'manual' });
          if (league.changeLog.length > 500) league.changeLog = league.changeLog.slice(-500);
          // Move baseline so next sync doesn't re-add the same HRs
          const { normName } = await import('./lib/core.mjs');
          const nk = normName(slot.player || '');
          if (nk && league.seasonHints?.[nk] !== undefined && league.seasonBaseline?.[nk] !== undefined) {
            league.seasonBaseline[nk] = league.seasonHints[nk] - newVal;
          }
        }
      } else if (['player','team','position'].includes(edit.field)) {
        slot[edit.field] = String(edit.value || '');
        if (edit.field === 'player') {
          // Reset baseline so a new player anchors cleanly on next sync
          const { normName } = await import('./lib/core.mjs');
          const nk = normName(slot.player || '');
          if (nk && league.seasonBaseline) delete league.seasonBaseline[nk];
        }
      }
    }
    await saveLeague(league);
    return Response.json({ ok: true, lastSync: league.lastSync }, { headers: NO_CACHE });
  }

  // ── ADD MONTH ──
  if (body.action === 'add-month') {
    if (!isCommissioner(league, session.email) && !session.isAdmin) {
      return Response.json({ ok: false, error: 'Only the commissioner can add months' }, { status: 403 });
    }
    const newMonthKey = nextMonthKey(league.currentMonth);
    if (league.months[newMonthKey]) {
      return Response.json({ ok: false, error: 'That month already exists' }, { status: 400 });
    }
    league.months[newMonthKey] = { rosters: {} };
    for (const mgr of league.managers) {
      league.months[newMonthKey].rosters[mgr] = emptyRoster(league.settings.rosterSize);
    }
    league.currentMonth = newMonthKey;
    await saveLeague(league);
    return Response.json({ ok: true, month: newMonthKey }, { headers: NO_CACHE });
  }

  return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 });
};

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function monthKey(ts) {
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

function nextMonthKey(current) {
  if (!current) return monthKey(Date.now());
  const [m, y] = current.split('-');
  let idx = MONTHS.indexOf(m) + 1;
  let year = parseInt(y);
  if (idx > 11) { idx = 0; year++; }
  return `${MONTHS[idx]}-${year}`;
}

function emptyRoster(size) {
  return Array(size).fill(null).map(() => ({ player: '', team: '', position: '', hr: 0 }));
}
