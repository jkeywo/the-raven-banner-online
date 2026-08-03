import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply, replay } from '../../gui/rules/reducer.js';
import { admit, availableTo } from '../../gui/rules/admission.js';
import { toSave, overrides } from '../../gui/rules/command-log.js';
import { roll, mulberry32 } from '../../gui/rules/rng.js';

const data = await loadData();

const PLAYER = { seatId: 's1', kind: 'player', roleId: 'king_alfred' };
const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };

function seated() {
  const state = createInitialState({ joinCode: 'TESTING', seed: 42, data });
  state.seats.s1 = { id: 's1', token: 't1', name: 'A', roleId: 'king_alfred', kind: 'player', connected: true, lastSeen: 0 };
  state.seats.s9 = { id: 's9', token: 't9', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
  return state;
}

/** Run a script of [actor, verb, payload] and return the final state. */
function run(state, script) {
  return script.reduce((at, [actor, verb, payload]) => {
    const result = apply(at, data, { verb, payload }, actor, { ts: 0 });
    if (!result.ok) throw new Error(`${verb} refused: ${result.reason}`);
    return result.state;
  }, state);
}

describe('admission', () => {
  it('refuses a command from the wrong phase, and says which', () => {
    const verdict = admit(seated(), data, { verb: 'recruit-soldiers' }, PLAYER);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('maintenance');
    expect(verdict.reason).toContain('lobby');
  });

  it('refuses a facilitator command from a player', () => {
    const verdict = admit(seated(), data, { verb: 'facilitator:set' }, PLAYER);
    expect(verdict).toMatchObject({ ok: false, reason: 'only a facilitator may do that' });
  });

  it('says what is missing rather than just no', () => {
    const state = run(seated(), [[FACILITATOR, 'facilitator:advance-phase', {}]]);
    const broke = structuredClone(state);
    broke.phase.name = 'maintenance';
    broke.roles.king_alfred.silver = 2;
    const verdict = admit(broke, data, { verb: 'recruit-soldiers' }, PLAYER);
    expect(verdict.reason).toBe('not enough silver — you have 2, this costs 5');
  });

  it('lists what a seat could do now, with reasons for what it cannot', () => {
    const state = seated();
    state.phase.name = 'maintenance';
    state.roles.king_alfred.silver = 0;
    const list = availableTo(state, data, PLAYER);
    const recruit = list.find((c) => c.verb === 'recruit-soldiers');
    expect(recruit).toMatchObject({ ok: false });
    expect(recruit.reason).toContain('not enough silver');
    expect(list.map((c) => c.verb)).not.toContain('declare-initiative-target');
  });
});

describe('a rejected command changes nothing', () => {
  it('returns the same object it was given', () => {
    const before = seated();
    const result = apply(before, data, { verb: 'recruit-soldiers' }, PLAYER, {});
    expect(result.ok).toBe(false);
    expect(result.state).toBe(before);
    expect(before.log).toHaveLength(0);
  });
});

describe('commands', () => {
  it('claims a role, and refuses one already being played', () => {
    let state = createInitialState({ joinCode: 'T', seed: 1, data });
    state.seats.s1 = { id: 's1', token: 't1', name: 'A', roleId: null, kind: 'player', connected: true, lastSeen: 0 };
    state.seats.s2 = { id: 's2', token: 't2', name: 'B', roleId: null, kind: 'player', connected: true, lastSeen: 0 };
    state = run(state, [[{ seatId: 's1', kind: 'player', roleId: null }, 'claim-role', { roleId: 'cenred' }]]);
    expect(state.seats.s1.roleId).toBe('cenred');

    const clash = admit(state, data, { verb: 'claim-role', payload: { roleId: 'cenred' } },
      { seatId: 's2', kind: 'player', roleId: null });
    expect(clash).toMatchObject({ ok: false });
    expect(clash.reason).toContain('already being played');
  });

  it('trades asymmetrically, as printed', () => {
    let state = seated();
    state.phase.name = 'maintenance';
    const before = state.roles.king_alfred;
    state = run(state, [[PLAYER, 'trade', { give: 'food' }]]);
    // One food sells for two silver...
    expect(state.roles.king_alfred.silver).toBe(before.silver + 2);
    expect(state.roles.king_alfred.food).toBe(before.food - 1);
    // ...and a second trade is refused, because it is once per turn.
    expect(admit(state, data, { verb: 'trade', payload: { give: 'food' } }, PLAYER).reason)
      .toContain('as often as you may');
  });

  it('lets the Danish trader trade twice', () => {
    let state = seated();
    state.phase.name = 'maintenance';
    state.seats.s1.roleId = 'frida_anundottir';
    const frida = { seatId: 's1', kind: 'player', roleId: 'frida_anundottir' };
    state = run(state, [[frida, 'trade', { give: 'food' }], [frida, 'trade', { give: 'food' }]]);
    expect(state.roles.frida_anundottir.perTurn.tradesUsed).toBe(2);
    expect(admit(state, data, { verb: 'trade', payload: { give: 'food' } }, frida).ok).toBe(false);
  });

  it('refuses homage that would close a circle', () => {
    const state = seated();
    state.phase.name = 'team';
    // Alfred is Cenred's liege already, so Alfred swearing to Cenred would
    // make each of them the other's lord and the support rule walk forever.
    const verdict = admit(state, data,
      { verb: 'swear-allegiance', payload: { liegeId: 'cenred' } }, PLAYER);
    expect(verdict).toMatchObject({ ok: false });
    expect(verdict.reason).toContain('circle');
  });

  it('announces team-scoped targets when the battle phase opens', () => {
    let state = seated();
    state.seats.s1.roleId = 'halfdan_ragnarsson';
    const halfdan = { seatId: 's1', kind: 'player', roleId: 'halfdan_ragnarsson' };
    state = run(state, [
      [FACILITATOR, 'facilitator:advance-phase', {}],                 // lobby -> team
      [halfdan, 'declare-initiative-target', { shireId: 'lindsey' }],
    ]);
    expect(state.initiative.declared.white.revealed).toBe(false);
    state = run(state, [[FACILITATOR, 'facilitator:advance-phase', {}]]);  // team -> battle
    expect(state.phase.name).toBe('battle');
    expect(state.initiative.declared.white.revealed).toBe(true);
  });

  it('resets per-turn allowances when the turn rolls over', () => {
    let state = seated();
    state.phase.name = 'encounter';
    state.roles.king_alfred.perTurn.tradesUsed = 1;
    state = run(state, [[FACILITATOR, 'facilitator:advance-phase', {}]]);
    expect(state.phase.turn).toBe(2);
    expect(state.phase.name).toBe('team');
    expect(state.roles.king_alfred.perTurn.tradesUsed).toBe(0);
  });
});

describe('facilitator overrides', () => {
  it('go through the reducer and are marked in the log', () => {
    const state = run(seated(), [[FACILITATOR, 'facilitator:set',
      { path: ['roles', 'king_alfred', 'silver'], value: 99 }]]);
    expect(state.roles.king_alfred.silver).toBe(99);
    expect(overrides(state.log)).toHaveLength(1);
    expect(state.log[0]).toMatchObject({ verb: 'facilitator:set', override: true });
  });
});

describe('replay', () => {
  it('rebuilds a game from its seed and log alone', () => {
    // The strongest single assertion in the suite: it exercises every reducer
    // path the script touches, and it is what makes a save file a few
    // kilobytes of history rather than a snapshot that can disagree with it.
    let state = seated();
    const halfdan = { seatId: 's2', kind: 'player', roleId: 'halfdan_ragnarsson' };
    state.seats.s2 = { id: 's2', token: 't2', name: 'H', roleId: 'halfdan_ragnarsson', kind: 'player', connected: true, lastSeen: 0 };

    state = run(state, [
      [FACILITATOR, 'facilitator:advance-phase', {}],
      [halfdan, 'declare-initiative-target', { shireId: 'lindsey' }],
      [PLAYER, 'swear-allegiance', { liegeId: null }],
      [FACILITATOR, 'facilitator:advance-phase', {}],
      [FACILITATOR, 'facilitator:advance-phase', {}],
      [PLAYER, 'collect-income', {}],
      [PLAYER, 'recruit-soldiers', {}],
      [PLAYER, 'trade', { give: 'silver' }],
      [FACILITATOR, 'facilitator:set', { path: ['aftermath', 'foreignInfluence'], value: 'Frankish gold' }],
    ]);

    const { state: rebuilt, refused } = replay(toSave(state), data);
    expect(refused).toEqual([]);

    // Seats are runtime, not history, so compare everything the rules own.
    const { seats: _a, seatByToken: _b, ...expected } = state;
    const { seats: _c, seatByToken: _d, ...actual } = rebuilt;
    expect(actual).toEqual(expected);
  });

  it('refuses a tampered entry rather than replaying it', () => {
    const state = run(seated(), [[FACILITATOR, 'facilitator:advance-phase', {}]]);
    const save = toSave(state);
    save.log = [...save.log, {
      seq: 99, ts: 0, seatId: 's1', roleId: 'king_alfred', verb: 'recruit-soldiers',
      payload: {}, rngCursorBefore: 0, override: false,
    }];
    const { refused } = replay(save, data);
    // The team phase is not the maintenance phase, so this never happened.
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ verb: 'recruit-soldiers' });
  });
});

describe('dice', () => {
  it('are a pure function of seed and cursor', () => {
    expect(roll(42, 0)).toEqual(roll(42, 0));
    expect(roll(42, 0).cursor).toBe(1);
    expect(roll(42, 0).value).not.toBe(roll(99, 0).value);
  });

  it('land on every face and stay inside them', () => {
    const next = mulberry32(2024);
    const seen = new Set();
    for (let i = 0; i < 600; i++) {
      const face = 1 + Math.floor(next() * 6);
      expect(face).toBeGreaterThanOrEqual(1);
      expect(face).toBeLessThanOrEqual(6);
      seen.add(face);
    }
    expect(seen.size).toBe(6);
  });
});
