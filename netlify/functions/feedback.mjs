// Lightweight feedback/bug-report collector.
// POST { message, url, leagueId? } → stores a feedback entry (auth required
// so submissions are attributable — see admin.mjs's ?action=feedback to read them back)
import { verifyAuth } from './lib/auth.mjs';
import { getStore } from '@netlify/blobs';

const NO_CACHE = { 'Cache-Control': 'no-store' };

export default async (req) => {
  const session = await verifyAuth(req);
  if (!session) return Response.json({ ok: false, error: 'Sign in required' }, { status: 401 });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const body = await req.json().catch(() => ({}));
  const message = String(body.message || '').trim().slice(0, 2000);
  if (!message) return Response.json({ ok: false, error: 'Message required' }, { status: 400 });

  const store = getStore('league');
  const entries = (await store.get('feedback', { type: 'json' })) || [];
  entries.push({
    t: Date.now(),
    email: session.email,
    message,
    url: String(body.url || '').slice(0, 300),
    leagueId: body.leagueId || null,
  });
  if (entries.length > 500) entries.splice(0, entries.length - 500);
  await store.setJSON('feedback', entries);

  return Response.json({ ok: true }, { headers: NO_CACHE });
};
