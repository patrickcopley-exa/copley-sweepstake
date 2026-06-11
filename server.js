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
        return { ...DEFAULT_STATE, ...data };
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
  const headers = apiKey ? { 'X-Auth-Token': apiKey } : {};
  const r = await fetch(`${FDORG_BASE}${path}`, { headers });
  if (!r.ok) throw new Error(`football-data.org ${r.status}: ${await r.text()}`);
  return r.json();
}

// GET /api/scores — live and recent World Cup matches
app.get('/api/scores', async (req, res) => {
  try {
    // Use openfootball/worldcup.json — free, no API key, real WC2026 data
    const r = await fetch('https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json');
    if (!r.ok) throw new Error('Could not fetch match data');
    const data = await r.json();

    const today = new Date();
    const allMatches = (data.matches || []).map(m => {
      // Parse match date
      const matchDate = m.date ? new Date(m.date) : null;
      const hasScore = m.score1 !== null && m.score1 !== undefined;
      const isToday = matchDate && matchDate.toDateString() === today.toDateString();

      return {
        homeTeam: m.team1,
        awayTeam: m.team2,
        homeScore: hasScore ? m.score1 : null,
        awayScore: hasScore ? m.score2 : null,
        status: hasScore ? 'FT' : isToday ? 'upcoming' : matchDate < today ? 'FT' : 'upcoming',
        minute: null,
        stage: m.group || m.round || 'Match',
        date: m.date
      };
    });

    // Show: finished matches from last 4 days + today's matches + next 4 days upcoming
    const fourDaysAgo = new Date(today - 4 * 86400000);
    const fourDaysAhead = new Date(today.getTime() + 4 * 86400000);

    const relevant = allMatches.filter(m => {
      if (!m.date) return true;
      const d = new Date(m.date);
      return d >= fourDaysAgo && d <= fourDaysAhead;
    });

    // If nothing in window, show most recent 20
    const matches = relevant.length > 0 ? relevant : allMatches.slice(-20);

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
    const groups = (data.standings || []).map(g => ({
      name: g.group ? g.group.replace('GROUP_','Group ') : 'Group',
      teams: (g.table || []).map(row => ({
        pos:    row.position,
        team:   row.team.shortName || row.team.name,
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
// Anthropic API proxy — Claude used only for stats summary
// Model and prompt locked server-side
// ─────────────────────────────────────────────────────────────

const STATS_PROMPT = `Return current World Cup 2026 tournament statistics. JSON exactly:
{"totalGoals":47,"totalMatches":18,"avgGoalsPerMatch":2.6,"totalRedCards":3,"firstRedCard":{"player":"Name","team":"Team","match":"A vs B","minute":34},"goalsByTeam":[{"team":"Name","scored":8,"conceded":3}]}`;

app.post('/api/claude', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Railway Variables.' });

    const { type } = req.body;
    if (type !== 'stats') {
      return res.status(400).json({ error: 'Invalid request type.' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: 'You are a World Cup 2026 data assistant. Today is ' + new Date().toISOString().split('T')[0] + '. Return ONLY valid JSON — no markdown, no backticks, no extra text.',
        messages: [{ role: 'user', content: STATS_PROMPT }]
      })
    });

    const responseText = await response.text();
    console.log('Anthropic status:', response.status);

    if (!response.ok) {
      return res.status(500).json({ error: 'Anthropic API error: ' + responseText.slice(0, 200) });
    }

    let data;
    try { data = JSON.parse(responseText); } catch(e) {
      return res.status(500).json({ error: 'Invalid JSON from Anthropic' });
    }

    if (data.content && data.content[0] && data.content[0].text) {
      const raw = data.content[0].text;
      const cleaned = raw.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
      try {
        return res.json({ ok: true, data: JSON.parse(cleaned) });
      } catch(e) {
        return res.status(500).json({ error: 'Model did not return valid JSON' });
      }
    }
    res.json(data);
  } catch(err) {
    console.error('Claude route error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Copley Family Sweepstake running on port ${PORT}`));
