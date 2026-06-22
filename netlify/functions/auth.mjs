// Auth endpoint — user-centric (no league coupling at signup).
// GET                                                → { me, isAdmin }
// POST { action: 'signup',         email, password, displayName }
// POST { action: 'login',          email, password }
// POST { action: 'logout' }
// POST { action: 'forgot-password', email }          → stores a reset token
// POST { action: 'reset-password',  token, password } → validates + resets
import crypto from 'node:crypto';
import {
  hashPassword, createSession, destroySession, verifyAuth, isAdminEmail,
} from './lib/auth.mjs';
import { getStore } from '@netlify/blobs';
import { getUser, saveUser, ensureLegacyMigrated } from './lib/storage.mjs';

const NO_CACHE = { 'Cache-Control': 'no-store' };

// ── Reset token helpers ──
// Tokens stored as `reset:{token}` → { email, exp } in the 'league' store.
// They expire after 1 hour. Tokens are single-use (deleted on use).
async function saveResetToken(email, token) {
  await getStore('league').setJSON(`reset:${token}`, {
    email: email.toLowerCase(),
    exp: Date.now() + 3600000, // 1 hour
  });
}
async function consumeResetToken(token) {
  const store = getStore('league');
  const rec = await store.get(`reset:${token}`, { type: 'json' });
  if (!rec) return null;
  if (Date.now() > rec.exp) return null; // expired
  // Delete it (single-use)
  try { await store.delete(`reset:${token}`); } catch {}
  return rec.email;
}

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

  // ── SIGNUP ──
  if (body.action === 'signup') {
    const email       = String(body.email || '').toLowerCase().trim();
    const password    = String(body.password || '');
    const displayName = String(body.displayName || '').trim() || email.split('@')[0];
    if (!email.includes('@') || password.length < 6) {
      return Response.json({ ok: false, error: 'Valid email and 6+ character password required' }, { status: 400 });
    }
    if (await getUser(email)) {
      return Response.json({ ok: false, error: 'An account with that email already exists — sign in instead' }, { status: 400 });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    await saveUser({ email, displayName, salt, hash: hashPassword(password, salt), createdAt: Date.now(), leagues: [] });
    const token = await createSession(email);
    return Response.json({ ok: true, token, email, displayName, isAdmin: isAdminEmail(email) });
  }

  // ── LOGIN ──
  if (body.action === 'login') {
    const email = String(body.email || '').toLowerCase().trim();
    const u = await getUser(email);
    if (!u || hashPassword(String(body.password || ''), u.salt) !== u.hash) {
      return Response.json({ ok: false, error: 'Wrong email or password' }, { status: 401 });
    }
    const token = await createSession(u.email);
    return Response.json({ ok: true, token, email: u.email, displayName: u.displayName, isAdmin: isAdminEmail(u.email) });
  }

  // ── LOGOUT ──
  if (body.action === 'logout') {
    const session = await verifyAuth(req);
    if (session) await destroySession(session.token);
    return Response.json({ ok: true });
  }

  // ── FORGOT PASSWORD ──
  // Generates a reset token and returns it in the response.
  // In a production app this would be emailed. Since we don't have SMTP,
  // we return the reset link directly so you can paste it to the user
  // (or they can visit /?reset=TOKEN). The link expires in 1 hour.
  if (body.action === 'forgot-password') {
    const email = String(body.email || '').toLowerCase().trim();
    if (!email.includes('@')) {
      return Response.json({ ok: false, error: 'Valid email required' }, { status: 400 });
    }
    const user = await getUser(email);
    // Always return success to avoid leaking which emails are registered
    if (!user) {
      return Response.json({ ok: true, message: 'If that email is registered you will receive a reset link.' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    await saveResetToken(email, token);
    // Return the token directly (no SMTP configured yet — admin can share it)
    return Response.json({
      ok: true,
      message: 'Reset link generated. Share this link with the user:',
      resetLink: `/?reset=${token}`,
      resetToken: token,
      expiresIn: '1 hour',
    });
  }

  // ── RESET PASSWORD ──
  if (body.action === 'reset-password') {
    const token    = String(body.token || '').trim();
    const password = String(body.password || '');
    if (!token) return Response.json({ ok: false, error: 'Reset token required' }, { status: 400 });
    if (password.length < 6) return Response.json({ ok: false, error: 'Password must be at least 6 characters' }, { status: 400 });
    const email = await consumeResetToken(token);
    if (!email) return Response.json({ ok: false, error: 'Reset link is invalid or has expired' }, { status: 400 });
    const user = await getUser(email);
    if (!user) return Response.json({ ok: false, error: 'Account not found' }, { status: 404 });
    const salt = crypto.randomBytes(16).toString('hex');
    await saveUser({ ...user, salt, hash: hashPassword(password, salt) });
    // Auto-login after reset
    const sessionToken = await createSession(email);
    return Response.json({ ok: true, token: sessionToken, email, displayName: user.displayName, isAdmin: isAdminEmail(email) });
  }

  // ── UPDATE DISPLAY NAME ──
  if (body.action === 'update-display-name') {
    const session = await verifyAuth(req);
    if (!session) return Response.json({ ok: false, error: 'Not signed in' }, { status: 401 });
    const displayName = String(body.displayName || '').trim();
    if (!displayName) return Response.json({ ok: false, error: 'Display name cannot be empty' }, { status: 400 });
    const user = await getUser(session.email);
    if (!user) return Response.json({ ok: false, error: 'Account not found' }, { status: 404 });
    await saveUser({ ...user, displayName });
    return Response.json({ ok: true, displayName }, { headers: NO_CACHE });
  }

  // ── CHANGE PASSWORD ──
  if (body.action === 'change-password') {
    const session = await verifyAuth(req);
    if (!session) return Response.json({ ok: false, error: 'Not signed in' }, { status: 401 });
    const user = await getUser(session.email);
    if (!user) return Response.json({ ok: false, error: 'Account not found' }, { status: 404 });
    const currentPassword = String(body.currentPassword || '');
    const newPassword     = String(body.newPassword     || '');
    if (hashPassword(currentPassword, user.salt) !== user.hash) {
      return Response.json({ ok: false, error: 'Current password is incorrect' }, { status: 401 });
    }
    if (newPassword.length < 6) {
      return Response.json({ ok: false, error: 'New password must be at least 6 characters' }, { status: 400 });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    await saveUser({ ...user, salt, hash: hashPassword(newPassword, salt) });
    return Response.json({ ok: true }, { headers: NO_CACHE });
  }

  return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 });
};
