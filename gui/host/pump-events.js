/**
 * gui/host/pump-events.js — what an outside service is told, and how.
 *
 * The event pump exists so a Discord bot can follow a game it is not playing.
 * Everything about *sending* is next door in event-pump.js; everything here is
 * a pure function over two snapshots, so the whole contract can be tested in
 * Node with no socket, no clock and no host.
 *
 * **The input is a spectator projection, never state.** That is the redaction
 * story and it is structural rather than careful: `projectView(state, data,
 * {kind: 'spectator'})` returns exactly the paths the manifest marks PUBLIC —
 * `permits()` refuses a spectator every owner, team and facilitator field, and
 * refuses them a reveal condition too. So a resource, an unannounced initiative
 * target, a tactic card and an envoy thread are not hidden from this module,
 * they are absent from what it is handed. No filtering happens here, and no
 * `FIELD_VISIBILITY` entry is needed, because the pump adds nothing to state
 * and reads nothing that is not already leaving the tab.
 *
 * The digest is the second half of that. It is a small, flat, diffable summary
 * of the public board, and a test asserts it comes out identical whether it is
 * built from a spectator projection or from raw state — which is only true
 * while every field it reads is PUBLIC. Reach for a private one and that test
 * goes red, because the projection would not have it.
 *
 * Events describe changes rather than carrying the board, so a bot never needs
 * to hold a copy of the game to make sense of one. Each says what moved and
 * what it moved from.
 */

/**
 * The wire's own version, bumped when a field changes meaning or leaves.
 *
 * The bot is in another repository and will be deployed on its own schedule,
 * so it needs to be able to say "I do not understand this" rather than
 * mis-parse a shape that quietly changed under it.
 */
export const PUMP_SCHEMA_VERSION = 1;

/**
 * Every type this module can emit.
 *
 * Exported because it is the contract: `docs/discord-integration.md` documents
 * exactly these and a test fails if the two lists ever disagree.
 */
export const EVENT_TYPES = [
  'game.opened',
  'game.phase',
  'seat.joined',
  'seat.left',
  'seat.returned',
  'seat.role',
  'board.steward',
  'battle.targets',
];

/** The keys on every envelope, in the order they are written. */
export const ENVELOPE_KEYS = ['v', 'seq', 'at', 'game', 'type', 'data'];

/**
 * The public board, reduced to the handful of things worth announcing.
 *
 * Deliberately flat and deliberately small. Diffing whole states would mean
 * holding two of them, and would make "what changed" a question about
 * structure rather than about the game.
 *
 * @param {object} view  a spectator projection
 */
export function publicDigest(view) {
  const phase = view?.phase ?? {};

  const seats = {};
  for (const [id, seat] of Object.entries(view?.seats ?? {})) {
    seats[id] = {
      name: typeof seat?.name === 'string' ? seat.name : '',
      roleId: seat?.roleId ?? null,
      kind: seat?.kind === 'facilitator' ? 'facilitator' : 'player',
      connected: Boolean(seat?.connected),
    };
  }

  // Who holds each shire, and nothing else about it. A castle coming down is a
  // detail of a battle; a shire changing hands is the story.
  const stewards = {};
  for (const [id, shire] of Object.entries(view?.shires ?? {})) {
    stewards[id] = shire?.stewardRoleId ?? null;
  }

  return {
    turn: phase.turn ?? null,
    phase: phase.name ?? null,
    paused: Boolean(phase.paused),
    seats,
    stewards,
    targets: [...(view?.battle?.targets ?? [])],
  };
}

/** One seat, in the shape every seat-shaped event carries it. */
const seatData = (seatId, seat) => ({
  seatId, name: seat.name, roleId: seat.roleId, kind: seat.kind,
});

const sameOrder = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * What happened between two digests.
 *
 * A null `before` is the first observation of a game, which is a different
 * question — the bot has just attached and needs the position, not a diff — so
 * it gets one `game.opened` carrying the roster rather than a join for every
 * seat that was already sitting there.
 *
 * Order is deterministic: the phase first, then seats in seat-id order, then
 * the board. A bot replaying a log file gets the same story the room got.
 *
 * @param {object|null} before
 * @param {object} after
 * @returns {{type: string, data: object}[]}
 */
