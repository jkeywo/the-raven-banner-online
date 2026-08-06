/**
 * gui/rules/replay-cursor.js — the game as it stood at any point in its own
 * history, fast enough to drag a slider through.
 *
 * `replay()` next door rebuilds a game from its seed and its whole log, which
 * is the right shape for a host coming back from a crash — it happens once.
 * A replay screen asks a different question several times a second: what did
 * the board look like *after the four hundredth action*, and then the four
 * hundred and first, and then back to the ninetieth because somebody dragged
 * the bar. Answering each of those from the seed is a five-turn sixteen-player
 * log replayed from scratch per frame.
 *
 * So this keeps snapshots. Every N entries the state is put aside, and any
 * position is reached by taking the nearest snapshot at or before it and
 * walking forward the remainder — never more than N entries of work, whichever
 * way the cursor moves. Forward by one is simply one entry applied.
 *
 * The snapshots are the *only* thing this adds. Every state it hands out came
 * out of `step()` in the reducer, the same function `replay()` folds over, so
 * a scrubbed board and a rebuilt one cannot disagree about the game they are
 * both describing. That is worth more here than the speed is: a replay that
 * showed a subtly different game from the one that was played would be worse
 * than no replay at all.
 *
 * Pure, like everything else under `gui/rules/`: a save and a position in,
 * a state out, no DOM anywhere near it.
 */

import { openingPosition, step as applyEntry } from './reducer.js';

/**
 * How many entries between snapshots.
 *
 * The trade is memory against the longest walk. A whole game state is a few
 * hundred kilobytes structured-cloned, and twenty-five entries of reduction is
 * imperceptible, so a couple of thousand entries costs a manageable handful of
 * snapshots and never more than twenty-five steps of catching up.
 */
export const CHECKPOINT_EVERY = 25;

export class ReplayCursor {
  /**
   * @param {{joinCode: string, seed: number, log: object[], roleIds?: string[]}} save
   * @param {object} data
   * @param {object} [options]
   * @param {number} [options.every]  entries between snapshots
   * @param {string[]} [options.roleIds]  only used when the save carries none
   */
  constructor(save, data, { every = CHECKPOINT_EVERY, roleIds } = {}) {
    this._save = save;
    this._data = data;
    this._log = save.log ?? [];
    this._every = Math.max(1, Math.trunc(every));
    // Index k holds the state after k * every entries. Written as the cursor
    // crosses each boundary going forward, so it is always dense from zero up
    // to the furthest point ever visited — which is what lets a rewind trust
    // that the snapshot it wants is there.
    this._checkpoints = [openingPosition(save, data, { roleIds })];
    this._refusals = new Map();
    this._position = 0;
    this._state = this._checkpoints[0];
  }

  /** How many entries the log holds. The cursor runs from 0 to this. */
  get length() { return this._log.length; }

  /** How many entries have been applied. Zero is the opening position. */
  get position() { return this._position; }

  /** The game after `position` entries. */
  get state() { return this._state; }

  /** The history itself, for a console that wants to list it. */
  get log() { return this._log; }

  /**
   * Entries the rules would no longer accept, in the order they appear.
   *
   * Only those the cursor has actually walked past — a log that has never been
   * scrubbed to the end has not been fully checked. `warm()` is the way to
   * know all of them.
   *
   * @returns {{index: number, seq: number, verb: string, reason: string}[]}
   */
  get refusals() {
    return [...this._refusals.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, refusal]) => ({ index, ...refusal }));
  }

  /** Whether the entry at a log index was refused, if it has been reached. */
  refusalAt(index) { return this._refusals.get(index) ?? null; }

  /**
   * Move to an absolute position, clamped to the log.
   *
   * Forward is a walk from where we are. Backward rewinds to the nearest
   * snapshot at or before the target first, because states are values here and
   * there is no undo — the only way back is forward from something earlier.
   *
   * @returns {object} the state at that position
   */
  seek(position) {
    const target = clamp(Math.trunc(position), 0, this.length);

    if (target < this._position) {
      const index = Math.min(Math.floor(target / this._every), this._checkpoints.length - 1);
      this._position = index * this._every;
      this._state = this._checkpoints[index];
    }

    while (this._position < target) {
      const entry = this._log[this._position];
      const result = applyEntry(this._state, this._data, entry);
      this._state = result.state;
      if (!result.ok) {
        this._refusals.set(this._position,
          { seq: entry.seq, verb: entry.verb, reason: result.reason });
      }
      this._position += 1;
      if (this._position % this._every === 0) {
        this._checkpoints[this._position / this._every] = this._state;
      }
    }

    return this._state;
  }

  /** Relative movement — one action, or ten, in either direction. */
  step(by = 1) { return this.seek(this._position + by); }

  toStart() { return this.seek(0); }

  toEnd() { return this.seek(this.length); }

  /**
   * Walk the whole log once and come back to where we were.
   *
   * A bar somebody drags has to answer wherever it lands, and the snapshots
   * only exist for the stretch already visited — so an unwarmed cursor is
   * quick everywhere except the first visit to each place, which is precisely
   * when it is being dragged. One pass at open costs what restoring a save
   * already costs and buys every later move.
   *
   * It also settles the refusals for the whole history, so a log the rules
   * have moved under can be said out loud on arrival rather than discovered
   * halfway along.
   */
  warm() {
    const where = this._position;
    this.seek(this.length);
    this.seek(where);
    return this;
  }
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
