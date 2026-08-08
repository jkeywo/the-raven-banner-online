/**
 * gui/rules/rng.js — the only source of randomness in the game.
 *
 * A seed and a cursor, both stored in state. Every roll advances the cursor, so
 * the whole game is a pure function of its seed and its command log: a save can
 * be replayed exactly, a disputed clash can be reconstructed, and a host that
 * crashes mid-battle comes back to the same dice it had before.
 *
 * That is also the answer to "the app cheated". Every roll is written to the
 * log with the cursor it consumed, so anyone can re-derive it.
 */

/**
 * mulberry32: a small, fast, well-distributed 32-bit PRNG.
 *
 * Chosen over `Math.random` because that has no seed, and over anything larger
 * because a megagame needs a few hundred dice rolls across three hours — the
 * bar is "fair and reproducible", not cryptographic.
 *
 * @param {number} seed
 * @returns {() => number} successive floats in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The nth value of the stream for a seed, without keeping a generator alive.
 *
 * Deliberately stateless: the host reduces commands as pure functions over
 * state, so a live generator object would be one more thing to serialise,
 * restore and keep in step with a replay. Re-deriving from (seed, cursor) is
 * O(cursor) and cursor stays in the low thousands over a whole game.
 *
 * @param {number} seed
 * @param {number} cursor  0-indexed position in the stream
 */
export function valueAt(seed, cursor) {
  const next = mulberry32(seed);
  let value = 0;
  for (let i = 0; i <= cursor; i++) value = next();
  return value;
}

/**
 * Roll a die without mutating anything.
 *
 * @param {number} seed
 * @param {number} cursor
 * @param {number} [sides]
 * @returns {{value: number, cursor: number}} the face, and the cursor to store
 */
export function roll(seed, cursor, sides = 6) {
  return {
    value: 1 + Math.floor(valueAt(seed, cursor) * sides),
    cursor: cursor + 1,
  };
}

/**
 * A seed for a new game. Callers pass their own randomness so this module
 * stays pure and testable — the host uses `Math.random`, tests use a constant.
 *
 * @param {() => number} random
 */
export function mintSeed(random) {
  return Math.floor(random() * 0xffffffff) >>> 0;
}
