// Regression tests for the sync engine's month-promotion / lock / baseline-
// reentry state machine — the source of every recurring HR-tracking
// incident this app has hit (Washed Dad's, Jeff Thinks He Will Win, and The
// Ghost of Peavy, twice). These test the exact pure functions core.mjs
// calls, not a reimplementation, so a change to the real logic is checked
// here automatically.
//
// Run with: node --test netlify/functions/lib/core.sync-state.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPromoteMonth, isMonthLocked, decidePlayerHrDelta } from './core.mjs';

const MIN = 60 * 1000;

describe('shouldPromoteMonth', () => {
  test('promotes once real time reaches a month that has been drafted', () => {
    assert.equal(shouldPromoteMonth('August-2026', 'September-2026', true), true);
  });

  test('does not promote when the next month has not been drafted yet', () => {
    // This is exactly the gap isMonthLocked exists to guard — nothing to
    // promote into, so currentMonth would otherwise stay stuck forever.
    assert.equal(shouldPromoteMonth('August-2026', 'September-2026', false), false);
  });

  test('does not promote when real time has not moved past current month', () => {
    assert.equal(shouldPromoteMonth('August-2026', 'August-2026', true), false);
  });

  test('does not promote backwards', () => {
    assert.equal(shouldPromoteMonth('September-2026', 'August-2026', true), false);
  });
});

describe('isMonthLocked', () => {
  test('locked once real time has moved past currentMonth', () => {
    assert.equal(isMonthLocked('August-2026', 'September-2026'), true);
  });

  test('not locked while still within the current month', () => {
    assert.equal(isMonthLocked('August-2026', 'August-2026'), false);
  });

  test('not locked if currentMonth is somehow ahead of real time', () => {
    assert.equal(isMonthLocked('September-2026', 'August-2026'), false);
  });
});

describe('decidePlayerHrDelta', () => {
  test('never-seen-before player anchors cleanly with zero credit', () => {
    const r = decidePlayerHrDelta({ baseline: undefined, lastSyncedAt: undefined, now: 1000, seasonHR: 22 });
    assert.equal(r.isStaleReentry, false);
    assert.equal(r.delta, 0);
  });

  test('normal continuous tracking credits the real delta', () => {
    const r = decidePlayerHrDelta({ baseline: 20, lastSyncedAt: 1000, now: 1000 + 3 * MIN, seasonHR: 21 });
    assert.equal(r.isStaleReentry, false);
    assert.equal(r.delta, 1);
  });

  test('a month-boundary transition (one cron cycle gap) still credits normally', () => {
    // The auto-promote block flips currentMonth and this loop reads the new
    // key in the SAME sync pass, so a continuously-rostered player crossing
    // a month boundary never sees more than one cycle's gap here.
    const r = decidePlayerHrDelta({ baseline: 21, lastSyncedAt: 1000, now: 1000 + 3 * MIN, seasonHR: 22 });
    assert.equal(r.isStaleReentry, false);
    assert.equal(r.delta, 1);
  });

  test('a long real gap with a recorded lastSyncedAt re-anchors instead of crediting the backlog', () => {
    // The original Juan Soto incident: dropped mid-season, picked up again
    // weeks later. lastSyncedAt WAS being recorded the whole time (this
    // player's league was never locked) — the gap alone is what matters.
    const sevenWeeks = 7 * 7 * 24 * 60 * MIN;
    const r = decidePlayerHrDelta({ baseline: 21, lastSyncedAt: 1000, now: 1000 + sevenWeeks, seasonHR: 22 });
    assert.equal(r.isStaleReentry, true);
    assert.equal(r.delta, 0);
  });

  test('an existing baseline with no recorded lastSyncedAt at all re-anchors, not credits', () => {
    // The Ghost of Peavy incident: the whole league sat locked (see
    // isMonthLocked) for days, so lastSyncedAt was NEVER set for any of its
    // players no matter how long the lock lasted — this must NOT be
    // mistaken for "definitely continuous, safe to credit." This is the
    // exact case the first version of this fix got backwards.
    const r = decidePlayerHrDelta({ baseline: 5, lastSyncedAt: undefined, now: 1000 + 30 * 24 * 60 * MIN, seasonHR: 28 });
    assert.equal(r.isStaleReentry, true);
    assert.equal(r.delta, 0);
  });

  test('gap just under the threshold still credits normally', () => {
    const r = decidePlayerHrDelta({ baseline: 21, lastSyncedAt: 1000, now: 1000 + 19 * MIN, seasonHR: 25 });
    assert.equal(r.isStaleReentry, false);
    assert.equal(r.delta, 4);
  });

  test('gap just over the threshold re-anchors', () => {
    const r = decidePlayerHrDelta({ baseline: 21, lastSyncedAt: 1000, now: 1000 + 21 * MIN, seasonHR: 25 });
    assert.equal(r.isStaleReentry, true);
    assert.equal(r.delta, 0);
  });

  test('no real change at all is not treated as stale', () => {
    const r = decidePlayerHrDelta({ baseline: 15, lastSyncedAt: 1000, now: 1000 + 3 * MIN, seasonHR: 15 });
    assert.equal(r.isStaleReentry, false);
    assert.equal(r.delta, 0);
  });
});

describe('end-to-end: a locked league unlocking (The Ghost of Peavy scenario)', () => {
  test('a month stuck with no next draft locks, then unlocks and re-anchors with zero credit once drafted', () => {
    // August ends, no September draft exists yet.
    assert.equal(shouldPromoteMonth('August-2026', 'September-2026', false), false);
    assert.equal(isMonthLocked('August-2026', 'September-2026'), true);
    // ...league sits locked for days. Its players' lastSyncedAt never
    // advances because the sync loop never runs for this league at all
    // while locked — simulated here by simply never calling
    // decidePlayerHrDelta during this stretch, exactly as the real
    // isMonthLocked early-return does.

    // The September draft finally closes — now the bucket exists.
    assert.equal(shouldPromoteMonth('August-2026', 'September-2026', true), true);
    assert.equal(isMonthLocked('September-2026', 'September-2026'), false);

    // First sync after unlocking: this player's baseline is from whenever
    // they were last tracked, potentially long before the lock even began,
    // and lastSyncedAt was never set during the entire locked stretch.
    const r = decidePlayerHrDelta({ baseline: 7, lastSyncedAt: undefined, now: Date.now(), seasonHR: 14 });
    assert.equal(r.isStaleReentry, true);
    assert.equal(r.delta, 0, 'the untracked backlog must not be credited to whoever just drafted them');
  });
});
