// Notification dispatcher — called by the sync after HR events are recorded.
// Rules (per league preferences):
//   • Notify a manager when a player on THEIR roster homers
//   • Notify everyone when the league leader changes
//   • Quiet hours: 11:00 PM – 9:00 AM Pacific (notifications suppressed)
//   • Prunes dead subscriptions (404/410 from push services)

import { getStore } from '@netlify/blobs';
import { sendPush } from './webpush.mjs';

function inQuietHours(now = new Date()) {
  // Convert to America/Los_Angeles hour
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false
  });
  const hour = parseInt(fmt.format(now));
  // Quiet: 23, 0-8 (i.e. 11 PM through 8:59 AM)
  return hour >= 23 || hour < 9;
}

export async function dispatchNotifications({ state, hrEvents, leaderBefore, leaderAfter }) {
  if (inQuietHours()) {
    console.log('Quiet hours — suppressing notifications');
    return { sent: 0, suppressed: true };
  }

  const store = getStore('league');
  const allSubs = (await store.get('pushSubs', { type: 'json' })) || {};

  // Build message list — one per (manager, message) we want to deliver.
  const queue = [];

  // 1. Per-HR notifications to the affected manager only
  for (const ev of hrEvents) {
    queue.push({
      manager: ev.mgr,
      payload: JSON.stringify({
        title: `⚾ ${ev.player} homered!`,
        body: `+${ev.delta} HR for your team`,
        tag: `hr-${ev.player}-${Date.now()}`,
        url: '/',
      }),
    });
  }

  // 2. League leader change — notify everyone
  if (leaderAfter && leaderBefore && leaderAfter.name !== leaderBefore.name) {
    for (const mgr of state.managers) {
      const isYou = (mgr === leaderAfter.name);
      queue.push({
        manager: mgr,
        payload: JSON.stringify({
          title: isYou ? '🏆 You\'ve taken the league lead!' : `🏆 ${leaderAfter.name} took the league lead`,
          body: `${leaderAfter.name} now has ${leaderAfter.hr} HR this month`,
          tag: `leader-${leaderAfter.name}-${Date.now()}`,
          url: '/',
        }),
      });
    }
  }

  // Dispatch with parallel sends; prune subscriptions that 404/410.
  let sent = 0;
  const deadEndpoints = new Set();
  await Promise.all(queue.map(async ({ manager, payload }) => {
    const subs = allSubs[manager] || [];
    for (const sub of subs) {
      try {
        const res = await sendPush(sub, payload, { ttl: 3600, urgency: 'high' });
        if (res.ok) sent++;
        else if (res.status === 404 || res.status === 410) deadEndpoints.add(sub.endpoint);
      } catch (e) {
        console.warn('Push failed:', e.message);
      }
    }
  }));

  // Prune dead subs
  if (deadEndpoints.size) {
    for (const m of Object.keys(allSubs)) {
      allSubs[m] = (allSubs[m] || []).filter(s => !deadEndpoints.has(s.endpoint));
    }
    await store.setJSON('pushSubs', allSubs);
  }

  // Total push attempts is queue.length × (subscriptions per manager), not queue.length itself.
  const totalAttempts = queue.reduce((n, q) => n + (allSubs[q.manager] || []).length, 0);
  console.log(`Notifications: ${sent}/${totalAttempts} delivered, ${deadEndpoints.size} dead subs pruned`);
  return { sent, dead: deadEndpoints.size };
}
