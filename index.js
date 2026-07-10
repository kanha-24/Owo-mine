'use strict';

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ComponentType,
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

// In-memory map of "pending mine rounds" so we know which bombCount belongs
// to which in-flight OwO message. Keyed by `${channelId}` since OwO's mine
// embed is a single message per invocation and the *next* OwO message in
// that channel after a trigger is (in practice) the corresponding game.
// We key more precisely by expecting the OwO message to arrive very shortly
// after the trigger and matching on channel + the triggering user.
//
// Structure: Map<channelId, Array<{ userId, username, bombCount, triggeredAt }>>
const pendingRounds = new Map();

const PENDING_TTL_MS = 15_000; // discard stale pending triggers after 15s

function addPendingRound(channelId, entry) {
  const list = pendingRounds.get(channelId) ?? [];
  list.push(entry);
  pendingRounds.set(channelId, list);
}

function popPendingRoundForChannel(channelId) {
  const list = pendingRounds.get(channelId);
  if (!list || list.length === 0) return null;

  const now = Date.now();
  // Drop anything stale
  const fresh = list.filter((e) => now - e.triggeredAt <= PENDING_TTL_MS);

  if (fresh.length === 0) {
    pendingRounds.delete(channelId);
    return null;
  }

  // FIFO: the oldest still-fresh trigger corresponds to the game that
  // resolves next in that channel.
  const entry = fresh.shift();
  if (fresh.length > 0) {
    pendingRounds.set(channelId, fresh);
  } else {
    pendingRounds.delete(channelId);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Trigger parsing
// ---------------------------------------------------------------------------

/**
 * Sort triggers longest-first so "owo mine" is checked before "owo m" and
 * "o mine" before "o m" — avoids the shorter prefix eating part of the
 * longer command's argument text.
 */
const SORTED_TRIGGERS = [...MINE_TRIGGERS].sort((a, b) => b.length - a.length);

/**
 * Attempt to parse a user's message as an OwO mine command.
 * Handles forms like:
 *   omine 10000 1
 *   owo mine all 3
 *   o m 500
 *   owo mine 1k
 * @param {string} content raw message content
 * @returns {{ bombCount: number } | null}
 */
function parseMineCommand(content) {
  const normalized = content.trim().toLowerCase();

  for (const trigger of SORTED_TRIGGERS) {
    if (normalized === trigger || normalized.startsWith(`${trigger} `)) {
      const rest = normalized.slice(trigger.length).trim();
      const args = rest.length ? rest.split(/\s+/) : [];

      // args[0] would be the bet amount (number, "all", "half", "1k", etc.)
      // args[1] would be the bomb count, if provided.
      let bombCount = DEFAULT_BOMB_COUNT;

      if (args.length >= 2) {
        const parsed = parseInt(args[1], 10);
        if (Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_BOMB_COUNT) {
          bombCount = parsed;
        }
      }
      // If args.length < 2, no bomb count was given -> DEFAULT_BOMB_COUNT stands.

      return { bombCount };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Session management commands: "@bot start mine" / "@bot end mine"
// ---------------------------------------------------------------------------

async function handleSessionCommand(message) {
  if (!message.mentions.has(client.user.id)) return false;

  const stripped = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim()
    .toLowerCase();

  if (/^start\s+mine$/.test(stripped)) {
    db.setTrackingEnabled(message.guild.id, true);
    const embed = new EmbedBuilder()
      .setColor(COLORS.SUCCESS)
      .setTitle('🟢 Mine Deduction Session Started')
      .setDescription(
        'I\'m now tracking `mine` rounds in this server.\n\n' +
        'Play with any of these triggers and I\'ll log the results:\n' +
        '`owo mine`, `o mine`, `omine`, `owo m`, `o m`'
      )
      .setFooter({ text: 'Say "@bot end mine" to stop tracking.' })
      .setTimestamp();
    await message.reply({ embeds: [embed] });
    return true;
  }

  if (/^end\s+mine$/.test(stripped)) {
    db.setTrackingEnabled(message.guild.id, false);
    const embed = new EmbedBuilder()
      .setColor(COLORS.DANGER)
      .setTitle('🔴 Mine Deduction Session Ended')
      .setDescription('Tracking is now paused. Historical data is kept — say `@bot start mine` to resume.')
      .setTimestamp();
    await message.reply({ embeds: [embed] });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// messageCreate: catch user trigger commands
// ---------------------------------------------------------------------------

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;

    // Session control commands take priority.
    const handledSession = await handleSessionCommand(message);
    if (handledSession) return;

    if (!db.isTrackingEnabled(message.guild.id)) return;

    const parsed = parseMineCommand(message.content);
    if (!parsed) return;

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
// Button / emoji parsing from OwO's mine embed message components
// ---------------------------------------------------------------------------

/**
 * Extract the 9 grid buttons' emoji labels from an OwO message.
 * OwO renders the mine grid as up to 3 ActionRows of up to 3 buttons each.
 * @param {import('discord.js').Message} msg
 * @returns {string[]} flattened list of emoji strings (in row-major order)
 */
function extractGridEmojis(msg) {
  const emojis = [];

  if (!msg.components || msg.components.length === 0) return emojis;

  for (const row of msg.components) {
    // row.components is the array of buttons for that ActionRow
    const buttons = row.components ?? [];
    for (const button of buttons) {
      // discord.js v14 message.components gives raw APIButtonComponent-like
      // objects when read from a cached/partial message. The emoji can show
      // up as `button.emoji` ({name, id, animated}) depending on cache path.
      let emojiStr = null;

      if (button.emoji) {
        emojiStr = button.emoji.name ?? null;
      } else if (button.label) {
        emojiStr = button.label;
      }

      emojis.push(emojiStr ?? '');
    }
  }

  return emojis;
}

/**
 * Determine whether an OwO message represents a *finished* mine round,
 * and if so, extract bomb tile positions (1-indexed, row-major 1-9).
 * @param {import('discord.js').Message} msg
 * @returns {{ finished: boolean, bombTiles: number[] }}
 */
function analyzeMineGrid(msg) {
  const emojis = extractGridEmojis(msg);

  if (emojis.length === 0) {
    return { finished: false, bombTiles: [] };
  }

  const hasExploded = emojis.includes(EMOJI.EXPLODED_BOMB);
  const hasRevealedBomb = emojis.includes(EMOJI.REVEALED_BOMB);

  if (!hasExploded && !hasRevealedBomb) {
    return { finished: false, bombTiles: [] };
  }

  const bombTiles = [];
  emojis.forEach((emoji, idx) => {
    if (emoji === EMOJI.EXPLODED_BOMB || emoji === EMOJI.REVEALED_BOMB) {
      bombTiles.push(idx + 1); // convert 0-indexed to 1-9
    }
  });

  return { finished: true, bombTiles };
}

/**
 * Try to figure out which embed on the OwO message is the mine game embed
 * and whether it belongs to a specific user (OwO embeds usually mention/
 * reference the player in the author field, title, or description).
 * @param {import('discord.js').Message} msg
 * @returns {string | null} best-guess username/mention text found, or null
 */
function extractPlayerHint(msg) {
  const embed = msg.embeds?.[0];
  if (!embed) return null;

  const haystacks = [
    embed.author?.name,
    embed.title,
    embed.description,
  ].filter(Boolean);

  return haystacks.join(' | ') || null;
}

// ---------------------------------------------------------------------------
// messageUpdate: this is where OwO reveals the finished board
// ---------------------------------------------------------------------------

client.on('messageUpdate', async (oldMessage, newMessage) => {
  try {
    // Fetch partials fully if needed.
    if (newMessage.partial) {
      try {
        newMessage = await newMessage.fetch();
      } catch (err) {
        console.error('[messageUpdate] failed to fetch partial message:', err);
        return;
      }
    }

    if (!newMessage.guild) return;
    if (newMessage.author?.id !== OWO_BOT_ID) return;
    if (!db.isTrackingEnabled(newMessage.guild.id)) return;

    const { finished, bombTiles } = analyzeMineGrid(newMessage);
    if (!finished || bombTiles.length === 0) return;

    const pending = popPendingRoundForChannel(newMessage.channel.id);
    if (!pending) {
      // We saw a finished OwO mine board but have no record of who
      // triggered it (e.g. tracking was just turned on mid-game, or the
      // TTL expired). Nothing safe to attribute it to — skip silently.
      return;
    }

    const rounds = db.recordRound(
      newMessage.guild.id,
      pending.userId,
      pending.username,
      pending.bombCount,
      bombTiles
    );

    const analysis = deduce(rounds, pending.bombCount);

    const embed = buildResultEmbed({
      username: pending.username,
      bombCount: pending.bombCount,
      bombTiles,
      analysis,
    });

    await newMessage.channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[messageUpdate] error:', err);
  }
});

// ---------------------------------------------------------------------------
// Embed building
// ---------------------------------------------------------------------------

const TILE_GLYPHS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

function buildResultEmbed({ username, bombCount, bombTiles, analysis }) {
  const { sorted, recommended, outputCount, totalRounds } = analysis;

  // Heat map lines, hottest first for readability (most-hit tile listed first)
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

  const embed = new EmbedBuilder()
    .setColor(COLORS.PRIMARY)
    .setTitle('⛏️ Mine Round Recorded')
    .setDescription(
      `**Player:** ${username}\n` +
      `**Bombs this round:** ${bombCount}\n` +
      `**Bomb location(s):** ${bombTilesFormatted}`
    )
    .addFields(
      { name: `📊 Heat Map (all-time, last ${HISTORY_LIMIT} rounds)`, value: heatMapLines || 'No data yet.', inline: false },
      {
        name: `🧊 Next Safe Tile Deduction (${outputCount} tile${outputCount === 1 ? '' : 's'})`,
        value: recommendedLines || 'Not enough data yet.',
        inline: false,
      }
    )
    .setFooter({ text: `Based on ${totalRounds} tracked round${totalRounds === 1 ? '' : 's'} · Historical frequency, not a prediction` })
    .setTimestamp();

  return embed;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

client.once('ready', () => {
  console.log(`[Ready] Logged in as ${client.user.tag}`);
  console.log('[Ready] Watching for OwO mine rounds. Use "@bot start mine" in a server to begin tracking.');
});

client.on('error', (err) => console.error('[Client Error]', err));
process.on('unhandledRejection', (err) => console.error('[Unhandled Rejection]', err));

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('Missing DISCORD_BOT_TOKEN environment variable. Set it before starting the bot.');
  process.exit(1);
}

client.login(token);
