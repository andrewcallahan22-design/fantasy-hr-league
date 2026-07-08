// Player profile endpoint
// GET ?id={mlbPlayerId} OR ?name={playerName}
// Returns: bio, current health status, season stats, last 10 game log, MLB.com URL
import { loadLeague } from './lib/storage.mjs';

const TEAM_ABBR = {
  108:'LAA',109:'ARI',110:'BAL',111:'BOS',112:'CHC',113:'CIN',114:'CLE',115:'COL',
  116:'DET',117:'HOU',118:'KC', 119:'LAD',120:'WSH',121:'NYM',133:'ATH',134:'PIT',
  135:'SD', 136:'SEA',137:'SFG',138:'STL',139:'TB', 140:'TEX',141:'TOR',142:'MIN',
  143:'PHI',144:'ATL',145:'CHW',146:'MIA',147:'NYY',158:'MIL',
};

const NO_CACHE = { 'Cache-Control': 'no-store' };

export default async (req) => {
  const url  = new URL(req.url);
  let playerId = url.searchParams.get('id');
  const name   = url.searchParams.get('name');
  const season = new Date().getFullYear();

  // Resolve name → id if needed
  if (!playerId && name) {
    try {
      const searchUrl = `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(name)}&sportIds=1&active=true`;
      const r = await fetch(searchUrl);
      if (r.ok) {
        const data = await r.json();
        playerId = data?.people?.[0]?.id;
      }
    } catch {}
  }
  if (!playerId) {
    return Response.json({ ok: false, error: 'Player not found' }, { status: 404, headers: NO_CACHE });
  }

  try {
    // Fetch profile + current team in one call
    const profileUrl = `https://statsapi.mlb.com/api/v1/people/${playerId}?hydrate=currentTeam,stats(group=hitting,type=season,season=${season}),rosterEntries`;
    const profileResp = await fetch(profileUrl);
    if (!profileResp.ok) throw new Error(`MLB profile ${profileResp.status}`);
    const profileData = await profileResp.json();
    const person = profileData?.people?.[0];
    if (!person) throw new Error('Player not found in MLB API');

    // Health status from active roster entry
    const teamId = person.currentTeam?.id;
    let health = 'Active', healthDetail = '';
    if (teamId) {
      try {
        const rosterUrl = `https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=40Man&season=${season}`;
        const rosterResp = await fetch(rosterUrl);
        if (rosterResp.ok) {
          const rosterData = await rosterResp.json();
          const entry = (rosterData.roster || []).find(e => e?.person?.id == playerId);
          if (entry) {
            const code = entry.status?.code || 'A';
            const desc = entry.status?.description || '';
            if (code.startsWith('D') || code === 'IL') {
              health = 'IL';
              healthDetail = desc || code;
            } else if (code !== 'A') {
              health = code;
              healthDetail = desc;
            }
          }
        }
      } catch {}
    }

    // Season stats
    const seasonStats = person.stats?.find(s => s.group?.displayName === 'hitting')?.splits?.[0]?.stat || {};

    // Last 10 games game log
    let recentGames = [];
    try {
      const glUrl = `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&group=hitting&season=${season}&limit=10`;
      const glResp = await fetch(glUrl);
      if (glResp.ok) {
        const glData = await glResp.json();
        recentGames = (glData?.stats?.[0]?.splits || [])
          .slice(-10)
          .reverse()
          .map(g => ({
            date:     g.date,
            opponent: g.opponent?.abbreviation || '?',
            hr:       parseInt(g.stat?.homeRuns)  || 0,
            avg:      g.stat?.avg               || '.000',
            hits:     parseInt(g.stat?.hits)     || 0,
            ab:       parseInt(g.stat?.atBats)   || 0,
            rbi:      parseInt(g.stat?.rbi)      || 0,
          }));
      }
    } catch {}

    return Response.json({
      ok: true,
      player: {
        id:          playerId,
        name:        person.fullName,
        team:        TEAM_ABBR[teamId] || person.currentTeam?.abbreviation || '?',
        teamName:    person.currentTeam?.name || '',
        pos:         person.primaryPosition?.abbreviation || '?',
        number:      person.primaryNumber || '',
        bats:        person.batSide?.code || '?',
        throws:      person.pitchHand?.code || '?',
        age:         person.currentAge || '',
        mlbUrl:      `https://www.mlb.com/player/${person.fullName?.toLowerCase().replace(/\s+/g, '-')}-${playerId}`,
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
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500, headers: NO_CACHE });
  }
};
