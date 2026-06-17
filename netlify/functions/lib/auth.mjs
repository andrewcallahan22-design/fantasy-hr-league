// Auth — user-centric, not per-league.
// A user has one account; they can belong to many leagues with different
// manager names in each. Per-league manager identity is resolved by looking
// up the user's email against the target league's members list.
import crypto from 'node:crypto';
import { getSessions, saveSessions, getUser } from './storage.mjs';

export const ADMIN_EMAILS = new Set([
  'andrewcallahan22@gmail.com',
]);
export function isAdminEmail(email) {
  return !!email && ADMIN_EMAILS.has(String(email).toLowerCase().trim());
}

export function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

export async function createSession(email) {
  const sessions = await getSessions();
  const now = Date.now();
  for (const [t, s] of Object.entries(sessions)) {
    if (s.exp < now) delete sessions[t];
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { email: email.toLowerCase(), exp: now + 30 * 86400000 };
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
  return { email: s.email.toLowerCase(), token, isAdmin: isAdminEmail(s.email) };
}

export function managerForUser(league, email) {
  if (!league?.members || !email) return null;
  const m = league.members.find(
    mem => mem.email && mem.email.toLowerCase() === email.toLowerCase() && mem.status === 'active'
  );
  return m ? m.manager : null;
}

export function isCommissioner(league, email) {
  if (!league?.commissioner || !email) return false;
  return league.commissioner.toLowerCase() === email.toLowerCase();
}

export function canEditRoster(league, session, targetManager) {
  if (!session) return false;
  if (session.isAdmin) return true;
  if (isCommissioner(league, session.email)) return true;
  const myMgr = managerForUser(league, session.email);
  return myMgr === targetManager;
}
