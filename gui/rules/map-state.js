/**
 * gui/rules/map-state.js — has this shire moved off the printed sheet?
 *
 * The exported map art is the printed sheet with the cells that are really
 * game state cut out of it: the steward frame, the support strip, the castle
 * stack and every settlement letter are blank fields now, and the overlay
 * fills them. That leaves one question the renderer has to answer eighteen
 * times a frame, and it is not a rendering question: *is this shire still
 * where the rules put it?* A board nobody has touched should read as the paper
 * game read before anyone sat down — quiet — so that the three shires which
 * have moved are the three things the eye lands on.
 *
 * The comparison is against a whole opening position rather than a hand-listed
 * set of printed values, because "as printed" already has a precise meaning in
 * this codebase: it is what `createInitialState` builds. Deriving the baseline
 * from the same function that starts the game means the map cannot come to
 * disagree with the setup — a scaling rule added to one is added to both.
 *
 * That also settles the short-handed table. A twelve-player game hands
 * Oscatel's shires on and takes a castle off a four-castle shire, and it does
 * so because the Facilitators Guide prints a table saying to. So the baseline
 * is the opening position *for the roster actually in play*: at twelve players
 * the board still opens blank, because nothing has happened yet.
 *
 * Pure: state and data in, plain answers out. The state may be a full host
 * state or a player's projection — every field read here is `PUBLIC` in the
 * visibility manifest, which is why the same predicate can run on both sides.
 */

import { createInitialState } from './state.js';
import { hasSupport, shipCost } from './derive.js';

/**
 * The order deviations come back in — coarsest first, so a caller that only
 * wants a headline can take the first one.
 */
export const DEVIATION_KINDS = [
  'steward',      // somebody else holds it, or nobody does
  'castles',      // a castle has been built or thrown down
  'support',      // it gained or lost support, however that happened
  'cross',        // missionaries have planted a cross here
  'shipCost',     // a contract or a defensive fleet moved what it costs by sea
  'settlements',  // a settlement was defended, or burned
];

/** Opening positions already built, per dataset and per roster. */
const OPENINGS = new WeakMap();

/**
 * The roles this game is being played with, in a stable order.
 *
 * Filtered against the dataset because a facilitator may add a role the
 * printed guide never had, and an opening position cannot be built for
 * somebody the rules have never heard of.
 */
function rosterOf(state, data) {
  const printed = Object.keys(data.roles.roles);
  const seated = Object.keys(state.roles ?? {}).filter((id) => printed.includes(id));
  return (seated.length ? seated : printed).slice().sort();
}

/**
 * The board as the rules print it, for this table.
 *
 * Cached because the renderer asks about eighteen shires per frame and the
 * answer is the same every time until the roster changes. A cache of a pure
 * function of its inputs is still a pure function of its inputs.
 */
export function printedBoard(state, data) {
  const roster = rosterOf(state, data);
  const key = roster.join(',');
  let byRoster = OPENINGS.get(data);
  if (!byRoster) {
    byRoster = new Map();
    OPENINGS.set(data, byRoster);
  }
  let opening = byRoster.get(key);
  if (!opening) {
    // The join code and seed are not read by anything this module asks about;
    // they are here because the opening position needs somewhere to start.
    opening = createInitialState({ joinCode: 'PRINTED', seed: 0, data, roleIds: roster });
    byRoster.set(key, opening);
  }
  return opening;
}

/**
 * Whether a shire has support right now.
 *
 * Prefers what the host already derived, because a projection carries
 * `derived.shires.*.supported` computed against the whole state — including
 * the halves of a liege chain a player may not otherwise be able to see the
 * point of. Falls back to computing it, which is what the host itself does.
 */
function supportedNow(state, data, shireId) {
  const derived = state.derived?.shires?.[shireId];
  if (typeof derived?.supported === 'boolean') return derived.supported;
  return hasSupport(state, data, shireId);
}

/** What it costs to reach by sea right now, on the same terms. */
function shipCostNow(state, data, shireId) {
  const derived = state.derived?.shires?.[shireId];
  if (derived && 'shipCost' in derived) return derived.shipCost;
  return shipCost(state, data, shireId);
}

/**
 * Every way this shire differs from the board the rules print.
 *
 * Support is compared rather than merely reported, which is the difference
 * that matters. Three shires are unsupported the moment the game opens —
 * Halfdan and Guthrum have not settled anywhere yet — and those are printed
 * facts, not events, so they draw nothing. But the turn Ceowulf wins Mercia,
 * Gainbeald's Mercian shires stop supporting him without anything about those
 * shires changing at all, and *that* is an event: the shire lights up.
 *
 * `adjacencyBought` is deliberately not here. It records who paid to reach the
 * shire this turn, which is a fact about a player rather than about the board,
 * and it is wiped every turn — a mark that appeared and vanished on its own
 * would teach players to distrust the whole overlay.
 *
 * @returns {string[]} a subset of DEVIATION_KINDS, in that order
 */
export function shireDeviations(state, data, shireId) {
  const live = state.shires?.[shireId];
  const opening = printedBoard(state, data);
  const printed = opening.shires[shireId];
  if (!live || !printed) return [];

  const moved = [];
  if ((live.stewardRoleId ?? null) !== (printed.stewardRoleId ?? null)) moved.push('steward');
  if (live.castles !== printed.castles) moved.push('castles');
  if (supportedNow(state, data, shireId) !== hasSupport(opening, data, shireId)) {
    moved.push('support');
  }
  if (Boolean(live.missionaryCross) !== Boolean(printed.missionaryCross)) moved.push('cross');
  if (shipCostNow(state, data, shireId) !== shipCost(opening, data, shireId)) moved.push('shipCost');

  // Walked from the printed list rather than the live one, so a settlement
  // that has gone missing from state entirely counts as a change rather than
  // as nothing to compare.
  const settlementMoved = Object.values(printed.settlements).some((was) => {
    const now = live.settlements?.[was.id];
    if (!now) return true;
    return Boolean(now.defended) !== Boolean(was.defended)
      || Boolean(now.destroyed) !== Boolean(was.destroyed);
  });
  if (settlementMoved) moved.push('settlements');

  return moved;
}

/** Whether this shire has moved off the printed sheet at all. */
export function hasDeviated(state, data, shireId) {
  return shireDeviations(state, data, shireId).length > 0;
}

/**
 * Every shire the game has moved, sorted.
 *
 * Empty on turn zero for every table size, which is the whole behaviour in one
 * assertion.
 */
export function deviatedShires(state, data) {
  return Object.keys(state.shires ?? {})
    .filter((id) => hasDeviated(state, data, id))
    .sort();
}
