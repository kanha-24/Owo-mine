'use strict';

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} = require('discord.js');

const {
  OWO_BOT_ID,
  MINE_TRIGGERS,
  EMOJI,
  MAX_BOMB_COUNT,
  DEFAULT_BOMB_COUNT,
  HISTORY_LIMIT,
  COLORS,
} = require('./config');

const db = require('./database');
const { deduce } = require('./deduction');

// ---------------------------------------------------------------------------
// Client setup
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ---------------------------------------------------------------------------
// Pending rounds tracker
// Structure: Map<channelId, Array<{ userId, username, bombCount, triggeredAt }>>
// ---------------------------------------------------------------------------

const pendingRounds = new Map();
const PENDING_TTL_MS = 15_000;

// Track in-progress games to capture move order via intermediate messageUpdates
// Structure: Map<messageId, { userId, username, bombCount, channelId, guildId, revealedTiles: number[] }>
const activeGames = new Map();

function addPendingRound(channelId, entry) {
  const list = pendingRounds.get(channelId) ?? [];
  list.push(entry);
  pendingRounds.set(channelId, list);
}

function popPendingRound(channelId, preferUserId = null) {
  const list = pendingRounds.get(channelId);
  if (!list || list.length === 0) return null;

  const now = Date.now();
  const fresh = list.filter((e) => now - e.triggeredAt <= PENDING_TTL_MS);

  if (fresh.length === 0) {
    pendingRounds.delete(channelId);
    return null;
  }

  let idx = -1;
  if (preferUserId) idx = fresh.findIndex((e) => e.userId === preferUserId);
  if (idx === -1) idx = 0;

  const [entry] = fresh.splice(idx, 1);
  if (fresh.length > 0) pendingRounds.set(channelId, fresh);
  else pendingRounds.delete(channelId);
  return entry;
}

// ---------------------------------------------------------------------------
// Trigger parsing
// ---------------------------------------------------------------------------

const SORTED_TRIGGERS = [...MINE_TRIGGERS].sort((a, b) => b.length - a.length);

