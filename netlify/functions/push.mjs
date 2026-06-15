// Push subscriptions endpoint.
// GET  -> { publicKey, subscribed }  — the browser needs the VAPID public key to subscribe
// POST -> { action: 'subscribe' | 'unsubscribe', subscription }  — sign-in required
import { getStore } from '@netlify/blobs';
import { verifyAuth } from './lib/auth.mjs';

const NO_CACHE = { 'Cache-Control': 'no-store' };

async function loadSubs() {
  return (await getStore('league').get('pushSubs', { type: 'json' })) || {};
}
async function saveSubs(s) {
  await getStore('league').setJSON('pushSubs', s);
}

export default async (req) => {
  const session = await verifyAuth(req);

  if (req.method === 'GET') {
    const subs = await loadSubs();
    return Response.json({
      publicKey: process.env.VAPID_PUBLIC_KEY || null,
      subscribed: session ? !!subs[session.manager]?.length : false,
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
    // Dedupe by endpoint (re-subscribing on the same device updates keys)
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

  return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 });
};
