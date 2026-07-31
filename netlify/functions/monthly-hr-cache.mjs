// Builds and caches real per-player HR totals for the most recently completed
// calendar month, across the full ~400-hitter draft pool.
//
// MLB's bulk "leaders" endpoint (used to build the draft pool) only ever
// returns season totals — date-range and split params are silently ignored
// (confirmed by direct testing). Monthly splits only exist per individual
// player via people/{id}/stats?stats=byMonth. Getting real numbers for the
// full pool means ~400 API calls, too slow to do inline during a page load —
// so this runs on its own daily background schedule instead, and is a no-op
// once the target month is already cached. A completed month's HR totals
// never change, so this only ever needs to run once per month in practice.
import { getStore } from '@netlify/blobs';
import { normName } from './lib/core.mjs';

export const config = { schedule: '0 6 * * *', background: true }; // daily, 6am UTC

const MONTHS = ['January','February','March','April','May','June','July','August',
                'September','October','November','December'];

function prevMonthInfo(ts) {
  const d = new Date(ts);
  let monthIndex = d.getMonth() - 1, year = d.getFullYear();
  if (monthIndex < 0) { monthIndex = 11; year--; }
  return { key: `${MONTHS[monthIndex]}-${year}`, monthIndex, year };
}

export default async () => {
  const store = getStore('league');
  const { key: targetMonthKey, monthIndex, year } = prevMonthInfo(Date.now());
  const cacheKey = `monthlyHR-${targetMonthKey}`;

  const existing = await store.get(cacheKey, { type: 'json' });
  if (existing) {
    console.log(`[monthly-hr-cache] ${targetMonthKey} already cached (${Object.keys(existing.hr || {}).length} players) — skipping`);
    return new Response(JSON.stringify({ ok: true, skipped: true }));
  }

  console.log(`[monthly-hr-cache] Building cache for ${targetMonthKey}...`);

  // Same bulk leaders call the draft pool uses — one cheap request for the
  // player list, not per-player.
  const leadersUrl = `https://statsapi.mlb.com/api/v1/stats/leaders?leaderCategories=homeRuns&statGroup=hitting&season=${year}&sportId=1&limit=500`;
  let players = [];
  try {
    const leadersResp = await fetch(leadersUrl);
    if (!leadersResp.ok) throw new Error(`leaders ${leadersResp.status}`);
    const leadersData = await leadersResp.json();
    players = (leadersData?.leagueLeaders?.[0]?.leaders || [])
      .map(l => ({ id: l?.person?.id, name: l?.person?.fullName }))
      .filter(p => p.id && p.name);
  } catch (e) {
    console.error(`[monthly-hr-cache] Leaders fetch failed:`, e.message);
    return new Response(JSON.stringify({ ok: false, error: e.message }));
  }

  const hrByName = {};
  let failed = 0;
  const BATCH = 10;
  for (let i = 0; i < players.length; i += BATCH) {
    const batch = players.slice(i, i + BATCH);
    await Promise.all(batch.map(async (p) => {
      try {
        const resp = await fetch(`https://statsapi.mlb.com/api/v1/people/${p.id}/stats?stats=byMonth&group=hitting&season=${year}`);
        if (!resp.ok) { failed++; return; }
        const data = await resp.json();
        const splits = data?.stats?.[0]?.splits || [];
        // MLB's month field is 1-indexed (matches Date.getMonth() + 1)
        const monthSplit = splits.find(s => s.month === monthIndex + 1);
        hrByName[normName(p.name)] = parseInt(monthSplit?.stat?.homeRuns) || 0;
      } catch (e) {
        failed++;
      }
    }));
  }

  await store.setJSON(cacheKey, { t: Date.now(), month: targetMonthKey, hr: hrByName });
  console.log(`[monthly-hr-cache] Cached ${Object.keys(hrByName).length} players for ${targetMonthKey} (${failed} failed)`);
  return new Response(JSON.stringify({ ok: true, month: targetMonthKey, count: Object.keys(hrByName).length, failed }));
};
