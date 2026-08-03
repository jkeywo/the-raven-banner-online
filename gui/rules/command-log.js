/**
 * gui/rules/command-log.js — an append-only record of everything that happened.
 *
 * Together with the seed, the log *is* the game: `replay(seed, log)` rebuilds
 * the state from nothing. That buys three things at once — a save file that is
 * a few kilobytes rather than a whole board, a way to reconstruct a disputed
 * clash roll by roll, and a test that exercises every reducer path at once by
 * asserting a replay equals the state it was recorded from.
 *
 * A five-turn game is a few thousand entries, so nothing here is trimmed.
 */

/**
 * @typedef {object} LogEntry
 * @property {number} seq        the host's own counter, not the client's
 * @property {number} ts
 * @property {string} seatId
 * @property {string|null} roleId
 * @property {string} verb
 * @property {object} payload
 * @property {number} rngCursorBefore   where the dice were when this ran
 * @property {boolean} override         a facilitator setting something directly
 */

/**
 * Record an accepted command. Returns a new array — the log is treated as
 * immutable like the rest of state, so a projection can hold one safely.
 *
 * @param {LogEntry[]} log
 * @param {Omit<LogEntry, 'seq'>} entry
 * @returns {LogEntry[]}
 */
export function append(log, entry) {
  return [...log, { seq: log.length + 1, ...entry }];
}

/** The entries that touched a given role, for a facilitator answering a query. */
export function entriesFor(log, roleId) {
  return log.filter((e) => e.roleId === roleId || e.payload?.roleId === roleId);
}

/** Every override, which is the honest answer to "what did the umpire change?". */
export function overrides(log) {
  return log.filter((e) => e.override);
}

/**
 * What a save file holds. Deliberately not the state: a seed and a log replay
 * to the state, and cannot disagree with it.
 */
export function toSave(state) {
  return {
    schemaVersion: state.schemaVersion,
    joinCode: state.joinCode,
    seed: state.seed,
    log: state.log,
    savedAt: null,      // stamped by the host, which owns the clock
  };
}
