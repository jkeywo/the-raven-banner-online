import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply } from '../../gui/rules/reducer.js';
import { admit } from '../../gui/rules/admission.js';
import {
  aftermath, isChristian, isDanishHeld, momentumGain, incomeFor,
} from '../../gui/rules/derive.js';

const data = await loadData();
const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };

function playing(roleId, phaseName = 'encounter') {
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

describe('missionaries', () => {
  it('go to Danish shires and nowhere else', () => {
    const { state, actor } = playing('abbess_wenyld', 'maintenance');
    state.roles.abbess_wenyld.momentum = 2;
    expect(isDanishHeld(state, data, 'jorvik')).toBe(true);
    expect(isDanishHeld(state, data, 'wiltshire')).toBe(false);

    const after = run(state, actor, 'missionary-expedition', { shireId: 'jorvik' });
    expect(after.shires.jorvik.missionaryCross).toBe(true);
    expect(after.roles.abbess_wenyld.momentum).toBe(1);

    expect(refusal(state, actor, 'missionary-expedition', { shireId: 'wiltshire' }))
      .toContain('Danish shires');
  });

  it('take a shire out of the pagan count', () => {
    // The whole point of a cross: the shire stops reading as pagan at the end,
    // without anybody having to take it.
    const { state, actor } = playing('abbess_wenyld', 'maintenance');
    state.roles.abbess_wenyld.momentum = 2;
    expect(aftermath(state, data).paganism.value).toBe(3);
    const after = run(state, actor, 'missionary-expedition', { shireId: 'jorvik' });
    expect(aftermath(after, data).paganism.value).toBe(2);
    // Still Danish, though — a cross converts nobody by itself.
    expect(aftermath(after, data).danelaw.value).toBe(3);
  });

  it('let the priest reinforce where the cross stands', () => {
    // Already built, but this is the reward the missionary is buying.
    const { state, actor } = playing('abbess_wenyld', 'maintenance');
    state.roles.abbess_wenyld.momentum = 3;
    let after = run(state, actor, 'missionary-expedition', { shireId: 'jorvik' });
    const target = Object.values(after.shires.jorvik.settlements).find((s) => !s.defended);
    after = run(after, actor, 'reinforce', { shireId: 'jorvik', settlementId: target.id });
    expect(after.shires.jorvik.settlements[target.id].defended).toBe(true);
  });

  it('will not go twice to the same shire', () => {
    const { state, actor } = playing('abbess_wenyld', 'maintenance');
    state.roles.abbess_wenyld.momentum = 3;
    const after = run(state, actor, 'missionary-expedition', { shireId: 'jorvik' });
    expect(refusal(after, actor, 'missionary-expedition', { shireId: 'jorvik' }))
      .toContain('already stands');
  });

  it('are not for a warrior to send', () => {
    const { state, actor } = playing('king_alfred', 'maintenance');
    state.roles.king_alfred.momentum = 2;
    expect(refusal(state, actor, 'missionary-expedition', { shireId: 'jorvik' }))
      .toBe('only a priest sends missionaries');
  });
});

describe('a rousing sermon', () => {
  it('puts a soldier in another Christian’s hand', () => {
    const { state, actor } = playing('abbess_wenyld');
    state.roles.abbess_wenyld.momentum = 2;
    const before = state.roles.king_alfred.soldiers;
    const after = run(state, actor, 'rousing-sermon', { targetRoleId: 'king_alfred' });
    expect(after.roles.king_alfred.soldiers).toBe(before + 1);
    expect(after.roles.abbess_wenyld.momentum).toBe(1);
  });

  it('is wasted on a heathen', () => {
    const { state, actor } = playing('abbess_wenyld');
    state.roles.abbess_wenyld.momentum = 2;
    expect(refusal(state, actor, 'rousing-sermon', { targetRoleId: 'guthrum_the_old' }))
      .toBe('they are not a Christian');
  });

  it('reaches a Dane once he has been baptised', () => {
    const { state, actor } = playing('abbess_wenyld');
    state.roles.abbess_wenyld.momentum = 4;
    const converted = run(state, actor, 'baptise',
      { targetRoleId: 'guthrum_the_old', willing: true });
    expect(isChristian(converted, data, 'guthrum_the_old')).toBe(true);
    expect(admit(converted, data, { verb: 'rousing-sermon', payload: { targetRoleId: 'guthrum_the_old' } },
      actor).ok).toBe(true);
  });
});

describe('baptism', () => {
  it('needs the pagan to agree', () => {
    // The app never converts anybody against their will; willingness is agreed
    // out loud and confirmed here.
    const { state, actor } = playing('abbess_wenyld');
    expect(refusal(state, actor, 'baptise', { targetRoleId: 'guthrum_the_old' }))
      .toBe('they have to agree to it');
    expect(refusal(state, actor, 'baptise', { targetRoleId: 'king_alfred', willing: true }))
      .toBe('they are already Christian');
  });

  it('ends the followers’ upkeep', () => {
    // The largest part of why a Dane would consider it.
    const { state, actor } = playing('abbess_wenyld');
    const converted = run(state, actor, 'baptise',
      { targetRoleId: 'halfdan_ragnarsson', willing: true });

    const halfdan = { seatId: 's2', kind: 'player', roleId: 'halfdan_ragnarsson' };
    let maintenance = converted;
    while (maintenance.phase.name !== 'maintenance') {
      maintenance = apply(maintenance, data, { verb: 'facilitator:advance-phase', payload: {} },
        FACILITATOR, { ts: 0 }).state;
    }
    // No upkeep question asked, and no soldier lost.
    expect(admit(maintenance, data, { verb: 'collect-income', payload: {} }, halfdan).ok).toBe(true);
    const after = run(maintenance, halfdan, 'collect-income');
    expect(after.roles.halfdan_ragnarsson.soldiers).toBe(12);
  });

  it('keeps his support where he has settled', () => {
    // The printed support rule says "Danes", not "pagan Danes", so conversion
    // does not cost him the ground he has already taken.
    const { state, actor } = playing('abbess_wenyld');
    state.shires.jorvik.danishSupport = true;
    const converted = run(state, actor, 'baptise',
      { targetRoleId: 'halfdan_ragnarsson', willing: true });
    expect(incomeFor(converted, data, 'halfdan_ragnarsson').silver)
      .toBe(incomeFor(state, data, 'halfdan_ragnarsson').silver);
  });

  it('grants a claim on every Danish shire the church had reached', () => {
    const { state, actor } = playing('abbess_wenyld', 'maintenance');
    state.roles.abbess_wenyld.momentum = 4;
    let after = run(state, actor, 'missionary-expedition', { shireId: 'jorvik' });
    while (after.phase.name !== 'encounter') {
      after = apply(after, data, { verb: 'facilitator:advance-phase', payload: {} },
        FACILITATOR, { ts: 0 }).state;
    }
    after = run(after, actor, 'baptise', { targetRoleId: 'guthrum_the_old', willing: true });
    // Jorvik has a cross and is Danish-held; East Anglia is Danish but has none.
    expect(after.roles.guthrum_the_old.deJureShires).toEqual(['jorvik']);
  });

  it('takes a shire out of the pagan count without a cross', () => {
    const { state, actor } = playing('abbess_wenyld');
    expect(aftermath(state, data).paganism.value).toBe(3);
    const after = run(state, actor, 'baptise',
      { targetRoleId: 'halfdan_ragnarsson', willing: true });
    // Halfdan holds Jorvik and Ribble; neither is pagan any more.
    expect(aftermath(after, data).paganism.value).toBe(1);
    // But they are still Danish shires, so the Danelaw is untouched.
    expect(aftermath(after, data).danelaw.value).toBe(3);
  });

  it('counts two churches for the priest who performed it', () => {
    // A missionary who converts three Danes has effectively built six
    // churches, which is what can push a faction over the ten.
    const { state, actor } = playing('abbess_wenyld');
    const strip = (shireId) => {
      for (const s of Object.values(state.shires[shireId].settlements)) {
        if (s.type === 'church') s.destroyed = true;
      }
    };
    for (const id of ['wrekinsets', 'magonsets', 'north_mercia', 'lindsey',
      'middle_anglia', 'lundenwic', 'hwicce', 'south_mercia']) strip(id);
    expect(momentumGain(state, data, 'abbess_wenyld')).toBe(2);

    let after = state;
    for (const pagan of ['halfdan_ragnarsson', 'guthrum_the_old', 'ubba_ragnarsson',
      'gyda_the_bold', 'anwend_the_steady']) {
      after = run(after, actor, 'baptise', { targetRoleId: pagan, willing: true });
    }
    expect(after.roles.abbess_wenyld.baptismsPerformed).toBe(5);
    expect(momentumGain(after, data, 'abbess_wenyld')).toBe(3);   // 5 x 2 = 10
  });

  it('is not for a warrior to perform', () => {
    const { state, actor } = playing('king_alfred');
    expect(refusal(state, actor, 'baptise', { targetRoleId: 'guthrum_the_old', willing: true }))
      .toBe('only a priest baptises');
  });
});
