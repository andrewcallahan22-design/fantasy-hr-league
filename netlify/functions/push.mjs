// Push subscriptions, keyed by user email so they follow the user across leagues.
import { getStore } from '@netlify/blobs';
import { verifyAuth } from './lib/auth.mjs';

const NO_CACHE = { 'Cache-Control': 'no-store' };

async function loadSubs() { return (await getStore('league').get('pushSubs', { type: 'json' })) || {}; }
async function saveSubs(s) { await getStore('league').setJSON('pushSubs', s); }
async function loadPrefs() { return (await getStore('league').get('pushPrefs', { type: 'json' })) || {}; }
async function savePrefs(p) { await getStore('league').setJSON('pushPrefs', p); }

export default async (req) => {
  const session = await verifyAuth(req);

  if (req.method === 'GET') {
    const subs = await loadSubs();
    const prefs = await loadPrefs();
    return Response.json({
      publicKey: process.env.VAPID_PUBLIC_KEY || null,
      subscribed: session ? !!subs[session.email]?.length : false,
      notifyAll: session ? !!prefs[session.email]?.notifyAll : false,
    }, { headers: NO_CACHE });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!session) return Response.json({ ok: false, error: 'Sign in required' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const subs = await loadSubs();
  if (!subs[session.email]) subs[session.email] = [];

  if (body.action === 'subscribe') {
    if (!body.subscription?.endpoint) return Response.json({ ok: false, error: 'Missing subscription' }, { status: 400 });
    subs[session.email] = subs[session.email].filter(s => s.endpoint !== body.subscription.endpoint);
    subs[session.email].push(body.subscription);
    await saveSubs(subs);
    return Response.json({ ok: true });
  }

  if (body.action === 'unsubscribe') {
    if (body.subscription?.endpoint) {
      subs[session.email] = subs[session.email].filter(s => s.endpoint !== body.subscription.endpoint);
    } else {
      subs[session.email] = [];
    }
    await saveSubs(subs);
    return Response.json({ ok: true });
  }

  if (body.action === 'set-prefs') {
    const prefs = await loadPrefs();
    if (!prefs[session.email]) prefs[session.email] = {};
    prefs[session.email].notifyAll = !!body.notifyAll;
    await savePrefs(prefs);
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 });
};
