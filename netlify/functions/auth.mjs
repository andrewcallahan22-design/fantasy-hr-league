// Auth endpoint — user-centric (no league coupling at signup).
// GET                                  → { me, isAdmin }
// POST { action: 'signup', email, password, displayName }
// POST { action: 'login',  email, password }
// POST { action: 'logout' }
import crypto from 'node:crypto';
import {
  hashPassword, createSession, destroySession, verifyAuth, isAdminEmail,
} from './lib/auth.mjs';
import { getUser, saveUser, ensureLegacyMigrated } from './lib/storage.mjs';

const NO_CACHE = { 'Cache-Control': 'no-store' };

export default async (req) => {
  await ensureLegacyMigrated();

  if (req.method === 'GET') {
    const session = await verifyAuth(req);
    return Response.json({
      me: session ? { email: session.email, isAdmin: session.isAdmin } : null,
    }, { headers: NO_CACHE });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const body = await req.json().catch(() => ({}));

  if (body.action === 'signup') {
    const email = String(body.email || '').toLowerCase().trim();
    const password = String(body.password || '');
    const displayName = String(body.displayName || '').trim() || email.split('@')[0];
    if (!email.includes('@') || password.length < 6) {
      return Response.json({ ok: false, error: 'Valid email and 6+ character password required' }, { status: 400 });
    }
    if (await getUser(email)) {
      return Response.json({ ok: false, error: 'An account with that email already exists — sign in instead' }, { status: 400 });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    await saveUser({
      email,
      displayName,
      salt,
      hash: hashPassword(password, salt),
      createdAt: Date.now(),
      leagues: [],
    });
    const token = await createSession(email);
    return Response.json({ ok: true, token, email, displayName, isAdmin: isAdminEmail(email) });
  }

  if (body.action === 'login') {
    const email = String(body.email || '').toLowerCase().trim();
    const u = await getUser(email);
    if (!u || hashPassword(String(body.password || ''), u.salt) !== u.hash) {
      return Response.json({ ok: false, error: 'Wrong email or password' }, { status: 401 });
    }
    const token = await createSession(u.email);
    return Response.json({ ok: true, token, email: u.email, displayName: u.displayName, isAdmin: isAdminEmail(u.email) });
  }

  if (body.action === 'logout') {
    const session = await verifyAuth(req);
    if (session) await destroySession(session.token);
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 });
};
