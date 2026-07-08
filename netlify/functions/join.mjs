// Join endpoint — handles invite-token joins. The user must be signed in
// already; we add them as a pending member of the league.
//
// POST { inviteToken, managerName } → creates pending member
//   - Returns { ok, leagueId, status: 'pending' | 'active' }
//   - 'active' only when the user is auto-joined (e.g. they are the commissioner)
import { loadLeague, listLeagues, saveLeague, ensureLegacyMigrated } from './lib/storage.mjs';
import { verifyAuth, isCommissioner } from './lib/auth.mjs';
import { normName } from './lib/core.mjs';

const NO_CACHE = { 'Cache-Control': 'no-store' };

export default async (req) => {
  await ensureLegacyMigrated();
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const session = await verifyAuth(req);
  if (!session) return Response.json({ ok: false, error: 'Sign in first' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const inviteToken = String(body.inviteToken || '');
  const managerName = String(body.managerName || '').trim();
  const realName    = String(body.realName    || '').trim();
  if (!inviteToken || !managerName) {
    return Response.json({ ok: false, error: 'Invite token and manager name required' }, { status: 400 });
  }
  if (managerName.length > 30) {
    return Response.json({ ok: false, error: 'Manager name 30 chars max' }, { status: 400 });
  }
  if (realName && realName.length > 60) {
    return Response.json({ ok: false, error: 'Real name 60 chars max' }, { status: 400 });
  }

  // Find the league by invite token
  const index = await listLeagues();
  let league = null;
  for (const entry of index) {
    const lg = await loadLeague(entry.id);
    if (lg?.inviteToken === inviteToken) { league = lg; break; }
  }
  if (!league) {
    return Response.json({ ok: false, error: 'Invite link not found or expired' }, { status: 404 });
  }

  // Already a member?
  const existing = (league.members || []).find(m => m.email?.toLowerCase() === session.email);
  if (existing) {
    if (existing.status === 'active') {
      return Response.json({ ok: true, leagueId: league.id, status: 'active', alreadyMember: true });
    }
    if (existing.status === 'pending') {
      return Response.json({ ok: true, leagueId: league.id, status: 'pending', alreadyPending: true });
    }
  }

  // Manager name conflict?
  if ((league.members || []).some(m => m.manager.toLowerCase() === managerName.toLowerCase())) {
    return Response.json({ ok: false, error: `"${managerName}" is taken in this league — pick a different name` }, { status: 400 });
  }

  // Add as pending (commissioner approves)
  // Exception: if the joining user IS the commissioner, auto-approve.
  const status = isCommissioner(league, session.email) ? 'active' : 'pending';
  league.members.push({
    manager:  managerName,
    realName: realName || session.displayName || '', // fall back to account display name
    email:    session.email,
    status,
    joinedAt: Date.now(),
  });
  if (status === 'active') {
    if (!league.managers.includes(managerName)) league.managers.push(managerName);
    const cm = league.currentMonth;
    if (cm && league.months?.[cm]) {
      league.months[cm].rosters[managerName] = Array(league.settings?.rosterSize || 6)
        .fill(null).map(() => ({ player: '', team: '', position: '', hr: 0 }));
    }
  }
  await saveLeague(league);

  // Notify the commissioner when a new pending request comes in so they
  // don't have to manually check the Commissioner tab.
  if (status === 'pending') {
    try {
      const { dispatchCommissionerNotification } = await import('./lib/notify.mjs');
      await dispatchCommissionerNotification({
        league,
        title: `🙋 ${realName || managerName} wants to join`,
        body: `${realName ? `${realName} (team: ${managerName})` : managerName} requested to join ${league.name}. Open the Commissioner tab to approve or decline.`,
        url: `/league/${league.id}/settings`,
        tag: `join-request-${league.id}-${normName(managerName)}`,
      });
    } catch (e) {
      console.warn('Commissioner join notification failed (non-fatal):', e.message);
    }
  }

  return Response.json({ ok: true, leagueId: league.id, status }, { headers: NO_CACHE });
};
