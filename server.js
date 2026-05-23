const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Where shared state is stored — persists across requests on Railway
const DATA_FILE = path.join(__dirname, 'data', 'state.json');

// Ensure data directory exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

// Default empty state
const DEFAULT_STATE = {
  participants: [],
  winner: '',
  runnerUp: '',
  firstRedCard: '',
  topScorerTeam: '',
  mostConcededTeam: ''
};

function readState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      return { ...DEFAULT_STATE, ...JSON.parse(raw) };
    }
  } catch (e) {
    console.error('Error reading state:', e.message);
  }
  return { ...DEFAULT_STATE };
}

function writeState(state) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Error writing state:', e.message);
    return false;
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── GET state — all devices load this on page open
app.get('/api/state', (req, res) => {
  res.json(readState());
});

// ── SAVE state — called after every draw or outcome update
app.post('/api/state', (req, res) => {
  const current = readState();
  const updated = { ...current, ...req.body };
  const ok = writeState(updated);
  if (ok) {
    res.json({ ok: true, state: updated });
  } else {
    res.status(500).json({ ok: false, error: 'Could not save state' });
  }
});

// ── ADD participant atomically — prevents two people drawing at once
app.post('/api/draw', (req, res) => {
  const { name, team } = req.body;
  if (!name || !team) return res.status(400).json({ ok: false, error: 'Name and team required' });

  const state = readState();

  // Check team not already taken
  if (state.participants.find(p => p.team === team)) {
    return res.status(409).json({ ok: false, error: 'Team already taken — please try again' });
  }

  state.participants.push({ name, team });
  const ok = writeState(state);

  if (ok) {
    res.json({ ok: true, state });
  } else {
    res.status(500).json({ ok: false, error: 'Could not save draw' });
  }
});

// ── Anthropic API proxy — keeps API key server-side
app.post('/api/claude', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Railway Variables.' });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Copley Family Sweepstake running on port ${PORT}`);
});
