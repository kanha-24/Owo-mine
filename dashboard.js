'use strict';

require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'history.json');
const PORT = parseInt(process.env.DASHBOARD_PORT ?? '3000', 10);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Safe data reader — never writes, always reads fresh from disk so it doesn't
// conflict with the bot's in-memory write debouncer.
// ---------------------------------------------------------------------------

function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return raw.trim() ? JSON.parse(raw) : { guilds: {} };
  } catch {
    return { guilds: {} };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAllRounds(data) {
  const rounds = [];
  for (const [guildId, guild] of Object.entries(data.guilds)) {
    for (const [userId, user] of Object.entries(guild.users ?? {})) {
      for (const round of user.rounds ?? []) {
        rounds.push({
          guildId,
          userId,
          username: user.username,
          bombCount: round.bombCount,
          bombTiles: round.bombTiles ?? [],
          moves: round.moves ?? [],
          ts: round.ts,
          // A round is a cash-out if moves.length > 0 and no bomb on the last move
          // We detect it by checking if moveTiles covers (9 - bombCount) safe tiles
          outcome: (round.moves?.length ?? 0) === (9 - (round.bombCount ?? 3))
            ? 'cashout'
            : (round.moves?.length > 0 ? 'cashout_partial' : 'explosion'),
        });
      }
    }
  }
  // Sort oldest first
  rounds.sort((a, b) => a.ts - b.ts);
  return rounds;
}

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------

// GET /api/guilds — list all guild IDs + names (no name info, just IDs + stats)
app.get('/api/guilds', (req, res) => {
  const data = readData();
  const guilds = Object.entries(data.guilds).map(([id, g]) => ({
    id,
    totalGames: g.totalGames ?? 0,
    trackingEnabled: g.trackingEnabled ?? false,
    playerCount: Object.keys(g.users ?? {}).length,
  }));
  res.json(guilds);
});

// GET /api/summary — global summary across all guilds
app.get('/api/summary', (req, res) => {
  const data = readData();
  const rounds = getAllRounds(data);

  const totalGames = rounds.length;
  const explosions = rounds.filter(r => r.outcome === 'explosion').length;
  const cashouts = rounds.filter(r => r.outcome !== 'explosion').length;
  const uniquePlayers = new Set(rounds.map(r => r.userId)).size;
  const uniqueGuilds = Object.keys(data.guilds).length;

  // Activity by day (last 30 days)
  const now = Date.now();
  const dayMs = 86_400_000;
  const activityByDay = {};
  for (let i = 29; i >= 0; i--) {
    const dayStart = now - (i + 1) * dayMs;
    const dayEnd = now - i * dayMs;
    const label = new Date(dayStart).toISOString().slice(0, 10);
    activityByDay[label] = rounds.filter(r => r.ts >= dayStart && r.ts < dayEnd).length;
  }

  // Bomb count distribution
  const bombDist = {};
  for (const r of rounds) {
    bombDist[r.bombCount] = (bombDist[r.bombCount] ?? 0) + 1;
  }

  res.json({
    totalGames,
    explosions,
    cashouts,
    uniquePlayers,
    uniqueGuilds,
    activityByDay,
    bombDist,
  });
});

// GET /api/players?guildId=<id> — list all players in a guild
app.get('/api/players', (req, res) => {
  const data = readData();
  const { guildId } = req.query;

  const guild = guildId ? data.guilds[guildId] : Object.values(data.guilds)[0];
  if (!guild) return res.json([]);

  const players = Object.entries(guild.users ?? {}).map(([userId, user]) => {
    const rounds = user.rounds ?? [];
    const explosions = rounds.filter(r => (r.moves?.length ?? 0) < 9 - r.bombCount).length;
    const cashouts = rounds.length - explosions;
    const avgMoves = rounds.length
      ? (rounds.reduce((s, r) => s + (r.moves?.length ?? 0), 0) / rounds.length).toFixed(1)
      : 0;

    // Bomb frequency map
    const bombFreq = new Array(10).fill(0);
    for (const r of rounds) {
      for (const t of r.bombTiles ?? []) bombFreq[t]++;
    }

    // First-click preference
    const firstClicks = new Array(10).fill(0);
    for (const r of rounds) {
      if (r.moves?.[0]) firstClicks[r.moves[0]]++;
    }

    return {
      userId,
      username: user.username,
      totalRounds: rounds.length,
      explosions,
      cashouts,
      avgMoves: Number(avgMoves),
      bombFreq,
      firstClicks,
      lastSeen: rounds.length ? Math.max(...rounds.map(r => r.ts)) : null,
    };
  });

  players.sort((a, b) => b.totalRounds - a.totalRounds);
  res.json(players);
});

// GET /api/rounds?guildId=&userId=&bombCount=&outcome=&from=&to=&limit=
app.get('/api/rounds', (req, res) => {
  const data = readData();
  let rounds = getAllRounds(data);

  const { guildId, userId, bombCount, outcome, from, to, limit } = req.query;

  if (guildId) rounds = rounds.filter(r => r.guildId === guildId);
  if (userId) rounds = rounds.filter(r => r.userId === userId);
  if (bombCount) rounds = rounds.filter(r => r.bombCount === parseInt(bombCount, 10));
  if (outcome) rounds = rounds.filter(r => r.outcome === outcome);
  if (from) rounds = rounds.filter(r => r.ts >= parseInt(from, 10));
  if (to) rounds = rounds.filter(r => r.ts <= parseInt(to, 10));

  // Newest first for display
  rounds.reverse();

  const cap = Math.min(parseInt(limit ?? '200', 10), 1000);
  res.json(rounds.slice(0, cap));
});

// GET /api/heatmap?guildId=&moveNumber=&type=tile|bomb&bombCount=
app.get('/api/heatmap', (req, res) => {
  const data = readData();
  const { guildId, moveNumber, type, bombCount } = req.query;

  const guild = guildId ? data.guilds[guildId] : Object.values(data.guilds)[0];
  if (!guild) return res.json({ tiles: new Array(9).fill(0), max: 0 });

  let stats = {};
  if (type === 'bomb') {
    const bc = bombCount ?? '3';
    const mn = moveNumber ?? '0';
    stats = guild.bombMoveStats?.[bc]?.[mn] ?? guild.bombStats?.[bc] ?? {};
  } else {
    const mn = moveNumber ?? '1';
    stats = guild.moveStats?.[mn] ?? {};
  }

  const tiles = [];
  for (let i = 1; i <= 9; i++) {
    tiles.push(stats[String(i)] ?? 0);
  }
  const max = Math.max(...tiles, 1);
  res.json({ tiles, max });
});

// GET /api/compare?guildId=&userA=&userB= — side-by-side player comparison
app.get('/api/compare', (req, res) => {
  const data = readData();
  const { guildId, userA, userB } = req.query;
  if (!userA || !userB) return res.status(400).json({ error: 'userA and userB required' });

  const guild = guildId ? data.guilds[guildId] : Object.values(data.guilds)[0];
  if (!guild) return res.json({ a: null, b: null });

  function buildProfile(userId) {
    const user = guild.users?.[userId];
    if (!user) return null;
    const rounds = user.rounds ?? [];

    const bombFreq = new Array(10).fill(0);
    const firstClicks = new Array(10).fill(0);
    const moveFreq = {}; // moveNumber → tile counts

    for (const r of rounds) {
      for (const t of r.bombTiles ?? []) bombFreq[t]++;
      if (r.moves?.[0]) firstClicks[r.moves[0]]++;
      for (let i = 0; i < (r.moves?.length ?? 0); i++) {
        const mn = String(i + 1);
        if (!moveFreq[mn]) moveFreq[mn] = new Array(10).fill(0);
        moveFreq[mn][r.moves[i]]++;
      }
    }

    const bombCounts = {};
    for (const r of rounds) {
      bombCounts[r.bombCount] = (bombCounts[r.bombCount] ?? 0) + 1;
    }

    const explosions = rounds.filter(r => (r.moves?.length ?? 0) < 9 - r.bombCount).length;

    return {
      userId,
      username: user.username,
      totalRounds: rounds.length,
      explosions,
      cashouts: rounds.length - explosions,
      avgMoves: rounds.length
        ? (rounds.reduce((s, r) => s + (r.moves?.length ?? 0), 0) / rounds.length).toFixed(2)
        : '0.00',
      bombFreq,
      firstClicks,
      moveFreq,
      bombCounts,
      preferredBombs: Object.entries(bombCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '3',
    };
  }

  res.json({ a: buildProfile(userA), b: buildProfile(userB) });
});

// GET /api/trends?guildId=&days=30 — time-series data for charts
app.get('/api/trends', (req, res) => {
  const data = readData();
  const { guildId, days } = req.query;
  const dayCount = Math.min(parseInt(days ?? '30', 10), 365);

  let rounds = getAllRounds(data);
  if (guildId) rounds = rounds.filter(r => r.guildId === guildId);

  const now = Date.now();
  const dayMs = 86_400_000;
  const result = [];

  for (let i = dayCount - 1; i >= 0; i--) {
    const dayStart = now - (i + 1) * dayMs;
    const dayEnd = now - i * dayMs;
    const dayRounds = rounds.filter(r => r.ts >= dayStart && r.ts < dayEnd);
    const label = new Date(dayStart).toISOString().slice(0, 10);
    result.push({
      date: label,
      total: dayRounds.length,
      explosions: dayRounds.filter(r => r.outcome === 'explosion').length,
      cashouts: dayRounds.filter(r => r.outcome !== 'explosion').length,
      avgMoves: dayRounds.length
        ? (dayRounds.reduce((s, r) => s + (r.moves?.length ?? 0), 0) / dayRounds.length).toFixed(2)
        : 0,
    });
  }

  res.json(result);
});

// GET /api/export?guildId=&format=json|csv
app.get('/api/export', (req, res) => {
  const data = readData();
  const { guildId, format } = req.query;

  let rounds = getAllRounds(data);
  if (guildId) rounds = rounds.filter(r => r.guildId === guildId);

  if (format === 'csv') {
    const header = 'timestamp,date,guildId,userId,username,bombCount,outcome,moveCount,moves,bombTiles';
    const rows = rounds.map(r => [
      r.ts,
      new Date(r.ts).toISOString(),
      r.guildId,
      r.userId,
      `"${(r.username ?? '').replace(/"/g, '""')}"`,
      r.bombCount,
      r.outcome,
      r.moves.length,
      `"${r.moves.join('-')}"`,
      `"${r.bombTiles.join('-')}"`,
    ].join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="mine-history.csv"');
    return res.send([header, ...rows].join('\n'));
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="mine-history.json"');
  res.json(rounds);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[Dashboard] Running at http://localhost:${PORT}`);
});
