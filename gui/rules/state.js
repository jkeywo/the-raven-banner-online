/**
 * gui/rules/state.js — the shape of a game, and how one begins.
 *
 * Plain JSON: no classes, no Map, no Set, no Date. That is what makes
 * `structuredClone` a valid copy, `JSON.stringify` a valid save, a downloaded
 * file a valid handover to another machine, and `toEqual` a valid assertion.
 * Every one of those would need bespoke code if this held live objects.
 *
 * Derived values are deliberately absent. Support, effective adjacency, income
 * and the four Aftermath counters are computed on demand by derive.js. Storing
 * them is how the map and the tracker come to disagree, and in a game whose
 * ending is read off the tracker, that disagreement is the bug that matters.
 */

export const SCHEMA_VERSION = 1;

/** The four phases of every turn, in order. */
export const PHASES = ['team', 'battle', 'maintenance', 'encounter'];

/**
 * The three initiative tokens, in the order the sheets name them — which is
 * also their order of precedence.
 *
 * Each is a plain roleId-or-null on `state.initiative`, sitting alongside
 * `declared`. No role may be the value of more than one at a time — they are
 * three counters on a table, and nobody is handed two.
 *
 * Two tokens cannot name the same shire. White outranks black outranks the
 * spare, and the loser of a collision has to choose somewhere else: their
 * declaration is cleared rather than sitting behind one that will always beat
 * it. That is what keeps "which token took this shire?" a question with one
 * answer, which everything from the token handover to the conqueror's steward
 * pick depends on.
 */
export const TOKENS = ['white', 'black', 'bonus'];

/** Does `token` outrank `other`? White, then black, then the spare. */
export const outranks = (token, other) =>
  TOKENS.indexOf(token) < TOKENS.indexOf(other);

/**
 * Which token this role holds, or null. The one place that question is asked.
 *
 * Every reader used to spell the lookup out for itself, which is how the bonus
 * token came to be written in two different shapes without anything noticing.
 */
export function tokenHeldBy(initiative, roleId) {
  if (!roleId) return null;
  return TOKENS.find((token) => initiative?.[token] === roleId) ?? null;
}

/**
 * Which roles are in play at a given head count.
 *
 * "You can run the game with up to 4 fewer players than maximum. To do so drop
 * roles in this order: Oscatel, Uchtred, Ecgbert, Godric." The order is not
 * arbitrary — each drop is a role whose absence the guide's own table knows how
 * to compensate for.
 */
export function rosterFor(data, players) {
  const all = Object.keys(data.roles.roles);
  const wanted = Math.min(Math.max(Number(players) || all.length, all.length - 4), all.length);
  const dropped = new Set((data.meta.dropOrder ?? []).slice(0, all.length - wanted));
  return all.filter((id) => !dropped.has(id));
}

/** The roles the guide drops at this head count, in the order it drops them. */
const droppedRoles = (data, inPlay) =>
  (data.meta.dropOrder ?? []).filter((id) => !inPlay.includes(id));

/**
 * Top the survivors up for everyone who is not at the table.
 *
 * The Facilitators Guide gives an exact table rather than a rule of thumb —
 * Guthrum gains three soldiers, two food and four silver when Oscatel is out,
 * and so on down the list. Applying it by hand is the sort of thing that gets
 * done wrong at nine in the morning with sixteen people arriving.
 *
 * A mercenary card is not compensation for a missing player; it is
 * compensation for an *uneven* table, so it is dealt by head count instead.
 */
function applyScaling(roles, data, inPlay) {
  const scaling = data.scaling ?? {};
  for (const gone of droppedRoles(data, inPlay)) {
    for (const [roleId, grant] of Object.entries(scaling.onDrop?.[gone]?.grant ?? {})) {
      if (!roles[roleId]) continue;
      for (const [what, amount] of Object.entries(grant)) {
        roles[roleId][what] = (roles[roleId][what] ?? 0) + Number(amount);
      }
    }
  }
  for (const roleId of scaling.mercenariesAt?.[String(inPlay.length)] ?? []) {
    if (roles[roleId]) roles[roleId].mercenary = true;
  }
}

/** Which shires change hands because their steward is not in the game. */
function stewardshipTransfers(data, inPlay) {
  const transfers = {};
  for (const gone of droppedRoles(data, inPlay)) {
    Object.assign(transfers, data.scaling?.onDrop?.[gone]?.stewardship ?? {});
  }
  return transfers;
}