function parseMineCommand(content) {
  const normalized = content.trim().toLowerCase();
  for (const trigger of SORTED_TRIGGERS) {
    if (normalized === trigger || normalized.startsWith(`${trigger} `)) {
      const rest = normalized.slice(trigger.length).trim();
      const args = rest.length ? rest.split(/\s+/) : [];
      let bombCount = DEFAULT_BOMB_COUNT;
      if (args.length >= 2) {
        const parsed = parseInt(args[1], 10);
        if (Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_BOMB_COUNT) {
          bombCount = parsed;
        }
      }
      return { bombCount };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// OwO Components v2 parsing
//
// OwO uses Discord's Components v2 (type 17 container). discord.js v14 does
// not deserialize these, so we read directly from msg.toJSON().
//
// Grid button custom_id format:
//   gamble:mines:<uuid>:<step>:reveal:<position>
//   position: 0-8 (left-to-right, top-to-bottom)
//   step: increments with each safe click (1 = first click, etc.)
//
// Emoji meanings:
//   question_mark (custom id)  → unrevealed tile (game in progress)
//   💎 (unicode)               → safe tile (revealed)
//   💥 (unicode)               → exploded bomb (round lost)
//   💣 (unicode)               → revealed bomb (shown on cash-out or loss)
// ---------------------------------------------------------------------------

function collectButtons(components) {
  const buttons = [];
  for (const comp of components) {
    if (comp.type === 2) {
      buttons.push(comp);
    } else if (Array.isArray(comp.components)) {
      buttons.push(...collectButtons(comp.components));
    }
  }
  return buttons;
}

function collectText(components) {
  let text = '';
  for (const comp of components) {
    if (comp.type === 10 && comp.content) {
      text += comp.content + ' ';
    } else if (Array.isArray(comp.components)) {
      text += collectText(comp.components);
    }
  }
  return text;
}

/**
 * Parse an OwO mine message from raw JSON.
 *
 * Returns one of:
 *   { state: 'none' }                            — not a mine message
 *   { state: 'inprogress', revealedTiles, triggeredUserId, gameId }
 *   { state: 'finished', bombTiles, triggeredUserId, gameId }
 *
 * gameId = the UUID from the custom_id, unique per round
 * revealedTiles = 1-indexed safe tiles visible so far (unordered on final board)
 */
function parseOwoMineMessage(msg) {
  let raw;
  try {
    raw = msg.toJSON ? msg.toJSON() : null;
  } catch (e) {
    return { state: 'none' };
  }

  if (!raw?.components?.length) return { state: 'none' };

  const allText = collectText(raw.components);
  const isFinished =
    allText.includes('touched a mine') ||
    allText.includes('cashed out');
  const isActive =
    allText.includes('is playing a mines game');

  if (!isFinished && !isActive) return { state: 'none' };

  const mentionMatch = allText.match(/<@!?(\d+)>/);
  const triggeredUserId = mentionMatch?.[1] ?? null;

  const allButtons = collectButtons(raw.components);
  const gridButtons = allButtons
    .filter((b) => b.custom_id && /gamble:mines:.+:reveal:\d$/.test(b.custom_id))
    .sort((a, b) => {
      const posA = parseInt(a.custom_id.split(':').pop(), 10);
      const posB = parseInt(b.custom_id.split(':').pop(), 10);
      return posA - posB;
    });

  if (gridButtons.length !== 9) return { state: 'none' };

  // Extract gameId (UUID) from any button's custom_id
  // Format: gamble:mines:<uuid>:<step>:reveal:<pos>
  const gameId = gridButtons[0]?.custom_id?.split(':')?.[2] ?? null;

  // Collect currently revealed safe tiles (💎, style 3 = green)
  const revealedTiles = [];
  gridButtons.forEach((btn, idx) => {
    if (btn.emoji?.name === EMOJI.SAFE) {
      revealedTiles.push(idx + 1);
    }
  });

  if (isActive) {
    return { state: 'inprogress', revealedTiles, triggeredUserId, gameId };
  }

  // Finished — check game is truly over
  // On cash-out: bombs are revealed (💣) but safe tiles may still be question_mark
  // On explosion: 💥 is present, all tiles revealed
  const hasUnrevealed = gridButtons.some((b) => b.emoji?.id != null);
  const hasExploded = gridButtons.some((b) => b.emoji?.name === EMOJI.EXPLODED_BOMB);
  const isCashOut = allText.includes('cashed out');

  // Still in progress if no explosion AND not a cash-out AND some tiles still hidden
  if (!hasExploded && !isCashOut && hasUnrevealed) return { state: 'none' };

  const bombTiles = [];
  gridButtons.forEach((btn, idx) => {
    const name = btn.emoji?.name ?? '';
    if (name === EMOJI.EXPLODED_BOMB || name === EMOJI.REVEALED_BOMB) {
      bombTiles.push(idx + 1);
    }
  });

  if (bombTiles.length === 0) return { state: 'none' };

  // Debug log
  console.log('[PARSE] Grid state (pos 1-9):');
  gridButtons.forEach((btn, idx) => {
    const emoji = btn.emoji?.name ?? (btn.emoji?.id ? `custom` : '?');
    console.log(`  tile ${idx + 1} | emoji=${emoji} style=${btn.style}`);
  });
  console.log('[PARSE] bombTiles:', bombTiles);
  console.log('[PARSE] gameId:', gameId, '| triggeredUserId:', triggeredUserId);

  return { state: 'finished', bombTiles, triggeredUserId, gameId, isCashOut };
}

// ---------------------------------------------------------------------------
// Session management commands
// ---------------------------------------------------------------------------

async function handleSessionCommand(message) {
  if (!message.mentions.has(client.user.id)) return false;

  const stripped = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim()
    .toLowerCase();

  if (/^start\s+mine$/.test(stripped)) {
    db.setTrackingEnabled(message.guild.id, true);
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.SUCCESS)
          .setTitle('🟢 Mine Deduction Session Started')
          .setDescription(
            'I\'m now tracking `mine` rounds in this server.\n\n' +
            'Play with any of these triggers and I\'ll log the results:\n' +
            '`owo mine`, `o mine`, `omine`, `owo m`, `o m`'
          )
          .setFooter({ text: 'Say "@bot end mine" to stop tracking.' })
          .setTimestamp(),
      ],
    });
    return true;
  }

  if (/^end\s+mine$/.test(stripped)) {
    db.setTrackingEnabled(message.guild.id, false);
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.DANGER)
          .setTitle('🔴 Mine Deduction Session Ended')
          .setDescription('Tracking is now paused. Historical data is kept — say `@bot start mine` to resume.')
          .setTimestamp(),
      ],
    });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// !heatmap <move_number> command
// ---------------------------------------------------------------------------

const TILE_GLYPHS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

// Emoji tiers — 20 steps of 5% each, cold → hot
const HEAT_TIERS = [
  '⬛', '⬛', // 0–9%   (never / almost never picked)
  '🟦', '🟦', // 10–19%
  '🟦', '🟩', // 20–29%
  '🟩', '🟩', // 30–39%
  '🟩', '🟨', // 40–49%
  '🟨', '🟨', // 50–59%
  '🟧', '🟧', // 60–69%
  '🟧', '🟥', // 70–79%
  '🟥', '🟥', // 80–89%
  '🟥', '🟥', // 90–100%
];

/**
 * Map a value in [0, max] to one of the HEAT_TIERS emojis (5% resolution).
 */
function heatEmoji(value, max) {
  if (max === 0) return HEAT_TIERS[0];
  const ratio = value / max;
  const idx = Math.min(Math.floor(ratio * HEAT_TIERS.length), HEAT_TIERS.length - 1);
  return HEAT_TIERS[idx];
}

