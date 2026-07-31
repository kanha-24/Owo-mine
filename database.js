'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_FILE, HISTORY_LIMIT } = require('./config');

/**
 * JSON-file-backed persistence layer.
 *
 * Top-level shape on disk:
 * {
 *   guilds: {
 *     [guildId]: {
 *       trackingEnabled: boolean,
 *       users: {
 *         [userId]: {
 *           username: string,
 *           rounds: [ { bombCount, bombTiles, moves, ts } ]
 *           //  moves: [ tileIndex (1-9) per safe click in order ]
 *         }
 *       },
 *       // Aggregate move stats — move number (1-based) → tile (1-9) → hit count
 *       // e.g. moveStats["1"]["5"] = 12  means tile 5 was the 1st click 12 times
 *       moveStats: { [moveNumber]: { [tile]: count } },
 *       totalGames: number,
 *     }
 *   }
 * }
 */
class Database {
  constructor(filePath = DATA_FILE) {
    this.filePath = filePath;
    this.data = { guilds: {} };
    this._dirty = false;
    this._load();
    this._flushInterval = setInterval(() => this._flush(), 5000).unref();
  }

  _load() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        this.data = raw.trim() ? JSON.parse(raw) : { guilds: {} };
      } else {
        this._flush(true);
      }
    } catch (err) {
      console.error('[Database] Failed to load history.json, starting fresh:', err);
      this.data = { guilds: {} };
    }
  }

  _flush(force = false) {
    if (!this._dirty && !force) return;
    try {
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.filePath);
      this._dirty = false;
    } catch (err) {
      console.error('[Database] Failed to flush history.json:', err);
    }
  }

  _shutdown() {
    this._flush(true);
    clearInterval(this._flushInterval);
    // process.exit handled by index.js gracefulShutdown
  }

  _ensureGuild(guildId) {
    if (!this.data.guilds[guildId]) {
      this.data.guilds[guildId] = {
        trackingEnabled: false,
        users: {},
        moveStats: {},
        totalGames: 0,
      };
    }
    // Backfill fields for older data files
    const g = this.data.guilds[guildId];
    if (!g.moveStats) g.moveStats = {};
    if (typeof g.totalGames !== 'number') g.totalGames = 0;
    return g;
  }

  _ensureUser(guildId, userId, username) {
    const guild = this._ensureGuild(guildId);
    if (!guild.users[userId]) {
      guild.users[userId] = { username, rounds: [] };
    } else if (username) {
      guild.users[userId].username = username;
    }
    return guild.users[userId];
  }

  // --- Tracking session toggle -------------------------------------------

  isTrackingEnabled(guildId) {
    return this._ensureGuild(guildId).trackingEnabled;
  }

  setTrackingEnabled(guildId, enabled) {
    this._ensureGuild(guildId).trackingEnabled = enabled;
    this._dirty = true;
  }

  // --- Round recording ------------------------------------------------------

  /**
   * Record a finished round for a user.
   * @param {string} guildId
   * @param {string} userId
   * @param {string} username
   * @param {number} bombCount
   * @param {number[]} bombTiles  1-indexed positions (1-9) of bomb tiles
   * @param {number[]} moveTiles  1-indexed positions of safe tiles in click order
   *                              (empty if round ended on first click)
   */
  recordRound(guildId, userId, username, bombCount, bombTiles, moveTiles = []) {
    const user = this._ensureUser(guildId, userId, username);
    const guild = this._ensureGuild(guildId);

    // Per-user round history (capped at HISTORY_LIMIT)
    user.rounds.push({ bombCount, bombTiles, moves: moveTiles, ts: Date.now() });
    if (user.rounds.length > HISTORY_LIMIT) {
      user.rounds = user.rounds.slice(-HISTORY_LIMIT);
    }

    // Guild-wide move stats: for each safe click, record which tile was
    // chosen at that move number (1-based position in the click sequence).
    for (let i = 0; i < moveTiles.length; i++) {
      const moveNum = String(i + 1);
      const tile = String(moveTiles[i]);
      if (!guild.moveStats[moveNum]) guild.moveStats[moveNum] = {};
      guild.moveStats[moveNum][tile] = (guild.moveStats[moveNum][tile] ?? 0) + 1;
    }

    // Guild-wide bomb stats: bombCount → tile → hit count (all rounds)
    // Also: bombMoveStats: bombCount → moveNumber → tile → hit count
    // moveNumber = how many safe clicks the player made before exploding (0 = first tile was a bomb)
    if (!guild.bombStats) guild.bombStats = {};
    if (!guild.bombMoveStats) guild.bombMoveStats = {};
    const bc = String(bombCount);
    if (!guild.bombStats[bc]) guild.bombStats[bc] = {};
    if (!guild.bombMoveStats[bc]) guild.bombMoveStats[bc] = {};

    for (const tile of bombTiles) {
      const t = String(tile);
      guild.bombStats[bc][t] = (guild.bombStats[bc][t] ?? 0) + 1;
    }

    // Record bomb positions keyed by how many safe moves were made first
    const moveNum = String(moveTiles.length); // 0 = first click was a bomb
    if (!guild.bombMoveStats[bc][moveNum]) guild.bombMoveStats[bc][moveNum] = {};
    for (const tile of bombTiles) {
      const t = String(tile);
      guild.bombMoveStats[bc][moveNum][t] = (guild.bombMoveStats[bc][moveNum][t] ?? 0) + 1;
    }

    guild.totalGames += 1;
    this._dirty = true;
    return user.rounds;
  }

  getUserRounds(guildId, userId) {
    return this._ensureGuild(guildId).users[userId]?.rounds ?? [];
  }

  getUsername(guildId, userId) {
    return this._ensureGuild(guildId).users[userId]?.username ?? null;
  }

  // --- Analytics ------------------------------------------------------------

  /**
   * Return bomb stats filtered by move number (how many safe clicks before bomb).
   * @param {string} guildId
   * @param {number} bombCount
   * @param {number} moveNumber  0 = first tile was a bomb, 1 = one safe click first, etc.
   * @returns {{ [tile: string]: number }}
   */
  getGuildBombMoveStats(guildId, bombCount, moveNumber) {
    const guild = this._ensureGuild(guildId);
    if (!guild.bombMoveStats) return {};
    return guild.bombMoveStats[String(bombCount)]?.[String(moveNumber)] ?? {};
  }

  /**
   * Return bomb stats for a specific bomb count in a guild.
   * Returns an object mapping tile (1-9) → count of times a bomb landed there.
   * @param {string} guildId
   * @param {number} bombCount
   * @returns {{ [tile: string]: number }}
   */
  getGuildBombStats(guildId, bombCount) {
    const guild = this._ensureGuild(guildId);
    if (!guild.bombStats) return {};
    return guild.bombStats[String(bombCount)] ?? {};
  }

  /**
   * Return move stats for a specific move number (1-based) in a guild.
   * Returns an object mapping tile (1-9) → count, e.g. { "1": 3, "5": 12 }
   * @param {string} guildId
   * @param {number} moveNumber
   * @returns {{ [tile: string]: number }}
   */
  getGuildMoveStats(guildId, moveNumber) {
    const guild = this._ensureGuild(guildId);
    return guild.moveStats[String(moveNumber)] ?? {};
  }

  /**
   * Return a summary for the guild.
   * @param {string} guildId
   * @returns {{ totalGames: number, mostCommonFirstMove: number|null, firstMoveCount: number }}
   */
  getGuildSummary(guildId) {
    const guild = this._ensureGuild(guildId);
    const firstMove = guild.moveStats['1'] ?? {};

    let mostCommonFirstMove = null;
    let firstMoveCount = 0;
    for (const [tile, count] of Object.entries(firstMove)) {
      if (count > firstMoveCount) {
        firstMoveCount = count;
        mostCommonFirstMove = Number(tile);
      }
    }

    return {
      totalGames: guild.totalGames,
      mostCommonFirstMove,
      firstMoveCount,
    };
  }

  /**
   * Return the total number of tracked rounds across all guilds.
   */
  getTotalGamesAllGuilds() {
    return Object.values(this.data.guilds).reduce(
      (sum, g) => sum + (g.totalGames ?? 0), 0
    );
  }
}

module.exports = new Database();