export function deriveEvents(before, after) {
  if (!before) {
    return [{
      type: 'game.opened',
      data: {
        turn: after.turn,
        phase: after.phase,
        paused: after.paused,
        seats: Object.entries(after.seats).map(([id, seat]) => seatData(id, seat)),
      },
    }];
  }

  const events = [];

  // Pausing counts. A bot holding a voice channel open for a phase needs to
  // know the room has stopped, and to a facilitator that is the same act as
  // moving on.
  if (before.turn !== after.turn || before.phase !== after.phase
      || before.paused !== after.paused) {
    events.push({
      type: 'game.phase',
      data: {
        turn: after.turn,
        phase: after.phase,
        paused: after.paused,
        previousTurn: before.turn,
        previousPhase: before.phase,
      },
    });
  }

  for (const [id, seat] of Object.entries(after.seats)) {
    const was = before.seats[id];
    if (!was) {
      events.push({ type: 'seat.joined', data: seatData(id, seat) });
      continue;
    }
    // Coming back is not the same as arriving. A bot that treated it as one
    // would greet the same person sixteen times over a three-hour game, which
    // is the behaviour that gets an integration muted.
    if (!was.connected && seat.connected) {
      events.push({ type: 'seat.returned', data: seatData(id, seat) });
    }
    if (was.connected && !seat.connected) {
      events.push({ type: 'seat.left', data: seatData(id, seat) });
    }
    if (was.roleId !== seat.roleId) {
      events.push({
        type: 'seat.role',
        data: { ...seatData(id, seat), previousRoleId: was.roleId },
      });
    }
  }

  // A chair is never thrown away while a game is running — a disconnected
  // player keeps theirs — but a save edited by hand or a future rule could
  // still take one, and a bot left holding a seat that no longer exists is a
  // worse failure than one extra branch here.
  for (const [id, seat] of Object.entries(before.seats)) {
    if (!after.seats[id]) events.push({ type: 'seat.left', data: seatData(id, seat) });
  }

  for (const [shireId, steward] of Object.entries(after.stewards)) {
    const was = before.stewards[shireId];
    if (was !== undefined && was !== steward) {
      events.push({
        type: 'board.steward',
        data: { shireId, stewardRoleId: steward, previousStewardRoleId: was },
      });
    }
  }

  // The announced target list, whole rather than per-shire. It is written in
  // one act by the facilitator and read as one list by everybody, and a bot
  // opening a voice channel per contested shire wants it that way round.
  if (!sameOrder(before.targets, after.targets)) {
    events.push({
      type: 'battle.targets',
      data: { turn: after.turn, shireIds: [...after.targets] },
    });
  }

  return events;
}

/**
 * Wrap derived events in the envelope the bot actually reads.
 *
 * The stamp is separate from the derivation because a clock and a counter are
 * not pure, and keeping them out here is what lets every event in this file be
 * asserted with a plain `toEqual`.
 *
 * @param {{type: string, data: object}[]} events
 * @param {{game: string, at: number, seq: number}} stamp  seq of the first
 */
export function stampEvents(events, { game, at, seq }) {
  return events.map((event, index) => ({
    v: PUMP_SCHEMA_VERSION,
    // Monotonic across one pump's life, so a bot can see that it missed
    // something. The pump is best-effort — a socket that was down dropped what
    // it could not hold — and a gap it can spot beats a gap it cannot.
    seq: seq + index,
    at,
    game,
    type: event.type,
    data: event.data,
  }));
}

/**
 * One or more envelopes as newline-terminated JSON.
 *
 * The same bytes whichever transport carries them: a WebSocket frame and an
 * HTTP body are both this string, so a bot can share one parser and a facilitator
 * can `tee` the stream to a file and read it back later.
 */
export function encodeBatch(envelopes) {
  return envelopes.map((envelope) => JSON.stringify(envelope)).join('\n') + '\n';
}
