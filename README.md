# OwO Mine Tracker

A Discord bot (discord.js v14) that watches `mine` minigame rounds played
against the **OwO** bot, logs bomb positions and click sequences per user,
builds statistical heatmaps, and posts interactive reports after every round
and on every boot/shutdown.

> **Honesty note:** OwO's bomb placement is random per round.
> This bot records *history* — it does not predict the future.
> Treat all recommendations as statistical tendencies, not guarantees.

---

## Table of Contents

1. [Project Structure](#project-structure)
2. [Setup](#setup)
3. [Environment Variables](#environment-variables)
4. [Commands](#commands)
5. [How It Works — Deep Dive](#how-it-works--deep-dive)
6. [OwO Message Format (Critical Findings)](#owo-message-format-critical-findings)
7. [Data Storage Schema](#data-storage-schema)
8. [Configuration Reference](#configuration-reference)
9. [Interactive Boot Reports](#interactive-boot-reports)
10. [Heatmap Gradient Reference](#heatmap-gradient-reference)
11. [Known Limitations & Edge Cases](#known-limitations--edge-cases)
12. [Architecture Notes for Future Developers](#architecture-notes-for-future-developers)
13. [Hosting Notes](#hosting-notes)
14. [Disclaimer](#disclaimer)

---

## Project Structure

```
owo-mine-tracker/
├── index.js          # Bot entry point: all event listeners, parsers, embed builders
├── config.js         # Constants: bot ID, triggers, emojis, limits, colors
├── database.js       # JSON-file persistence layer (atomic writes, debounced flush)
├── deduction.js      # Pure frequency/heatmap math (no discord.js dependency)
├── package.json
├── .env              # Your actual secrets — never commit this
├── .env.example      # Template to copy
├── .gitignore
└── data/
    └── history.json  # Auto-created on first run — do not edit by hand
```

---

## Setup

### Prerequisites
- Node.js **18+**
- A Discord bot application and token ([Discord Developer Portal](https://discord.com/developers/applications))

### Privileged Gateway Intents
In the Developer Portal → your application → **Bot**, enable **all three**:
- **Presence Intent**
- **Server Members Intent**
- **Message Content Intent** ← critical, without this the bot sees nothing

### Bot Permissions
When inviting via OAuth2, the bot needs:
- `View Channel`, `Send Messages`, `Read Message History`, `Embed Links`
- `Use External Emojis` (for emoji rendering in embeds)

Invite URL format:
```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=8&scope=bot
```
(`permissions=8` = Administrator, simplest for testing)

### Install & Run

```bash
npm install
npm start
```

Expected output:
```
[Ready] Logged in as yathuwuowominebot#6542
[Ready] Watching for OwO mine rounds. Use "@bot start mine" in a server to begin tracking.
[Boot Report] start reports sent to channel <channelId>
```

---

## Environment Variables

Stored in `.env` (loaded via `dotenv`):

| Variable | Required | Description |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Yes | Your bot token from the Developer Portal |
| `REPORT_CHANNEL_ID` | No | Channel ID to send boot/shutdown reports to. If unset, reports are silently skipped. |

`.env` example:
```
DISCORD_BOT_TOKEN=MTUzMjQ0MTc1MTQ4...
REPORT_CHANNEL_ID=1532454225412362491
```

> **Security:** Never commit `.env`. The `.gitignore` already excludes it.
> If your token is ever exposed in chat or a public repo, immediately go to
> the Developer Portal → Bot → Reset Token.

---

## Commands

### Session Control (mention-based)
| Command | Description |
|---|---|
| `@bot start mine` | Enable tracking for this server. Persists until `end mine` or restart. |
| `@bot end mine` | Pause tracking. All historical data is preserved. |

### Heatmap Commands (prefix-based, no tracking required)
| Command | Description |
|---|---|
| `!heatmap <n>` | Shows which tiles were most/least chosen as the **Nth safe click** across all tracked rounds. Move 1 = first click. |
| `!bombheatmap <x> [y]` | Shows bomb position frequency at move **x** in **y**-bomb rounds. `y` defaults to 3. Move 0 = bomb was hit on the first click. |
| `!minebot` | Full info panel: all commands, heatmap legend, examples. |

### Automatic (no command needed)
After every mine round ends (explosion or cash-out), the bot posts an embed with:
- Player name, bomb count, bomb tile locations
- Click sequence for that round (move 1 → move 2 → ...)
- Per-user bomb frequency heatmap (last 50 rounds)
- Coldest tiles recommended for the next round

---

## How It Works — Deep Dive

### 1. Trigger Detection
When a user sends a message matching any mine trigger (`owo mine`, `o mine`,
`omine`, `owo m`, `o m`), the bot queues a pending round entry:

```js
{ userId, username, bombCount, triggeredAt }
```

Stored per channel in a `Map<channelId, Array<entry>>`. Entries expire after
**15 seconds** (TTL). Bomb count is parsed from the second argument (e.g.
`owo mine 500 5` → bombCount=5). Defaults to 3 if not provided.

### 2. OwO Message Tracking
OwO sends one message per mine round and **edits it** as the player clicks
tiles. Each edit is a `messageUpdate` event. The bot also listens on
`messageCreate` because OwO's final result sometimes arrives as a new
message rather than an edit, depending on Discord's delivery.

### 3. In-Progress Move Tracking
When the bot sees a `messageUpdate` from OwO with "is playing a mines game"
text and newly revealed `💎` tiles, it builds a **click order sequence**
in real time:

```js
activeGames: Map<gameId, { revealedTiles: number[] }>
```

Each update, newly revealed tiles (not previously seen) are appended in
order. This gives accurate move sequencing even for multi-click rounds.

`gameId` is the UUID embedded in every button's `custom_id`:
`gamble:mines:<UUID>:<step>:reveal:<position>`

### 4. Round Completion Detection
A round is considered finished when the text component contains:
- `"touched a mine"` → explosion
- `"cashed out"` → player withdrew winnings

**Cash-out quirk:** On cash-out, OwO reveals bomb tiles (`💣`) but leaves
some unrevealed safe tiles as `question_mark` custom emojis. The bot
handles this by skipping the "no unrevealed tiles" check specifically for
cash-out rounds.

**Explosion:** All tiles are revealed. The exploded tile shows `💥`, other
bombs show `💣`, safe tiles show `💎`.

### 5. Round Attribution
When a round finishes, `triggeredUserId` is extracted from the OwO message
text (`<@userId>`). The pending round queue is searched for a matching
userId first (precise), falling back to FIFO (oldest entry) if no match.
This handles multi-player channels correctly in most cases.

### 6. Persistence
After recording, the round is saved to `data/history.json` via a debounced
5-second flush. Writes are atomic (write to `.tmp`, then `rename`).

---

## OwO Message Format (Critical Findings)

> This section documents hard-won discoveries about OwO's message structure
> that are essential for any future work on the parser.

### Components v2 (Type 17 Container)
OwO uses Discord's **Components v2** format (`type: 17` container). This is
a newer Discord API feature that **discord.js v14 does not fully deserialize**.
All `message.components`, `button.emoji`, `button.label`, etc. come back as
empty objects `{}` through the normal discord.js API.

**The fix:** call `message.toJSON()` to get the raw API JSON, then walk the
component tree manually.

### Raw Message Structure
```json
{
  "components": [{
    "type": 17,
    "components": [
      { "type": 10, "content": "### 💥 <@userId> touched a mine!\n-# **Bet**: ..." },
      { "type": 14, "divider": true },
      { "type": 1, "components": [
        { "type": 2, "emoji": { "name": "💎" }, "custom_id": "gamble:mines:<uuid>:<step>:reveal:0" },
        { "type": 2, "emoji": { "name": "💥" }, "custom_id": "gamble:mines:<uuid>:<step>:reveal:1" },
        ...
      ]},
      ...
    ]
  }]
}
```

### Component Types Used by OwO
| Type | Meaning |
|---|---|
| `17` | Container (wraps everything) |
| `10` | Text display — contains the result text with player mention |
| `14` | Divider |
| `1` | Action row — each row holds 3 grid buttons |
| `2` | Button — grid tile |

### Button Emoji Values
| Emoji | Unicode | Meaning |
|---|---|---|
| `💎` | SAFE tile | Clicked safely or unrevealed safe (on loss) |
| `💥` | EXPLODED_BOMB | The tile the player clicked that was a bomb |
| `💣` | REVEALED_BOMB | An unclicked bomb shown after round ends |
| `question_mark` | Custom emoji (has `.id` field) | Unrevealed tile (game in progress) |

**Key insight for unrevealed detection:** Custom emojis have `emoji.id` set.
Unicode emojis have only `emoji.name`. So `btn.emoji?.id != null` reliably
detects an unrevealed tile.

### Button `custom_id` Format
```
gamble:mines:<UUID>:<step>:reveal:<position>
```
- `UUID` — unique per round, used as `gameId` for tracking
- `step` — OwO's internal round counter, **not** the click order (all buttons
  in a finished round share the same step value — do not use this for
  move sequencing)
- `position` — 0-indexed tile position, left-to-right, top-to-bottom:
  ```
  0 | 1 | 2
  3 | 4 | 5
  6 | 7 | 8
  ```
  The bot converts these to 1-indexed (1–9) for display.

### Result Text Location
The result text ("touched a mine", "cashed out", player mention) is in the
`type: 10` text display component, **not** in `message.content` (which is
always empty) and **not** in embeds (which are also empty). Always use
`collectText(raw.components)` to extract it.

### Grid Button Regex Filter
The filter used to find grid buttons:
```js
/gamble:mines:.+:reveal:\d$/
```
Note the `\d$` — this matches only single-digit positions (0–8). If OwO
ever extends to larger grids this would need updating.

---

## Data Storage Schema

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
            {
              "bombCount": 3,
              "bombTiles": [2, 6, 9],
              "moves": [1, 5, 3],
              "ts": 1720612345678
            }
          ]
        }
      },
      "moveStats": {
        "1": { "5": 12, "3": 8, "1": 4 },
        "2": { "9": 6, "2": 5 }
      },
      "bombStats": {
        "3": { "2": 15, "6": 11, "9": 9 }
      },
      "bombMoveStats": {
        "3": {
          "0": { "5": 4, "2": 3 },
          "1": { "9": 2, "6": 2 },
          "2": { "3": 1 }
        }
      }
    }
  }
}
```

### Field Descriptions
| Field | Description |
|---|---|
| `trackingEnabled` | Whether `@bot start mine` has been issued for this guild |
| `totalGames` | Total rounds recorded in this guild (never decremented) |
| `users[id].rounds` | Per-user history, capped at `HISTORY_LIMIT` (default 50), oldest dropped first |
| `rounds[].moves` | 1-indexed tile positions in click order (first click = index 0) |
| `moveStats[n][tile]` | How many times `tile` was the Nth safe click guild-wide |
| `bombStats[bc][tile]` | How many times `tile` had a bomb in `bc`-bomb rounds |
| `bombMoveStats[bc][m][tile]` | Bomb frequency at tile, filtered to rounds where the bomb was hit after `m` safe clicks |

---

## Configuration Reference

`config.js` — all tuneable constants:

| Constant | Default | Description |
|---|---|---|
| `OWO_BOT_ID` | `408785106942164992` | Only messages from this bot ID are parsed |
| `MINE_TRIGGERS` | `['owo mine', 'o mine', 'omine', 'owo m', 'o m']` | Recognized command prefixes, matched case-insensitively |
| `DEFAULT_BOMB_COUNT` | `3` | Used when no bomb count is in the trigger message |
| `MAX_BOMB_COUNT` | `8` | Upper bound for bomb count argument parsing |
| `HISTORY_LIMIT` | `50` | Max rounds stored per user (oldest dropped on overflow) |
| `SAFE_TILE_OUTPUT` | `{1-6: 3, 7: 2, 8: 1}` | How many cold tiles to recommend based on bomb count |
| `DATA_FILE` | `./data/history.json` | Path to the persistence file |
| `COLORS.PRIMARY` | `0x8b5cf6` | Purple — normal round embed |
| `COLORS.SUCCESS` | `0x22c55e` | Green — cash-out embed, bot online report |
| `COLORS.DANGER` | `0xef4444` | Red — explosion embed (unused currently), bomb heatmap |
| `COLORS.INFO` | `0x38bdf8` | Blue — tile heatmap, boot summary |

---

## Interactive Boot Reports

On every **startup** and **graceful shutdown** (`SIGINT`/`SIGTERM`), the bot
sends 3 messages to `REPORT_CHANNEL_ID`:

1. **Summary embed** — online/offline status, guild count, total games tracked, command reference
2. **Tile heatmap** (move 1) — interactive, with ◀/▶ buttons to navigate move numbers
3. **Bomb heatmap** (move 0, 3 bombs) — interactive, with ◀/▶ for move numbers and bomb counts

### Button Custom ID Format
```
tile_heatmap:<guildId>:<moveNumber>:<suffix>
bomb_heatmap:<guildId>:<moveNumber>:<bombCount>:<suffix>
```

Suffixes (`prev`, `next`, `home`, `bprev`, `bnext`) are appended to prevent
Discord's "duplicate custom_id" error when two buttons would otherwise
generate the same ID (e.g. when already on move 1, both ◀ and "Move 1"
button would have identical IDs without the suffix).

### Shutdown Behavior
The bot overrides `SIGINT`/`SIGTERM` at the process level. The shutdown
sequence is:
1. Send shutdown reports to `REPORT_CHANNEL_ID`
2. Flush `history.json` to disk
3. `process.exit(0)`

The database's own `_shutdown` method no longer calls `process.exit` —
`index.js` owns the full shutdown flow.

---

## Heatmap Gradient Reference

Both `!heatmap` and `!bombheatmap` use the same 20-step gradient (one step
per 5% of the max value):

| Emoji | Frequency Range | Meaning |
|---|---|---|
| ⬛ | 0–9% | Never or barely chosen |
| 🟦 | 10–29% | Rarely chosen |
| 🟩 | 30–49% | Occasionally chosen |
| 🟨 | 50–59% | Moderately common |
| 🟧 | 60–79% | Frequently chosen |
| 🟥 | 80–100% | Most common tile (relative to the highest-frequency tile) |

All percentages are relative to the **most-chosen tile in that dataset**,
not absolute. A tile at 🟥 doesn't mean it was chosen 80% of the time —
it means it was chosen at 80–100% the rate of the single most popular tile.

### Grid Layout
All heatmaps render as a 3×3 grid matching the mine board:
```
Tile 1 | Tile 2 | Tile 3
Tile 4 | Tile 5 | Tile 6
Tile 7 | Tile 8 | Tile 9
```

---

## Known Limitations & Edge Cases

### Multi-Player Attribution
Round attribution matches by `triggeredUserId` first (extracted from OwO's
result text), then falls back to FIFO. If two users trigger mine in the same
channel within 15 seconds and OwO resolves them out of order, attribution
may be wrong. The 15-second TTL mitigates stale matches.

### No Click Order on First-Click Bombs
If the player hits a bomb on their very first click, `moves` is `[]` (empty).
The in-progress tracker never fires because there are no intermediate updates
before the round ends. This is correct — there are no safe clicks to record.

### OwO Bot Not Cached
Because OwO is a verified bot in potentially millions of servers, its
messages are not always cached by discord.js. The `messageUpdate` event may
fire with a partial `newMessage`. The bot fetches partials explicitly:
```js
if (msg.partial) msg = await msg.fetch();
```

### Components v2 — discord.js v14 Incompatibility
discord.js v14 does not parse Components v2 (`type: 17`). This means
`message.components`, `message.embeds`, and `message.content` are all empty
or useless for OwO's mine messages. Always use `message.toJSON()` and walk
the raw JSON tree. This is the single most important architectural constraint
in this codebase. **Do not upgrade to standard discord.js component parsing
without verifying OwO has switched back to Components v1.**

### Step Counter in custom_id Is Not Click Order
The `<step>` field in `gamble:mines:<uuid>:<step>:reveal:<pos>` is NOT
an incrementing click counter. All buttons on a finished board share the
same step value. Click order is tracked by watching each intermediate
`messageUpdate` and noting which tiles transition from `question_mark` to `💎`.

### Cash-Out Leaves Unrevealed Tiles
When a player cashes out, OwO reveals bomb positions (`💣`) but leaves
un-clicked safe tiles as `question_mark`. The parser explicitly allows this:
```js
if (!hasExploded && !isCashOut && hasUnrevealed) return { state: 'none' };
```
Without this check, cash-out rounds would never be recorded.

### Regex for Grid Buttons Only Matches Single-Digit Positions
```js
/gamble:mines:.+:reveal:\d$/
```
This matches positions 0–9. If OwO ever uses a larger board this breaks.

---

## Architecture Notes for Future Developers

### Adding New Commands
All commands follow the same pattern in `messageCreate`:
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

### Adding New Stats Dimensions
To add a new statistic (e.g. per-user move stats):
1. Add the data structure to `_ensureGuild()` or `_ensureUser()` in `database.js`
2. Update `recordRound()` to populate it
3. Add a getter method
4. Add a command in `index.js`

### Extending the Heatmap to Per-User Data
Currently heatmaps are guild-wide. For per-user heatmaps, pass a `userId`
parameter and filter `guild.users[userId].rounds` instead of `guild.moveStats`.
The `deduction.js` module already works per-user (it takes a `rounds` array).

### Replacing JSON Storage with SQLite
The JSON file works fine for small servers. For high-volume use, replace
`database.js` with a SQLite adapter (e.g. `better-sqlite3`). The public API
of `database.js` is the contract — `index.js` only calls:
- `db.isTrackingEnabled(guildId)`
- `db.setTrackingEnabled(guildId, bool)`
- `db.recordRound(guildId, userId, username, bombCount, bombTiles, moveTiles)`
- `db.getGuildMoveStats(guildId, moveNumber)`
- `db.getGuildBombStats(guildId, bombCount)`
- `db.getGuildBombMoveStats(guildId, bombCount, moveNumber)`
- `db.getGuildSummary(guildId)`
- `db.getTotalGamesAllGuilds()`
- `db._flush(true)` (shutdown only)

### Interactive Button State
Buttons embed their full navigation state in `custom_id`. No server-side
session storage is needed. The interaction handler parses the ID, rebuilds
the embed, and calls `interaction.update()`. This means buttons work
correctly even after bot restarts (old messages keep working as long as
the custom_id format doesn't change).

### discord.js v15 Migration Note
A deprecation warning appears on startup:
```
The ready event has been renamed to clientReady
```
In v15, change `client.once('ready', ...)` to `client.once('clientReady', ...)`.
No other breaking changes are expected for this codebase's usage patterns,
but verify Components v2 support improvements in v15 before upgrading.

---

## Hosting Notes

- **No external database** — just Node.js and a writable disk. Works on
  any always-on host: VPS, Railway, Render, Fly.io, Raspberry Pi, etc.
- The flush interval uses `.unref()` so it never prevents clean shutdown.
- On platforms that send `SIGTERM` on deploy/restart (Railway, Docker,
  PM2), the shutdown report fires automatically before exit.
- To run with PM2:
  ```bash
  pm2 start index.js --name owo-mine-tracker
  pm2 save
  ```
- To run in Docker, set `DISCORD_BOT_TOKEN` and `REPORT_CHANNEL_ID` as
  environment variables and mount `./data` as a volume to persist history.

---

## Disclaimer

This tool tracks **cowoncy**, OwO's virtual non-real-money currency, for a
Discord minigame. It does not interact with OwO's backend, does not automate
gameplay, and provides no genuine predictive advantage — it is a historical
frequency tracker. Use in accordance with your Discord server's rules and
OwO's terms of service.

---

## Fun Replies

Two personality responses are built into the bot, checked after all real
commands in `messageCreate`:

| Trigger | Response |
|---|---|
| Someone @mentions the bot without a valid command | `aapki tuchki tuiyan` |
| Someone replies to any of the bot's messages | `dont talk to me plwease 🥺🙏 i dont wanna talk to you` |

The reply check runs **before** the mention check — this is important because
Discord auto-injects the bot's @mention into every reply, which would
otherwise trigger the mention handler instead of the reply handler.

Order in `messageCreate`:
1. Reply reference check (`message.reference?.messageId`) → reply response
2. Mention check (`message.mentions.has(client.user.id)`) → tuchki tuiyan
