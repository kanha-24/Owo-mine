<div align="center">

# ⛏️ OwO Minewatch

**A Discord bot that tracks mine game rounds played against the OwO bot — logs bomb positions, click sequences, and builds statistical heatmaps.**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.js.org)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

> **Honesty note:** OwO's bomb placement is random per round.
> This bot records *history* — it does not predict the future.
> Treat all heatmap recommendations as statistical tendencies, not guarantees.

</div>

---

## 📁 Project Structure

```
owo-minewatch/
├── index.js          # Bot entry point — event listeners, parsers, embed builders
├── config.js         # Constants: bot ID, triggers, emojis, limits, colors
├── database.js       # JSON persistence layer (atomic writes, debounced flush)
├── deduction.js      # Pure frequency/heatmap math (no discord.js dependency)
├── dashboard.js      # Standalone Express dashboard server
├── package.json
├── .env              # Your secrets — never commit this
├── .env.example      # Template to copy
├── .gitignore
└── data/
    └── history.json  # Auto-created on first run — do not edit by hand
```

---

## 🚀 Setup

### Prerequisites
- **Node.js 18+**
- A Discord bot application and token → [Discord Developer Portal](https://discord.com/developers/applications)

### Privileged Gateway Intents
In the Developer Portal → your app → **Bot**, enable all three:

| Intent | Required |
|---|---|
| Presence Intent | ✅ |
| Server Members Intent | ✅ |
| Message Content Intent | ✅ ← critical, without this the bot sees nothing |

### Bot Permissions
When inviting via OAuth2 the bot needs:
`View Channel` · `Send Messages` · `Read Message History` · `Embed Links` · `Use External Emojis`

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=8&scope=bot
```

### Install & Run

```bash
npm install
```

Then double-click **`start.bat`** — it will ask if you want to launch the dashboard too:

```
  Launch dashboard too? (Y/N):
```

- **Y** — opens the dashboard in a separate terminal window at `http://localhost:3000`, then starts the bot. Both processes run independently — closing one won't affect the other.
- **N** — starts the bot only.

Or run manually:

```bash
npm start               # bot only
npm run dashboard       # dashboard only (separate terminal)
```

Expected bot output:
```
[Ready] Logged in as yathuwuowominebot#6542
[Ready] Watching for OwO mine rounds. Use "@bot start mine" in a server to begin tracking.
[Boot Report] start reports sent to channel <channelId>
```

---

## 🌐 Web Dashboard

A read-only stats dashboard is included, running separately from the bot. Access it at **`http://localhost:3000`** after launching via `start.bat` or `npm run dashboard`.

### Dashboard Tabs

| Tab | What it shows |
|---|---|
| **Overview** | 4 stat cards, daily activity bar chart, bomb distribution doughnut, outcomes line chart |
| **Heatmaps** | 3×3 click heatmap + bomb heatmap with move/bomb controls |
| **Players** | Leaderboard table — click a row to see personal bomb grid + first-click chart |
| **Compare** | Pick two players, side-by-side stats + bomb grids + first-click chart overlay |
| **History** | Searchable/filterable round table with CSV/JSON export |

### API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/guilds` | List guilds with game counts |
| `GET /api/summary` | Global stats + 30-day activity + bomb distribution |
| `GET /api/players?guildId=` | Player leaderboard |
| `GET /api/rounds?guildId=&userId=&bombCount=&outcome=&from=&to=` | Filtered round history |
| `GET /api/heatmap?type=tile\|bomb&moveNumber=&bombCount=&guildId=` | Tile counts for grid rendering |
| `GET /api/compare?userA=&userB=&guildId=` | Side-by-side player profiles |
| `GET /api/trends?days=30&guildId=` | Daily totals/outcomes for line chart |
| `GET /api/export?format=csv\|json&guildId=` | Download all rounds |

---

## 🔑 Environment Variables

```env
DISCORD_BOT_TOKEN=MTUzMjQ0...   # Required — bot token from Developer Portal
REPORT_CHANNEL_ID=153245...     # Optional — channel to send boot/shutdown reports
DASHBOARD_PORT=3000             # Optional — dashboard port (default 3000)
```

> **Security:** `.env` is already in `.gitignore`. If your token is ever exposed, immediately go to Developer Portal → Bot → **Reset Token**.

---

## 💬 Commands

### Session Control *(mention-based)*

| Command | Description |
|---|---|
| `@bot start mine` | Enable tracking for this server |
| `@bot end mine` | Pause tracking (data is preserved) |

### Heatmap Commands *(prefix-based)*

| Command | Description |
|---|---|
| `!heatmap <n>` | Which tiles were most/least chosen as the Nth safe click |
| `!bombheatmap <move> [bombs]` | Bomb position frequency at move `x` in `y`-bomb rounds. `bombs` defaults to 3. Move 0 = bomb hit on first click. |
| `!minebot` | Full info panel with all commands and heatmap legend |

### Automatic Embeds
After every round ends (explosion or cash-out) the bot posts:
- Player name, bomb count, bomb tile locations
- Click sequence for that round
- Per-user bomb frequency heatmap (last 50 rounds)
- Coldest tiles recommended for the next round

---

## 🗄️ Data Storage Schema

`data/history.json`:

```json
{
  "guilds": {
    "<guildId>": {
      "trackingEnabled": true,
      "totalGames": 42,
      "users": {
        "<userId>": {
          "username": "PlayerName",
          "rounds": [
            { "bombCount": 3, "bombTiles": [2, 6, 9], "moves": [1, 5, 3], "ts": 1720612345678 }
          ]
        }
      },
      "moveStats":     { "1": { "5": 12, "3": 8 } },
      "bombStats":     { "3": { "2": 15, "6": 11 } },
      "bombMoveStats": { "3": { "0": { "5": 4 }, "1": { "9": 2 } } }
    }
  }
}
```

| Field | Description |
|---|---|
| `trackingEnabled` | Whether `@bot start mine` has been issued for this guild |
| `totalGames` | Total rounds recorded (never decremented) |
| `users[id].rounds` | Per-user history, capped at 50, oldest dropped first |
| `rounds[].moves` | 1-indexed tile positions in click order |
| `moveStats[n][tile]` | How many times `tile` was the Nth safe click guild-wide |
| `bombStats[bc][tile]` | How many times `tile` had a bomb in `bc`-bomb rounds |
| `bombMoveStats[bc][m][tile]` | Bomb frequency at tile, filtered to rounds where bomb was hit after `m` safe clicks |

---

## 🎨 Heatmap Gradient Reference

Both `!heatmap` and `!bombheatmap` use a 20-step gradient relative to the highest-frequency tile in the dataset:

| Emoji | Range | Meaning |
|---|---|---|
| ⬛ | 0–9% | Never or barely chosen |
| 🟦 | 10–29% | Rarely chosen |
| 🟩 | 30–49% | Occasionally chosen |
| 🟨 | 50–59% | Moderately common |
| 🟧 | 60–79% | Frequently chosen |
| 🟥 | 80–100% | Most common tile |

Grid layout (matches the mine board):
```
Tile 1 | Tile 2 | Tile 3
Tile 4 | Tile 5 | Tile 6
Tile 7 | Tile 8 | Tile 9
```

---

## ⚙️ Configuration Reference

All tuneable constants live in `config.js`:

| Constant | Default | Description |
|---|---|---|
| `OWO_BOT_ID` | `408785106942164992` | Only messages from this bot ID are parsed |
| `MINE_TRIGGERS` | `['owo mine', 'o mine', ...]` | Recognized command prefixes (case-insensitive) |
| `DEFAULT_BOMB_COUNT` | `3` | Used when no bomb count is in the trigger message |
| `MAX_BOMB_COUNT` | `8` | Upper bound for bomb count argument parsing |
| `HISTORY_LIMIT` | `50` | Max rounds stored per user |
| `DATA_FILE` | `./data/history.json` | Path to the persistence file |
| `COLORS.PRIMARY` | `0x8b5cf6` | Purple — normal round embed |
| `COLORS.SUCCESS` | `0x22c55e` | Green — cash-out embed |
| `COLORS.DANGER` | `0xef4444` | Red — explosion / bomb heatmap |
| `COLORS.INFO` | `0x38bdf8` | Blue — tile heatmap, boot summary |

---

## 📡 Interactive Boot Reports

On every startup and graceful shutdown, the bot sends 3 messages to `REPORT_CHANNEL_ID`:

1. **Summary embed** — status, guild count, total games tracked, command reference
2. **Tile heatmap** (move 1) — interactive with ◀/▶ buttons to navigate move numbers
3. **Bomb heatmap** (move 0, 3 bombs) — interactive with ◀/▶ for move numbers and bomb counts

Shutdown sequence:
1. Send shutdown reports
2. Flush `history.json` to disk
3. `process.exit(0)`

---

## 🤖 Fun Replies

| Trigger | Response |
|---|---|
| Someone @mentions the bot without a valid command | `aapki tuchki tuiyan` |
| Someone replies to any of the bot's messages | `dont talk to me plwease 🥺🙏 i dont wanna talk to you` |

The reply check runs **before** the mention check — Discord auto-injects the bot's @mention into every reply, which would otherwise trigger the wrong handler.

---

## 🏗️ Architecture Notes

<details>
<summary><strong>OwO Message Format (Critical Findings)</strong></summary>

OwO uses Discord's **Components v2** format (`type: 17` container). discord.js v14 does not fully deserialize this — `message.components`, `button.emoji`, `button.label` all come back as empty objects.

**The fix:** call `message.toJSON()` to get the raw API JSON, then walk the component tree manually.

### Component Types Used by OwO
| Type | Meaning |
|---|---|
| `17` | Container (wraps everything) |
| `10` | Text display — contains result text with player mention |
| `14` | Divider |
| `1` | Action row — each row holds 3 grid buttons |
| `2` | Button — grid tile |

### Button Emoji Values
| Emoji | Meaning |
|---|---|
| 💎 | Safe tile (clicked or unrevealed safe on loss) |
| 💥 | The tile the player clicked that was a bomb |
| 💣 | Unclicked bomb shown after round ends |
| `question_mark` (custom) | Unrevealed tile (game in progress) |

Custom emojis have `emoji.id` set; unicode emojis only have `emoji.name`. So `btn.emoji?.id != null` reliably detects an unrevealed tile.

### Button `custom_id` Format
```
gamble:mines:<UUID>:<step>:reveal:<position>
```
- `UUID` — unique per round, used as `gameId`
- `step` — OwO's internal counter, **not** click order (do not use for move sequencing)
- `position` — 0-indexed, left-to-right, top-to-bottom (0–8), converted to 1-indexed for display

</details>

<details>
<summary><strong>Adding New Commands</strong></summary>

```js
async function handleXxxCommand(message) {
  if (message.content.trim().toLowerCase() !== '!xxx') return false;
  // ... do work ...
  return true;
}
// In messageCreate:
if (await handleXxxCommand(message)) return;
```

Return `false` to pass through, `true` to consume the message.

</details>

<details>
<summary><strong>Replacing JSON Storage with SQLite</strong></summary>

The public API of `database.js` is the contract. `index.js` only calls:

- `db.isTrackingEnabled(guildId)`
- `db.setTrackingEnabled(guildId, bool)`
- `db.recordRound(guildId, userId, username, bombCount, bombTiles, moveTiles)`
- `db.getGuildMoveStats(guildId, moveNumber)`
- `db.getGuildBombStats(guildId, bombCount)`
- `db.getGuildBombMoveStats(guildId, bombCount, moveNumber)`
- `db.getGuildSummary(guildId)`
- `db.getTotalGamesAllGuilds()`
- `db._flush(true)` *(shutdown only)*

</details>

---

## 🖥️ Hosting Notes

- **No external database** — just Node.js and a writable disk. Works on any always-on host: VPS, Railway, Render, Fly.io, Raspberry Pi.
- On platforms that send `SIGTERM` on deploy/restart (Railway, Docker, PM2), the shutdown report fires automatically.

```bash
# PM2
pm2 start index.js --name owo-minewatch
pm2 save
```

For Docker, set `DISCORD_BOT_TOKEN` and `REPORT_CHANNEL_ID` as environment variables and mount `./data` as a volume to persist history.

---

## ⚠️ Known Limitations

| Issue | Notes |
|---|---|
| Multi-player attribution | Attribution matches by `triggeredUserId` first, falls back to FIFO. May be wrong if two users trigger in the same channel within 15 seconds and OwO resolves out of order. |
| No click order on first-click bombs | `moves` is `[]` if the player hits a bomb immediately — correct, there are no safe clicks to record. |
| Components v2 / discord.js v14 | Always use `message.toJSON()` — never rely on `message.components` or `message.embeds` for OwO messages. |
| Grid button regex | `/gamble:mines:.+:reveal:\d$/` only matches positions 0–8. Breaks if OwO ever uses a larger board. |

---

## 📄 Disclaimer

This tool tracks **cowoncy**, OwO's virtual non-real-money currency, for a Discord minigame. It does not interact with OwO's backend, does not automate gameplay, and provides no genuine predictive advantage. Use in accordance with your Discord server's rules and OwO's terms of service.
