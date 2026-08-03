import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply } from '../../gui/rules/reducer.js';
import { admit } from '../../gui/rules/admission.js';
import { factionReach, shiresOfFaction, shipCost } from '../../gui/rules/derive.js';

const data = await loadData();
const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };

function playing(roleId, phaseName = 'maintenance') {
  let state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
  state.seats.s1 = { id: 's1', token: 't', name: 'A', roleId, kind: 'player', connected: true, lastSeen: 0 };
  state.seats.s9 = { id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
  while (state.phase.name !== phaseName) {
    state = apply(state, data, { verb: 'facilitator:advance-phase', payload: {} },
      FACILITATOR, { ts: 0 }).state;
  }
  return { state, actor: { seatId: 's1', kind: 'player', roleId } };
}

function run(state, actor, verb, payload = {}) {
  const result = apply(state, data, { verb, payload }, actor, { ts: 0 });
  if (!result.ok) throw new Error(`${verb} refused: ${result.reason}`);
  return result.state;
}

const refusal = (state, actor, verb, payload = {}) =>
  admit(state, data, { verb, payload }, actor).reason;

describe('a faction reaches further than a person', () => {
  it('covers what the faction holds and everything beside it', () => {
    const { state } = playing('king_alfred');
    const wessex = shiresOfFaction(state, 'wessex');
    expect(wessex).toContain('wiltshire');
    const reach = factionReach(state, data, 'wessex');
    // Its own shires, and their neighbours.
    for (const id of wessex) expect(reach).toContain(id);
    expect(reach).toContain('hwicce');       // borders Wiltshire
    expect(reach).not.toContain('bernicia'); // the far end of England
  });

  it('lets a landless man raid beside his jarl’s conquest', () => {
    // Most of what a landless Dane is for. Ubba holds nothing at all, but the
    // Great Heathen Army holds Jorvik.
    const { state } = playing('ubba_ragnarsson', 'encounter');
    expect(shiresOfFaction(state, 'great_heathen_army')).toContain('jorvik');
    expect(factionReach(state, data, 'great_heathen_army')).toContain('lindsey');
  });
});

describe('raiding', () => {
  it('burns a settlement and carries off what it was worth', () => {
    const { state, actor } = playing('halfdan_ragnarsson', 'encounter');
    state.roles.halfdan_ragnarsson.momentum = 4;
    // Lindsey borders Jorvik, which the Great Heathen Army holds.
    const target = Object.values(state.shires.lindsey.settlements)
      .find((s) => s.type === 'church' && !s.defended);
    const before = state.roles.halfdan_ragnarsson.silver;

    const after = run(state, actor, 'raid-settlement',
      { shireId: 'lindsey', settlementId: target.id });
    expect(after.shires.lindsey.settlements[target.id].destroyed).toBe(true);
    expect(after.roles.halfdan_ragnarsson.silver).toBe(before + 5);   // a church
    expect(after.roles.halfdan_ragnarsson.momentum).toBe(2);
  });

  it('pays a farm in food and a town in silver', () => {
    expect(data.meta.raidSpoils).toEqual({
      farm: { food: 2 }, town: { silver: 4 }, church: { silver: 5 },
    });
  });

  it('costs two soldiers more to storm a defended one', () => {
    const { state, actor } = playing('halfdan_ragnarsson', 'encounter');
    state.roles.halfdan_ragnarsson.momentum = 4;
    const target = Object.values(state.shires.lindsey.settlements).find((s) => s.defended);
    const before = state.roles.halfdan_ragnarsson.soldiers;
    const after = run(state, actor, 'raid-settlement',
      { shireId: 'lindsey', settlementId: target.id });
    expect(after.roles.halfdan_ragnarsson.soldiers).toBe(before - 2);

    const broke = playing('halfdan_ragnarsson', 'encounter');
    broke.state.roles.halfdan_ragnarsson.momentum = 4;
    broke.state.roles.halfdan_ragnarsson.soldiers = 1;
    expect(refusal(broke.state, broke.actor, 'raid-settlement',
      { shireId: 'lindsey', settlementId: target.id })).toContain('not enough soldiers');
  });

  it('does not care whether the holder had support', () => {
    // Income is gated on support; burning the place is not. A settlement that
    // pays its holder nothing is still perfectly worth taking a torch to.
    const { state, actor } = playing('halfdan_ragnarsson', 'encounter');
    state.roles.halfdan_ragnarsson.momentum = 4;
    const target = Object.values(state.shires.lindsey.settlements).find((s) => !s.defended);
    expect(admit(state, data, { verb: 'raid-settlement', payload: { shireId: 'lindsey', settlementId: target.id } },
      actor).ok).toBe(true);
  });

  it('will not reach across the country', () => {
    const { state, actor } = playing('halfdan_ragnarsson', 'encounter');
    state.roles.halfdan_ragnarsson.momentum = 4;
    const target = Object.values(state.shires.kent.settlements)[0];
    expect(refusal(state, actor, 'raid-settlement', { shireId: 'kent', settlementId: target.id }))
      .toContain('holds nothing next to that shire');
  });

  it('will not burn the same place twice', () => {
    const { state, actor } = playing('halfdan_ragnarsson', 'encounter');
    state.roles.halfdan_ragnarsson.momentum = 4;
    const target = Object.values(state.shires.lindsey.settlements).find((s) => !s.defended);
    const after = run(state, actor, 'raid-settlement',
      { shireId: 'lindsey', settlementId: target.id });
    expect(refusal(after, actor, 'raid-settlement', { shireId: 'lindsey', settlementId: target.id }))
      .toContain('already burned it');
  });

  it('is an encounter-phase action', () => {
    const { state, actor } = playing('halfdan_ragnarsson', 'maintenance');
    state.roles.halfdan_ragnarsson.momentum = 4;
    const target = Object.values(state.shires.lindsey.settlements)[0];
    expect(refusal(state, actor, 'raid-settlement', { shireId: 'lindsey', settlementId: target.id }))
      .toContain('encounter');
  });
});

describe('raising the banners', () => {
  it('gains soldiers equal to the turn, once a game', () => {
    // Worth more the longer you hold it: the whole design of the card is
    // "save this for when it matters".
    const { state, actor } = playing('king_alfred');
    state.phase.turn = 4;
    const before = state.roles.king_alfred.soldiers;
    const after = run(state, actor, 'raise-christian-banners');
    expect(after.roles.king_alfred.soldiers).toBe(before + 4);
    expect(refusal(after, actor, 'raise-christian-banners')).toContain('once already');
  });

  it('needs three churches', () => {
    const { state, actor } = playing('king_alfred');
    // Strip Wessex's churches down below the line.
    let left = 3;
    for (const id of ['wiltshire', 'west_country']) {
      for (const settlement of Object.values(state.shires[id].settlements)) {
        if (settlement.type === 'church' && left > 0) { left -= 1; continue; }
        if (settlement.type === 'church') settlement.destroyed = true;
      }
    }
    state.shires.wiltshire.settlements[
      Object.values(state.shires.wiltshire.settlements).find((s) => s.type === 'church').id
    ].destroyed = true;
    expect(refusal(state, actor, 'raise-christian-banners')).toMatch(/churches and this needs 3/);
  });

  it('is not for a heathen', () => {
    const { state, actor } = playing('halfdan_ragnarsson');
    expect(refusal(state, actor, 'raise-christian-banners')).toBe('the banners are Christian');
  });
});

describe('a defensive fleet', () => {
  it('makes a coastal shire dearer to reach', () => {
    const { state, actor } = playing('king_alfred');
    state.roles.king_alfred.ships = 2;
    const before = shipCost(state, data, 'wiltshire');
    const after = run(state, actor, 'defensive-fleet', { shireId: 'wiltshire' });
    expect(shipCost(after, data, 'wiltshire')).toBe(before + 1);
    expect(after.roles.king_alfred.ships).toBe(0);
  });

  it('has nothing to guard inland', () => {
    const { state, actor } = playing('gainbeald');
    state.roles.gainbeald.ships = 4;
    expect(data.shires.shires.north_mercia.shipCost).toBe(null);
    expect(refusal(state, actor, 'defensive-fleet', { shireId: 'north_mercia' }))
      .toContain('no coast');
  });
});

describe('rebuilding', () => {
  it('puts a burned settlement back, undefended', () => {
    // Rebuilding a place is not the same as walling it.
    const { state, actor } = playing('king_alfred');
    state.roles.king_alfred.silver = 8;
    const ruin = Object.values(state.shires.wiltshire.settlements)[0];
    ruin.destroyed = true;
    ruin.defended = true;

    const after = run(state, actor, 'rebuild-settlement',
      { shireId: 'wiltshire', settlementId: ruin.id });
    expect(after.shires.wiltshire.settlements[ruin.id])
      .toMatchObject({ destroyed: false, defended: false });
    expect(after.roles.king_alfred.silver).toBe(2);
  });

  it('has nothing to rebuild where nothing burned', () => {
    const { state, actor } = playing('king_alfred');
    state.roles.king_alfred.silver = 8;
    const standing = Object.values(state.shires.wiltshire.settlements)[0];
    expect(refusal(state, actor, 'rebuild-settlement',
      { shireId: 'wiltshire', settlementId: standing.id })).toContain('still standing');
  });
});

describe('a trade contract pays both signatories', () => {
  it('gives the steward their two silver as well as the trader', () => {
    // Paying only the trader would make the deal worthless to the person being
    // asked for a soldier — which is the half that has to be persuaded.
    const { state } = playing('king_alfred');
    state.contracts = [{
      id: 'c1', shireId: 'west_country', traderRoleId: 'frida_anundottir', status: 'active',
    }];
    const alfred = { seatId: 's1', kind: 'player', roleId: 'king_alfred' };
    const before = state.roles.king_alfred.silver;
    const income = run(state, alfred, 'collect-income').roles.king_alfred.silver;

    const without = playing('king_alfred');
    const baseline = run(without.state, alfred, 'collect-income').roles.king_alfred.silver;
    expect(income).toBe(baseline + 2);
    expect(before).toBe(4);
  });
});
