# Handoff Notes — DELETE THIS FILE

Everything in README.md is accurate up to the boot reports section.
Below is what was added/changed AFTER the README was last written.

---

## Cash-out fix (index.js)

OwO reveals bomb tiles (`💣`) on cash-out but leaves unrevealed safe tiles
as `question_mark` custom emojis. The parser now explicitly skips the
"no unrevealed tiles" check for cash-out rounds:

```js
const isCashOut = allText.includes('cashed out');
if (!hasExploded && !isCashOut && hasUnrevealed) return { state: 'none' };
```

`isCashOut` is passed through to `buildResultEmbed` which uses it to set:
- Title: `💰 Mine Round — Cashed Out` (green) vs `⛏️ Mine Round — Exploded`
- Color: `COLORS.SUCCESS` vs `COLORS.PRIMARY`

---

## Web Dashboard (NEW FILES)

### Files added
- `dashboard.js` — standalone Express server, reads `history.json` directly
- `public/index.html` — dark-mode SPA dashboard (Chart.js + Tailwind CDN)
- `DASHBOARD_PORT=3000` added to `.env` and `.env.example`
- `package.json` scripts updated:
  - `npm run dashboard` → `node dashboard.js`
  - `npm run start:all` → runs both bot + dashboard (PowerShell: use two terminals)

### Architecture
- Dashboard is **read-only** — it calls `fs.readFileSync` directly on
  `history.json` on every request. It never imports `database.js` so there
  is zero conflict with the bot's write debouncer.
- Run in a **separate terminal** from the bot: `node dashboard.js`
- Access at: **http://localhost:3000**

### API endpoints (dashboard.js)
| Endpoint | Description |
|---|---|
| `GET /api/guilds` | List guilds with game counts |
| `GET /api/summary` | Global stats + 30-day activity + bomb dist |
| `GET /api/players?guildId=` | Player leaderboard with bomb/click freq |
| `GET /api/rounds?guildId=&userId=&bombCount=&outcome=&from=&to=` | Filtered round history |
| `GET /api/heatmap?type=tile\|bomb&moveNumber=&bombCount=&guildId=` | Tile counts for grid rendering |
| `GET /api/compare?userA=&userB=&guildId=` | Side-by-side player profiles |
| `GET /api/trends?days=30&guildId=` | Daily totals/outcomes for line chart |
| `GET /api/export?format=csv\|json&guildId=` | Download all rounds |

### Dashboard tabs
1. **Overview** — 4 stat cards, daily activity bar chart, bomb dist doughnut, outcomes line chart
2. **Heatmaps** — 3×3 tile grid (click heatmap) + bomb heatmap, both interactive with move/bomb controls
3. **Players** — leaderboard table, click row to see personal bomb grid + first-click bar chart
4. **Compare** — pick two players, side-by-side stats + bomb grids + first-click chart overlay
5. **History** — searchable/filterable round table (player, bombs, outcome, date range), CSV/JSON export buttons

### Current bug (index.html is incomplete)
The last dashboard session was cut short. `public/index.html` is **partially
written** — it has the Overview and Heatmap tabs rendered but the Players,
Compare, History tabs and ALL JavaScript are missing/incomplete.

The root cause of the "graphs keep increasing" bug that was being fixed:
multiple `<script>` blocks each re-declared `let charts = {}`, wiping
chart instance references so `destroyChart()` could never find them to
destroy before re-creating. Fix: all JS must be in ONE `<script>` block
at the bottom of `<body>`.

### Recommended next steps for dashboard
1. Delete the partial `public/index.html` and rewrite it cleanly with one
   `<script>` block at the bottom
2. Key JS architecture:
   - Single `const charts = {}` at top of script
   - `destroyChart(id)` checks `charts[id]?.destroy()` then `delete charts[id]`
   - All chart-creating functions call `destroyChart(id)` first
   - `reloadAll()` called once on guild change, not on every tab switch
3. The `dashboard.js` server is complete and working — no changes needed there

---

## !minebot command update

`!minebot` now lists `!bombheatmap` with the updated signature:
```
!bombheatmap <move_number> [bomb_count]
```
- `move_number` = how many safe clicks before the bomb (0 = first tile was bomb)
- `bomb_count` = optional, defaults to 3

---

## bombMoveStats schema (database.js)

Added alongside `bombStats`:
```json
"bombMoveStats": {
  "3": {
    "0": { "5": 4, "2": 3 },
    "2": { "9": 2 }
  }
}
```
Key = bombCount → moveNumber (safe clicks before bomb) → tile → count.

New DB methods:
- `db.getGuildBombMoveStats(guildId, bombCount, moveNumber)`
- `db.getGuildBombStats(guildId, bombCount)`

---

## Shutdown flow (index.js)

`database.js` no longer calls `process.exit` or registers SIGINT/SIGTERM.
`index.js` owns the full shutdown:
1. `sendBootReports('stop')` — sends 3 messages to REPORT_CHANNEL_ID
2. `db._flush(true)` — force-writes history.json
3. `process.exit(0)`

---

## Fun Replies (index.js)

Two personality responses added inside `messageCreate`, after all command
handlers and before the mine trigger detection:

**Ping with no command:**
```js
if (message.mentions.has(client.user.id)) {
  await message.reply('aapki tuchki tuiyan');
  return;
}
```
Fires when someone @mentions the bot but the message didn't match any
command (`start mine`, `end mine`, `!heatmap`, `!bombheatmap`, `!minebot`).

**Reply to a bot message:**
```js
if (message.reference?.messageId) {
  const replied = await message.channel.messages.fetch(message.reference.messageId);
  if (replied.author?.id === client.user.id) {
    await message.reply('dont talk to me plwease 🥺🙏 i dont wanna talk to you');
    return;
  }
}
```
Fires when someone replies to any message the bot sent (embeds, reports,
round results, etc.). Wraps the fetch in a try/catch to silently ignore
deleted/inaccessible messages.

Both checks sit after all real command handlers so they never intercept
legitimate commands.

**Bug fix — order matters:**
The reply check must run BEFORE the mention check. When someone replies to
a bot message, Discord automatically injects the bot's @mention into the
reply content, which would cause the mention handler to fire first and say
"aapki tuchki tuiyan" instead of the reply response. Correct order:

1. Check `message.reference?.messageId` first → reply response
2. Check `message.mentions.has(client.user.id)` second → tuchki tuiyan