async function handleHeatmapCommand(message) {
  const args = message.content.trim().split(/\s+/);
  if (args[0].toLowerCase() !== '!heatmap') return false;

  const moveNumber = parseInt(args[1], 10);
  if (isNaN(moveNumber) || moveNumber < 1) {
    await message.reply('Usage: `!heatmap <move_number>` — e.g. `!heatmap 1` for the first click.');
    return true;
  }

  const stats = db.getGuildMoveStats(message.guild.id, moveNumber);
  const entries = Object.entries(stats); // [["tile", count], ...]

  if (entries.length === 0) {
    await message.reply(`No data yet for move **${moveNumber}**. Play some rounds first!`);
    return true;
  }

  // Build a count array indexed 1-9
  const counts = new Array(10).fill(0);
  let totalClicks = 0;
  for (const [tile, count] of entries) {
    const t = Number(tile);
    if (t >= 1 && t <= 9) {
      counts[t] = count;
      totalClicks += count;
    }
  }

  const maxCount = Math.max(...counts.slice(1));

  // Build 3×3 grid lines
  const gridLines = [];
  for (let row = 0; row < 3; row++) {
    const cells = [];
    for (let col = 0; col < 3; col++) {
      const tile = row * 3 + col + 1;
      cells.push(heatEmoji(counts[tile], maxCount));
    }
    gridLines.push(cells.join(' '));
  }

  // Ranked list
  const ranked = counts
    .map((count, tile) => ({ tile, count }))
    .slice(1) // drop index 0
    .sort((a, b) => b.count - a.count);

  const rankLines = ranked
    .map(({ tile, count }) => {
      const pct = totalClicks > 0 ? ((count / totalClicks) * 100).toFixed(1) : '0.0';
      return `${heatEmoji(count, maxCount)} ${TILE_GLYPHS[tile - 1]} Tile **${tile}** — **${count}** click${count !== 1 ? 's' : ''} (${pct}%)`;
    })
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor(COLORS.INFO)
    .setTitle(`🗺️ Move ${moveNumber} Heatmap`)
    .setDescription(
      `**Grid** (🟦 cold → 🟥 hot)\n\n` +
      gridLines.join('\n') +
      '\n\u200b'
    )
    .addFields(
      { name: `📊 Tile Breakdown (${totalClicks} total clicks)`, value: rankLines, inline: false }
    )
    .setFooter({ text: `Move ${moveNumber} = the ${ordinal(moveNumber)} safe tile clicked in a round` })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
  return true;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ---------------------------------------------------------------------------
// !bombheatmap <n> command
// ---------------------------------------------------------------------------

async function handleBombHeatmapCommand(message) {
  const args = message.content.trim().split(/\s+/);
  if (args[0].toLowerCase() !== '!bombheatmap') return false;

  // Parse args: !bombheatmap <moveNumber> [bombCount=3]
  const moveNumber = parseInt(args[1], 10);
  if (isNaN(moveNumber) || moveNumber < 0) {
    await message.reply(
      'Usage: `!bombheatmap <move_number> [bomb_count]`\n' +
      '• `move_number` — how many safe clicks before the bomb (0 = first tile was a bomb)\n' +
      '• `bomb_count` — optional, defaults to **3** (valid: 1–8)\n' +
      'Examples: `!bombheatmap 0` · `!bombheatmap 2 5`'
    );
    return true;
  }

  const bombCount = args[2] !== undefined ? parseInt(args[2], 10) : 3;
  if (isNaN(bombCount) || bombCount < 1 || bombCount > 8) {
    await message.reply('Invalid bomb count. Valid values: 1–8.');
    return true;
  }

  // Use move-filtered stats if moveNumber is specified, else all-rounds stats
  const stats = db.getGuildBombMoveStats(message.guild.id, bombCount, moveNumber);
  const allStats = db.getGuildBombStats(message.guild.id, bombCount);
  const entries = Object.entries(stats);

  if (entries.length === 0) {
    const allEntries = Object.entries(allStats);
    if (allEntries.length === 0) {
      await message.reply(`No bomb data yet for **${bombCount}-bomb** rounds. Play some rounds with \`owo mine <bet> ${bombCount}\`!`);
    } else {
      await message.reply(`No data for **${bombCount}-bomb** rounds where the bomb was hit after exactly **${moveNumber}** safe click${moveNumber !== 1 ? 's' : ''}. Try a different move number.`);
    }
    return true;
  }

  // Build count array indexed 1-9
  const counts = new Array(10).fill(0);
  let totalBombs = 0;
  for (const [tile, count] of entries) {
    const t = Number(tile);
    if (t >= 1 && t <= 9) {
      counts[t] = count;
      totalBombs += count;
    }
  }

  const maxCount = Math.max(...counts.slice(1));

  // 3×3 grid
  const gridLines = [];
  for (let row = 0; row < 3; row++) {
    const cells = [];
    for (let col = 0; col < 3; col++) {
      const tile = row * 3 + col + 1;
      cells.push(heatEmoji(counts[tile], maxCount));
    }
    gridLines.push(cells.join(' '));
  }

  // Ranked list hottest first
  const ranked = counts
    .map((count, tile) => ({ tile, count }))
    .slice(1)
    .sort((a, b) => b.count - a.count);

  const rankLines = ranked
    .map(({ tile, count }) => {
      const pct = totalBombs > 0 ? ((count / totalBombs) * 100).toFixed(1) : '0.0';
      return `${heatEmoji(count, maxCount)} ${TILE_GLYPHS[tile - 1]} Tile **${tile}** — **${count}** bomb${count !== 1 ? 's' : ''} (${pct}%)`;
    })
    .join('\n');

  // Safest tiles = lowest bomb frequency
  const safest = [...ranked]
    .sort((a, b) => a.count - b.count)
    .slice(0, 3)
    .map(({ tile }) => `${TILE_GLYPHS[tile - 1]} Tile **${tile}**`)
    .join('  ');

  const totalRounds = Math.round(totalBombs / bombCount);
  const moveLabel = moveNumber === 0
    ? 'the **first tile** clicked was a bomb'
    : `player had made **${moveNumber}** safe click${moveNumber !== 1 ? 's' : ''} first`;

  const embed = new EmbedBuilder()
    .setColor(COLORS.DANGER)
    .setTitle(`💣 Bomb Heatmap — Move ${moveNumber}, ${bombCount}-Bomb Rounds`)
    .setDescription(
      `Showing bomb positions in **${bombCount}-bomb** rounds where ${moveLabel}.\n\n` +
      `**Grid** (⬛ safe → 🟥 dangerous)\n\n` +
      gridLines.join('\n') +
      '\n\u200b'
    )
    .addFields(
      { name: `📊 Tile Breakdown (~${totalRounds} matching rounds)`, value: rankLines, inline: false },
      { name: '🧊 Statistically Safest Tiles (this scenario)', value: safest || '_Not enough data_', inline: false },
    )
    .setFooter({ text: `!bombheatmap ${moveNumber} ${bombCount} · ⬛→🟥 = 5% steps` })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
  return true;
}

// ---------------------------------------------------------------------------
// !minebot command — full info & help embed
// ---------------------------------------------------------------------------

async function handleMinebotCommand(message) {
  if (message.content.trim().toLowerCase() !== '!minebot') return false;

  const legend = [
    '⬛ 0–9%   — never / barely picked',
    '🟦 10–29% — rarely picked',
    '🟩 30–49% — occasionally picked',
    '🟨 50–59% — moderately common',
    '🟧 60–79% — frequently picked',
    '🟥 80–100% — most common tile',
  ].join('\n');

  const gridExample = [
    '`1` `2` `3`',
    '`4` `5` `6`',
    '`7` `8` `9`',
  ].join('\n');

  const embed = new EmbedBuilder()
    .setColor(COLORS.PRIMARY)
    .setTitle('⛏️ OwO Mine Tracker — Info & Commands')
    .setDescription(
      'This bot tracks every OwO mine round played in the server and builds ' +
      'a statistical heatmap to help you pick safer tiles based on real historical data.'
    )
    .addFields(
      {
        name: '🎮 How It Works',
        value:
          '1. Enable tracking with `@bot start mine`\n' +
          '2. Play `owo mine` as normal — the bot watches OwO\'s messages automatically\n' +
          '3. After each round ends, the bot posts bomb locations, your click sequence, and the coldest tiles for next round\n' +
          '4. Data builds up over time — the more rounds played, the more accurate the stats',
        inline: false,
      },
      {
        name: '📋 Commands',
        value: [
          '`@bot start mine` — start tracking rounds in this server',
          '`@bot end mine` — pause tracking (data is kept)',
          '`!heatmap <n>` — which tiles were picked as the Nth **safe click** most often',
          '`!bombheatmap <x> [y]` — bomb positions at move **x** in **y**-bomb rounds (y defaults to 3)',
          '`!minebot` — show this info panel',
        ].join('\n'),
        inline: false,
      },
      {
        name: '🗺️ Heatmap — How to Read It',
        value:
          'The heatmap renders as a **3×3 grid** matching the mine board:\n' +
          gridExample + '\n\n' +
          'Each cell is colored by how often that tile was chosen at that move number, ' +
          'relative to the most-picked tile. Colors update every **5%**:\n\n' +
          legend,
        inline: false,
      },
      {
        name: '📊 Example Usage',
        value:
          '`!heatmap 1` — tiles players click **first** most often\n' +
          '`!heatmap 2` — most common **second** click\n' +
          '`!bombheatmap 0` — tiles that were bombs when hit on the **first click** (3 bombs)\n' +
          '`!bombheatmap 2 5` — bomb positions after **2 safe clicks** in **5-bomb** rounds\n' +
          'Move 0 = bomb on first click · Move 1 = bomb after 1 safe click · etc.',
        inline: false,
      },
      {
        name: '⚙️ Mine Triggers Supported',
        value: '`owo mine`, `o mine`, `omine`, `owo m`, `o m`\nWith optional bet and bomb count: `owo mine all 3`',
        inline: false,
      },
    )
    .setFooter({ text: 'Data is persistent and survives bot restarts · Heatmap accuracy improves with more rounds' })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
  return true;
}

// ---------------------------------------------------------------------------
// Core handler: process an OwO mine message (in-progress or finished)
// ---------------------------------------------------------------------------

async function processOwoMineResult(msg) {
  if (!msg.guild) return;
  if (msg.author?.id !== OWO_BOT_ID) return;
  if (!db.isTrackingEnabled(msg.guild.id)) return;

  const parsed = parseOwoMineMessage(msg);

  // ── In-progress: track which new tile just got revealed ──────────────────
  if (parsed.state === 'inprogress') {
    const { revealedTiles, triggeredUserId, gameId } = parsed;
    if (!gameId) return;

    // Find or create the active game entry
    if (!activeGames.has(gameId)) {
      // Associate with a pending round for this user
      const channelPending = pendingRounds.get(msg.channel.id);
      const pendingEntry = channelPending?.find(
        (e) => !triggeredUserId || e.userId === triggeredUserId
      );
      if (!pendingEntry) return; // No pending round for this game yet

      activeGames.set(gameId, {
        userId: pendingEntry.userId,
        username: pendingEntry.username,
        bombCount: pendingEntry.bombCount,
        channelId: msg.channel.id,
        guildId: msg.guild.id,
        messageId: msg.id,
        revealedTiles: [], // ordered list built incrementally
      });
    }

    const game = activeGames.get(gameId);
    // Append newly revealed tiles (ones not already tracked)
    for (const tile of revealedTiles) {
      if (!game.revealedTiles.includes(tile)) {
        game.revealedTiles.push(tile);
        console.log(`[MOVE] gameId=${gameId} | new tile revealed: ${tile} (move #${game.revealedTiles.length})`);
      }
    }
    return;
  }

  // ── Finished: record the round ───────────────────────────────────────────
  if (parsed.state === 'finished') {
    const { bombTiles, triggeredUserId, gameId, isCashOut } = parsed;

    // Retrieve move order from active game tracking, or fall back to empty
    let moveTiles = [];
    if (gameId && activeGames.has(gameId)) {
      moveTiles = activeGames.get(gameId).revealedTiles;
      activeGames.delete(gameId);
    }

    console.log('[INFO] moveTiles (click order):', moveTiles);

    const pending = popPendingRound(msg.channel.id, triggeredUserId);
    if (!pending) {
      console.log('[INFO] Finished mine board detected but no pending round — skipping.');
      return;
    }

    console.log(
      `[INFO] Recording round for ${pending.username}: ` +
      `bombs=[${bombTiles}], moves=[${moveTiles}]`
    );

    const rounds = db.recordRound(
      msg.guild.id,
      pending.userId,
      pending.username,
      pending.bombCount,
      bombTiles,
      moveTiles,
    );

    const analysis = deduce(rounds, pending.bombCount);

    await msg.channel.send({
      embeds: [buildResultEmbed({
        username: pending.username,
        bombCount: pending.bombCount,
        bombTiles,
        moveTiles,
        analysis,
        isCashOut,
      })],
    });
  }
}

// ---------------------------------------------------------------------------
// messageCreate
// ---------------------------------------------------------------------------

client.on('messageCreate', async (message) => {
  try {
    // OwO result messages
    if (message.author?.id === OWO_BOT_ID) {
      await processOwoMineResult(message);
      return;
    }

    if (message.author.bot) return;
    if (!message.guild) return;

    // Session control (@bot start/end mine)
    const handledSession = await handleSessionCommand(message);
    if (handledSession) return;

    // !heatmap command (anyone can use, no tracking required)
    const handledHeatmap = await handleHeatmapCommand(message);
    if (handledHeatmap) return;

    // !minebot info command
    const handledInfo = await handleMinebotCommand(message);
    if (handledInfo) return;

    // !bombheatmap command
    const handledBombHeatmap = await handleBombHeatmapCommand(message);
    if (handledBombHeatmap) return;

    // Reply if someone replied to one of the bot's messages
    if (message.reference?.messageId) {
      try {
        const replied = await message.channel.messages.fetch(message.reference.messageId);
        if (replied.author?.id === client.user.id) {
          await message.reply('dont talk to me plwease 🥺🙏 i dont wanna talk to you');
          return;
        }
      } catch {
        // Ignore if fetch fails
      }
    }

    // Reply if someone mentioned the bot but didn't use a command (and isn't a reply)
    if (message.mentions.has(client.user.id)) {
      await message.reply('aapki tuchki tuiyan');
      return;
    }

    // Mine trigger detection
    if (!db.isTrackingEnabled(message.guild.id)) return;

    const parsed = parseMineCommand(message.content);
    if (!parsed) return;

    console.log(`[INFO] Mine trigger from ${message.author.username}, bombCount=${parsed.bombCount}`);
    addPendingRound(message.channel.id, {
      userId: message.author.id,
      username: message.member?.displayName ?? message.author.username,
      bombCount: parsed.bombCount,
      triggeredAt: Date.now(),
    });
  } catch (err) {
    console.error('[messageCreate] error:', err);
  }
});

// ---------------------------------------------------------------------------
// messageUpdate
// ---------------------------------------------------------------------------

client.on('messageUpdate', async (oldMessage, newMessage) => {
  try {
    let msg = newMessage;
    if (msg.partial) {
      try { msg = await msg.fetch(); }
      catch (err) { console.error('[messageUpdate] fetch failed:', err); return; }
    }
    await processOwoMineResult(msg);
  } catch (err) {
    console.error('[messageUpdate] error:', err);
  }
});

// ---------------------------------------------------------------------------
// Embed building
// ---------------------------------------------------------------------------

function buildResultEmbed({ username, bombCount, bombTiles, moveTiles, analysis, isCashOut = false }) {
  const { sorted, recommended, outputCount, totalRounds } = analysis;

  const heatMapLines = [...sorted]
    .sort((a, b) => b.hits - a.hits)
    .map(({ tile, hits }) => {
      const bar = '🔥'.repeat(Math.min(hits, 5)) || '❄️';
      return `${TILE_GLYPHS[tile - 1]} Tile **${tile}** — hit **${hits}** time${hits === 1 ? '' : 's'} ${bar}`;
    })
    .join('\n');

  const recommendedLines = recommended
    .map((tile, i) => `${i + 1}. ${TILE_GLYPHS[tile - 1]} **Tile ${tile}**`)
    .join('\n');

  const bombTilesFormatted = bombTiles
    .map((t) => `${TILE_GLYPHS[t - 1]} Tile ${t}`)
    .join(', ');

  const moveSequence = moveTiles.length
    ? moveTiles.map((t, i) => `**${i + 1}.** ${TILE_GLYPHS[t - 1]}`).join(' → ')
    : '_No safe clicks before the bomb_';

  return new EmbedBuilder()
    .setColor(isCashOut ? COLORS.SUCCESS : COLORS.PRIMARY)
    .setTitle(isCashOut ? '💰 Mine Round — Cashed Out' : '⛏️ Mine Round — Exploded')
    .setDescription(
      `**Player:** ${username}\n` +
      `**Bombs:** ${bombCount}  •  **Bomb tile(s):** ${bombTilesFormatted}`
    )
    .addFields(
      { name: '🖱️ Click Sequence This Round', value: moveSequence, inline: false },
      { name: `📊 Bomb Heat Map (last ${HISTORY_LIMIT} rounds)`, value: heatMapLines || 'No data yet.', inline: false },
      {
        name: `🧊 Coldest Tiles for Next Round (${outputCount} tile${outputCount === 1 ? '' : 's'})`,
        value: recommendedLines || 'Not enough data yet.',
        inline: false,
      },
    )
    .setFooter({ text: `Based on ${totalRounds} tracked round${totalRounds === 1 ? '' : 's'} · Use !heatmap <n> for move-by-move stats` })
    .setTimestamp();
}

// ---------------------------------------------------------------------------
// Shared heatmap embed builders (used by boot reports + button interactions)
// ---------------------------------------------------------------------------

/**
 * Build a tile-click heatmap embed + navigation buttons for a given move number.
 * @param {string} guildId
 * @param {number} moveNumber  1-based click number
 */
function buildTileHeatmapEmbed(guildId, moveNumber) {
  const stats = db.getGuildMoveStats(guildId, moveNumber);
  const counts = new Array(10).fill(0);
  let totalClicks = 0;
  for (const [tile, count] of Object.entries(stats)) {
    const t = Number(tile);
    if (t >= 1 && t <= 9) { counts[t] = count; totalClicks += count; }
  }
  const maxCount = Math.max(...counts.slice(1));

  const gridLines = [];
  for (let row = 0; row < 3; row++) {
    const cells = [];
    for (let col = 0; col < 3; col++) {
      const tile = row * 3 + col + 1;
      cells.push(heatEmoji(counts[tile], maxCount));
    }
    gridLines.push(cells.join(' '));
  }

  const ranked = counts.map((c, t) => ({ tile: t, count: c })).slice(1).sort((a, b) => b.count - a.count);
  const rankLines = ranked.map(({ tile, count }) => {
    const pct = totalClicks > 0 ? ((count / totalClicks) * 100).toFixed(1) : '0.0';
    return `${heatEmoji(count, maxCount)} ${TILE_GLYPHS[tile - 1]} Tile **${tile}** — **${count}** (${pct}%)`;
  }).join('\n') || '_No data yet_';

  const embed = new EmbedBuilder()
    .setColor(COLORS.INFO)
    .setTitle(`🖱️ Tile Heatmap — Move ${moveNumber}`)
    .setDescription(
      `Which tiles players chose as their **${ordinal(moveNumber)} click**\n\n` +
      `**Grid** (⬛ cold → 🟥 hot)\n\n` +
      (totalClicks > 0 ? gridLines.join('\n') : '_No data yet for this move_') +
      '\n\u200b'
    )
    .addFields({ name: `📊 Breakdown (${totalClicks} total clicks)`, value: rankLines, inline: false })
    .setFooter({ text: `Move ${moveNumber} · ⬛→🟥 = 5% steps · Use buttons to navigate` })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`tile_heatmap:${guildId}:${Math.max(1, moveNumber - 1)}:prev`)
      .setLabel('◀ Previous Move')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(moveNumber <= 1),
    new ButtonBuilder()
      .setCustomId(`tile_heatmap:${guildId}:${moveNumber + 1}:next`)
      .setLabel('Next Move ▶')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`tile_heatmap:${guildId}:1:home`)
      .setLabel('Move 1')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(moveNumber === 1),
  );

  return { embed, row };
}

