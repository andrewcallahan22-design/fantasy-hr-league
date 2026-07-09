// Notification dispatcher — multi-tenant, per-user subscriptions.
//
// DEDUP STRATEGY (3 layers):
//   1. Stable tags: tag = `hr-{leagueId}-{playerNormalized}-{totalSeasonHR}`
//      so the browser/OS deduplicates — same HR can only show once per device.
//   2. In-call dedup: track (email, tag) pairs so one sync can't send two
//      pushes to the same person for the same event.
//   3. Tie suppression: leader-change notifications only fire when one manager
//      definitively EXCEEDS the previous leader — not on ties.
//
// NOTIFICATION RULES:
//   • Owner of homering player: celebratory push (always, if subscribed)
//   • Other members with notifyAll=true: calm factual push
//   • Lead CHANGE (not tie): notify all members — distinct message per person
//   • Quiet hours 11 PM – 9 AM Pacific: suppress all
import { getStore } from '@netlify/blobs';
import { sendPush } from './webpush.mjs';

export function normName(n) {
  return (n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

function inQuietHours(now = new Date()) {
  // Quiet hours: midnight–8am PT only.
  // Previously 11pm–9am, but west coast games end at 10-11pm PT and the
  // MLB API often doesn't finalize stats until the game is fully over —
  // meaning a 9pm HR might not be detected until 11pm+ when the sync runs.
  // Shifting to midnight–8am ensures late-night game HRs still fire notifications.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false,
  });
  const hour = parseInt(fmt.format(now));
  return hour >= 0 && hour < 8; // midnight to 8am PT only
}

async function loadSubs()  { return (await getStore('league').get('pushSubs',  { type: 'json' })) || {}; }
async function saveSubs(s) { await getStore('league').setJSON('pushSubs', s); }
async function loadPrefs() { return (await getStore('league').get('pushPrefs', { type: 'json' })) || {}; }

function emailForManager(league, mgr) {
  const m = (league.members || []).find(x => x.manager === mgr && x.status === 'active');
  return m?.email?.toLowerCase() || null;
}

// Stable tag for an HR event — does NOT include timestamp so browser/OS can
// deduplicate: if the same notification arrives twice it replaces the first
// rather than stacking.
// Format: hr-{leagueId}-{playerNorm}-{newSeasonTotal}
// The newSeasonTotal is the season HR count AFTER the delta. We derive it
// from ev.baselineAfter passed in by core.mjs, or fall back to a rough
// minute-bucket to limit the window.
function hrTag(leagueId, ev) {
  const norm = normName(ev.player).replace(/\s+/g, '_');
  const bucket = ev.baselineAfter !== undefined
    ? String(ev.baselineAfter)
    : String(Math.floor(Date.now() / 60000)); // 1-minute bucket fallback
  return `hr-${leagueId}-${norm}-${bucket}`;
}

function leaderTag(leagueId, leaderName, leaderHR) {
  return `leader-${leagueId}-${normName(leaderName).replace(/\s+/g, '_')}-${leaderHR}`;
}

