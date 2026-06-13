// Auth library — email/password accounts for league managers.
// Passwords are salted + hashed with scrypt (Node built-in crypto, no dependencies).
// Sessions are random 256-bit tokens stored server-side with a 30-day expiry.
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const store = () => getStore('league');

// Admin emails — these accounts can edit any manager's roster.
// Compare lowercase.
export const ADMIN_EMAILS = new Set([
  'andrewcallahan22@gmail.com',
]);
export function isAdminEmail(email) {
  return !!email && ADMIN_EMAILS.has(String(email).toLowerCase().trim());
}

export async function getUsers() {
  return (await store().get('users', { type: 'json' })) || {};
}
export async function saveUsers(u) {
  await store().setJSON('users', u);
}
export async function getSessions() {
  return (await store().get('sessions', { type: 'json' })) || {};
}
export async function saveSessions(s) {
  await store().setJSON('sessions', s);
}

export function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

export async function createSession(email, manager) {
  const sessions = await getSessions();
  const now = Date.now();
  // prune expired sessions while we're here
  for (const [t, s] of Object.entries(sessions)) {
    if (s.exp < now) delete sessions[t];
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { email, manager, isAdmin: isAdminEmail(email), exp: now + 30 * 86400000 };
  await saveSessions(sessions);
  return token;
}

export async function destroySession(token) {
  if (!token) return;
  const sessions = await getSessions();
  if (sessions[token]) {
    delete sessions[token];
    await saveSessions(sessions);
  }
}

export async function verifyAuth(req) {
  const h = req.headers.get('authorization') || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const sessions = await getSessions();
  const s = sessions[token];
  if (!s || s.exp < Date.now()) return null;
  // Re-evaluate admin status on every check so newly-tagged admins
  // get the privilege without having to sign back in.
  return { ...s, isAdmin: isAdminEmail(s.email), token };
}
