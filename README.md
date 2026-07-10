# OwO Mine Tracker

A Discord bot (discord.js v14) that watches `mine` minigame rounds played
against the **OwO** bot, logs where the bombs land per-user, and posts a
"heat map" style embed after every round with the historically coldest
(least-hit) tiles.

> **Important honesty note:** OwO's bomb placement is random per round.
> This bot does **not** predict the future — it records *history* and
> shows you which tiles have been hit least often *so far*. Treat the
> "Next Safe Tile Deduction" as a fun stats readout, not a guarantee.

---

## Features

- Listens only to the official OwO bot (`408785106942164992`) — never
  reacts to other bots or regular user messages as game data.
- Recognizes mine triggers: `owo mine`, `o mine`, `omine`, `owo m`, `o m`,
  followed by a bet amount and an optional bomb count (`1`–`8`).
  - If no bomb count is given, it **defaults to 3**.
- Parses OwO's edited embed (`messageUpdate`) to read the 3×3 button grid
  and detect 💥 (clicked bomb), 💣 (revealed bomb), 💎 (safe tile).
- Stores up to the **last 50 rounds per user** in a local JSON file
  (atomic writes, periodic flush — safe for continuous hosting).
- Calculates tile-by-tile bomb frequency and sorts coldest → hottest,
  randomizing ties.
- Outputs a dynamic number of recommended safe tiles based on the bomb
  count just played:
  | Bombs played | Safe tiles recommended |
  |---|---|
  | 1–6 | 3 |
  | 7 | 2 |
  | 8 | 1 |
- Clean, informative embed per finished round: player, bomb count, bomb
  location(s), full heat map, and the next-round deduction.
- Per-server session toggle:
  - `@YourBot start mine` — begin tracking in this server.
  - `@YourBot end mine` — stop tracking (history is preserved).

---

## Project structure

```
owo-mine-tracker/
├── index.js          # Bot entry point: all event listeners & embed building
├── config.js          # Constants: bot ID, triggers, emojis, limits, colors
├── database.js        # JSON-file persistence layer (atomic writes, debounced flush)
├── deduction.js        # Pure frequency/heat-map math (unit-testable, no discord.js dep)
├── package.json
├── .env.example        # Copy to .env and fill in your token (or use real env vars)
├── .gitignore
└── data/
    └── history.json    # Auto-created on first run — do not edit by hand
```

---

## Setup