export async function dispatchNotifications({ league, hrEvents, leaderBefore, leaderAfter }) {
  if (inQuietHours()) {
    console.log(`[notify:${league.id}] Quiet hours — suppressed`);
    return { sent: 0, suppressed: true };
  }

  const allSubs  = await loadSubs();
  const allPrefs = await loadPrefs();

  // (email, tag) pairs already enqueued this call — prevents double-sending
  // within a single sync run (e.g. if the same player is on two roster slots).
  const seen = new Set();
  const queue = []; // { email, payload, tag }

  const enqueue = (email, payload, tag) => {
    const key = `${email}||${tag}`;
    if (seen.has(key)) return;
    seen.add(key);
    queue.push({ email, payload, tag });
  };

  // Load user profiles to get custom hrEmoji per manager
  const { getStore } = await import('@netlify/blobs');
  const userStore = getStore('league');

  async function getUserProfile(email) {
    try {
      return email ? await userStore.get(`user:${email.toLowerCase()}`, { type: 'json' }) : null;
    } catch { return null; }
  }

  function getHrEmojiFromProfile(profile) {
    return (profile?.hrEmoji?.trim()) || '🚀';
  }

  function getRivalMessageFromProfile(profile, member, playerName, managerName) {
    // Per-league message takes priority over account-level message
    const template = (member?.rivalMessage?.trim()) || (profile?.rivalMessage?.trim());
    if (!template) return null;
    return template
      .replace(/\{player\}/gi, playerName)
      .replace(/\{manager\}/gi, managerName)
      .slice(0, 120);
  }

  // ── HR events ──
  for (const ev of hrEvents) {
    const tag = hrTag(league.id, ev);
    const ownerEmail   = emailForManager(league, ev.mgr);
    const ownerProfile = await getUserProfile(ownerEmail);
    const ownerMember  = (league.members || []).find(m => m.email?.toLowerCase() === ownerEmail?.toLowerCase());
    const hrEmoji      = getHrEmojiFromProfile(ownerProfile);

    // Owner gets celebratory push with their custom emoji
    if (ownerEmail) {
      enqueue(ownerEmail, JSON.stringify({
        title: `${hrEmoji} ${ev.player} just went yard!`,
        body: `+${ev.delta} HR for YOUR team · ${league.name}`,
        tag,
        url: `/league/${league.id}`,
      }), tag);
    }

    // Others with notifyAll get the owner's custom rival message if set,
    // otherwise fall back to a factual notification
    const rivalMsg = getRivalMessageFromProfile(ownerProfile, ownerMember, ev.player, ev.mgr);
    for (const member of (league.members || [])) {
      if (member.status !== 'active' || !member.email) continue;
      const email = member.email.toLowerCase();
      if (email === ownerEmail) continue;
      if (!allPrefs[email]?.notifyAll) continue;
      enqueue(email, JSON.stringify({
        title: rivalMsg
          ? rivalMsg
          : `⚾ ${ev.player} homered for ${ev.mgr}`,
        body: `+${ev.delta} HR · ${league.name}`,
        tag: `other-${tag}`,
        url: `/league/${league.id}`,
      }), `other-${tag}`);
    }
  }

  // ── Leader change — ONLY when one manager definitively exceeds the other ──
  // Suppressed when:
  //   • No leader before (first sync of month)
  //   • Same leader as before (no change)
  //   • The new "leader" is tied with someone else (tie is NOT a lead change)
  if (leaderAfter && leaderBefore) {
    const genuineLeadChange =
      leaderAfter.names.length === 1 &&           // exactly one leader (no tie)
      leaderBefore.names.length === 1 &&          // was exactly one leader before
      leaderAfter.names[0] !== leaderBefore.names[0] && // it's a different person
      leaderAfter.hr > leaderBefore.hr;           // they actually have more HR

    const brokeATie =
      leaderAfter.names.length === 1 &&           // exactly one leader now
      leaderBefore.names.length > 1 &&            // it was a tie before
      leaderAfter.hr >= leaderBefore.hr;          // same or better HR total

    if (genuineLeadChange || brokeATie) {
      const newLeader = leaderAfter.names[0];
      const tag = leaderTag(league.id, newLeader, leaderAfter.hr);
      const verb = brokeATie ? 'broke the tie' : 'took the league lead';
      for (const member of (league.members || [])) {
        if (member.status !== 'active' || !member.email) continue;
        const email = member.email.toLowerCase();
        const isYou = member.manager === newLeader;
        enqueue(email, JSON.stringify({
          title: isYou
            ? `🏆 You ${verb}!`
            : `🏆 ${newLeader} ${verb}`,
          body: `${newLeader} now leads with ${leaderAfter.hr} HR this month · ${league.name}`,
          tag,
          url: `/league/${league.id}`,
        }), tag);
      }
    }
  }

  // ── Fire the queue ──
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
        console.warn(`[notify:${league.id}] Push failed:`, e.message);
      }
    }
  }));

  // Prune dead endpoints
  if (deadEndpoints.size) {
    for (const e of Object.keys(allSubs)) {
      allSubs[e] = (allSubs[e] || []).filter(s => !deadEndpoints.has(s.endpoint));
    }
    await saveSubs(allSubs);
  }

  const totalAttempts = queue.reduce((n, { email }) => n + (allSubs[email] || []).length, 0);
  console.log(`[notify:${league.id}] ${sent}/${totalAttempts} delivered, ${deadEndpoints.size} dead subs pruned, ${queue.length} distinct events queued`);
  return { sent, dead: deadEndpoints.size };
}

