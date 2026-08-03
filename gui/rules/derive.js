/**
 * gui/rules/derive.js — everything computed rather than stored.
 *
 * Support, effective adjacency, income and the four Aftermath counters are all
 * functions of the board. Keeping them out of state means the map and the
 * tracker cannot drift apart, which in a game whose ending is read off the
 * tracker is the drift that would matter most.
 *
 * Pure: state and data in, values out. No DOM, no network, no module globals.
 */

import { liegeChain } from './state.js';

/**
 * The factions a role counts as, for support.
 *
 * Their team's faction to begin with, plus one for every crown they hold. The
 * map legend makes these the same list: the starting factions are D, M and W,
 * and the "potential factions" are exactly the crowns a player can claim. So
 * "the Northumbrian faction" and "whoever holds the crown of Northumbria" are
 * one idea, and support is one rule rather than two.
 *
 * @returns {string[]} faction initials as printed in a shire's support box
 */
export function factionsOf(state, data, roleId) {
  const role = state.roles[roleId];
  if (!role) return [];
  const { crownLetter, teamLetter } = data.factions;
  const letters = new Set();
  const team = teamLetter[role.teamId];
  if (team) letters.add(team);
  for (const crown of role.crowns) {
    if (crownLetter[crown]) letters.add(crownLetter[crown]);
  }
  return [...letters];
}

/** Whether a role is Danish, which is about their archetype, not their team. */
export function isDanish(state, data, roleId) {
  const archetype = data.roles.roles[roleId]?.archetype;
  return data.factions.danishArchetypes.includes(archetype);
}

/** Whether a role is pagan: Danish and not yet baptised. */
export function isPagan(state, data, roleId) {
  return isDanish(state, data, roleId) && !state.roles[roleId]?.baptised;
}

/**
 * Whether a role has support in a shire.
 *
 * The printed rule: support is given in a shire if you or your liege hold the
 * crown matching any faction initial in that shire's support box. Danes are the
 * exception — they have support only where they have Settled, which is why the
 * three Danish-held shires are the only unsupported ones when the game opens.
 *
 * Without support, a shire's defended settlements pay nothing, and it counts
 * toward Disorder at the end.
 */
export function hasSupport(state, data, shireId, roleId = null) {
  const shire = state.shires[shireId];
  if (!shire) return false;
  const holder = roleId ?? shire.stewardRoleId;
  if (!holder || !state.roles[holder]) return false;

  if (isDanish(state, data, holder)) return shire.danishSupport;

  const box = data.shires.shires[shireId].support;
  for (const id of [holder, ...liegeChain(state, holder)]) {
    if (factionsOf(state, data, id).some((f) => box.includes(f))) return true;
  }
  return false;
}

/**
 * What a shire costs to reach by sea this turn, or null if it is landlocked.
 * A defensive fleet raises it; a trade contract lowers it.
 */
export function shipCost(state, data, shireId) {
  const printed = data.shires.shires[shireId].shipCost;
  if (printed === null) return null;
  return Math.max(0, printed + (state.shires[shireId].shipCostDelta ?? 0));
}

/**
 * The shires a role may attack from, this turn.
 *
 * Three ways in: a drawn border, support in the shire (which grants access
 * without one), and paying a coastal shire's ship cost, which lasts the turn.
 */
export function reachableFrom(state, data, roleId) {
  const reach = new Set();
  for (const [a, b] of data.adjacency.edges) {
    if (state.shires[a]?.stewardRoleId === roleId) reach.add(b);
    if (state.shires[b]?.stewardRoleId === roleId) reach.add(a);
  }
  for (const id of Object.keys(state.shires)) {
    if (hasSupport(state, data, id, roleId)) reach.add(id);
    if (state.shires[id].adjacencyBought?.[roleId] === state.phase.turn) reach.add(id);
  }
  reach.delete(null);
  return [...reach].sort();
}

/**
 * What a role with no land collects instead, by archetype.
 *
 * Enough to stay in the game and not enough to stay out of it. A priest with
 * nothing gets silver rather than a soldier, which is the sheets being precise
 * about what a churchman is for.
 */
const LANDLESS = {
  saxon_warrior: { silver: 0, food: 2, soldiers: 1 },
  saxon_priest: { silver: 3, food: 2, soldiers: 0 },
  danish_warrior: { silver: 0, food: 2, soldiers: 1 },
  danish_trader: { silver: 0, food: 2, soldiers: 1 },
};

/**
 * What a role collects in the maintenance phase.
 *
 * A farm pays one food and a town pays two silver, but only where the holder
 * has support — without it, defended settlements pay nothing at all. Churches
 * never pay; they buy momentum for priests and legitimacy for everyone.
 */
