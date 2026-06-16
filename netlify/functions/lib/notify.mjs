// Notification dispatcher — called by the sync after HR events are recorded.
//
// Three correctness rules baked in:
//   1. EXACTLY ONE push per (subscription, logical event). Stable tag values
//      let iOS/Android dedupe identical messages so the same HR can't show up
//      twice even if two cron jobs race or a push gets retried.
//   2. Leader changes distinguish "took the lead" (one name newly on top) from
//      "tied the lead" (more than one name on top) from "extended the lead"
//      (same single leader, higher count).
//   3. Quiet hours 11 PM – 9 AM Pacific.
import { getStore } from '@netlify/blobs';
import { sendPush } from './webpush.mjs';

function inQuietHours(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false
  });
  const hour = parseInt(fmt.format(now));
  return hour >= 23 || hour < 9;
}

// Bucket time into 60-second windows so identical events arriving in the same
// minute share a tag and dedupe on the device. Two minutes later the same
// player homering again gets a fresh tag (correctly treated as a new event).
function timeBucket(ms = Date.now()) {
  return Math.floor(ms / 60000);
}

function buildLeaderMessages({ leaderBefore, leaderAfter, state, dedupeBucket }) {
  // Returns an array of { manager, payload } messages for leader transitions.
  // Cases (using the names arrays returned by core.computeLeader):
  //   A. Before nobody → After single name           "X took the league lead"
  //   B. Single leader X → Single leader Y (X ≠ Y)   "Y took the league lead from X"
  //   C. Single leader X → Tie that INCLUDES X       "Z tied X for the league lead"
  //   D. Single leader X → Tie that EXCLUDES X       "Y & Z tied for the league lead"
  //   E. Tie → Single leader (one breaks away)        "X took the league lead"
  //   F. Tie → Bigger/different tie                   "Y joined the tie for the lead"
  //   G. Same single leader, higher HR count          (no notification — boring)
  //   H. Same tie, higher HR count                    (no notification — boring)
  const before = leaderBefore?.names || [];
  const after  = leaderAfter?.names  || [];
  if (!after.length) return [];

  const beforeSet = new Set(before);
  const afterSet  = new Set(after);
  const newcomers = after.filter(n => !beforeSet.has(n));   // who just joined the top
  const dethroned = before.filter(n => !afterSet.has(n));   // who fell off

  // Case G/H — nothing visibly changed. Skip.
  if (newcomers.length === 0 && dethroned.length === 0) return [];

  // Compose the headline + body. `you` substitution happens per-recipient.
  // We pre-compute the "shared" text and adapt only the title for the recipient.
  const total = `${leaderAfter.hr} HR`;
  let sharedBody = '';
  let titleFor = () => '';

  if (after.length === 1) {
    // Single leader now
    const leader = after[0];
    if (before.length === 0) {
      // First leader of the season/month
      titleFor = (mgr) => mgr === leader ? '🏆 You\'ve taken the league lead!' : `🏆 ${leader} took the league lead`;
      sharedBody = `${leader} now has ${total} this month`;
    } else if (before.length === 1) {
      // Clean takeover (B)
      const old = before[0];
      titleFor = (mgr) =>
        mgr === leader ? `🏆 You\'ve taken the league lead from ${old}!` :
        mgr === old    ? `📉 ${leader} just passed you for the league lead` :
                         `🏆 ${leader} took the league lead from ${old}`;
      sharedBody = `${leader} now has ${total} · ${old} sits behind`;
    } else {
      // Tie broken — someone pulled ahead (E)
      titleFor = (mgr) => mgr === leader ? '🏆 You broke the tie and took the lead!' : `🏆 ${leader} broke the tie for the league lead`;
      sharedBody = `${leader} now has ${total} this month`;
    }
  } else {
    // Multiple leaders now — it's a tie
    const tieDisplay = after.length === 2 ? after.join(' & ') : after.slice(0, -1).join(', ') + ' & ' + after[after.length - 1];

    if (before.length === 1 && newcomers.length >= 1 && afterSet.has(before[0])) {
      // Case C: tie that includes the previous solo leader
      const old = before[0];
      titleFor = (mgr) =>
        newcomers.includes(mgr) ? `🤝 You tied ${old} for the league lead!` :
        mgr === old             ? `🤝 ${newcomers.join(' & ')} just tied you for the lead` :
                                  `🤝 ${tieDisplay} are tied for the league lead`;
      sharedBody = `Each has ${total} this month`;
    } else if (before.length === 1 && !afterSet.has(before[0])) {
      // Case D: the old single leader fell off entirely; a new tie forms above
      titleFor = (mgr) =>
        after.includes(mgr)        ? `🤝 You\'re tied for the league lead!` :
        mgr === before[0]          ? `📉 You\'ve been passed — ${tieDisplay} are now tied for the lead` :
                                     `🤝 ${tieDisplay} are tied for the league lead`;
      sharedBody = `Each has ${total} this month`;
    } else {
      // Case F: tie shifted (someone joined or left an existing tie) — generic phrasing
      titleFor = (mgr) =>
        newcomers.includes(mgr)    ? `🤝 You\'ve tied for the league lead!` :
        afterSet.has(mgr)          ? `🤝 ${newcomers.join(' & ')} joined the tie for the lead` :
                                     `🤝 ${tieDisplay} are tied for the league lead`;
      sharedBody = `Each has ${total} this month`;
    }
  }

  // Stable tag so a re-fire of the same situation in the same minute dedupes.
  const tagSig = `leader-${after.join('+')}-${leaderAfter.hr}-${dedupeBucket}`;

  return state.managers.map(mgr => ({
    manager: mgr,
    payload: JSON.stringify({
      title: titleFor(mgr),
      body: sharedBody,
      tag: tagSig,
      url: '/',
    }),
  }));
}

