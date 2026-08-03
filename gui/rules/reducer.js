/**
 * gui/rules/reducer.js — the only thing that changes the game.
 *
 * `apply` is pure: state in, new state out, nothing mutated in place. That is
 * what makes `replay` possible, and `replay` is what makes a crashed host
 * recoverable and a disputed clash reconstructible.
 *
 * Effects are written as mutations of a draft — a clone made here — because
 * spelling out immutable updates of a nested board is where bugs live. The
 * clone is the boundary; callers never see a half-applied state.
 */

import { admit } from './admission.js';
import { COMMANDS, subjectOf } from './commands.js';
import { append } from './command-log.js';
import { createInitialState } from './state.js';
import { roll } from './rng.js';

/**
 * Apply one command.
 *
 * On refusal the state is returned unchanged and untouched, so a rejected
 * command leaves no trace beyond the reason handed back to whoever tried it.
 *
 * @param {object} state
 * @param {object} data
 * @param {{verb: string, payload?: object}} cmd
 * @param {{seatId: string, kind: string, roleId: string|null}} actor
 * @param {{ts?: number}} [meta]
 * @returns {{ok: boolean, reason?: string, state: object}}
 */
export function apply(state, data, cmd, actor, meta = {}) {
  const verdict = admit(state, data, cmd, actor);
  if (!verdict.ok) return { ok: false, reason: verdict.reason, state };

  const spec = COMMANDS[cmd.verb];
  const draft = structuredClone(state);
  const ctx = { state, data, cmd, actor };

  // Dice are drawn through here so every roll advances the cursor stored in
  // state. An effect that reached for its own randomness would make the game
  // unreplayable, which is the one thing this file exists to prevent.
  const rollDie = (sides = 6) => {
    const result = roll(draft.seed, draft.rngCursor, sides);
    draft.rngCursor = result.cursor;
    return result.value;
  };

  const rngCursorBefore = draft.rngCursor;
  spec.effects(draft, ctx, { data, roll: rollDie });

  draft.log = append(draft.log, {
    ts: meta.ts ?? 0,
    seatId: actor.seatId,
    roleId: subjectOf(ctx),
    verb: cmd.verb,
    payload: cmd.payload ?? {},
    rngCursorBefore,
    override: actor.kind === 'facilitator',
  });

  return { ok: true, state: draft };
}

/**
 * Rebuild a game from its seed and its log.
 *
 * Every entry is re-admitted rather than trusted, so a tampered log fails
 * loudly instead of producing a state the rules could never have reached.
 *
 * @returns {{state: object, refused: {seq: number, verb: string, reason: string}[]}}
 */
export function replay({ joinCode, seed, log }, data, { roleIds } = {}) {
  let state = createInitialState({ joinCode, seed, data, roleIds });
  const refused = [];

  for (const entry of log) {
    const actor = {
      seatId: entry.seatId,
      kind: entry.override ? 'facilitator' : 'player',
      roleId: entry.roleId,
    };
    // A seat must exist for its commands to be admissible; the log records
    // what a seat did, not that it existed, so recreate it on first sight.
    if (!state.seats[entry.seatId]) {
      state = {
        ...state,
        seats: {
          ...state.seats,
          [entry.seatId]: {
            id: entry.seatId, token: null, name: null,
            roleId: actor.kind === 'facilitator' ? null : entry.roleId,
            kind: actor.kind, connected: false, lastSeen: entry.ts,
          },
        },
      };
    }

    const result = apply(state, data, { verb: entry.verb, payload: entry.payload }, actor,
      { ts: entry.ts });
    if (result.ok) state = result.state;
    else refused.push({ seq: entry.seq, verb: entry.verb, reason: result.reason });
  }

  return { state, refused };
}
