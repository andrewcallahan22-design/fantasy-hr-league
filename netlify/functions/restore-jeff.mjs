// ONE-TIME restore script for Jeff league (splash-hawks-818f)
// Restores rosters from the August-2026 data we recovered.
// HR counts are set to 0 — the sync will recalculate correctly
// from seasonBaseline on the next run, picking up all HRs
// including any hit during the ~5 hour gap.

import { loadLeague, saveLeague } from './lib/storage.mjs';

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get('secret') !== 'goyard2026restore') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const league = await loadLeague('splash-hawks-818f');
  if (!league) return Response.json({ ok: false, error: 'League not found' });

  // Restore rosters with hr:0 — sync will recalculate from seasonBaseline
  // This catches all HRs including the last 5 hours
  const restoredRosters = {
    'Cali': [
      { player: 'Junior Caminero',   team: 'TB',  position: '3B',  hr: 0 },
      { player: 'Mike Trout',        team: 'LAA', position: 'CF',  hr: 0 },
      { player: 'Ben Rice',          team: 'NYY', position: '1B',  hr: 0 },
      { player: 'Brooks Lee',        team: 'MIN', position: 'SS',  hr: 0 },
      { player: 'Juan Soto',         team: 'NYM', position: 'RF',  hr: 0 },
      { player: 'Ketel Marte',       team: 'ARI', position: '2B',  hr: 0 },
    ],
    'Ding Dongers': [
      { player: 'Yordan Alvarez',    team: 'HOU', position: 'DH',  hr: 0 },
      { player: 'Colson Montgomery', team: 'CHW', position: 'SS',  hr: 0 },
      { player: 'James Wood',        team: 'WSH', position: 'RF',  hr: 0 },
      { player: 'Kazuma Okamoto',    team: 'TOR', position: '3B',  hr: 0 },
      { player: 'JJ Bleday',         team: 'CIN', position: 'LF',  hr: 0 },
      { player: 'Willson Contreras', team: 'BOS', position: '1B',  hr: 0 },
    ],
    'Prestige Worldwide': [
      { player: 'Shohei Ohtani',     team: 'LAD', position: 'TWP', hr: 0 },
      { player: 'Hunter Goodman',    team: 'COL', position: 'C',   hr: 0 },
      { player: 'Nick Kurtz',        team: 'ATH', position: '1B',  hr: 0 },
      { player: 'Manny Machado',     team: 'SD',  position: '3B',  hr: 0 },
      { player: 'Brice Turang',      team: 'MIL', position: '2B',  hr: 0 },
      { player: 'Gunnar Henderson',  team: 'BAL', position: 'SS',  hr: 0 },
    ],
    'SeaBassSaidThat?': [
      { player: 'Kyle Schwarber',        team: 'PHI', position: 'DH',  hr: 0 },
      { player: 'Matt Olson',            team: 'ATL', position: '1B',  hr: 0 },
      { player: 'Jordan Walker',         team: 'STL', position: 'RF',  hr: 0 },
      { player: 'Pete Crow-Armstrong',   team: 'CHC', position: 'CF',  hr: 0 },
      { player: 'Brandon Lowe',          team: 'PIT', position: '2B',  hr: 0 },
      { player: 'Casey Schmitt',         team: 'SFG', position: '3B',  hr: 0 },
    ],
  };

  // Write into July-2026
  if (!league.months['July-2026']) league.months['July-2026'] = {};
  league.months['July-2026'].rosters = restoredRosters;
  league.months['July-2026'].rostersLiveAt = league.draftClosedAt || Date.now();
  league.currentMonth = 'July-2026';

  // Remove August bucket
  delete league.months['August-2026'];

  // Reset seasonBaseline for all restored players to 0
  // so the next sync recalculates the full delta from scratch
  // (current season HR - 0 = full count since draft)
  // BUT we need to preserve the existing baselines so we only count
  // HRs SINCE the draft, not the player's entire season.
  // The existing seasonBaseline entries are already set from when
  // the draft pool was loaded — they represent HRs before the draft.
  // So we leave seasonBaseline UNTOUCHED and let the sync add the delta.

  await saveLeague(league);

  return Response.json({
    ok: true,
    message: 'Jeff league rosters restored. HR counts set to 0 — sync will recalculate all HRs from seasonBaseline within 60 seconds.',
    rosters: Object.fromEntries(
      Object.entries(restoredRosters).map(([mgr, r]) => [mgr, r.map(p => p.player)])
    )
  });
};
