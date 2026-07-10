'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_FILE, HISTORY_LIMIT } = require('./config');

/**
 * Simple JSON-file-backed persistence layer.
 *
 * Shape on disk:
 * {
 *   guilds: {
 *     [guildId]: {
 *       trackingEnabled: boolean,
 *       users: {
 *         [userId]: {
 *           username: string,
 *           rounds: [ { bombCount: number, bombTiles: number[], ts: number } ],
 *         }
 *       }
 *     }
 *   }
 * }
 *
 * Kept intentionally simple (no external DB dependency) so the bot can be
 * dropped onto any host with just Node + a writable disk. Writes are
 * debounced/batched via a dirty flag + interval flush so continuous, rapid
 * message-update events don't hammer the filesystem.
 */
class Database {
  constructor(filePath = DATA_FILE) {
    this.filePath = filePath;
    this.data = { guilds: {} };
    this._dirty = false;
    this._load();
    this._flushInterval = setInterval(() => this._flush(), 5000).unref();

    process.on('SIGINT', () => this._shutdown());
    process.on('SIGTERM', () => this._shutdown());
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
      fs.renameSync(tmpPath, this.filePath); // atomic-ish swap
      this._dirty = false;
    } catch (err) {
      console.error('[Database] Failed to flush history.json:', err);
    }
  }

  _shutdown() {
    this._flush(true);
    clearInterval(this._flushInterval);
    process.exit(0);
  }

  _ensureGuild(guildId) {
    if (!this.data.guilds[guildId]) {
      this.data.guilds[guildId] = { trackingEnabled: false, users: {} };
    }
    return this.data.guilds[guildId];
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
   * @param {number[]} bombTiles 1-indexed tile positions (1-9) where bombs were
   */
  recordRound(guildId, userId, username, bombCount, bombTiles) {
    const user = this._ensureUser(guildId, userId, username);
    user.rounds.push({ bombCount, bombTiles, ts: Date.now() });
    if (user.rounds.length > HISTORY_LIMIT) {
      user.rounds = user.rounds.slice(-HISTORY_LIMIT);
    }
    this._dirty = true;
    return user.rounds;
  }

  getUserRounds(guildId, userId) {
    const guild = this._ensureGuild(guildId);
    return guild.users[userId]?.rounds ?? [];
  }

  getUsername(guildId, userId) {
    const guild = this._ensureGuild(guildId);
    return guild.users[userId]?.username ?? null;
  }
}

module.exports = new Database();