/**
 * Build a bomb heatmap embed + navigation buttons.
 * @param {string} guildId
 * @param {number} moveNumber  0-based (safe clicks before bomb)
 * @param {number} bombCount   1-8
 */
function buildBombHeatmapEmbed(guildId, moveNumber, bombCount) {
  const stats = db.getGuildBombMoveStats(guildId, bombCount, moveNumber);
  const counts = new Array(10).fill(0);
  let totalBombs = 0;
  for (const [tile, count] of Object.entries(stats)) {
    const t = Number(tile);
    if (t >= 1 && t <= 9) { counts[t] = count; totalBombs += count; }
  }
  const maxCount = Math.max(...counts.slice(1));

  const gridLines = [];
  for (let row = 0; row < 3; row++) {
    const cells = [];
    for (let col = 0; col < 3; col++) {
      const tile = row * 3 + col + 1;
      cells.push(heatEmoji(counts[tile], maxCount));
    }
    gridLines.push(cells.join(' '));
  }

  const ranked = counts.map((c, t) => ({ tile: t, count: c })).slice(1).sort((a, b) => b.count - a.count);
  const rankLines = ranked.map(({ tile, count }) => {
    const pct = totalBombs > 0 ? ((count / totalBombs) * 100).toFixed(1) : '0.0';
    return `${heatEmoji(count, maxCount)} ${TILE_GLYPHS[tile - 1]} Tile **${tile}** — **${count}** bomb${count !== 1 ? 's' : ''} (${pct}%)`;
  }).join('\n') || '_No data yet_';

  const safest = [...ranked].sort((a, b) => a.count - b.count).slice(0, 3)
    .map(({ tile }) => `${TILE_GLYPHS[tile - 1]} Tile **${tile}**`).join('  ') || '_Not enough data_';

  const moveLabel = moveNumber === 0 ? 'first tile clicked' : `after ${moveNumber} safe click${moveNumber !== 1 ? 's' : ''}`;

  const embed = new EmbedBuilder()
    .setColor(COLORS.DANGER)
    .setTitle(`💣 Bomb Heatmap — Move ${moveNumber}, ${bombCount} Bombs`)
    .setDescription(
      `Bomb positions when the **${moveLabel}** was a mine in **${bombCount}-bomb** rounds.\n\n` +
      `**Grid** (⬛ safe → 🟥 dangerous)\n\n` +
      (totalBombs > 0 ? gridLines.join('\n') : '_No data yet for this scenario_') +
      '\n\u200b'
    )
    .addFields(
      { name: `📊 Breakdown (~${Math.round(totalBombs / Math.max(bombCount, 1))} matching rounds)`, value: rankLines, inline: false },
      { name: '🧊 Safest Tiles', value: safest, inline: false },
    )
    .setFooter({ text: `Move ${moveNumber} · ${bombCount} bombs · ⬛→🟥 = 5% steps · Use buttons to navigate` })
    .setTimestamp();

  const prevMove = Math.max(0, moveNumber - 1);
  const nextMove = moveNumber + 1;
  const prevBombs = Math.max(1, bombCount - 1);
  const nextBombs = Math.min(8, bombCount + 1);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bomb_heatmap:${guildId}:${prevMove}:${bombCount}:prev`)
      .setLabel('◀ Prev Move')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(moveNumber <= 0),
    new ButtonBuilder()
      .setCustomId(`bomb_heatmap:${guildId}:${nextMove}:${bombCount}:next`)
      .setLabel('Next Move ▶')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`bomb_heatmap:${guildId}:0:${bombCount}:home`)
      .setLabel('Move 0')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(moveNumber === 0),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bomb_heatmap:${guildId}:${moveNumber}:${prevBombs}:bprev`)
      .setLabel(`◀ ${prevBombs} Bombs`)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(bombCount <= 1),
    new ButtonBuilder()
      .setCustomId(`bomb_heatmap:${guildId}:${moveNumber}:${nextBombs}:bnext`)
      .setLabel(`${nextBombs} Bombs ▶`)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(bombCount >= 8),
  );

  return { embed, rows: [row1, row2] };
}

