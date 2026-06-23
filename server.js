const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
// Storage: JSONBin (permanent — survives Railway redeploys)
// Falls back to local file if JSONBin not configured
// ─────────────────────────────────────────────────────────────

const LOCAL_FILE = path.join(__dirname, 'data', 'state.json');
const DEFAULT_STATE = {
  participants: [], winner: '', runnerUp: '',
  firstRedCard: '', topScorerTeam: '', mostConcededTeam: ''
};

function ensureDataDir() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readLocal() {
  try {
    ensureDataDir();
    if (fs.existsSync(LOCAL_FILE))
      return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8')) };
  } catch(e) { console.error('readLocal:', e.message); }
  return { ...DEFAULT_STATE };
}

function writeLocal(state) {
  try {
    ensureDataDir();
    fs.writeFileSync(LOCAL_FILE, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch(e) { console.error('writeLocal:', e.message); return false; }
}

const STATS_CACHE_VERSION = '2'; // bump to invalidate cached statsData

async function readState() {
  const binId  = process.env.JSONBIN_BIN_ID;
  const apiKey = process.env.JSONBIN_API_KEY;
  if (binId && apiKey) {
    try {
      const r = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, {
        headers: { 'X-Master-Key': apiKey, 'X-Bin-Meta': 'false' }
      });
      if (r.ok) {
        const data = await r.json();
        const state = { ...DEFAULT_STATE, ...data };
        // Clear cached stats if version changed — forces fresh fetch with fixed names
        if (state.statsCacheVersion !== STATS_CACHE_VERSION) {
          state.statsData = null;
          state.statsUpdated = '';
          state.statsCacheVersion = STATS_CACHE_VERSION;
          // Save the cleared state back so all devices get clean data
          writeState(state).catch(() => {});
        }
        return state;
      }
    } catch(e) { console.error('JSONBin read error:', e.message); }
  }
  // Fallback to local file
  return readLocal();
}

async function writeState(state) {
  const binId  = process.env.JSONBIN_BIN_ID;
  const apiKey = process.env.JSONBIN_API_KEY;
  if (binId && apiKey) {
    try {
      const r = await fetch(`https://api.jsonbin.io/v3/b/${binId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Master-Key': apiKey },
        body: JSON.stringify(state)
      });
      if (r.ok) {
        const data = await r.json();
        return data.record || state;
      }
    } catch(e) { console.error('JSONBin write error:', e.message); }
  }
  // Fallback to local file
  writeLocal(state);
  return state;
}

// ─────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────

// GET state — all devices load this on page open
app.get('/api/state', async (req, res) => {
  try {
    res.json(await readState());
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// POST state — save outcome fields (winner, redCard etc)
app.post('/api/state', async (req, res) => {
  try {
    const current = await readState();
    const updated = { ...current, ...req.body };
    const saved = await writeState(updated);
    res.json({ ok: true, state: saved });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST draw — atomically adds a participant, prevents duplicate teams
app.post('/api/draw', async (req, res) => {
  try {
    const { name, team } = req.body;
    if (!name || !team) return res.status(400).json({ ok: false, error: 'Name and team required' });

    const state = await readState();
    if (!state.participants) state.participants = [];

    if (state.participants.find(p => p.team === team)) {
      return res.status(409).json({ ok: false, error: 'Team already taken — please try again' });
    }

    state.participants.push({ name, team });
    const saved = await writeState(state);
    res.json({ ok: true, state: saved });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// Football-Data.org — real live scores and standings
// Sign up free at football-data.org, add FOOTBALL_API_KEY to Railway
// ─────────────────────────────────────────────────────────────

const FDORG_BASE = 'https://api.football-data.org/v4';

async function footballDataFetch(path) {
  const apiKey = process.env.FOOTBALL_API_KEY;
  if (!apiKey) throw new Error('FOOTBALL_API_KEY not set in Railway Variables.');
  const r = await fetch(`${FDORG_BASE}${path}`, {
    headers: { 'X-Auth-Token': apiKey }
  });
  if (!r.ok) {
    const txt = await r.text();
    console.error(`football-data.org ${r.status}:`, txt.slice(0, 200));
    throw new Error(`football-data.org error ${r.status}: ${txt.slice(0, 100)}`);
  }
  return r.json();
}

// GET /api/scores — live and recent World Cup matches
app.get('/api/scores', async (req, res) => {
  try {
    const apiKey = process.env.FOOTBALL_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: 'FOOTBALL_API_KEY not set in Railway Variables.' });

    // Fetch all WC matches from football-data.org
    const r = await fetch('https://api.football-data.org/v4/competitions/WC/matches', {
      headers: { 'X-Auth-Token': apiKey }
    });

    if (!r.ok) {
      const txt = await r.text();
      console.error('football-data.org scores error:', r.status, txt.slice(0,200));
      return res.status(500).json({ ok: false, error: `football-data.org ${r.status}: ${txt.slice(0,100)}` });
    }

    const data = await r.json();
    const allMatches = data.matches || [];

    // Sort: live/paused first, then finished (most recent first), then upcoming
    const statusOrder = { 'IN_PLAY':0, 'PAUSED':1, 'FINISHED':2, 'TIMED':3, 'SCHEDULED':4 };
    allMatches.sort((a, b) => {
      const ao = statusOrder[a.status] ?? 9;
      const bo = statusOrder[b.status] ?? 9;
      if (ao !== bo) return ao - bo;
      // For finished, most recent first; for upcoming, soonest first
      if (a.status === 'FINISHED') return new Date(b.utcDate) - new Date(a.utcDate);
      return new Date(a.utcDate) - new Date(b.utcDate);
    });

    // Show live + last 10 finished + next 10 upcoming
    const live     = allMatches.filter(m => m.status === 'IN_PLAY' || m.status === 'PAUSED');
    const finished = allMatches.filter(m => m.status === 'FINISHED').slice(0, 10);
    const upcoming = allMatches.filter(m => m.status === 'TIMED' || m.status === 'SCHEDULED').slice(0, 10);
    const relevant = [...live, ...finished, ...upcoming];

    const NAME_MAP2 = {
      'Korea Republic':        'South Korea',
      'Czechia':               'Czech Republic',
      'Bosnia and Herzegovina':'Bosnia & Herz.',
      'Bosnia-H.':             'Bosnia & Herz.',
      'Bosnia & Herzegovina':  'Bosnia & Herz.',
      "Côte d'Ivoire":         'Ivory Coast',
      'Ivory Coast':           'Ivory Coast',
      'Turkey':                'Türkiye',
      'Curacao':               'Curaçao',
      'Congo DR':              'DR Congo',
    };
    const nn = n => NAME_MAP2[n] || n;

    const matches = relevant.map(m => ({
      homeTeam: nn(m.homeTeam.shortName || m.homeTeam.name),
      awayTeam: nn(m.awayTeam.shortName || m.awayTeam.name),
      homeScore: m.score.fullTime.home,
      awayScore: m.score.fullTime.away,
      homeScoreHT: m.score.halfTime.home,
      awayScoreHT: m.score.halfTime.away,
      status: m.status === 'FINISHED' ? 'FT'
            : m.status === 'IN_PLAY'  ? 'LIVE'
            : m.status === 'PAUSED'   ? 'HT'
            : 'upcoming',
      minute: m.minute || null,
      stage: m.group
        ? m.group.replace('GROUP_', 'Group ')
        : (m.stage || 'Knockout').replace(/_/g, ' '),
      utcDate: m.utcDate
    }));

    res.json({ ok: true, matches });
  } catch(err) {
    console.error('Scores error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/standings — all group tables
app.get('/api/standings', async (req, res) => {
  try {
    const data = await footballDataFetch('/competitions/WC/standings');
    // Normalise team names to match our OFFICIAL_GROUPS names
    const NAME_MAP = {
      'Korea Republic': 'South Korea',
      'Czechia':        'Czech Republic',
      'Bosnia and Herzegovina': 'Bosnia & Herz.',
      'DR Congo':       'DR Congo',
      'Ivory Coast':    'Ivory Coast',
      "Côte d'Ivoire":  'Ivory Coast',
      'Turkey':         'Türkiye',
      'Curacao':        'Curaçao',
    };
    const normName = n => NAME_MAP[n] || n;

    const groups = (data.standings || []).map(g => ({
      name: g.group ? g.group.replace('GROUP_','Group ') : 'Group',
      teams: (g.table || []).map(row => ({
        pos:    row.position,
        team:   normName(row.team.shortName || row.team.name),
        flag:   '',
        played: row.playedGames,
        won:    row.won,
        drawn:  row.draw,
        lost:   row.lost,
        gf:     row.goalsFor,
        ga:     row.goalsAgainst,
        gd:     row.goalDifference,
        points: row.points
      }))
    }));
    res.json({ ok: true, groups });
  } catch(err) {
    console.error('Standings error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Stats — real data from football-data.org
// ─────────────────────────────────────────────────────────────

app.get('/api/stats', async (req, res) => {
  try {
    const apiKey = process.env.FOOTBALL_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: 'FOOTBALL_API_KEY not set in Railway Variables.' });

    // Fetch all matches and scorers in parallel
    const [matchesRes, scorersRes] = await Promise.all([
      fetch('https://api.football-data.org/v4/competitions/WC/matches', { headers: { 'X-Auth-Token': apiKey } }),
      fetch('https://api.football-data.org/v4/competitions/WC/scorers?limit=100', { headers: { 'X-Auth-Token': apiKey } })
    ]);

    if (!matchesRes.ok) {
      const txt = await matchesRes.text();
      return res.status(500).json({ ok: false, error: `football-data.org ${matchesRes.status}: ${txt.slice(0,100)}` });
    }

    const matchData = await matchesRes.json();
    const scorerData = scorersRes.ok ? await scorersRes.json() : { scorers: [] };

    const finished = (matchData.matches || []).filter(m => m.status === 'FINISHED');
    const totalMatches = finished.length;

    // Tally goals and cards per team
    let totalGoals = 0;
    let totalRedCards = 0;
    let firstRedCard = null;
    const teamStats = {};

    const NAME_MAP = {
      'Korea Republic':        'South Korea',
      'Czechia':               'Czech Republic',
      'Bosnia and Herzegovina':'Bosnia & Herz.',
      'Bosnia-H.':             'Bosnia & Herz.',
      'Bosnia & Herzegovina':  'Bosnia & Herz.',
      "Côte d'Ivoire":         'Ivory Coast',
      'Turkey':                'Türkiye',
      'Curacao':               'Curaçao',
      'Congo DR':              'DR Congo',
      'DR Congo':              'DR Congo',
      'Republic of Ireland':   'Ireland',
    };
    const nn = n => NAME_MAP[n] || n;

    finished.forEach(m => {
      const ht = nn(m.homeTeam.shortName || m.homeTeam.name);
      const at = nn(m.awayTeam.shortName || m.awayTeam.name);
      const hg = m.score.fullTime.home || 0;
      const ag = m.score.fullTime.away || 0;
      totalGoals += hg + ag;

      if (!teamStats[ht]) teamStats[ht] = { scored: 0, conceded: 0 };
      if (!teamStats[at]) teamStats[at] = { scored: 0, conceded: 0 };
      teamStats[ht].scored   += hg;
      teamStats[ht].conceded += ag;
      teamStats[at].scored   += ag;
      teamStats[at].conceded += hg;

      // Note: bookings/cards not available on free tier of football-data.org
      // Red card tracking requires a paid plan
    });

    const goalsByTeam = Object.entries(teamStats)
      .map(([team, s]) => ({ team, scored: s.scored, conceded: s.conceded }))
      .sort((a, b) => b.scored - a.scored || a.team.localeCompare(b.team));

    // Top scorers — normalise team names to match our goalsByTeam
    // Also add a teamGoals field so the grouped view matches totalGoals
    const topScorers = (scorerData.scorers || []).slice(0, 20).map(s => {
      const teamName = nn(s.team?.shortName || s.team?.name);
      // Find this team's total in goalsByTeam for consistency
      const teamTotal = goalsByTeam.find(t => t.team === teamName);
      return {
        player: s.player?.name,
        team:   teamName,
        goals:  s.goals,
        teamTotalGoals: teamTotal?.scored ?? s.goals
      };
    });

    // Also send goalsByTeam sorted so top scoring team is first — this is the
    // authoritative source for prize calculation (derived from match results)
    res.json({
      ok: true,
      totalGoals,
      totalMatches,
      avgGoalsPerMatch: totalMatches > 0 ? (totalGoals / totalMatches).toFixed(2) : 0,
      totalRedCards: null,
      firstRedCard: null,
      goalsByTeam,
      topScorers
    });
  } catch(err) {
    console.error('Stats error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});


app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Copley Family Sweepstake running on port ${PORT}`));
