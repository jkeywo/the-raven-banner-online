/**
 * gui/rules/admission.js — the one gate the rules are enforced at.
 *
 * The host calls this before touching state. Clients call the same function
 * against their own projection to grey out controls they cannot use — but a
 * client's answer is presentation only. Only the host's decides anything, so a
 * modified client gains nothing but a misleading screen.
 *
 * A command whose legality depends on something the client cannot see is
 * marked `hostOnly`; a console renders those as available-but-unverified
 * rather than guessing and being confidently wrong.
 */

import { COMMANDS, subjectOf } from './commands.js';

/** @typedef {{seatId: string, kind: 'player'|'facilitator', roleId: string|null}} Actor */

/**
 * @param {object} state
 * @param {object} data
 * @param {{verb: string, payload?: object}} cmd
 * @param {Actor} actor
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function admit(state, data, cmd, actor) {
  const spec = COMMANDS[cmd.verb];
  if (!spec) return { ok: false, reason: `unknown command '${cmd.verb}'` };

  if (spec.actor === 'facilitator' && actor.kind !== 'facilitator') {
    return { ok: false, reason: 'only a facilitator may do that' };
  }
  if (spec.phases !== '*' && !spec.phases.includes(state.phase.name)) {
    return {
      ok: false,
      reason: `that belongs to the ${spec.phases.join(' or ')} phase, `
        + `and this is the ${state.phase.name} phase`,
    };
  }

  const ctx = { state, data, cmd, actor };
  const subject = subjectOf(ctx);
  if (spec.actor === 'player' && !spec.roleless) {
    if (!subject) return { ok: false, reason: 'claim a role first' };
    if (!state.roles[subject]) return { ok: false, reason: 'no such role in this game' };
    if (state.roles[subject].dead) return { ok: false, reason: 'that character is dead' };
  }

  return spec.admit(ctx);
}

/**
 * Every command this actor could issue right now, each with the reason it is
 * refused where it is. What a console renders its action list from.
 *
 * @returns {{verb: string, ok: boolean, reason?: string, hostOnly: boolean}[]}
 */
export function availableTo(state, data, actor) {
  return Object.entries(COMMANDS)
    .filter(([, spec]) => spec.actor === actor.kind || actor.kind === 'facilitator')
    .filter(([, spec]) => spec.phases === '*' || spec.phases.includes(state.phase.name))
    .map(([verb, spec]) => {
      const verdict = admit(state, data, { verb, payload: {} }, actor);
      return {
        verb,
        ok: verdict.ok,
        ...(verdict.ok ? {} : { reason: verdict.reason }),
        hostOnly: Boolean(spec.hostOnly),
      };
    });
}
