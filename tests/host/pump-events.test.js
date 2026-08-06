import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { projectView } from '../../gui/rules/views.js';
import {
  publicDigest, deriveEvents, stampEvents, encodeBatch,
  EVENT_TYPES, ENVELOPE_KEYS, PUMP_SCHEMA_VERSION,
} from '../../gui/host/pump-events.js';

const data = await loadData();

const spectatorOf = (state) => projectView(state, data, { kind: 'spectator' });

const seat = (id, name, roleId, over = {}) => ({
  id, token: `SECRET::token.${id}`, name, roleId, kind: 'player',
  connected: true, lastSeen: 1, ...over,
});

/** A game with somebody in it, so a diff has something to be about. */
function seated() {
  const state = createInitialState({ joinCode: 'RAVEN7Z', seed: 42, data });
  state.seats = {
    s1: seat('s1', 'Alice', 'cenred'),
    s2: seat('s2', 'Bryn', 'guthrum_the_old'),
  };
  return state;
}

const digestOf = (state) => publicDigest(spectatorOf(state));

/** The events one change produces, straight from two states. */
const between = (before, after) => deriveEvents(digestOf(before), digestOf(after));

describe('the public digest', () => {
  it('reads the same board whether it is given a projection or the state itself', () => {
    // The redaction guarantee, mechanically. A spectator projection holds
    // exactly the paths the manifest marks PUBLIC, so these two agree only
    // while every field the digest reads is one of them. Reach for a player's
    // silver, a seat's token or an unannounced target and the projection will
    // not have it, and this goes red.
    const state = seated();
    state.phase = { turn: 2, name: 'battle', endsAt: 90, paused: false, pausedRemainingMs: null };
    state.battle.targets = ['lindsey', 'essex'];
    state.shires.lindsey.stewardRoleId = 'halfdan_ragnarsson';

    expect(publicDigest(spectatorOf(state))).toEqual(publicDigest(state));
  });

  it('carries no seat token, and nothing a seat is not', () => {
    const digest = digestOf(seated());
    expect(Object.keys(digest.seats.s1).sort())
      .toEqual(['connected', 'kind', 'name', 'roleId']);
    expect(JSON.stringify(digest)).not.toContain('SECRET::');
  });

  it('survives a view with nothing in it', () => {
    expect(publicDigest({})).toEqual({
      turn: null, phase: null, paused: false, seats: {}, stewards: {}, targets: [],
    });
    expect(() => publicDigest(undefined)).not.toThrow();
  });
});