/**
 * The shire that loses a castle at twelve players.
 *
 * "Do not use mercenary cards, instead remove a castle from any shire that
 * starts with four." Any will do, so the app takes the first in printed order
 * and says which — an arbitrary choice made visibly beats one made silently,
 * and the facilitator can move it with the inspector.
 */
export function castleRemovedAt(data, inPlay) {
  if (inPlay.length !== Number(data.scaling?.castleRemovalAt)) return null;
  return Object.keys(data.shires.shires)
    .find((id) => data.shires.shires[id].castles === 4) ?? null;
}

/** Turn one's declarations, already made by the rules on the holders' behalf. */
function fixedFirstTargets(data, holders) {
  const declared = {};
  for (const [roleId, shireId] of Object.entries(data.meta.fixedFirstTargets ?? {})) {
    const token = Object.keys(holders).find((key) => holders[key] === roleId);
    if (token) declared[token] = { roleId, shireId, revealed: false, fixed: true };
  }
  return declared;
}

/**
 * Build the opening position from the static data.
 *
 * @param {object} args
 * @param {string} args.joinCode
 * @param {number} args.seed
 * @param {object} args.data  the contents of data/, already loaded
 * @param {string[]} [args.roleIds]  roles in play; defaults to all of them
 * @returns {object} a fresh GameState
 */
export function createInitialState({ joinCode, seed, data, roleIds }) {
  const inPlay = roleIds ?? Object.keys(data.roles.roles);

  const roles = {};
  for (const id of inPlay) {
    const role = data.roles.roles[id];
    if (!role) throw new Error(`createInitialState: unknown role '${id}'`);
    roles[id] = {
      id,
      // No seat binding here on purpose. Who is sitting in a chair is runtime,
      // not history: it is in `seats`, and duplicating it would give replay
      // something it cannot rebuild from the log and so a way to disagree.
      ...role.start,
      wounds: 0,
      // A liege who is not in play at this player count leaves their vassal
      // free rather than pointing at nobody.
      liegeId: inPlay.includes(role.liege) ? role.liege : null,
      teamId: role.team,
      factionId: role.team,
      claims: [...role.claims],
      baptised: false,
      // Shires a baptised Dane gained a de jure claim on: the Danish ones the
      // church had already reached with a cross when they converted.
      deJureShires: [],
      // A priest counts two extra churches for each of these.
      baptismsPerformed: 0,
      dead: false,
      // How many times this character has been replaced by their heir. The
      // player stays; the person in the chair is somebody else.
      generation: 0,
      once: { christianBanners: false, mercenary: false },
      // A mercenary card, where the head count calls for one.
      mercenary: false,
      perTurn: { shipsBuilt: 0, tradesUsed: 0 },
    };
  }

  applyScaling(roles, data, inPlay);

  const shires = {};
  const handedOn = stewardshipTransfers(data, inPlay);
  for (const [id, shire] of Object.entries(data.shires.shires)) {
    const printed = inPlay.includes(shire.initialSteward) ? shire.initialSteward : null;
    // A dropped role's lands do not go unheld: the guide names who picks them
    // up, and an empty shire would quietly change the support count.
    const steward = printed ?? (inPlay.includes(handedOn[id]) ? handedOn[id] : null);
    shires[id] = {
      id,
      stewardRoleId: steward,
      factionId: steward ? roles[steward].factionId : null,
      castles: shire.castles - (id === castleRemovedAt(data, inPlay) ? 1 : 0),
      missionaryCross: false,
      danishSupport: false,
      shipCostDelta: 0,
      settlements: Object.fromEntries(shire.settlements.map((s) => [
        s.id, { id: s.id, type: s.type, defended: s.defended, destroyed: false },
      ])),
      adjacencyBought: {},
    };
  }

  const tokenHolders = {
    white: inPlay.includes('halfdan_ragnarsson') ? 'halfdan_ragnarsson' : null,
    black: inPlay.includes('guthrum_the_old') ? 'guthrum_the_old' : null,
    bonus: null,
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    joinCode,
    seed,
    rngCursor: 0,
    phase: { turn: 1, name: 'lobby', endsAt: null, paused: false, pausedRemainingMs: null },
    // Keyed by a short public seat id, never by the seat token. A projection
    // can redact a value but not a key -- the key is structure -- so anything
    // secret has to not be one. The token is the credential that resumes a
    // seat, so it lives inside the record where the manifest can hide it.
    seats: {},
    seatByToken: {},
    roles,
    shires,
    // The three tokens. Turn one's targets are fixed by the rules, so the
    // holders start already assigned and the first battle phase has somewhere
    // to go even if nobody has worked out what they are doing yet.
    initiative: {
      ...tokenHolders,
      // "In turn 1 the targets are fixed: Halfdan will always attack Lindsey
      // and Guthrum will always attack Essex." Seeded rather than declared, so
      // the first battle has somewhere to go before anybody has worked out
      // what they are doing.
      declared: fixedFirstTargets(data, tokenHolders),
    },
    battle: {
      targets: [], sides: {}, clashes: {},
      // Defenders with no clash of their own, who may reinforce someone
      // else's or scout — one or the other, never both.
      spare: {}, scouts: {},
      // Mercenary cards handed in, per shire and per side. They buy a clash
      // nobody fought, so they live beside the battle rather than in it.
      mercenaries: {},
      // Who the conqueror of each fallen shire named to take it, by shire.
      // Turn-scoped for free: `facilitator:end-battles` clears this whole
      // object, and a pick is only ever about a battle currently on the board.
      stewardPicks: {},
      pairingComplete: false,
    },
    // Requests waiting on other people's agreement — settling a shire, and
    // swearing homage to somebody who has to accept it. The first things in
    // the game that make one player wait on another.
    consents: {},
    // Who wears which crown. "Mercia starts the game without a king", and
    // every minor claim is a claim rather than a coronation until an election
    // settles it — but Wessex and Northumbria are already worn, and are
    // seeded here rather than left implicit so an heir has an actual crown to
    // lose and a fresh election has an actual throne to contest.
    crownHolders: Object.fromEntries(
      Object.entries(data.meta.startingCrowns ?? {})
        .filter(([, roleId]) => inPlay.includes(roleId))),
    // Petitions to rebel: a vassal has asked, and is waiting on the
    // facilitator to price it before they decide whether to go through with
    // it. Kept rather than removed once resolved, like a contract or a
    // consent request — a rebellion refused or called off is still part of
    // the story of the game.
    rebellions: {},
    // Trade contracts, offered and signed. Three cards, one per named shire,
    // each carrying a status rather than being removed when it ends — a
    // cancelled deal is part of the story of the game.
    contracts: [],
    votes: {},
    envoys: {},
    // What was promised to the powers nobody plays. Written by the
    // facilitator as each deal is struck, because the alternative is trying to
    // remember four courts' worth of bargains at the debrief.
    // Keyed rather than a list, so the projector can walk into it and show
    // each promise only to whoever made it.
    concessions: {},
    // Foreign Influence is prose because the printed counter is prose. The
    // two stamps are set when the facilitator calls time.
    aftermath: { foreignInfluence: '', endedAt: null, endedOnTurn: null },
    facilitatorNotes: {},
    // What the battle phase could not do and had no other way to report — see
    // `battleNoteKey` in battle.js. Kept apart from facilitatorNotes on
    // purpose: that one is prose an umpire typed, and the epilogue reads it
    // out under "What the umpire changed", which is not where a
    // machine-voiced line about a counter belongs.
    battleNotes: {},
    log: [],
    lastSeq: {},
  };
}

