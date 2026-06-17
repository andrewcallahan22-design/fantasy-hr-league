// Initial league state — seeds shared storage on the very first load.
// After that, the stored copy is the single source of truth for everyone.
export const INITIAL_STATE={
  managers:['Max','Johnny','HK','Cali'],
  positions:['C','1B','2B','3B','SS','OF','RF','CF','LF','DH','SP','RP'],
  currentMonth:'June-2026',
  autoSync:true,
  // Seeded streak estimates from the June 10 baseline; replaced with exact
  // MLB game-log values on the first successful sync.
  streaks:{'aaron judge':0,'bobby witt jr':0,'juan soto':0,'gunnar henderson':0,'nick kurtz':2,'hunter goodman':2},
  months:{
    'April-2026':{rosters:{
      'Max':[{player:'Aaron Judge',team:'NYY',position:'RF',hr:12},{player:'Pete Alonso',team:'NYM',position:'1B',hr:4},{player:'Bobby Witt Jr',team:'KC',position:'SS',hr:2},{player:'Vlad Guerrero Jr',team:'TOR',position:'1B',hr:2},{player:'Yordan Alvarez',team:'HOU',position:'DH',hr:12},{player:'Ketel Marte',team:'ARI',position:'2B',hr:5}],
      'Johnny':[{player:'Kyle Schwarber',team:'PHI',position:'DH',hr:11},{player:'Eugenio Suarez',team:'ARI',position:'3B',hr:3},{player:'Byron Buxton',team:'MIN',position:'CF',hr:8},{player:'Nick Kurtz',team:'ATH',position:'1B',hr:5},{player:'Jose Ramirez',team:'CLE',position:'3B',hr:6},{player:'Hunter Goodman',team:'COL',position:'C',hr:9}],
      'HK':[{player:'Shohei Ohtani',team:'LAD',position:'DH',hr:6},{player:'Juan Soto',team:'NYM',position:'RF',hr:3},{player:'Jo Adell',team:'LAA',position:'OF',hr:4},{player:'Fernando Tatis Jr',team:'SD',position:'RF',hr:0},{player:'Matt Olson',team:'ATL',position:'1B',hr:9},{player:'Munetaka Murakami',team:'NYM',position:'DH',hr:12}],
      'Cali':[{player:'Cal Raleigh',team:'SEA',position:'C',hr:7},{player:'Junior Caminero',team:'TB',position:'3B',hr:8},{player:'Riley Greene',team:'DET',position:'CF',hr:4},{player:'Michael Busch',team:'CHC',position:'1B',hr:2},{player:'Rafael Devers',team:'BOS',position:'3B',hr:2},{player:'James Wood',team:'WAS',position:'RF',hr:10}]
    }},
    'May-2026':{rosters:{
      'Max':[{player:'Aaron Judge',team:'NYY',position:'RF',hr:5},{player:'Junior Caminero',team:'TB',position:'3B',hr:5},{player:'Cal Raleigh',team:'SEA',position:'C',hr:0},{player:'Nick Kurtz',team:'ATH',position:'1B',hr:5},{player:'Jose Ramirez',team:'CLE',position:'3B',hr:2},{player:'Bobby Witt Jr',team:'KC',position:'SS',hr:7}],
      'Johnny':[{player:'Kyle Schwarber',team:'PHI',position:'DH',hr:11},{player:'Elly De La Cruz',team:'CIN',position:'SS',hr:2},{player:'Mike Trout',team:'LAA',position:'CF',hr:4},{player:'Byron Buxton',team:'MIN',position:'CF',hr:9},{player:'Hunter Goodman',team:'COL',position:'C',hr:4},{player:'Willson Contreras',team:'STL',position:'C',hr:4}],
      'HK':[{player:'Munetaka Murakami',team:'NYM',position:'DH',hr:8},{player:'Yordan Alvarez',team:'HOU',position:'DH',hr:8},{player:'Gunnar Henderson',team:'BAL',position:'SS',hr:4},{player:'Oneil Cruz',team:'PIT',position:'SS',hr:4},{player:'Ildemaro Vargas',team:'',position:'',hr:1},{player:'Riley Greene',team:'DET',position:'CF',hr:0}],
      'Cali':[{player:'Shohei Ohtani',team:'LAD',position:'DH',hr:4},{player:'Juan Soto',team:'NYM',position:'RF',hr:10},{player:'James Wood',team:'WAS',position:'RF',hr:6},{player:'Vlad Guerrero Jr',team:'TOR',position:'1B',hr:1},{player:'Matt Olson',team:'ATL',position:'1B',hr:7},{player:'Corey Seager',team:'TEX',position:'SS',hr:1}]
    }},
    'June-2026':{rosters:{
      'Max':[{player:'Aaron Judge',team:'NYY',position:'RF',hr:0},{player:'Junior Caminero',team:'TB',position:'3B',hr:1},{player:'Nick Kurtz',team:'ATH',position:'1B',hr:5},{player:'Bobby Witt Jr',team:'KC',position:'SS',hr:0},{player:'Hunter Goodman',team:'COL',position:'C',hr:5},{player:'Ketel Marte',team:'ARI',position:'2B',hr:2}],
      'Johnny':[{player:'Shohei Ohtani',team:'LAD',position:'DH',hr:2},{player:'James Wood',team:'WAS',position:'RF',hr:2},{player:'Mike Trout',team:'LAA',position:'CF',hr:1},{player:'Oneil Cruz',team:'PIT',position:'CF',hr:1},{player:'Casey Schmitt',team:'SFG',position:'DH',hr:3},{player:'Jose Ramirez',team:'CLE',position:'3B',hr:2}],
      'HK':[{player:'Kyle Schwarber',team:'PHI',position:'DH',hr:2},{player:'Byron Buxton',team:'MIN',position:'CF',hr:3},{player:'Matt Olson',team:'ATL',position:'1B',hr:2},{player:'Ian Happ',team:'CHC',position:'LF',hr:2},{player:'Gunnar Henderson',team:'BAL',position:'SS',hr:0},{player:'Eugenio Suarez',team:'CIN',position:'3B',hr:1}],
      'Cali':[{player:'Yordan Alvarez',team:'HOU',position:'DH',hr:2},{player:'Juan Soto',team:'NYM',position:'RF',hr:0},{player:'Jordan Walker',team:'STL',position:'RF',hr:2},{player:'Colson Montgomery',team:'CHW',position:'SS',hr:1},{player:'Julio Rodriguez',team:'SEA',position:'CF',hr:1},{player:'Jake Burger',team:'TEX',position:'1B',hr:1}]
    }}
  }
};