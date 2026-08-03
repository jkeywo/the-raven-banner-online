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
      once: { christianBanners: false },
      perTurn: { shipsBuilt: 0, tradesUsed: 0 },
    };
  }

  const shires = {};
  for (const [id, shire] of Object.entries(data.shires.shires)) {
    const steward = inPlay.includes(shire.initialSteward) ? shire.initialSteward : null;
    shires[id] = {
      id,
      stewardRoleId: steward,
      factionId: steward ? roles[steward].factionId : null,
      castles: shire.castles,
      missionaryCross: false,
      danishSupport: false,
      shipCostDelta: 0,
      settlements: Object.fromEntries(shire.settlements.map((s) => [
        s.id, { id: s.id, type: s.type, defended: s.defended, destroyed: false },
      ])),
      adjacencyBought: {},
    };
  }

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
      white: inPlay.includes('halfdan_ragnarsson') ? 'halfdan_ragnarsson' : null,
      black: inPlay.includes('guthrum_the_old') ? 'guthrum_the_old' : null,
      bonus: null,
      declared: {},
    },
    battle: {
      targets: [], sides: {}, clashes: {},
      // Defenders with no clash of their own, who may reinforce someone
      // else's or scout — one or the other, never both.
      spare: {}, scouts: {},
      pairingComplete: false,
    },
    // Requests waiting on other people's agreement — settling a shire, and
    // swearing homage to somebody who has to accept it. The first things in
    // the game that make one player wait on another.
    consents: {},
    // Who wears which crown. Empty at the start: "Mercia starts the game
    // without a king", and every other crown is a claim rather than a
    // coronation until an election settles it.
    crownHolders: {},
    // What a rebellion costs this vassal, where the facilitator has ruled that
    // their liege has lost the favour of God and it should cost them less.
    rebellionRelief: {},
    // Trade contracts, offered and signed. Three cards, one per named shire,
    // each carrying a status rather than being removed when it ends — a
    // cancelled deal is part of the story of the game.
    contracts: [],
    votes: {},
    envoys: {},
    aftermath: { foreignInfluence: '' },
    facilitatorNotes: {},
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