describe('deriving events', () => {
  it('opens with the position rather than a diff', () => {
    const events = deriveEvents(null, digestOf(seated()));
    expect(events).toEqual([{
      type: 'game.opened',
      data: {
        turn: 1,
        phase: 'lobby',
        paused: false,
        seats: [
          { seatId: 's1', name: 'Alice', roleId: 'cenred', kind: 'player' },
          { seatId: 's2', name: 'Bryn', roleId: 'guthrum_the_old', kind: 'player' },
        ],
      },
    }]);
  });

  it('says nothing when nothing moved', () => {
    const digest = digestOf(seated());
    expect(deriveEvents(digest, digest)).toEqual([]);
  });

  it('reports a phase turning, and what it turned from', () => {
    const before = seated();
    const after = structuredClone(before);
    after.phase = { turn: 1, name: 'team', endsAt: 60, paused: false, pausedRemainingMs: null };

    expect(between(before, after)).toEqual([{
      type: 'game.phase',
      data: {
        turn: 1, phase: 'team', paused: false, previousTurn: 1, previousPhase: 'lobby',
      },
    }]);
  });

  it('treats a pause as a phase event, because to the room it is one', () => {
    const before = seated();
    before.phase.name = 'team';
    const after = structuredClone(before);
    after.phase.paused = true;

    const events = between(before, after);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('game.phase');
    expect(events[0].data.paused).toBe(true);
  });

  it('tells arriving, leaving and coming back apart', () => {
    const before = seated();

    const arrived = structuredClone(before);
    arrived.seats.s3 = seat('s3', 'Cerdic', null);
    expect(between(before, arrived)).toEqual([{
      type: 'seat.joined',
      data: { seatId: 's3', name: 'Cerdic', roleId: null, kind: 'player' },
    }]);

    const gone = structuredClone(before);
    gone.seats.s2.connected = false;
    expect(between(before, gone).map((e) => e.type)).toEqual(['seat.left']);

    // A chair kept: leaving and returning is the same seat, not a new one.
    const back = structuredClone(gone);
    back.seats.s2.connected = true;
    expect(between(gone, back)).toEqual([{
      type: 'seat.returned',
      data: { seatId: 's2', name: 'Bryn', roleId: 'guthrum_the_old', kind: 'player' },
    }]);
  });

  it('reports a role claimed, released and reassigned', () => {
    const before = seated();
    before.seats.s2.roleId = null;

    const claimed = structuredClone(before);
    claimed.seats.s2.roleId = 'guthrum_the_old';
    expect(between(before, claimed)).toEqual([{
      type: 'seat.role',
      data: {
        seatId: 's2', name: 'Bryn', roleId: 'guthrum_the_old', kind: 'player',
        previousRoleId: null,
      },
    }]);

    const released = structuredClone(claimed);
    released.seats.s2.roleId = null;
    expect(between(claimed, released)[0].data)
      .toMatchObject({ roleId: null, previousRoleId: 'guthrum_the_old' });
  });

  it('reports a seat that vanished outright', () => {
    const before = seated();
    const after = structuredClone(before);
    delete after.seats.s2;
    expect(between(before, after).map((e) => e.type)).toEqual(['seat.left']);
  });

  it('reports a shire changing hands, and only that shire', () => {
    const before = seated();
    const after = structuredClone(before);
    after.shires.lindsey.stewardRoleId = 'halfdan_ragnarsson';
    // A castle coming down is a detail of a battle, not a movement.
    after.shires.essex.castles = 0;

    expect(between(before, after)).toEqual([{
      type: 'board.steward',
      data: {
        shireId: 'lindsey',
        stewardRoleId: 'halfdan_ragnarsson',
        previousStewardRoleId: before.shires.lindsey.stewardRoleId,
      },
    }]);
  });

  it('sends the announced target list whole, including when it empties', () => {
    const before = seated();
    const announced = structuredClone(before);
    announced.battle.targets = ['lindsey', 'essex'];
    expect(between(before, announced)).toEqual([{
      type: 'battle.targets',
      data: { turn: 1, shireIds: ['lindsey', 'essex'] },
    }]);

    const cleared = structuredClone(announced);
    cleared.battle.targets = [];
    expect(between(announced, cleared)).toEqual([{
      type: 'battle.targets', data: { turn: 1, shireIds: [] },
    }]);
  });

  it('orders a busy change the same way every time', () => {
    const before = seated();
    const after = structuredClone(before);
    after.phase.name = 'battle';
    after.seats.s3 = seat('s3', 'Cerdic', null);
    after.seats.s1.connected = false;
    after.shires.lindsey.stewardRoleId = 'halfdan_ragnarsson';
    after.battle.targets = ['essex'];

    const once = between(before, after).map((e) => e.type);
    expect(once).toEqual([
      'game.phase', 'seat.left', 'seat.joined', 'board.steward', 'battle.targets',
    ]);
    expect(between(before, after).map((e) => e.type)).toEqual(once);
  });

  it('emits nothing outside the documented set of types', () => {
    const before = seated();
    const after = structuredClone(before);
    after.phase = { turn: 3, name: 'encounter', endsAt: 1, paused: true, pausedRemainingMs: 5 };
    after.seats.s3 = seat('s3', 'Cerdic', 'king_alfred');
    after.seats.s1.roleId = null;
    after.shires.essex.stewardRoleId = null;
    after.battle.targets = ['essex'];

    for (const event of [...deriveEvents(null, digestOf(after)), ...between(before, after)]) {
      expect(EVENT_TYPES).toContain(event.type);
    }
  });
});

