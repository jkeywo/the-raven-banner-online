/**
 * gui/rules/derive.js — everything computed rather than stored.
 *
 * Support, effective adjacency, income and the four Aftermath counters are all
 * functions of the board. Keeping them out of state means the map and the
 * tracker cannot drift apart, which in a game whose ending is read off the
 * tracker is the drift that would matter most.
 *
 * Pure: state and data in, values out. No DOM, no network, no module globals.
 *
 * Board truth only. The debrief used to be assembled at the bottom of this
 * file, which made the module every rule in the game imports also the module
 * that knew how a report should be ordered for one reader at one moment. It
 * has moved to `epilogue.js`, which imports from here — the traffic runs that
 * way and not back.
 */

import { liegeChain } from './state.js';

/**
 * The crowns a role speaks for.
 *
 * A crown nobody wears is spoken for by everyone who claims it — which is the
 * whole of turn zero, since "Mercia starts the game without a king" and Alfred
 * has only just inherited Wessex. Once a king is crowned, a claim stops being
 * enough: the crown answers to its holder, and to nobody else who wanted it.
 *
 * That is what makes an election worth holding. The moment Ceowulf wins
 * Mercia, Gainbeald's Mercian shires stop supporting him, and he is a lord
 * with land he cannot tax.
 */
export function crownsOf(state, roleId) {
  const role = state.roles[roleId];
  if (!role) return [];
  const held = Object.entries(state.crownHolders ?? {})
    .filter(([, who]) => who === roleId).map(([crown]) => crown);
  const unheld = role.claims.filter((crown) => !state.crownHolders?.[crown]);
  return [...new Set([...held, ...unheld])];
}

/**
 * The factions a role counts as, for support.
 *
 * Their team's faction to begin with, plus one for every crown they speak for.
 * The map legend makes these the same list: the starting factions are D, M and
 * W, and the "potential factions" are exactly the crowns a player can claim.
 * So "the Northumbrian faction" and "whoever holds the crown of Northumbria"
 * are one idea, and support is one rule rather than two.
 *
 * @returns {string[]} faction initials as printed in a shire's support box
 */
export function factionsOf(state, data, roleId) {
  const role = state.roles[roleId];
  if (!role) return [];
  const { crownLetter, teamLetter } = data.factions;
  const letters = new Set();
  // A kingdom without a king is spoken for by everyone in it — which is why
  // the turn-zero tracker reads three unsupported shires rather than seven.
  // Once it has a king it speaks through him, and a Mercian who did not win
  // the election is a lord with land he cannot tax until he swears to the man
  // who did. That is the whole point of holding one.
  const team = teamLetter[role.teamId];
  const teamCrown = crownLetter[role.teamId] ? role.teamId : null;
  const kingOfHisKingdom = teamCrown ? state.crownHolders?.[teamCrown] ?? null : null;
  if (team && (!kingOfHisKingdom || kingOfHisKingdom === roleId)) letters.add(team);
  for (const crown of crownsOf(state, roleId)) {
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
 * Whether a role is Christian.
 *
 * Everyone who is not a pagan, which after a baptism includes Danes. The
 * distinction matters for who may be preached to, who may raise banners, and
 * which shires count toward Paganism at the end.
 */
export function isChristian(state, data, roleId) {
  return Boolean(state.roles[roleId]) && !isPagan(state, data, roleId);
}

/**
 * Whether a shire is Danish for missionary purposes.
 *
 * The printed target is "one occupied or settled Danish shire" -- so a shire a
 * Dane stewards, or one they have Settled. A baptised Dane's shire still
 * counts: the cross is what stops it reading as pagan at the end, and a
 * convert's lands are exactly where a church wants one.
 */
export function isDanishHeld(state, data, shireId) {
  const shire = state.shires[shireId];
  if (!shire) return false;
  if (shire.danishSupport) return true;
  return Boolean(shire.stewardRoleId) && isDanish(state, data, shire.stewardRoleId);
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

/** Shires a faction's members currently steward between them. */
export function shiresOfFaction(state, factionId) {
  return Object.keys(state.shires).filter((id) => {
    const steward = state.shires[id].stewardRoleId;
    return steward && state.roles[steward]?.factionId === factionId;
  });
}

/**
 * Shires adjacent to anything a faction holds.
 *
 * Raiding reaches further than attacking does, and reaches on behalf of the
 * whole faction rather than the raider: the printed target is "a settlement in
 * a shire adjacent to one your faction controls". A landless Dane can burn a
 * farm next to a shire his jarl took, which is exactly what a landless Dane is
 * for.
 *
 * Borders only — no support shortcut and no buying passage by sea, both of
 * which are how an *army* moves rather than how a raiding party does.
 */
export function factionReach(state, data, factionId) {
  const held = new Set(shiresOfFaction(state, factionId));
  const reach = new Set();
  for (const [a, b] of data.adjacency.edges) {
    if (held.has(a)) reach.add(b);
    if (held.has(b)) reach.add(a);
  }
  // A faction's own shires are reachable too: a lord may burn his own farm,
  // and more usefully may raid a shire he has just taken.
  for (const id of held) reach.add(id);
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
  // Every baptism the priest has performed counts as two more churches. A
  // missionary who converts three Danes has effectively built six of them,
  // which is the game saying conversion is worth as much as construction.
  const notional = factionChurches(state, roleId)
    + 2 * (state.roles[roleId]?.baptismsPerformed ?? 0);
  return base + (notional >= 10 ? 1 : 0);
}

/**
 * Who elects a king, and with how many votes each.
 *
 * Printed whole in the Facilitators Guide: "All saxon stewards of shires that
 * have support for this crown (regardless of who their liege is) can vote…
 * Each character has one vote for every shire they are steward of that supports
 * the crown, plus one extra vote for every 2 churches in their shires."
 *
 * "Regardless of who their liege is" is the load-bearing clause. A king cannot
 * pack the electorate by taking vassals — he has to hold the ground, because
 * the votes are attached to shires and not to people.
 *
 * @returns {Record<string, number>} roleId to weight, only those with a vote
 */
export function electorate(state, data, crown) {
  const letter = data.factions.crownLetter[crown];
  if (!letter) return {};
  const weights = {};
  for (const [id, shire] of Object.entries(state.shires)) {
    const steward = shire.stewardRoleId;
    if (!steward || isDanish(state, data, steward)) continue;
    if (!data.shires.shires[id].support.includes(letter)) continue;
    weights[steward] = (weights[steward] ?? 0) + 1;
  }
  // The churches are counted across everything they steward, not only the
  // shires that gave them a vote in the first place: a bishop's influence
  // does not stop at a county line.
  for (const roleId of Object.keys(weights)) {
    weights[roleId] += Math.floor(churchesHeld(state, roleId) / 2);
  }
  return weights;
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

  // Danelaw counts Danish stewards; Paganism counts *pagan* ones. The two are
  // the same list until somebody is baptised, and then they are not: a
  // converted jarl's shires stay Danish for the culture count and stop being
  // pagan for the church's. Getting these the same way round would make
  // conversion worth nothing on the tracker, which is where the game is read.
  const danelaw = ids.filter((id) => stewardOf(id) && isDanish(state, data, stewardOf(id)));
  const paganism = ids.filter((id) => stewardOf(id)
    && isPagan(state, data, stewardOf(id))
    && !state.shires[id].missionaryCross);
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
