'use strict';

const { SAFE_TILE_OUTPUT } = require('./config');

/**
 * Build a frequency map of how often each tile (1-9) has held a bomb
 * across a user's stored round history.
 * @param {Array<{bombCount:number, bombTiles:number[]}>} rounds
 * @returns {number[]} index 0 unused; index[1..9] = hit count
 */
function buildFrequencyMap(rounds) {
  const freq = new Array(10).fill(0); // 1-9 used, 0 ignored
  for (const round of rounds) {
    for (const tile of round.bombTiles) {
      if (tile >= 1 && tile <= 9) freq[tile] += 1;
    }
  }
  return freq;
}

/**
 * Sort tiles 1-9 from coldest (fewest bomb hits) to hottest (most hits).
 * Ties are broken randomly so repeated calls don't always favor the same
 * tile among equally-cold candidates.
 * @param {number[]} freq frequency map from buildFrequencyMap
 * @returns {Array<{tile:number, hits:number}>}
 */
function sortColdToHot(freq) {
  const tiles = [];
  for (let t = 1; t <= 9; t++) {
    tiles.push({ tile: t, hits: freq[t] });
  }

  // Shuffle first so equal-frequency groups are in random order,
  // then do a stable sort by hits ascending. This gives a random
  // tie-break "for free" without a custom comparator side channel.
  for (let i = tiles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }

  tiles.sort((a, b) => a.hits - b.hits);
  return tiles;
}

/**
 * Given a user's round history and the bomb count of the round they just
 * played, produce the recommended "coldest" safe tiles for their next round.
 *
 * @param {Array} rounds user's stored rounds (already includes the round that just ended)
 * @param {number} bombCount bomb count of the round that just ended (1-8)
 * @returns {{ sorted: Array<{tile:number, hits:number}>, recommended: number[], outputCount: number, totalRounds: number }}
 */
function deduce(rounds, bombCount) {
  const freq = buildFrequencyMap(rounds);
  const sorted = sortColdToHot(freq);
  const outputCount = SAFE_TILE_OUTPUT[bombCount] ?? 3;
  const recommended = sorted.slice(0, outputCount).map((t) => t.tile);

  return {
    sorted,
    recommended,
    outputCount,
    totalRounds: rounds.length,
  };
}

module.exports = { buildFrequencyMap, sortColdToHot, deduce };