describe('the envelope', () => {
  it('writes the six keys in the documented order and counts up from the given seq', () => {
    const stamped = stampEvents(
      [{ type: 'game.phase', data: { turn: 1 } }, { type: 'seat.joined', data: { seatId: 's1' } }],
      { game: 'RAVEN7Z', at: 1730000000000, seq: 7 });

    expect(Object.keys(stamped[0])).toEqual(ENVELOPE_KEYS);
    expect(stamped.map((e) => e.seq)).toEqual([7, 8]);
    expect(stamped[0].v).toBe(PUMP_SCHEMA_VERSION);
    expect(stamped[0].game).toBe('RAVEN7Z');
    expect(stamped[0].at).toBe(1730000000000);
  });

  it('encodes a batch as newline-terminated JSON lines', () => {
    const body = encodeBatch(stampEvents(
      [{ type: 'game.phase', data: {} }, { type: 'seat.joined', data: {} }],
      { game: 'RAVEN7Z', at: 1, seq: 0 }));

    expect(body.endsWith('\n')).toBe(true);
    const lines = body.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});

describe('what an event may carry', () => {
  /**
   * The same trick the redaction test uses: every secret is a unique sentinel,
   * so a leak is findable by string search rather than by knowing to look for
   * it. If any of these reaches the wire the pump is describing the game to an
   * outside service in terms no outside service is entitled to.
   */
  function fullOfSecrets() {
    const state = seated();
    state.seats.s1.token = 'SECRET::token.alice';
    state.roles.cenred.silver = 4242;
    state.roles.guthrum_the_old.silver = 9191;
    state.roles.cenred.mercenary = true;
    state.phase = { turn: 2, name: 'battle', endsAt: 5, paused: false, pausedRemainingMs: null };
    state.initiative.declared = {
      white: {
        roleId: 'guthrum_the_old',
        shireId: 'SECRET::initiative.unannounced',
        revealed: false,
      },
    };
    state.battle.targets = ['lindsey'];
    state.battle.clashes = {
      c1: {
        id: 'c1',
        shireId: 'lindsey',
        stage: 'awaiting_tactics',
        auto: false,
        attacker: 'guthrum_the_old',
        defender: 'cenred',
        tactic: { guthrum_the_old: 'SECRET::clash.tactic', cenred: '3' },
        lead: { guthrum_the_old: null, cenred: null },
        reinforcements: {},
        rolls: { guthrum_the_old: 'SECRET::clash.roll', cenred: null },
        result: null,
        amendWindowEndsAt: null,
      },
    };
    state.envoys = {
      e1: {
        roleId: 'cenred', npcFaction: 'franks', open: true,
        messages: ['SECRET::envoy.message'],
      },
    };
    state.concessions = { c1: { roleId: 'cenred', text: 'SECRET::concession' } };
    state.facilitatorNotes = { plan: 'SECRET::facilitatorNotes' };
    state.seed = 'SECRET::seed';
    state.log = [{ verb: 'SECRET::log.verb', payload: {} }];
    state.shires.lindsey.stewardRoleId = 'halfdan_ragnarsson';
    return state;
  }

  it('lets no secret out, in a snapshot or in a diff', () => {
    const loaded = fullOfSecrets();
    const emitted = JSON.stringify([
      ...deriveEvents(null, digestOf(loaded)),
      ...between(seated(), loaded),
    ]);

    expect(emitted).not.toContain('SECRET::');
    // Named individually as well, because a sentinel search only catches what
    // somebody remembered to make a sentinel.
    expect(emitted).not.toContain('4242');
    expect(emitted).not.toContain('9191');
    expect(emitted).not.toContain('mercenary');
    expect(emitted).not.toContain('tactic');
    expect(emitted).not.toContain('envoy');
    expect(emitted).not.toContain('concession');
  });

  it('still describes the game while it is doing that', () => {
    // The check above would pass on a pump that said nothing at all.
    const types = between(seated(), fullOfSecrets()).map((e) => e.type);
    expect(types).toContain('game.phase');
    expect(types).toContain('board.steward');
    expect(types).toContain('battle.targets');
  });
});
