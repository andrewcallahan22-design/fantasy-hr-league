// Player profile endpoint
// GET ?id={mlbPlayerId} OR ?name={playerName}
// All MLB API calls run in parallel to stay well within Netlify's 10s timeout.

const NO_CACHE = { 'Cache-Control': 'no-store' };

const TEAM_ABBR = {
  108:'LAA',109:'ARI',110:'BAL',111:'BOS',112:'CHC',113:'CIN',114:'CLE',115:'COL',
  116:'DET',117:'HOU',118:'KC', 119:'LAD',120:'WSH',121:'NYM',133:'ATH',134:'PIT',
  135:'SD', 136:'SEA',137:'SFG',138:'STL',139:'TB', 140:'TEX',141:'TOR',142:'MIN',
  143:'PHI',144:'ATL',145:'CHW',146:'MIA',147:'NYY',158:'MIL',
};

// Fetch with a timeout so one slow MLB API call never kills the whole response
async function fetchWithTimeout(url, ms = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return r;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

export default async (req) => {
  const url = new URL(req.url);
  let playerId = url.searchParams.get('id');
  const name   = url.searchParams.get('name');
  const season = new Date().getFullYear();

  // Resolve name → id via MLB people search
  if (!playerId && name) {
    try {
      const r = await fetchWithTimeout(
        `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(name)}&sportIds=1&active=true`,
        4000
      );
      if (r.ok) {
        const d = await r.json();
        playerId = d?.people?.[0]?.id;
      }
    } catch {}
  }

  if (!playerId) {
    return Response.json({ ok: false, error: 'Player not found' }, { status: 404, headers: NO_CACHE });
  }

  // Fire all three MLB API calls in parallel
  const [profileRes, glRes] = await Promise.allSettled([
    // 1. Profile + season stats
    fetchWithTimeout(
      `https://statsapi.mlb.com/api/v1/people/${playerId}?hydrate=currentTeam,stats(group=hitting,type=season,season=${season})`,
      6000
    ).then(r => r.ok ? r.json() : null).catch(() => null),

    // 2. Game log (last 10 games)
    fetchWithTimeout(
      `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&group=hitting&season=${season}&limit=10`,
      6000
    ).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);

  const profileData = profileRes.status === 'fulfilled' ? profileRes.value : null;
  const glData      = glRes.status === 'fulfilled'      ? glRes.value      : null;

  const person = profileData?.people?.[0];
  if (!person) {
    return Response.json({ ok: false, error: 'Player not found in MLB API' }, { status: 404, headers: NO_CACHE });
  }

  const teamId = person.currentTeam?.id;

  // Health status — fetch team roster separately (can fail gracefully)
  let health = 'Active', healthDetail = '';
  if (teamId) {
    try {
      const rosterRes = await fetchWithTimeout(
        `https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=40Man&season=${season}`,
        4000
      );
      if (rosterRes.ok) {
        const rosterData = await rosterRes.json();
        const entry = (rosterData.roster || []).find(e => String(e?.person?.id) === String(playerId));
        if (entry) {
          const code = entry.status?.code || 'A';
          const desc = entry.status?.description || '';
          if (code.startsWith('D') || code === 'IL') { health = 'IL'; healthDetail = desc || code; }
          else if (code !== 'A') { health = code; healthDetail = desc; }
        }
      }
    } catch {}
  }

  // Season stats
  const seasonStats = person.stats?.find(s => s.group?.displayName === 'hitting')?.splits?.[0]?.stat || {};

  // Recent games
  const recentGames = (glData?.stats?.[0]?.splits || [])
    .slice(-10).reverse()
    .map(g => ({
      date:     g.date,
      opponent: g.opponent?.abbreviation || '?',
      hr:       parseInt(g.stat?.homeRuns) || 0,
      avg:      g.stat?.avg || '.000',
      hits:     parseInt(g.stat?.hits) || 0,
      ab:       parseInt(g.stat?.atBats) || 0,
      rbi:      parseInt(g.stat?.rbi) || 0,
    }));

  const slug = `${(person.fullName || '').toLowerCase().replace(/\s+/g, '-')}-${playerId}`;

  return Response.json({
    ok: true,
    player: {
      id:          playerId,
      name:        person.fullName || name || '',
      team:        TEAM_ABBR[teamId] || person.currentTeam?.abbreviation || '?',
      teamName:    person.currentTeam?.name || '',
      pos:         person.primaryPosition?.abbreviation || '?',
      number:      person.primaryNumber || '',
      age:         person.currentAge || '',
      mlbUrl:      `https://www.mlb.com/player/${slug}`,
      health,
      healthDetail,
      season: {
        hr:    parseInt(seasonStats.homeRuns)    || 0,
        avg:   seasonStats.avg                   || '.000',
        ops:   seasonStats.ops                   || '.000',
        rbi:   parseInt(seasonStats.rbi)         || 0,
        sb:    parseInt(seasonStats.stolenBases) || 0,
        hits:  parseInt(seasonStats.hits)        || 0,
        ab:    parseInt(seasonStats.atBats)      || 0,
        obp:   seasonStats.obp                   || '.000',
        slg:   seasonStats.slg                   || '.000',
        games: parseInt(seasonStats.gamesPlayed) || 0,
      },
      recentGames,
    },
  }, { headers: NO_CACHE });
};