// ── DRAFT TURN NOTIFICATION ──
// Notifies the manager whose pick is up. Fires once per pick (tag includes
// pick number, so the same turn never double-notifies even if called twice).
// Quiet hours still apply — a draft turn at 2am won't buzz anyone's phone.
export async function dispatchDraftTurnNotification({ league, onClockManager, pickNumber, round, totalPicks }) {
  if (inQuietHours()) {
    console.log(`[draft-notify:${league.id}] Quiet hours — suppressed`);
    return { sent: 0, suppressed: true };
  }

  const email = emailForManager(league, onClockManager);
  if (!email) return { sent: 0, reason: 'no email linked for ' + onClockManager };

  const allSubs = await loadSubs();
  const subs = allSubs[email] || [];
  if (!subs.length) return { sent: 0, reason: 'no push subscriptions' };

  // Tag includes pick number — guarantees one notification per turn, no
  // matter how many times this function gets called for the same pick.
  const tag = `draft-turn-${league.id}-pick${pickNumber}`;
  const payload = JSON.stringify({
    title: `🏈 You're on the clock!`,
    body: `Round ${round} · Pick ${pickNumber} of ${totalPicks} · ${league.name}`,
    tag,
    url: `/league/${league.id}/draft`,
  });

  let sent = 0;
  const deadEndpoints = new Set();
  for (const sub of subs) {
    try {
      const res = await sendPush(sub, payload, { ttl: 3600, urgency: 'high' });
      if (res.ok) sent++;
      else if (res.status === 404 || res.status === 410) deadEndpoints.add(sub.endpoint);
    } catch (e) {
      console.warn(`[draft-notify:${league.id}] Push failed:`, e.message);
    }
  }
  if (deadEndpoints.size) {
    allSubs[email] = subs.filter(s => !deadEndpoints.has(s.endpoint));
    await saveSubs(allSubs);
  }
  console.log(`[draft-notify:${league.id}] Notified ${onClockManager} (${email}) — ${sent} device(s)`);
  return { sent };
}

// ── COMMISSIONER NOTIFICATION ──
// Sends a push notification to the league commissioner.
// Used for join requests, and any other admin action that needs attention.
export async function dispatchCommissionerNotification({ league, title, body, url, tag }) {
  if (inQuietHours()) return { sent: 0, suppressed: true };

  const commishEmail = league.commissioner?.toLowerCase();
  if (!commishEmail) return { sent: 0, reason: 'no commissioner email' };

  const allSubs = await loadSubs();
  const subs = allSubs[commishEmail] || [];
  if (!subs.length) return { sent: 0, reason: 'commissioner has no push subscriptions' };

  const payload = JSON.stringify({ title, body, tag: tag || `commish-${league.id}`, url: url || `/league/${league.id}/settings` });

  let sent = 0;
  const deadEndpoints = new Set();
  for (const sub of subs) {
    try {
      const res = await sendPush(sub, payload, { ttl: 86400, urgency: 'normal' });
      if (res.ok) sent++;
      else if (res.status === 404 || res.status === 410) deadEndpoints.add(sub.endpoint);
    } catch (e) {
      console.warn(`[commish-notify:${league.id}] Push failed:`, e.message);
    }
  }
  if (deadEndpoints.size) {
    allSubs[commishEmail] = subs.filter(s => !deadEndpoints.has(s.endpoint));
    await saveSubs(allSubs);
  }
  console.log(`[commish-notify:${league.id}] Commissioner notified — ${sent} device(s)`);
  return { sent };
}
