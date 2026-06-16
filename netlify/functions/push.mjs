// Push subscriptions + preferences.
// GET  -> { publicKey, subscribed, notifyAll }  — used by the Settings UI
// POST -> { action: 'subscribe' | 'unsubscribe' | 'set-prefs', subscription, notifyAll }
import { getStore } from '@netlify/blobs';
import { verifyAuth } from './lib/auth.mjs';

const NO_CACHE = { 'Cache-Control': 'no-store' };

async function loadSubs() {
  return (await getStore('league').get('pushSubs', { type: 'json' })) || {};
}
async function saveSubs(s) {
  await getStore('league').setJSON('pushSubs', s);
}
async function loadPrefs() {
  return (await getStore('league').get('pushPrefs', { type: 'json' })) || {};
}
async function savePrefs(p) {
  await getStore('league').setJSON('pushPrefs', p);
}

export default async (req) => {
  const session = await verifyAuth(req);

  if (req.method === 'GET') {
    const subs = await loadSubs();
    const prefs = await loadPrefs();
    return Response.json({
      publicKey: process.env.VAPID_PUBLIC_KEY || null,
      subscribed: session ? !!subs[session.manager]?.length : false,
      notifyAll: session ? !!prefs[session.manager]?.notifyAll : false,
    }, { headers: NO_CACHE });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!session) return Response.json({ ok: false, error: 'Sign in required' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const subs = await loadSubs();
  if (!subs[session.manager]) subs[session.manager] = [];

  if (body.action === 'subscribe') {
    if (!body.subscription?.endpoint) {
      return Response.json({ ok: false, error: 'Missing subscription' }, { status: 400 });
    }
    subs[session.manager] = subs[session.manager]
      .filter(s => s.endpoint !== body.subscription.endpoint);
    subs[session.manager].push(body.subscription);
    await saveSubs(subs);
    return Response.json({ ok: true });
  }

  if (body.action === 'unsubscribe') {
    if (body.subscription?.endpoint) {
      subs[session.manager] = subs[session.manager]
        .filter(s => s.endpoint !== body.subscription.endpoint);
    } else {
      subs[session.manager] = [];
    }
    await saveSubs(subs);
    return Response.json({ ok: true });
  }

  if (body.action === 'set-prefs') {
    const prefs = await loadPrefs();
    if (!prefs[session.manager]) prefs[session.manager] = {};
    prefs[session.manager].notifyAll = !!body.notifyAll;
    await savePrefs(prefs);
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 });
};
