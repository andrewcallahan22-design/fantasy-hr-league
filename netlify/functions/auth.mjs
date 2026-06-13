// Auth endpoint.
// GET  -> { managers, claimed, me } — used by the sign-up screen and session check
// POST -> { action: 'signup' | 'login' | 'logout' }
//   signup: each league manager (Max/Johnny/HK/Cali) can be claimed exactly once
//   with an email + password. After that, it's login-only for that manager.
import crypto from 'node:crypto';
import { getUsers, saveUsers, hashPassword, createSession, destroySession, verifyAuth, isAdminEmail } from './lib/auth.mjs';
import { loadLeagueState } from './lib/core.mjs';

export default async (req) => {
  if (req.method === 'GET') {
    const state = await loadLeagueState();
    const users = await getUsers();
    const claimed = Object.values(users).map(u => u.manager);
    const session = await verifyAuth(req);
    return Response.json({
      managers: state.managers,
      claimed,
      me: session ? { manager: session.manager, email: session.email, isAdmin: session.isAdmin } : null,
    });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const body = await req.json().catch(() => ({}));

  if (body.action === 'signup') {
    const email = String(body.email || '').toLowerCase().trim();
    const password = String(body.password || '');
    const manager = String(body.manager || '');
    if (!email.includes('@') || password.length < 6 || !manager) {
      return Response.json({ ok: false, error: 'Valid email, manager, and a 6+ character password required' }, { status: 400 });
    }
    const state = await loadLeagueState();
    if (!state.managers.includes(manager)) {
      return Response.json({ ok: false, error: 'Unknown manager name' }, { status: 400 });
    }
    const users = await getUsers();
    if (users[email]) {
      return Response.json({ ok: false, error: 'That email is already registered' }, { status: 400 });
    }
    if (Object.values(users).some(u => u.manager === manager)) {
      return Response.json({ ok: false, error: `${manager} has already been claimed` }, { status: 400 });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    users[email] = { email, manager, salt, hash: hashPassword(password, salt), createdAt: Date.now() };
    await saveUsers(users);
    const token = await createSession(email, manager);
    return Response.json({ ok: true, token, manager, email, isAdmin: isAdminEmail(email) });
  }

  if (body.action === 'login') {
    const email = String(body.email || '').toLowerCase().trim();
    const users = await getUsers();
    const u = users[email];
    if (!u || hashPassword(String(body.password || ''), u.salt) !== u.hash) {
      return Response.json({ ok: false, error: 'Wrong email or password' }, { status: 401 });
    }
    const token = await createSession(u.email, u.manager);
    return Response.json({ ok: true, token, manager: u.manager, email: u.email, isAdmin: isAdminEmail(u.email) });
  }

  if (body.action === 'logout') {
    const session = await verifyAuth(req);
    if (session) await destroySession(session.token);
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 });
};