// ---------------------------------------------------------------------------
// Button interaction handler
// ---------------------------------------------------------------------------

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const [type, guildId, ...rest] = interaction.customId.split(':');

  try {
    if (type === 'tile_heatmap') {
      const moveNumber = Math.max(1, parseInt(rest[0], 10) || 1);
      const { embed, row } = buildTileHeatmapEmbed(guildId, moveNumber);      await interaction.update({ embeds: [embed], components: [row] });

    } else if (type === 'bomb_heatmap') {
      const moveNumber = Math.max(0, parseInt(rest[0], 10));
      const bombCount = Math.min(8, Math.max(1, parseInt(rest[1], 10) || 3));
      const { embed, rows } = buildBombHeatmapEmbed(guildId, moveNumber, bombCount);
      await interaction.update({ embeds: [embed], components: rows });
    }
  } catch (err) {
    console.error('[interactionCreate] error:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong updating the heatmap.', ephemeral: true });
    }
  }
});

// ---------------------------------------------------------------------------
// Boot-up report
// ---------------------------------------------------------------------------

async function sendBootReports(type = 'start') {
  const channelId = process.env.REPORT_CHANNEL_ID;
  if (!channelId) return;

  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    console.warn('[Boot Report] Could not fetch REPORT_CHANNEL_ID:', err.message);
    return;
  }
  if (!channel?.isTextBased()) return;

  const totalGames = db.getTotalGamesAllGuilds();
  const guildCount = client.guilds.cache.size;
  const isStart = type === 'start';

  // ── Summary embed ────────────────────────────────────────────────────────
  const summaryEmbed = new EmbedBuilder()
    .setColor(isStart ? COLORS.SUCCESS : COLORS.DANGER)
    .setTitle(isStart ? '🟢 Bot Online — Session Report' : '🔴 Bot Offline — Shutdown Report')
    .setDescription(isStart
      ? `**${client.user.tag}** is now online and tracking mine rounds.`
      : `**${client.user.tag}** is shutting down. Here's a final summary.`
    )
    .addFields(
      { name: '🌐 Guilds', value: String(guildCount), inline: true },
      { name: '🎮 Total Games Tracked', value: String(totalGames), inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: '📋 Commands', value: '`!heatmap <n>` · `!bombheatmap <x> [y]` · `!minebot`', inline: false },
    )
    .setTimestamp();

  await channel.send({ embeds: [summaryEmbed] });

  // ── Tile heatmap (move 1) with buttons ───────────────────────────────────
  // Use first guild that has data, or fallback to first guild
  const targetGuild = [...client.guilds.cache.values()].find(g => {
    const s = db.getGuildMoveStats(g.id, 1);
    return Object.keys(s).length > 0;
  }) ?? client.guilds.cache.first();

  if (targetGuild) {
    const { embed: tileEmbed, row: tileRow } = buildTileHeatmapEmbed(targetGuild.id, 1);
    await channel.send({ embeds: [tileEmbed], components: [tileRow] });

    const { embed: bombEmbed, rows: bombRows } = buildBombHeatmapEmbed(targetGuild.id, 0, 3);
    await channel.send({ embeds: [bombEmbed], components: bombRows });
  }

  console.log(`[Boot Report] ${type} reports sent to channel`, channelId);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

client.once('ready', async () => {
  console.log(`[Ready] Logged in as ${client.user.tag}`);
  console.log('[Ready] Watching for OwO mine rounds. Use "@bot start mine" in a server to begin tracking.');
  await sendBootReports('start');
});

client.on('error', (err) => console.error('[Client Error]', err));
process.on('unhandledRejection', (err) => console.error('[Unhandled Rejection]', err));

async function gracefulShutdown() {
  console.log('[Shutdown] Sending shutdown report...');
  try {
    await sendBootReports('stop');
  } catch (err) {
    console.error('[Shutdown] Failed to send shutdown report:', err.message);
  }
  db._flush(true);
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('Missing DISCORD_BOT_TOKEN environment variable. Set it before starting the bot.');
  process.exit(1);
}

client.login(token);