export async function dispatchNotifications({ state, hrEvents, leaderBefore, leaderAfter }) {
  if (inQuietHours()) {
    console.log('Quiet hours — suppressing notifications');
    return { sent: 0, suppressed: true };
  }

  const store = getStore('league');
  const allSubs = (await store.get('pushSubs', { type: 'json' })) || {};
  const allPrefs = (await store.get('pushPrefs', { type: 'json' })) || {};
  const bucket = timeBucket();

  const queue = [];

  // Per-HR notifications — stable tag prevents duplicates from re-fires.
  // The tag is the same for two events with the same player/manager/delta
  // within the same minute, so iOS will replace the prior banner instead of
  // stacking a second one.
  for (const ev of hrEvents) {
    const ownerTag = `hr-own-${ev.player}-${ev.mgr}-${ev.delta}-${bucket}`;
    queue.push({
      manager: ev.mgr,
      payload: JSON.stringify({
        title: `🚀 BOOM! ${ev.player} just went yard!`,
        body: `+${ev.delta} HR for YOUR team — keep it going!`,
        tag: ownerTag,
        url: '/',
      }),
    });
    const otherTag = `hr-other-${ev.player}-${ev.mgr}-${ev.delta}-${bucket}`;
    for (const mgr of state.managers) {
      if (mgr === ev.mgr) continue;
      if (!allPrefs[mgr]?.notifyAll) continue;
      queue.push({
        manager: mgr,
        payload: JSON.stringify({
          title: `⚾ ${ev.player} homered`,
          body: `+${ev.delta} for ${ev.mgr}'s roster`,
          tag: otherTag,
          url: '/',
        }),
      });
    }
  }

  // Leader/tie messages
  const leaderMsgs = buildLeaderMessages({ leaderBefore, leaderAfter, state, dedupeBucket: bucket });
  queue.push(...leaderMsgs);

  // De-duplicate identical (manager, tag) pairs so the same person never gets
  // queued twice for the same logical event — protects against the rare case
  // where one HR event also breaks a leader tie.
  const seen = new Set();
  const deduped = [];
  for (const q of queue) {
    let parsedTag = null;
    try { parsedTag = JSON.parse(q.payload).tag; } catch {}
    const k = `${q.manager}|${parsedTag}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(q);
  }

  let sent = 0;
  const deadEndpoints = new Set();
  await Promise.all(deduped.map(async ({ manager, payload }) => {
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

  if (deadEndpoints.size) {
    for (const m of Object.keys(allSubs)) {
      allSubs[m] = (allSubs[m] || []).filter(s => !deadEndpoints.has(s.endpoint));
    }
    await store.setJSON('pushSubs', allSubs);
  }

  const totalAttempts = deduped.reduce((n, q) => n + (allSubs[q.manager] || []).length, 0);
  console.log(`Notifications: ${sent}/${totalAttempts} delivered (${queue.length - deduped.length} duplicates suppressed), ${deadEndpoints.size} dead subs pruned`);
  return { sent, dead: deadEndpoints.size, deduped: queue.length - deduped.length };
}