export function incomeFor(state, data, roleId) {
  const held = Object.values(state.shires).filter((s) => s.stewardRoleId === roleId);
  if (held.length === 0) {
    const archetype = data.roles.roles[roleId]?.archetype ?? 'saxon_warrior';
    return { ...LANDLESS[archetype] ?? LANDLESS.saxon_warrior, landless: true };
  }

  let silver = 0;
  let food = 0;
  for (const shire of held) {
    const supported = hasSupport(state, data, shire.id, roleId);
    for (const settlement of Object.values(shire.settlements)) {
      if (settlement.destroyed) continue;
      if (settlement.defended && !supported) continue;
      if (settlement.type === 'farm') food += 1;
      if (settlement.type === 'town') silver += 2;
    }
  }
  return { silver, food, soldiers: 0, landless: false };
}

/** Churches a role holds, which gate Raise Christian Banners. */
export function churchesHeld(state, roleId) {
  return Object.values(state.shires)
    .filter((s) => s.stewardRoleId === roleId)
    .flatMap((s) => Object.values(s.settlements))
    .filter((x) => x.type === 'church' && !x.destroyed).length;
}

/**
 * Churches held by everyone in a role's faction.
 *
 * A priest gains an extra momentum where their faction holds ten or more, so
 * the count that matters is the faction's rather than the priest's own — the
 * bonus is for belonging to a strong church, not for personally owning one.
 */
export function factionChurches(state, roleId) {
  const faction = state.roles[roleId]?.factionId;
  if (!faction) return 0;
  const members = Object.values(state.roles)
    .filter((r) => r.factionId === faction).map((r) => r.id);
  return members.reduce((total, id) => total + churchesHeld(state, id), 0);
}

/** How much momentum this role gains in a maintenance phase, before the cap. */
export function momentumGain(state, data, roleId) {
  const base = 2;
  const archetype = data.roles.roles[roleId]?.archetype;
  if (archetype !== 'saxon_priest') return base;
  return base + (factionChurches(state, roleId) >= 10 ? 1 : 0);
}

/** Settlements still standing, across the whole board. */
export function settlementsStanding(state) {
  return Object.values(state.shires)
    .flatMap((s) => Object.values(s.settlements))
    .filter((x) => !x.destroyed).length;
}

/**
 * "England in the Aftermath" — the four counters the endgame is read from.
 *
 * All four are derived from the board rather than tracked, so the epilogue can
 * never disagree with the map it is describing. Foreign Influence is the fifth
 * and is not here: it is the facilitator's judgement of what was promised to
 * the Franks, the Britons and the Pope, and no counter can hold that.
 */
export function aftermath(state, data) {
  // Sorted so a projection is byte-stable: an unordered list would make every
  // rebroadcast look like a change, and every replay assertion flaky.
  const ids = Object.keys(state.shires).sort();
  const stewardOf = (id) => state.shires[id].stewardRoleId;

  const danelaw = ids.filter((id) => stewardOf(id) && isDanish(state, data, stewardOf(id)));
  const paganism = danelaw.filter((id) => !state.shires[id].missionaryCross);
  const disorder = ids.filter((id) => stewardOf(id) && !hasSupport(state, data, id));
  const prosperity = settlementsStanding(state);

  const band = (which, value) => {
    const bands = data.meta.aftermath[which].bands;
    const index = bands.findIndex(([lo, hi]) => value >= lo && (hi === null || value <= hi));
    return { value, band: index, of: bands.length };
  };

  return {
    paganism: { ...band('paganism', paganism.length), shires: paganism },
    danelaw: { ...band('danelaw', danelaw.length), shires: danelaw },
    disorder: { ...band('disorder', disorder.length), shires: disorder },
    prosperity: band('prosperity', prosperity),
    foreignInfluence: state.aftermath.foreignInfluence,
  };
}

/**
 * Everything a console needs that is not in state, computed once per
 * projection so a view never has to work anything out for itself.
 */
export function deriveAll(state, data) {
  const shires = {};
  for (const id of Object.keys(state.shires)) {
    shires[id] = {
      supported: hasSupport(state, data, id),
      shipCost: shipCost(state, data, id),
      standing: Object.values(state.shires[id].settlements).filter((x) => !x.destroyed).length,
    };
  }
  const roles = {};
  for (const id of Object.keys(state.roles)) {
    roles[id] = {
      income: incomeFor(state, data, id),
      churches: churchesHeld(state, id),
      factionChurches: factionChurches(state, id),
      momentumGain: momentumGain(state, data, id),
      danish: isDanish(state, data, id),
      pagan: isPagan(state, data, id),
      factions: factionsOf(state, data, id),
    };
  }
  return { shires, roles, aftermath: aftermath(state, data) };
}
