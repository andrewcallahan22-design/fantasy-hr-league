// Push subscriptions, keyed by user email (always lowercase) so they follow
// the user across leagues. Email normalization is critical — notify.mjs looks
// up subs by lowercased email, so we must store with the same key.
import { getStore } from '@netlify/blobs';
import { verifyAuth } from './lib/auth.mjs';

const NO_CACHE = { 'Cache-Control': 'no-store' };

async function loadSubs()  { return (await getStore('league').get('pushSubs',  { type: 'json' })) || {}; }
async function saveSubs(s) { await getStore('league').setJSON('pushSubs', s); }
async function loadPrefs()  { return (await getStore('league').get('pushPrefs', { type: 'json' })) || {}; }
async function savePrefs(p) { await getStore('league').setJSON('pushPrefs', p); }

export default async (req) => {
  const session = await verifyAuth(req);

  if (req.method === 'GET') {
    const subs  = await loadSubs();
    const prefs = await loadPrefs();
    const email = session?.email?.toLowerCase();

    // One-time migration: normalize any subscription keys that were stored
    // with non-lowercase email (e.g. Andrewcallahan22@gmail.com → andrewcallahan22@gmail.com)
    let migrated = false;
    for (const key of Object.keys(subs)) {
      if (key !== key.toLowerCase()) {
        const lower = key.toLowerCase();
        subs[lower] = [...(subs[lower] || []), ...subs[key]];
        delete subs[key];
        migrated = true;
      }
    }
    for (const key of Object.keys(prefs)) {
      if (key !== key.toLowerCase()) {
        const lower = key.toLowerCase();
        prefs[lower] = { ...prefs[key], ...prefs[lower] };
        delete prefs[key];
        migrated = true;
      }
    }
    if (migrated) {
      await saveSubs(subs);
      await savePrefs(prefs);
      console.log('[push] Migrated subscription keys to lowercase');
    }

    return Response.json({
      publicKey:   process.env.VAPID_PUBLIC_KEY || null,
      subscribed:  email ? !!subs[email]?.length : false,
      notifyAll:   email ? !!prefs[email]?.notifyAll : false,
    }, { headers: NO_CACHE });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!session) return Response.json({ ok: false, error: 'Sign in required' }, { status: 401 });

  const email = session.email.toLowerCase(); // always normalize
  const body  = await req.json().catch(() => ({}));
  const subs  = await loadSubs();
  if (!subs[email]) subs[email] = [];

  if (body.action === 'subscribe') {
    if (!body.subscription?.endpoint) return Response.json({ ok: false, error: 'Missing subscription' }, { status: 400 });
    // Replace any existing sub with the same endpoint, then add fresh one
    subs[email] = subs[email].filter(s => s.endpoint !== body.subscription.endpoint);
    subs[email].push(body.subscription);
    await saveSubs(subs);
    console.log(`[push] Subscription saved for ${email}, total subs: ${subs[email].length}`);
    return Response.json({ ok: true });
  }

  if (body.action === 'unsubscribe') {
    if (body.subscription?.endpoint) {
      subs[email] = subs[email].filter(s => s.endpoint !== body.subscription.endpoint);
    } else {
      subs[email] = [];
    }
    await saveSubs(subs);
    return Response.json({ ok: true });
  }

  if (body.action === 'set-prefs') {
    const prefs = await loadPrefs();
    if (!prefs[email]) prefs[email] = {};
    prefs[email].notifyAll = !!body.notifyAll;
    await savePrefs(prefs);
    return Response.json({ ok: true });
  }

  if (body.action === 'send-test') {
    const { sendPush } = await import('./lib/webpush.mjs');
    const userSubs = subs[email] || [];
    if (!userSubs.length) {
      return Response.json({ ok: false, error: `No push subscriptions found for ${email}. Try turning notifications off and back on in ⚙ Settings.` });
    }
    let sent = 0;
    const dead = [];
    for (const sub of userSubs) {
      const res = await sendPush(sub, JSON.stringify({
        title: '⚾ Go Yard test notification',
        body: `Push is working for ${email}! You'll get notified on every HR.`,
        url: '/',
      }), { ttl: 60, urgency: 'high' });
      if (res.ok) sent++;
      else if (res.status === 404 || res.status === 410) dead.push(sub.endpoint);
      else console.warn(`[push:test] delivery failed status=${res.status} for ${email}`);
    }
    if (dead.length) {
      subs[email] = userSubs.filter(s => !dead.includes(s.endpoint));
      await saveSubs(subs);
    }
    return Response.json({ ok: true, sent, dead: dead.length, total: userSubs.length });
  }

  return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 });
};
