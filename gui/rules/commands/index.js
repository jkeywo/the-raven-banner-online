/**
 * gui/rules/commands/index.js — one registry, assembled from the parts of the
 * game it is about.
 *
 * Every way the game can change is still a single `COMMANDS` object, because
 * everything downstream — admission, the reducer, the log, the action list —
 * wants to ask one question of one table. What changed is where a spec is
 * written: beside the other verbs about the same subject, and beside the
 * helpers only those verbs use. Nothing here knows a rule; it knows which
 * fragments exist and in what order they are read.
 *
 * The order matters, mildly and visibly. `availableTo` walks this object, so
 * it is the order a player's action list appears in. It runs roughly as a turn
 * does — taking a chair, the feudal web, your own lands, the things needing
 * somebody's agreement, the contracts, the church, the foreign courts, the
 * battle, and the umpire last — which is as close as a domain split can come
 * to the phase-by-phase order the one big file happened to have.
 *
 * The accessors below stay here rather than in a fragment because each of them
 * reads the whole registry. A fragment that imported them would be importing
 * the merged object it is itself part of, which is the one import cycle this
 * layout is arranged to avoid.
 */

import { LOBBY_COMMANDS } from './lobby.js';
import { FEUDAL_COMMANDS } from './feudal.js';
import { HOLDINGS_COMMANDS } from './holdings.js';
import { CONSENT_COMMANDS } from './consent.js';
import { CONTRACT_COMMANDS } from './contracts.js';
import { CHURCH_COMMANDS } from './church.js';
import { ENVOY_COMMANDS } from './envoy.js';
import { BATTLE_COMMANDS } from './battle.js';
import { FACILITATOR_COMMANDS } from './facilitator.js';

export const COMMANDS = {
  ...LOBBY_COMMANDS,
  ...FEUDAL_COMMANDS,
  ...HOLDINGS_COMMANDS,
  ...CONSENT_COMMANDS,
  ...CONTRACT_COMMANDS,
  ...CHURCH_COMMANDS,
  ...ENVOY_COMMANDS,
  ...BATTLE_COMMANDS,
  ...FACILITATOR_COMMANDS,
};

/**
 * The rules helpers other modules reach for by name.
 *
 * Re-exported here so that `gui/rules/commands.js` remains the one address for
 * all of it. Where a helper lives is now a fact about this directory rather
 * than about anybody's import statement.
 */
export { subjectOf } from './shared.js';
export { REBELLION_PRINTED_COST, openRebellion, resolveVote } from './feudal.js';
export { shipPrice } from './holdings.js';
export { neighbourStewards, resolveConsent } from './consent.js';
export { contractOn, activateContract, cancelContract } from './contracts.js';
export { phaseEndsAt, remainingMs } from './facilitator.js';

/** @typedef {import('./shared.js').Field} Field */

/**
 * What a verb is called, for the button that issues it.
 *
 * A verb nobody has named prints its own id, which is ugly enough that
 * somebody notices — better than a blank button nobody can identify.
 */
export function labelFor(verb) {
  return COMMANDS[verb]?.label ?? verb;
}

/**
 * The line under the button, or nothing.
 *
 * A note may be a function of the game rather than a sentence, because a few
 * of them are about a number somebody has only just set. See `rebellionNote`.
 */
export function noteFor(verb, state, data, roleId = state?.viewer?.roleId ?? null) {
  const note = COMMANDS[verb]?.note;
  return (typeof note === 'function' ? note(state, data, roleId) : note) ?? '';
}

/**
 * What this action still needs answered, given the game as this player sees it.
 *
 * `roleId` defaults to the viewer of a projection: a client asking what its
 * own player may choose is the common case, and a projection is state-shaped,
 * so the same functions answer for the host — which passes the role it means.
 *
 * @returns {Field[]} empty when the action is just a button
 */
export function fieldsFor(verb, state, data, roleId = state?.viewer?.roleId ?? null) {
  return COMMANDS[verb]?.fields?.(state, data, roleId) ?? [];
}

/**
 * Turn a filled-in form into the payload the command expects.
 *
 * Most verbs want exactly what was chosen. The few that do not say so on their
 * own spec, next to the fields whose values they are rewriting — a form hands
 * back strings, and a settlement is chosen as one option but admitted as two
 * keys.
 */
export function payloadFrom(verb, values) {
  const spec = COMMANDS[verb];
  return spec?.toPayload ? spec.toPayload(values) : values;
}

/**
 * A representative legal instance of this command, for `availableTo`.
 *
 * Derived from the fields, because a field's options are by construction ones
 * the game currently allows — so "is there any way to do this at all?" is
 * answered off the same list the player would be picking from, and there is no
 * second hand-written answer to drift away from it. It goes through
 * `payloadFrom` for the same reason the form does: a probe the command's own
 * `admit` would not recognise is worse than no probe at all.
 *
 * A spec may still write its own `probe` where the first option is not the
 * representative one — where the cheapest instance is not the first, or where
 * an empty dropdown should still be refused in the phase's own words rather
 * than with "no such thing". Each of those says why where it is written.
 */
export function probeFor(verb, state, data, roleId) {
  const spec = COMMANDS[verb];
  if (!spec) return {};
  if (spec.probe !== undefined) {
    return (typeof spec.probe === 'function'
      ? spec.probe(state, data, roleId) : spec.probe) ?? {};
  }
  const values = {};
  for (const field of fieldsFor(verb, state, data, roleId)) {
    values[field.name] = field.kind === 'number'
      ? field.value ?? field.min ?? 1
      : field.options?.[0]?.value;
  }
  return payloadFrom(verb, values);
}

/**
 * The shires this action could land on, for pointing at them on the map.
 *
 * Reads the same options the chooser itself renders, so a highlighted shire
 * can never disagree with what the dropdown actually offers — this has no
 * knowledge of its own, only the fields' options split on `|` where a target
 * names a settlement rather than a shire outright.
 *
 * @returns {string[]} shire ids, or empty for an action with no shire field
 */
export function shireTargetsFor(verb, state, data, roleId = state?.viewer?.roleId ?? null) {
  const field = fieldsFor(verb, state, data, roleId)
    .find((f) => f.name === 'shireId' || f.name === 'target');
  if (!field) return [];
  const ids = field.options.map((o) => String(o.value).split('|')[0]);
  return [...new Set(ids.filter((id) => data.shires.shires[id]))];
}

/** Commands a role could issue in this phase, whether or not they can afford them. */
export function commandsInPhase(phaseName) {
  return Object.entries(COMMANDS)
    .filter(([, spec]) => spec.phases === '*' || spec.phases.includes(phaseName))
    .map(([verb]) => verb);
}
