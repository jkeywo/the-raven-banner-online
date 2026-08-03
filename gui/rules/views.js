/**
 * gui/rules/views.js — the only way state leaves the host.
 *
 * A small generic projector over the manifest in visibility.js. It knows how to
 * walk a state tree and ask "may this recipient see this path"; it knows
 * nothing about briefs, or clashes, or whose turn it is. All of that is data,
 * next door, in one file.
 */

import {
  ruleFor, PUBLIC, OWNER, TEAM, FACILITATOR, NOBODY, TACTICS_REVEALED, LEAD_REVEALED,
} from './visibility.js';
import { deriveAll } from './derive.js';

/** Leaves are copied whole; anything else is walked into. */
const isBranch = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @typedef {object} Viewer
 * @property {'player'|'facilitator'|'spectator'} kind
 * @property {string|null} [roleId]  the role this seat holds
 * @property {string|null} [teamId]  denormalised so team checks stay cheap
 */

function permits(rule, segments, state, viewer) {
  if (rule.audience === NOBODY) return false;
  if (rule.audience === PUBLIC) return true;
  if (rule.audience === FACILITATOR) return viewer.kind === 'facilitator';
  if (viewer.kind === 'spectator') return false;

  // A reveal condition opens a private field to everyone once it is met, which
  // is what makes a simultaneous reveal simultaneous.
  if (rule.revealWhen?.(segments, state)) return true;

  const ownerId = rule.owner?.(segments, state) ?? null;
  if (!ownerId) return false;
  if (rule.audience === OWNER) return viewer.roleId === ownerId;
  if (rule.audience === TEAM) {
    return viewer.roleId === ownerId || viewer.teamId === state.roles[ownerId]?.teamId;
  }
  return false;
}

function walk(node, segments, state, viewer, onUnclassified) {
  if (isBranch(node)) {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      const child = walk(value, [...segments, key], state, viewer, onUnclassified);
      if (child !== undefined) out[key] = child;
    }
    // Drop a branch that nothing survived, so a player is not told an envoy
    // thread exists by receiving an empty object where one used to be.
    return Object.keys(out).length || Object.keys(node).length === 0 ? out : undefined;
  }

  const rule = ruleFor(segments);
  if (!rule) {
    onUnclassified?.(segments.join('.'));
    return undefined;            // fail closed
  }
  return permits(rule, segments, state, viewer) ? node : undefined;
}

/**
 * Build one recipient's copy of the game.
 *
 * A facilitator gets everything: they wrote the briefs, they hold the only
 * state, and they are the umpire the paper game already trusts. Everyone else
 * gets what the manifest allows plus the derived values their console needs.
 *
 * @param {object} state
 * @param {object} data
 * @param {Viewer} viewer
 */
export function projectView(state, data, viewer) {
  const derived = deriveAll(state, data);
  if (viewer.kind === 'facilitator') {
    return { ...structuredClone(state), derived, viewer };
  }

  const visible = walk(state, [], state, viewer, null) ?? {};
  return {
    ...visible,
    derived,
    // Who has committed, without saying to what. A clash cannot be run without
    // knowing whether you are waiting for your opponent, and that is not the
    // secret -- the card is.
    clashProgress: clashProgress(state),
    viewer,
    brief: viewer.roleId ? data.briefs.briefs[viewer.roleId] ?? null : null,
  };
}

/** Per clash: who has submitted, and whether the reveals have happened. */
export function clashProgress(state) {
  const out = {};
  for (const [id, clash] of Object.entries(state.battle.clashes)) {
    out[id] = {
      stage: clash.stage,
      tacticSubmitted: Object.fromEntries(
        Object.entries(clash.tactic ?? {}).map(([role, card]) => [role, card !== null])),
      leadSubmitted: Object.fromEntries(
        Object.entries(clash.lead ?? {}).map(([role, lead]) => [role, lead !== null])),
      tacticsRevealed: TACTICS_REVEALED.includes(clash.stage),
      leadRevealed: LEAD_REVEALED.includes(clash.stage),
    };
  }
  return out;
}

/**
 * Which paths a projection let through. For tests and for answering "why can
 * they see that?" without reading the walk by hand.
 *
 * @returns {string[]}
 */
export function auditProjection(state, data, viewer) {
  const paths = [];
  const collect = (node, segments) => {
    if (isBranch(node)) {
      for (const [key, value] of Object.entries(node)) collect(value, [...segments, key]);
      return;
    }
    const rule = ruleFor(segments);
    if (rule && permits(rule, segments, state, viewer)) paths.push(segments.join('.'));
  };
  collect(state, []);
  return paths.sort();
}

/**
 * Paths in this state that the manifest says nothing about.
 *
 * The completeness half of the redaction guarantee. A field added without a
 * manifest entry shows up here, and the test turns that into a failure — so
 * the cost of forgetting is a red build rather than a leak nobody notices.
 *
 * @returns {string[]}
 */
export function unclassifiedPaths(state) {
  const missing = new Set();
  walk(state, [], state, { kind: 'facilitator' }, (path) => missing.add(path));
  // The facilitator projection short-circuits, so walk explicitly as a player.
  walk(state, [], state, { kind: 'player', roleId: null, teamId: null },
    (path) => missing.add(path));
  return [...missing].sort();
}
