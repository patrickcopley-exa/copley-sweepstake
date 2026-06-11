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
// Anthropic API proxy — locked server-side
// Browser only sends a 'type', cannot change model or prompt
// ─────────────────────────────────────────────────────────────

const ALLOWED_TYPES = ['scores', 'standings', 'stats'];
const PROMPT_TEMPLATES = {
  scores:    `Return recent and upcoming World Cup 2026 match results. JSON exactly:\n{"matches":[{"homeTeam":"Name","awayTeam":"Name","homeScore":2,"awayScore":1,"status":"FT or LIVE or HT or upcoming","minute":"78","stage":"Group A"}]}`,
  standings: `Return complete current group stage standings for FIFA World Cup 2026. All 12 groups A-L, 4 teams each. JSON exactly:\n{"groups":[{"name":"Group A","teams":[{"pos":1,"team":"Name","flag":"🏴","played":3,"won":2,"drawn":1,"lost":0,"gf":5,"ga":2,"gd":3,"points":7}]}]}`,
  stats:     `Return current World Cup 2026 tournament statistics. JSON exactly:\n{"totalGoals":47,"totalMatches":18,"avgGoalsPerMatch":2.6,"totalRedCards":3,"firstRedCard":{"player":"Name","team":"Team","match":"A vs B","minute":34},"goalsByTeam":[{"team":"Name","scored":8,"conceded":3}]}`
};

app.post('/api/claude', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Railway Variables.' });

    const { type } = req.body;
    if (!type || !ALLOWED_TYPES.includes(type)) {
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
        model: 'claude-haiku-4-5',
        max_tokens: 2000,
        system: 'You are a World Cup 2026 data assistant. Today is ' + new Date().toISOString().split('T')[0] + '. Return ONLY valid JSON — no markdown, no backticks, no extra text.',
        messages: [{ role: 'user', content: PROMPT_TEMPLATES[type] }]
      })
    });
    const text = await response.text();
    try {
      const data = JSON.parse(text);
      res.json(data);
    } catch(e) {
      console.error('Anthropic response not JSON:', text.slice(0, 200));
      res.status(500).json({ error: 'Anthropic API returned unexpected response: ' + text.slice(0, 100) });
    }
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Copley Family Sweepstake running on port ${PORT}`));
