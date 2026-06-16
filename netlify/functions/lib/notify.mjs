// Notification dispatcher.
// Push subscriptions are keyed by user email (not manager name) so they
// follow the user across leagues. Preferences are also per-user.
//
// Rules:
//   • The owner of a homering player ALWAYS gets a celebratory push
//   • Other league members with notifyAll=true get a calm factual push
//   • League leader changes notify all league members
//   • Quiet hours 11 PM – 9 AM Pacific
import { getStore } from '@netlify/blobs';
import { sendPush } from './webpush.mjs';

function inQuietHours(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false
  });
  const hour = parseInt(fmt.format(now));
  return hour >= 23 || hour < 9;
}

async function loadSubs() { return (await getStore('league').get('pushSubs', { type: 'json' })) || {}; }
async function saveSubs(s) { await getStore('league').setJSON('pushSubs', s); }
async function loadPrefs() { return (await getStore('league').get('pushPrefs', { type: 'json' })) || {}; }

// Find the email of the user managing this team in this league.
function emailForManager(league, mgr) {
  const m = (league.members || []).find(x => x.manager === mgr && x.status === 'active');
  return m?.email?.toLowerCase() || null;
}

export async function dispatchNotifications({ league, hrEvents, leaderBefore, leaderAfter }) {
  if (inQuietHours()) {
    console.log('Quiet hours — suppressing notifications');
    return { sent: 0, suppressed: true };
  }

  const allSubs = await loadSubs();
  const allPrefs = await loadPrefs();

  const queue = [];   // { email, payload }

  for (const ev of hrEvents) {
    const ownerEmail = emailForManager(league, ev.mgr);
    if (ownerEmail) {
      queue.push({
        email: ownerEmail,
        payload: JSON.stringify({
          title: `🚀 BOOM! ${ev.player} just went yard!`,
          body: `+${ev.delta} HR for YOUR team in ${league.name}`,
          tag: `hr-own-${league.id}-${ev.player}-${Date.now()}`,
          url: `/league/${league.id}`,
        }),
      });
    }
    for (const member of (league.members || [])) {
      if (member.status !== 'active' || !member.email) continue;
      if (member.email.toLowerCase() === ownerEmail) continue;
      if (!allPrefs[member.email.toLowerCase()]?.notifyAll) continue;
      queue.push({
        email: member.email.toLowerCase(),
        payload: JSON.stringify({
          title: `⚾ ${ev.player} homered`,
          body: `+${ev.delta} for ${ev.mgr}'s roster · ${league.name}`,
          tag: `hr-other-${league.id}-${ev.player}-${Date.now()}`,
          url: `/league/${league.id}`,
        }),
      });
    }
  }

  if (leaderAfter && leaderBefore && leaderAfter.name !== leaderBefore.name) {
    for (const member of (league.members || [])) {
      if (member.status !== 'active' || !member.email) continue;
      const isYou = (member.manager === leaderAfter.name);
      queue.push({
        email: member.email.toLowerCase(),
        payload: JSON.stringify({
          title: isYou ? '🏆 You\'ve taken the league lead!' : `🏆 ${leaderAfter.name} took the league lead`,
          body: `${leaderAfter.name} now has ${leaderAfter.hr} HR this month · ${league.name}`,
          tag: `leader-${league.id}-${leaderAfter.name}-${Date.now()}`,
          url: `/league/${league.id}`,
        }),
      });
    }
  }

  let sent = 0;
  const deadEndpoints = new Set();
  await Promise.all(queue.map(async ({ email, payload }) => {
    const subs = allSubs[email] || [];
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

  if (deadEndpoints.size) {
    for (const e of Object.keys(allSubs)) {
      allSubs[e] = (allSubs[e] || []).filter(s => !deadEndpoints.has(s.endpoint));
    }
    await saveSubs(allSubs);
  }

  const totalAttempts = queue.reduce((n, q) => n + (allSubs[q.email] || []).length, 0);
  console.log(`Notifications [${league.id}]: ${sent}/${totalAttempts} delivered, ${deadEndpoints.size} dead subs pruned`);
  return { sent, dead: deadEndpoints.size };
}
