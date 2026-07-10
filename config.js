'use strict';

module.exports = {
  // Official OwO bot ID — the tracker only ever reads messages authored by this ID.
  OWO_BOT_ID: '408785106942164992',

  // Trigger prefixes a user can type to start a mine round.
  // Matched case-insensitively, at the start of the message content.
  MINE_TRIGGERS: ['owo mine', 'o mine', 'omine', 'owo m', 'o m'],

  // Emojis OwO uses on the 3x3 button grid when a round resolves.
  EMOJI: {
    EXPLODED_BOMB: '💥', // the bomb the user actually clicked
    REVEALED_BOMB: '💣', // an unclicked bomb, revealed on cash-out
    SAFE: '💎',          // a safe diamond tile (clicked or not)
  },

  // How many past rounds to retain per user for the heat map.
  HISTORY_LIMIT: 50,

  // bombCount -> number of "coldest" safe tiles to recommend.
  SAFE_TILE_OUTPUT: {
    1: 3, 2: 3, 3: 3, 4: 3, 5: 3, 6: 3,
    7: 2,
    8: 1,
  },

  DEFAULT_BOMB_COUNT: 3,
  MAX_BOMB_COUNT: 8,

  DATA_FILE: require('path').join(__dirname, 'data', 'history.json'),

  // Embed colors
  COLORS: {
    PRIMARY: 0x8b5cf6,
    SUCCESS: 0x22c55e,
    DANGER: 0xef4444,
    INFO: 0x38bdf8,
  },
};
