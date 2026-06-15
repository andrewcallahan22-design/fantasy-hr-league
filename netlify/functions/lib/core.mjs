// Shared sync logic — runs on Netlify's servers (manual button AND the 5pm/11pm schedule).
// Data source: the official MLB Stats API (statsapi.mlb.com) — public, free, no key.
// These are the same official totals FoxSports displays; server-side we go straight
// to the source. Pure JSON parsing, no AI, no scraping.
//
// Delta model: each player's season HR total is remembered as a baseline.
// When a total rises, the difference is added to their current-month count
// and logged in the change history. Manual entries are never recomputed.

import { getStore } from '@netlify/blobs';
import { INITIAL_STATE } from './initial-state.mjs';

const VERIFIED_IDS = {
  'aaron judge': 592450,
  'shohei ohtani': 660271,
  'nick kurtz': 701762,
};

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export function normName(n) {
  return (n || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

async function resolvePlayerId(state, playerName) {
  const key = normName(playerName);
  if (VERIFIED_IDS[key]) return VERIFIED_IDS[key];
  if (!state.playerIds) state.playerIds = {};
  if (state.playerIds[key]) return state.playerIds[key];

  const url = `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(playerName)}&sportIds=1&active=true`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`MLB search ${resp.status}`);
  const data = await resp.json();
  const person = (data.people || [])[0];
  if (!person) throw new Error(`No MLB match for "${playerName}"`);
  state.playerIds[key] = person.id;
  return person.id;
}

async function fetchGameLogStats(state, playerName, season) {
  const id = await resolvePlayerId(state, playerName);
  const url = `https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=gameLog&group=hitting&season=${season}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`MLB gameLog ${resp.status}`);
  const data = await resp.json();
  const splits = data?.stats?.[0]?.splits || [];
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  let last7 = 0, seasonHR = 0;
  for (const s of splits) {
    const hr = parseInt(s?.stat?.homeRuns) || 0;
    seasonHR += hr;
    if ((s.date || '') >= cutoff) last7 += hr;
  }
  return { last7, seasonHR };
}

function logChange(state, player, delta, mgr, month, src) {
  if (!state.changeLog) state.changeLog = [];
  state.changeLog.push({ t: Date.now(), player, delta, mgr, month, src });
  if (state.changeLog.length > 500) state.changeLog = state.changeLog.slice(-500);
}

export async function loadLeagueState() {
  const store = getStore('league');
  let state = await store.get('state', { type: 'json' });
  if (!state) {
    state = JSON.parse(JSON.stringify(INITIAL_STATE));
    await store.setJSON('state', state);
  }
  return state;
}

export async function saveLeagueState(state) {
  const store = getStore('league');
  await store.setJSON('state', state);
}

export async function runSync() {
  const state = await loadLeagueState();

  const key = state.currentMonth;
  if (!key || !state.months?.[key]) return { ok: false, error: 'No active month' };
  if (!state.seasonBaseline) state.seasonBaseline = {};
  if (!state.streaks) state.streaks = {};
  if (!state.seasonHints) state.seasonHints = {};

  const seasonYear = (key.split('-')[1]) || String(new Date().getFullYear());

  // Unique rostered players for the current month
  const playerSet = new Set();
  for (const mgr of state.managers) {
    for (const p of (state.months[key].rosters[mgr] || [])) {
      if (p.player) playerSet.add(p.player);
    }
  }
  const players = [...playerSet];
  if (!players.length) return { ok: false, error: 'No players on roster' };

  let added = 0;
  const failed = [];

  // Fetch sequentially-ish in small parallel batches to be polite to the API
  const results = await Promise.all(players.map(async (p) => {
    try {
      const { last7, seasonHR } = await fetchGameLogStats(state, p, seasonYear);
      return { player: p, last7, seasonHR, ok: true };
    } catch (e) {
      return { player: p, ok: false, err: e.message };
    }
  }));

  // Collect HR events so we can notify the right managers after state is saved.
  const hrEvents = []; // { player, delta, mgr } per slot updated
  const leaderBefore = computeLeader(state);

  for (const r of results) {
    const nk = normName(r.player);
    if (!r.ok) { failed.push(r.player); continue; }

    state.streaks[nk] = r.last7;
    state.seasonHints[nk] = r.seasonHR;

    const baseline = state.seasonBaseline[nk];
    if (baseline === undefined) {
      // First time we've seen this player: anchor only, change nothing.
      state.seasonBaseline[nk] = r.seasonHR;
      continue;
    }
    const delta = r.seasonHR - baseline;
    if (delta !== 0) {
      for (const mgr of state.managers) {
        for (const slot of (state.months[key].rosters[mgr] || [])) {
          if (slot.player && normName(slot.player) === nk) {
            slot.hr = Math.max(0, (parseInt(slot.hr) || 0) + delta);
            logChange(state, slot.player, delta, mgr, key, 'sync');
            if (delta > 0) {
              added += delta;
              hrEvents.push({ player: slot.player, delta, mgr });
            }
          }
        }
      }
      state.seasonBaseline[nk] = r.seasonHR;
    }
  }

  const leaderAfter = computeLeader(state);

  state.lastSync = Date.now();
  await saveLeagueState(state);

  // Fire-and-forget notification fan-out. Failures here must not break the sync.
  if (hrEvents.length || leaderAfter?.name !== leaderBefore?.name) {
    try {
      const { dispatchNotifications } = await import('./notify.mjs');
      await dispatchNotifications({ state, hrEvents, leaderBefore, leaderAfter });
    } catch (e) {
      console.warn('Notification dispatch failed (non-fatal):', e.message);
    }
  }

  return { ok: true, added, failed, ts: state.lastSync };
}

function computeLeader(state) {
  const key = state.currentMonth;
  if (!key || !state.months?.[key]) return null;
  const totals = {};
  for (const mgr of state.managers) {
    totals[mgr] = (state.months[key].rosters[mgr] || [])
      .reduce((s, p) => s + (parseInt(p.hr) || 0), 0);
  }
  let leader = null, max = -1;
  for (const [m, t] of Object.entries(totals)) {
    if (t > max) { max = t; leader = m; }
  }
  return leader ? { name: leader, hr: max } : null;
}
