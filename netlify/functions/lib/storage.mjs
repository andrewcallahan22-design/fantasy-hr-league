// Multi-tenant storage layer.
// Each league is its own blob: league:{leagueId}
// Each user account is its own blob: user:{email-normalized}
// Sessions and global indexes follow similar patterns.
//
// On first call to loadLeague(legacyId), if no multi-tenant data exists,
// we migrate the legacy single-tenant `state` blob into the new system as
// the founding "default" league, so Andrew's existing rosters/history/etc.
// survive the upgrade intact.

import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const store = () => getStore('league');

// ── ID generation ──
// Slug-like IDs are stable and URL-friendly.
const adjectives = ['classic','sluggers','dingers','homer','splash','grand','rally','bombs','sandlot','wildcard','clutch'];
const animals    = ['eagles','pirates','tigers','bears','foxes','wolves','hawks','cubs','aces','knights','dragons'];

export function newLeagueId() {
  const a = adjectives[Math.floor(Math.random()*adjectives.length)];
  const n = animals[Math.floor(Math.random()*animals.length)];
  const suffix = crypto.randomBytes(2).toString('hex');
  return `${a}-${n}-${suffix}`;
}

export function newInviteToken() {
  return crypto.randomBytes(12).toString('base64url');
}

// ── League records ──
//
// League shape:
// {
//   id: 'sluggers-eagles-1a2b',
//   name: 'Sluggers',
//   createdAt: 12345,
//   commissioner: 'andrewcallahan22@gmail.com',
//   inviteToken: 'abc...',
//   plan: 'free',                  // hidden: payment-ready
//   tier: 'standard',              // hidden: payment-ready
//   settings: {
//     rosterSize: 6,
//     scoringCategories: ['hr'],
//     positionsAllowed: ['C','1B','2B','3B','SS','OF','RF','CF','LF','DH','SP','RP'],
//     positionRule: 'one-duplicate-allowed',  // or 'all-unique', 'unrestricted'
//     teamRule: 'all-unique',                 // or 'unrestricted'
//     multiPlayerPerTeam: false,              // can two managers draft same player? (no by default)
//     redraftCadence: 'monthly',              // monthly | weekly | season
//     maxManagers: null,                      // null = no cap (validation phase)
//   },
//   members: [
//     { manager: 'Andrew',     email: 'andrew@…',  status: 'active', joinedAt: 12345 },
//     { manager: 'Bob',        email: 'bob@…',     status: 'pending', joinedAt: 12350 },
//   ],
//   pendingInvites: [
//     // future code-based invites slot in here
//   ],
//   // Game state (rosters, HR counts, draft, etc) — migrated from legacy:
//   managers: ['Max','Johnny','HK','Cali'],
//   positions: ['C','1B','2B','3B','SS','OF','RF','CF','LF','DH','SP','RP'],
//   currentMonth: 'June-2026',
//   months: { ... },
//   seasonBaseline: {},
//   seasonHints: {},
//   streaks: {},
//   playerIds: {},
//   changeLog: [],
//   lastSync: null,
//   draft: null,
// }

function makeBlankSettings() {
  return {
    rosterSize: 6,
    scoringCategories: ['hr'],
    positionsAllowed: ['C','1B','2B','3B','SS','OF','RF','CF','LF','DH','SP','RP'],
    positionRule: 'one-duplicate-allowed',
    teamRule: 'all-unique',
    multiPlayerPerTeam: false,
    redraftCadence: 'monthly',
    maxManagers: null,
  };
}

export async function loadLeague(leagueId) {
  return await store().get(`league:${leagueId}`, { type: 'json' });
}

export async function saveLeague(league) {
  if (!league?.id) throw new Error('League missing id');
  await store().setJSON(`league:${league.id}`, league);
}

export async function listLeagues() {
  const idx = (await store().get('leagues-index', { type: 'json' })) || [];
  return idx;
}

export async function addLeagueToIndex(league) {
  const idx = await listLeagues();
  if (!idx.find(l => l.id === league.id)) {
    idx.push({ id: league.id, name: league.name, createdAt: league.createdAt });
    await store().setJSON('leagues-index', idx);
  }
}

// ── Users ──
export async function getUser(email) {
  return await store().get(`user:${email.toLowerCase()}`, { type: 'json' });
}
export async function saveUser(user) {
  await store().setJSON(`user:${user.email.toLowerCase()}`, user);
}

// ── Sessions (shared across leagues) ──
// session shape: { token, email, exp }
// Note: a session represents a USER, not a manager. Per-league manager identity
// is resolved by looking up the user's email in the target league's members.
export async function getSessions() {
  return (await store().get('sessions', { type: 'json' })) || {};
}
export async function saveSessions(s) {
  await store().setJSON('sessions', s);
}

// ── One-time migration of legacy single-tenant state ──
// Run lazily: the first time anyone asks for the default league.
const LEGACY_LEAGUE_ID = 'andrews-league-2026';

export async function ensureLegacyMigrated() {
  const existing = await loadLeague(LEGACY_LEAGUE_ID);
  if (existing) return existing; // already migrated

  const legacy = await store().get('state', { type: 'json' });
  if (!legacy) return null;  // no legacy data, nothing to migrate

  // Pull in legacy users that were registered against the single-tenant schema
  const legacyUsers = (await store().get('users', { type: 'json' })) || {};

  // The historical commissioner is Andrew Callahan
  const commish = 'andrewcallahan22@gmail.com';

  // Migrate users — each existing user becomes a top-level user account.
  for (const [email, u] of Object.entries(legacyUsers)) {
    await saveUser({
      email: email.toLowerCase(),
      salt: u.salt,
      hash: u.hash,
      displayName: u.manager,
      createdAt: u.createdAt || Date.now(),
      leagues: [LEGACY_LEAGUE_ID],
    });
  }

  // Build the league record from the legacy state, mapping managers → members
  const members = (legacy.managers || []).map(mgr => {
    const userEmail = Object.entries(legacyUsers).find(([_, u]) => u.manager === mgr)?.[0];
    return {
      manager: mgr,
      email: userEmail || null,
      status: 'active',
      joinedAt: legacy.createdAt || Date.now(),
    };
  });

  const settings = makeBlankSettings();
  // Andrew's league used these specific settings, capture them:
  settings.rosterSize = 6;
  settings.scoringCategories = ['hr'];

  const league = {
    id: LEGACY_LEAGUE_ID,
    name: 'Andrew\'s League',
    createdAt: legacy.createdAt || Date.now(),
    commissioner: commish,
    inviteToken: newInviteToken(),
    plan: 'free',
    tier: 'standard',
    settings,
    members,
    pendingInvites: [],
    // Preserve all the legacy game state untouched:
    managers: legacy.managers || [],
    positions: legacy.positions || settings.positionsAllowed,
    currentMonth: legacy.currentMonth,
    months: legacy.months || {},
    seasonBaseline: legacy.seasonBaseline || {},
    seasonHints: legacy.seasonHints || {},
    streaks: legacy.streaks || {},
    playerIds: legacy.playerIds || {},
    changeLog: legacy.changeLog || [],
    lastSync: legacy.lastSync || null,
    draft: legacy.draft || null,
    autoSync: legacy.autoSync !== false,
  };

  await saveLeague(league);
  await addLeagueToIndex(league);
  console.log('Migrated legacy single-tenant league to multi-tenant:', LEGACY_LEAGUE_ID);
  return league;
}

export { LEGACY_LEAGUE_ID, makeBlankSettings };