### 1. Prerequisites
- Node.js **18+**
- A Discord bot application/token ([Discord Developer Portal](https://discord.com/developers/applications))

### 2. Required bot permissions & intents
In the Developer Portal, under your application → **Bot**, enable:
- **Message Content Intent** (required — the bot reads raw message text and embed data)
- **Server Members Intent** (recommended, for reliable display-name resolution)

When inviting the bot to a server, it needs these permissions in the channel(s) it will watch:
- `View Channel`
- `Send Messages`
- `Read Message History`
- `Embed Links`

### 3. Install

```bash
cd owo-mine-tracker
npm install
```

### 4. Configure your token

Copy the example env file and fill in your bot token:

```bash
cp .env.example .env
```

Then edit `.env`:
```
DISCORD_BOT_TOKEN=your_actual_bot_token_here
```

This project reads the token from the `DISCORD_BOT_TOKEN` environment
variable directly (via `process.env`). If you want `.env` to be loaded
automatically, install `dotenv` and add `require('dotenv').config();` as
the first line of `index.js` — or simply export the variable in your
shell/host's environment settings, which most hosting platforms
(Railway, Render, PM2, systemd, Docker, etc.) support natively.

### 5. Run

```bash
export DISCORD_BOT_TOKEN=your_actual_bot_token_here
node index.js
```

Or with `npm`:
```bash
npm start
```

You should see:
```
[Ready] Logged in as YourBotName#0000
[Ready] Watching for OwO mine rounds. Use "@bot start mine" in a server to begin tracking.
```

---

## Usage

1. In any server the bot is in, mention it to start a tracking session:
   ```
   @YourBot start mine
   ```
2. Play mine as normal with OwO:
   ```
   owo mine 10000 3
   omine all
   o m 500 7
   ```
   (If you omit the bomb count, it's assumed to be **3**.)
3. When OwO's message resolves (bomb explodes or you cash out), the
   tracker bot automatically posts a follow-up embed with:
   - Who played
   - How many bombs were in that round
   - Where the bomb(s) actually were
   - The full heat map (all tracked rounds, coldest tiles highlighted)
   - The recommended safe tiles for your **next** round
4. To pause tracking in a server:
   ```
   @YourBot end mine
   ```
   Historical data is kept — running `start mine` again resumes using
   the same history.

---

## How round attribution works

OwO doesn't reply-reference the message that triggered a game, so the
bot keeps a short-lived, per-channel FIFO queue: when a user's trigger
command matches, it queues `{ userId, username, bombCount }` for that
channel. When OwO's message later resolves in that same channel, the
oldest still-fresh queued entry (within 15 seconds) is matched to it and
consumed. This keeps attribution correct even if multiple people are
playing in the same channel in quick succession, as long as OwO
resolves games roughly in the order they were started.

---

## Data storage

All history lives in `data/history.json`, structured as:

```json
{
  "guilds": {
    "<guildId>": {
      "trackingEnabled": true,
      "users": {
        "<userId>": {
          "username": "SomeUser",
          "rounds": [
            { "bombCount": 3, "bombTiles": [2, 5, 9], "ts": 1720612345678 }
          ]
        }
      }
    }
  }
}
```

- Writes are atomic (write to `.tmp`, then rename) and flushed on a
  5-second interval plus on process exit (`SIGINT`/`SIGTERM`), so the
  bot is safe to restart or redeploy without corrupting data.
- Each user's `rounds` array is capped at **50** entries (oldest
  dropped first) — configurable via `HISTORY_LIMIT` in `config.js`.

---

## Configuration reference (`config.js`)

| Constant | Default | Description |
|---|---|---|
| `OWO_BOT_ID` | `408785106942164992` | Only this bot's messages are analyzed |
| `MINE_TRIGGERS` | `['owo mine', 'o mine', 'omine', 'owo m', 'o m']` | Recognized command prefixes |
| `DEFAULT_BOMB_COUNT` | `3` | Used when no bomb count argument is given |
| `MAX_BOMB_COUNT` | `8` | Highest valid bomb count |
| `HISTORY_LIMIT` | `50` | Max rounds retained per user |
| `SAFE_TILE_OUTPUT` | `{1-6: 3, 7: 2, 8: 1}` | How many cold tiles to recommend per bomb count |

---

## Testing the emoji parser against real OwO output

Discord's cached component data shape can vary slightly by client/cache
path. If the bot isn't detecting finished rounds correctly, temporarily
add this line inside the `messageUpdate` handler in `index.js`
(right after the partial-fetch block) to inspect the real structure:

```js
console.log(JSON.stringify(newMessage.components, null, 2));
```

Play one round, check the console output, and adjust
`extractGridEmojis()` in `index.js` if the emoji data lives somewhere
different than `button.emoji.name`. Remove the debug line once confirmed.

---

## Hosting notes

- The bot has no external DB dependency — just Node and a writable
  disk for `data/history.json`. Works on any always-on Node host (VPS,
  Railway, Render, a Raspberry Pi, etc.).
- `unref()` is used on the flush interval so it never keeps the process
  alive on its own; normal Discord gateway activity keeps the process
  running as expected.
- Graceful shutdown on `SIGINT`/`SIGTERM` flushes any pending writes
  before exit — safe for container restarts and redeploys.

---

## Disclaimer

This tool tracks **cowoncy**, OwO's virtual, non-real-money currency,
purely for a Discord minigame. It does not interact with OwO's backend,
does not automate gameplay, and does not provide any actual predictive
edge — it's a historical stats tracker. Use in accordance with your
Discord server's rules and OwO's terms of service.
