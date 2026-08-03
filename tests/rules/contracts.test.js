import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply, replay } from '../../gui/rules/reducer.js';
import { admit } from '../../gui/rules/admission.js';
import { toSave } from '../../gui/rules/command-log.js';
import { shipCost } from '../../gui/rules/derive.js';

const data = await loadData();
const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };

const TRADER = 'frida_anundottir';
const as = (roleId) => ({ seatId: `s-${roleId}`, kind: 'player', roleId });

function playing(phaseName = 'team') {
  let state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
  state.seats.s9 = { id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
  while (state.phase.name !== phaseName) {
    state = apply(state, data, { verb: 'facilitator:advance-phase', payload: {} },
      FACILITATOR, { ts: 0 }).state;
  }
  return state;
}

function run(state, actor, verb, payload = {}) {
  const result = apply(state, data, { verb, payload }, actor, { ts: 0 });
  if (!result.ok) throw new Error(`${verb} refused: ${result.reason}`);
  return result.state;
}

const refusal = (state, actor, verb, payload = {}) =>
  admit(state, data, { verb, payload }, actor).reason;

const stewardOf = (state, shireId) => state.shires[shireId].stewardRoleId;

/** Frida offers the West Country contract. Returns the state and its id. */
function offered(state = playing()) {
  const after = run(state, as(TRADER), 'offer-contract', { shireId: 'west_country' });
  return { state: after, id: after.contracts.at(-1).id };
}

describe('offering', () => {
  it('is the Danish Trader’s alone', () => {
    // Three cards, and she holds all three.
    const state = playing();
    expect(refusal(state, as('king_alfred'), 'offer-contract', { shireId: 'west_country' }))
      .toBe('only the Danish Trader holds the contracts');
    expect(admit(state, data, { verb: 'offer-contract', payload: { shireId: 'west_country' } },
      as(TRADER)).ok).toBe(true);
  });

  it('is only for the three printed shires', () => {
    const state = playing();
    expect(refusal(state, as(TRADER), 'offer-contract', { shireId: 'jorvik' }))
      .toContain('no contract for');
    for (const shireId of ['wrekinsets', 'kent', 'west_country']) {
      expect(admit(state, data, { verb: 'offer-contract', payload: { shireId } },
        as(TRADER)).ok).toBe(true);
    }
  });

  it('costs nothing by itself', () => {
    const before = playing();
    const { state } = offered(before);
    expect(state.roles[TRADER].soldiers).toBe(before.roles[TRADER].soldiers);
    expect(state.contracts.at(-1)).toMatchObject(
      { shireId: 'west_country', traderRoleId: TRADER, status: 'offered' });
  });

  it('needs somebody on the other side of the table', () => {
    const state = playing();
    state.shires.kent.stewardRoleId = null;
    expect(refusal(state, as(TRADER), 'offer-contract', { shireId: 'kent' }))
      .toContain('nobody to sign');
  });

  it('will not stack two offers on one shire', () => {
    const { state } = offered();
    expect(refusal(state, as(TRADER), 'offer-contract', { shireId: 'west_country' }))
      .toContain('already offered');
  });

  it('is refused when she has no soldier to send', () => {
    const state = playing();
    state.roles[TRADER].soldiers = 0;
    expect(refusal(state, as(TRADER), 'offer-contract', { shireId: 'west_country' }))
      .toContain('not enough soldiers');
  });
});

describe('signing', () => {
  it('takes a soldier from each side and opens the port', () => {
    let { state, id } = offered();
    const steward = stewardOf(state, 'west_country');
    const before = {
      trader: state.roles[TRADER].soldiers,
      steward: state.roles[steward].soldiers,
      ships: shipCost(state, data, 'west_country'),
    };

    state = run(state, as(steward), 'answer-contract', { contractId: id, accept: true });
    expect(state.contracts.at(-1).status).toBe('active');
    expect(state.roles[TRADER].soldiers).toBe(before.trader - 1);
    expect(state.roles[steward].soldiers).toBe(before.steward - 1);
    expect(shipCost(state, data, 'west_country')).toBe(before.ships - 2);
  });

  it('pays both of them, every maintenance phase', () => {
    let { state, id } = offered();
    const steward = stewardOf(state, 'west_country');
    state = run(state, as(steward), 'answer-contract', { contractId: id, accept: true });
    while (state.phase.name !== 'maintenance') {
      state = apply(state, data, { verb: 'facilitator:advance-phase', payload: {} },
        FACILITATOR, { ts: 0 }).state;
    }

    const silver = (s, who) => s.roles[who].silver;
    const before = { trader: silver(state, TRADER), steward: silver(state, steward) };
    let after = run(state, as(TRADER), 'collect-income', { upkeep: 'lose' });
    after = run(after, as(steward), 'collect-income');

    // Frida is landless, so her whole income is the contract.
    expect(silver(after, TRADER)).toBe(before.trader + 2);
    // The steward's own income on top of the two.
    const without = playing('maintenance');
    const baseline = run(without, as(steward), 'collect-income').roles[steward].silver
      - without.roles[steward].silver;
    expect(silver(after, steward) - before.steward).toBe(baseline + 2);
  });

  it('is the steward’s to sign, nobody else’s', () => {
    const { state, id } = offered();
    const steward = stewardOf(state, 'west_country');
    const other = Object.keys(state.roles).find((who) => who !== steward && who !== TRADER);
    expect(refusal(state, as(other), 'answer-contract', { contractId: id, accept: true }))
      .toBe('it is not yours to sign');
  });

  it('can simply be declined, at no cost to anyone', () => {
    let { state, id } = offered();
    const steward = stewardOf(state, 'west_country');
    const before = state.roles[TRADER].soldiers;
    state = run(state, as(steward), 'answer-contract', { contractId: id, accept: false });
    expect(state.contracts.at(-1).status).toBe('declined');
    expect(state.roles[TRADER].soldiers).toBe(before);
    expect(shipCost(state, data, 'west_country')).toBe(shipCost(playing(), data, 'west_country'));
  });

  it('lets her offer again after a refusal', () => {
    let { state, id } = offered();
    const steward = stewardOf(state, 'west_country');
    state = run(state, as(steward), 'answer-contract', { contractId: id, accept: false });
    // A new card on the table, and the old refusal still on the record.
    state = run(state, as(TRADER), 'offer-contract', { shireId: 'west_country' });
    expect(state.contracts.map((c) => c.status)).toEqual(['declined', 'offered']);
  });

  it('will not go through if the trader has spent her soldier since offering', () => {
    let { state, id } = offered();
    const steward = stewardOf(state, 'west_country');
    state.roles[TRADER].soldiers = 0;
    expect(refusal(state, as(steward), 'answer-contract', { contractId: id, accept: true }))
      .toContain('no soldier left');
  });

  it('cannot be signed twice', () => {
    let { state, id } = offered();
    const steward = stewardOf(state, 'west_country');
    state = run(state, as(steward), 'answer-contract', { contractId: id, accept: true });
    expect(refusal(state, as(steward), 'answer-contract', { contractId: id, accept: true }))
      .toBe('that offer is no longer open');
    expect(refusal(state, as(TRADER), 'offer-contract', { shireId: 'west_country' }))
      .toContain('already running');
  });
});

describe('cancelling', () => {
  /** A signed contract on the West Country, in the team phase. */
  function signed() {
    let { state, id } = offered();
    const steward = stewardOf(state, 'west_country');
    state = run(state, as(steward), 'answer-contract', { contractId: id, accept: true });
    return { state, id, steward };
  }

  it('gives the shire its ship value back', () => {
    let { state, id } = signed();
    const printed = shipCost(playing(), data, 'west_country');
    expect(shipCost(state, data, 'west_country')).toBe(printed - 2);

    state = run(state, as(TRADER), 'cancel-contract', { contractId: id });
    expect(state.contracts.at(-1)).toMatchObject({ status: 'cancelled', cancelledBy: TRADER });
    expect(shipCost(state, data, 'west_country')).toBe(printed);
  });

  it('does not hand the soldiers back', () => {
    // They were handed over; a cancelled deal is not an undone one.
    let { state, id } = signed();
    const before = state.roles[TRADER].soldiers;
    state = run(state, as(TRADER), 'cancel-contract', { contractId: id });
    expect(state.roles[TRADER].soldiers).toBe(before);
  });

  it('is either party’s to do, and nobody else’s', () => {
    const { state, id, steward } = signed();
    expect(admit(state, data, { verb: 'cancel-contract', payload: { contractId: id } },
      as(steward)).ok).toBe(true);
    const other = Object.keys(state.roles).find((who) => who !== steward && who !== TRADER);
    expect(refusal(state, as(other), 'cancel-contract', { contractId: id }))
      .toBe('you are not party to it');
  });

  it('follows the shire when it changes hands', () => {
    // The card sits next to the shire, and so does the income. Whoever holds
    // the West Country is the party to the deal.
    const { state, id, steward } = signed();
    const other = Object.keys(state.roles).find((who) => who !== steward && who !== TRADER);
    state.shires.west_country.stewardRoleId = other;
    expect(admit(state, data, { verb: 'cancel-contract', payload: { contractId: id } },
      as(other)).ok).toBe(true);
    expect(refusal(state, as(steward), 'cancel-contract', { contractId: id }))
      .toBe('you are not party to it');
  });

  it('is a Team Phase matter, as printed on the card', () => {
    let { state, id, steward } = signed();
    while (state.phase.name !== 'encounter') {
      state = apply(state, data, { verb: 'facilitator:advance-phase', payload: {} },
        FACILITATOR, { ts: 0 }).state;
    }
    expect(refusal(state, as(steward), 'cancel-contract', { contractId: id }))
      .toContain('team');
  });

  it('stops the silver', () => {
    let { state, id, steward } = signed();
    state = run(state, as(TRADER), 'cancel-contract', { contractId: id });
    while (state.phase.name !== 'maintenance') {
      state = apply(state, data, { verb: 'facilitator:advance-phase', payload: {} },
        FACILITATOR, { ts: 0 }).state;
    }
    const before = state.roles[TRADER].silver;
    const after = run(state, as(TRADER), 'collect-income', { upkeep: 'lose' });
    expect(after.roles[TRADER].silver).toBe(before);
  });
});

describe('a contract replays', () => {
  it('rebuilds to the same board', () => {
    let { state, id } = offered();
    const steward = stewardOf(state, 'west_country');
    state = run(state, as(steward), 'answer-contract', { contractId: id, accept: true });
    state = run(state, as(steward), 'cancel-contract', { contractId: id });

    const { state: rebuilt, refused } = replay(toSave(state), data);
    expect(refused).toEqual([]);
    expect(rebuilt.contracts).toEqual(state.contracts);
    expect(rebuilt.shires).toEqual(state.shires);
    expect(rebuilt.roles).toEqual(state.roles);
  });
});
