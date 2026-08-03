import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply, replay } from '../../gui/rules/reducer.js';
import { admit } from '../../gui/rules/admission.js';
import { toSave } from '../../gui/rules/command-log.js';
import { neighbourStewards } from '../../gui/rules/commands.js';
import { hasSupport, aftermath } from '../../gui/rules/derive.js';

const data = await loadData();
const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };

function playing(phaseName = 'maintenance') {
  let state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
  state.seats.s9 = { id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
  while (state.phase.name !== phaseName) {
    state = apply(state, data, { verb: 'facilitator:advance-phase', payload: {} },
      FACILITATOR, { ts: 0 }).state;
  }
  return state;
}

const as = (roleId) => ({ seatId: `s-${roleId}`, kind: 'player', roleId });

function run(state, actor, verb, payload = {}) {
  const result = apply(state, data, { verb, payload }, actor, { ts: 0 });
  if (!result.ok) throw new Error(`${verb} refused: ${result.reason}`);
  return result.state;
}

const refusal = (state, actor, verb, payload = {}) =>
  admit(state, data, { verb, payload }, actor).reason;

/**
 * Halfdan, with the momentum to spare, asks to settle Jorvik.
 * Returns the state and the request id.
 */
function asking(state = playing()) {
  state.roles.halfdan_ragnarsson.momentum = 2;
  const after = run(state, as('halfdan_ragnarsson'), 'request-settle', { shireId: 'jorvik' });
  return { state: after, id: Object.keys(after.consents)[0] };
}

describe('who has to agree', () => {
  it('is every neighbour with somebody in charge of it', () => {
    const state = playing();
    const asked = neighbourStewards(state, data, 'jorvik', 'halfdan_ragnarsson');
    // Jorvik borders Bernicia, Lindsey, North Mercia and Ribble. Ribble is
    // Halfdan's own, so he does not need his own permission.
    expect(asked).toEqual(['gainbeald', 'king_ecgberht']);
  });

  it('leaves an unheld shire silent rather than obstructive', () => {
    const state = playing();
    // Gainbeald holds both Lindsey and North Mercia; take away the pair and
    // there is nobody on that side of the border to object.
    state.shires.lindsey.stewardRoleId = null;
    state.shires.north_mercia.stewardRoleId = null;
    expect(neighbourStewards(state, data, 'jorvik', 'halfdan_ragnarsson'))
      .toEqual(['king_ecgberht']);
  });

  it('counts a neighbour once, however many border shires they hold', () => {
    const state = playing();
    expect(neighbourStewards(state, data, 'jorvik', 'halfdan_ragnarsson')
      .filter((who) => who === 'gainbeald')).toHaveLength(1);
  });
});

describe('asking', () => {
  it('costs nothing until it carries', () => {
    // Asking is free; a refusal should cost the asker nothing but the time.
    const { state } = asking();
    expect(state.roles.halfdan_ragnarsson).toMatchObject(
      { silver: 8, soldiers: 12, momentum: 2 });
  });

  it('is refused outright if the asker could never afford it', () => {
    // No point putting three neighbours through a vote he cannot pay for.
    const state = playing();
    state.roles.halfdan_ragnarsson.momentum = 2;
    state.roles.halfdan_ragnarsson.silver = 1;
    expect(refusal(state, as('halfdan_ragnarsson'), 'request-settle', { shireId: 'jorvik' }))
      .toContain('silver');
  });

  it('is for Danes, in shires they steward', () => {
    const state = playing();
    state.roles.king_alfred.momentum = 2;
    state.roles.halfdan_ragnarsson.momentum = 2;
    expect(refusal(state, as('king_alfred'), 'request-settle', { shireId: 'wiltshire' }))
      .toBe('only Danes settle');
    expect(refusal(state, as('halfdan_ragnarsson'), 'request-settle', { shireId: 'lindsey' }))
      .toContain('a shire you steward');
  });

  it('will not settle the same shire twice', () => {
    const state = playing();
    state.roles.halfdan_ragnarsson.momentum = 2;
    state.shires.jorvik.danishSupport = true;
    expect(refusal(state, as('halfdan_ragnarsson'), 'request-settle', { shireId: 'jorvik' }))
      .toContain('already settled');
  });

  it('will not run two rounds about the same shire at once', () => {
    const { state } = asking();
    expect(refusal(state, as('halfdan_ragnarsson'), 'request-settle', { shireId: 'jorvik' }))
      .toContain('already asking');
  });
});

describe('answering', () => {
  it('carries once every neighbour has said yes, and only then charges', () => {
    let { state, id } = asking();
    state.roles.halfdan_ragnarsson.momentum = 2;

    state = run(state, as('gainbeald'), 'answer-consent', { consentId: id, granted: true });
    expect(state.consents[id].resolved).toBe(false);       // still one to go
    expect(state.shires.jorvik.danishSupport).toBe(false);

    state = run(state, as('king_ecgberht'), 'answer-consent', { consentId: id, granted: true });
    expect(state.consents[id]).toMatchObject({ resolved: true, outcome: 'granted' });
    expect(state.shires.jorvik.danishSupport).toBe(true);
    expect(state.roles.halfdan_ragnarsson).toMatchObject(
      { momentum: 1, soldiers: 9, silver: 3 });
  });

  it('ends on the first refusal, without waiting for the rest', () => {
    // The requirement is consent from *all* of them, so one no settles it.
    let { state, id } = asking();
    state = run(state, as('gainbeald'), 'answer-consent', { consentId: id, granted: false });
    expect(state.consents[id]).toMatchObject({ resolved: true, outcome: 'refused' });
    expect(state.shires.jorvik.danishSupport).toBe(false);
    // And nothing was spent.
    expect(state.roles.halfdan_ragnarsson.silver).toBe(8);
  });

  it('defends two settlements when it carries', () => {
    let { state, id } = asking();
    state.roles.halfdan_ragnarsson.momentum = 2;
    const before = Object.values(state.shires.jorvik.settlements).filter((s) => s.defended).length;
    for (const who of ['gainbeald', 'king_ecgberht']) {
      state = run(state, as(who), 'answer-consent', { consentId: id, granted: true });
    }
    const after = Object.values(state.shires.jorvik.settlements).filter((s) => s.defended).length;
    expect(after).toBe(Math.min(before + 2, Object.keys(state.shires.jorvik.settlements).length));
  });

  it('turns a Danish shire supported, which is the whole point', () => {
    // Without support a Dane's defended settlements pay him nothing, and the
    // shire counts toward Disorder at the end. Settling fixes both.
    let { state, id } = asking();
    state.roles.halfdan_ragnarsson.momentum = 2;
    expect(hasSupport(state, data, 'jorvik')).toBe(false);
    expect(aftermath(state, data).disorder.value).toBe(3);

    for (const who of ['gainbeald', 'king_ecgberht']) {
      state = run(state, as(who), 'answer-consent', { consentId: id, granted: true });
    }
    expect(hasSupport(state, data, 'jorvik')).toBe(true);
    expect(aftermath(state, data).disorder.value).toBe(2);
    // Still Danish, and still pagan: settling is not conversion.
    expect(aftermath(state, data).danelaw.value).toBe(3);
    expect(aftermath(state, data).paganism.value).toBe(3);
  });

  it('refuses an answer from somebody nobody asked', () => {
    const { state, id } = asking();
    expect(refusal(state, as('king_alfred'), 'answer-consent', { consentId: id, granted: true }))
      .toBe('nobody asked you');
  });

  it('goes on working after the phase moves on', () => {
    // A round started in the maintenance phase should not die because the
    // clock ran out mid-negotiation.
    let { state, id } = asking();
    state = apply(state, data, { verb: 'facilitator:advance-phase', payload: {} },
      FACILITATOR, { ts: 0 }).state;
    expect(admit(state, data, { verb: 'answer-consent', payload: { consentId: id, granted: true } },
      as('gainbeald')).ok).toBe(true);
  });
});

describe('the facilitator can unstick it', () => {
  it('answers for one neighbour who has wandered off', () => {
    let { state, id } = asking();
    state.roles.halfdan_ragnarsson.momentum = 2;
    state = run(state, as('gainbeald'), 'answer-consent', { consentId: id, granted: true });
    state = run(state, FACILITATOR, 'facilitator:answer-consent',
      { consentId: id, onBehalfOf: 'king_ecgberht', granted: true });
    expect(state.consents[id].outcome).toBe('granted');
  });

  it('answers for everyone still silent at once', () => {
    // Twenty people should not wait on one who has gone to make tea.
    let { state, id } = asking();
    state.roles.halfdan_ragnarsson.momentum = 2;
    state = run(state, FACILITATOR, 'facilitator:answer-consent',
      { consentId: id, granted: true });
    expect(state.consents[id].outcome).toBe('granted');
    expect(state.shires.jorvik.danishSupport).toBe(true);
  });

  it('does not overwrite an answer somebody already gave', () => {
    let { state, id } = asking();
    state = run(state, as('gainbeald'), 'answer-consent', { consentId: id, granted: false });
    // Already refused and closed; the facilitator cannot quietly reverse it.
    expect(refusal(state, FACILITATOR, 'facilitator:answer-consent',
      { consentId: id, granted: true })).toContain('already been settled');
  });
});

describe('driving the missionaries out', () => {
  it('removes a cross from a shire you control', () => {
    let state = playing('encounter');
    state.shires.jorvik.missionaryCross = true;
    state.roles.halfdan_ragnarsson.momentum = 2;
    expect(aftermath(state, data).paganism.value).toBe(2);

    state = run(state, as('halfdan_ragnarsson'), 'drive-out-missionaries', { shireId: 'jorvik' });
    expect(state.shires.jorvik.missionaryCross).toBe(false);
    expect(aftermath(state, data).paganism.value).toBe(3);
  });

  it('will not reach into somebody else’s shire', () => {
    const state = playing('encounter');
    state.shires.wiltshire.missionaryCross = true;
    state.roles.halfdan_ragnarsson.momentum = 2;
    expect(refusal(state, as('halfdan_ragnarsson'), 'drive-out-missionaries', { shireId: 'wiltshire' }))
      .toContain('do not control');
  });
});

describe('a consent round replays', () => {
  it('rebuilds to the same board', () => {
    // Every step a real command, so the log alone can rebuild it: Halfdan
    // takes his income for the momentum, asks, and both neighbours agree.
    let state = playing();
    const halfdan = as('halfdan_ragnarsson');
    state = run(state, halfdan, 'collect-income', { upkeep: 'lose' });
    state = run(state, halfdan, 'request-settle', { shireId: 'jorvik' });
    const id = Object.keys(state.consents)[0];
    for (const who of ['gainbeald', 'king_ecgberht']) {
      state = run(state, as(who), 'answer-consent', { consentId: id, granted: true });
    }
    expect(state.shires.jorvik.danishSupport).toBe(true);

    const { state: rebuilt, refused } = replay(toSave(state), data);
    expect(refused).toEqual([]);
    expect(rebuilt.shires).toEqual(state.shires);
    expect(rebuilt.consents).toEqual(state.consents);
    expect(rebuilt.roles).toEqual(state.roles);
  });
});