/** The seat holding a token, or null. */
export function seatForToken(state, token) {
  const id = state.seatByToken[token];
  return id ? state.seats[id] ?? null : null;
}

/** The next free public seat id. Short, sequential, and safe to broadcast. */
export function nextSeatId(state) {
  return `s${Object.keys(state.seats).length + 1}`;
}

/** Roles the given seat may act for. A facilitator may act for anyone. */
export function rolesFor(state, seatId) {
  const seat = state.seats[seatId];
  if (!seat) return [];
  if (seat.kind === 'facilitator') return Object.keys(state.roles);
  return seat.roleId ? [seat.roleId] : [];
}

/** The role a seat holds, or null. */
export function roleOf(state, seatId) {
  const roleId = state.seats[seatId]?.roleId;
  return roleId ? state.roles[roleId] ?? null : null;
}

/** The seat playing a role, or null. The reverse of roleOf, computed. */
export function seatHolding(state, roleId) {
  return Object.values(state.seats).find((s) => s.roleId === roleId) ?? null;
}

/** Follow a liege chain to its head, tolerating a cycle rather than hanging. */
export function liegeChain(state, roleId) {
  const chain = [];
  let at = state.roles[roleId]?.liegeId ?? null;
  while (at && !chain.includes(at) && chain.length < Object.keys(state.roles).length) {
    chain.push(at);
    at = state.roles[at]?.liegeId ?? null;
  }
  return chain;
}
