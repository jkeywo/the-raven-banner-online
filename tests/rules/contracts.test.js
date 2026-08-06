import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply, replay } from '../../gui/rules/reducer.js';
import { admit, availableTo } from '../../gui/rules/admission.js';
import { toSave } from '../../gui/rules/command-log.js';
import { shipCost } from '../../gui/rules/derive.js';

const data = await loadData();
const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };

const TRADER = 'frida_anundottir';
const as = (roleId) => ({ seatId: `s-${roleId}`, kind: 'player', roleId });

/** Move the game on until it reaches a phase, through the log like anything else. */
function toPhase(state, phaseName) {
  let at = state;
  while (at.phase.name !== phaseName) {
    at = apply(at, data, { verb: 'facilitator:advance-phase', payload: {} },
      FACILITATOR, { ts: 0 }).state;
  }
  return at;
}

function playing(phaseName = 'team') {
  const state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
  state.seats.s9 = { id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
  return toPhase(state, phaseName);
}

function run(state, actor, verb, payload = {}) {
  const result = apply(state, data, { verb, payload }, actor, { ts: 0 });
  if (!result.ok) throw new Error(`${verb} refused: ${result.reason}`);
  return result.state;
}

const refusal = (state, actor, verb, payload = {}) =>
  admit(state, data, { verb, payload }, actor).reason;

const stewardOf = (state, shireId) => state.shires[shireId].stewardRoleId;

/**
 * Frida offers the West Country contract. Returns the state and its id.
 *
 * In the Maintenance Phase, because the stewards of all three printed shires
 * are Saxons and the Team Phase is each team's own — see 'across the lines'.
 */
function offered(state = playing('maintenance')) {
  const after = run(state, as(TRADER), 'offer-contract', { shireId: 'west_country' });
  return { state: after, id: after.contracts.at(-1).id };
}

describe('offering', () => {
  it('is the Danish Trader’s alone', () => {
    // Three cards, and she holds all three.
    const state = playing('maintenance');
    expect(refusal(state, as('king_alfred'), 'offer-contract', { shireId: 'west_country' }))
      .toBe('only the Danish Trader holds the contracts');
    expect(admit(state, data, { verb: 'offer-contract', payload: { shireId: 'west_country' } },
      as(TRADER)).ok).toBe(true);
  });

  it('is only for the three printed shires', () => {
    const state = playing('maintenance');
    expect(refusal(state, as(TRADER), 'offer-contract', { shireId: 'jorvik' }))
      .toContain('no contract for');
    for (const shireId of ['wrekinsets', 'kent', 'west_country']) {
      expect(admit(state, data, { verb: 'offer-contract', payload: { shireId } },
        as(TRADER)).ok).toBe(true);
    }
  });

  it('costs nothing by itself', () => {
    const before = playing('maintenance');
    const { state } = offered(before);
    expect(state.roles[TRADER].soldiers).toBe(before.roles[TRADER].soldiers);
    expect(state.contracts.at(-1)).toMatchObject(
      { shireId: 'west_country', traderRoleId: TRADER, status: 'offered' });
  });

  it('needs somebody on the other side of the table', () => {
    const state = playing('maintenance');
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
    const state = playing('maintenance');
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
    state = toPhase(state, 'maintenance');

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

describe('dealing across the lines', () => {
  // King Ecgberht is a Saxon riding with the Great Heathen Army, so he is the
  // one steward in England Frida could deal with while the teams sit apart.
  const OWN_SIDE = 'king_ecgberht';

  /** The West Country in the hands of somebody on the trader's own side. */
  function ownSideSteward(phaseName = 'team') {
    const state = playing(phaseName);
    state.shires.west_country.stewardRoleId = OWN_SIDE;
    state.shires.west_country.factionId = state.roles[OWN_SIDE].factionId;
    return state;
  }

  it('will not offer a contract across the lines in the Team Phase', () => {
    const state = playing('team');
    expect(state.roles[stewardOf(state, 'west_country')].factionId)
      .not.toBe(state.roles[TRADER].factionId);
    expect(refusal(state, as(TRADER), 'offer-contract', { shireId: 'west_country' }))
      .toContain('own team');
  });

  it('leaves no mark on the game when it refuses one', () => {
    const state = playing('team');
    const result = apply(state, data, {
      verb: 'offer-contract', payload: { shireId: 'west_country' },
    }, as(TRADER), { ts: 0 });
    expect(result.ok).toBe(false);
    expect(result.state).toBe(state);
    expect(state.contracts).toEqual([]);
    expect(state.log.filter((entry) => entry.verb === 'offer-contract')).toEqual([]);
  });

  it('lets her deal with her own side even then', () => {
    let state = ownSideSteward('team');
    state = run(state, as(TRADER), 'offer-contract', { shireId: 'west_country' });
    const id = state.contracts.at(-1).id;
    state = run(state, as(OWN_SIDE), 'answer-contract', { contractId: id, accept: true });
    expect(state.contracts.at(-1).status).toBe('active');
  });

  it('will not let a steward answer across the lines in the Team Phase', () => {
    // Offered where it was lawful, and then the clock rolls round to a Team
    // Phase before he has answered.
    let { state, id } = offered();
    const steward = stewardOf(state, 'west_country');
    state = toPhase(state, 'team');
    for (const accept of [true, false]) {
      expect(refusal(state, as(steward), 'answer-contract', { contractId: id, accept }))
        .toContain('own team');
    }
  });

  it('keeps the offer on her action list when one of the three is a teammate’s', () => {
    // Kent in her own side's hands, the other two Saxon. The action list asks
    // "is there an offer she could make at all?" and the answer is yes, so the
    // button must not grey out over the Mercian who happens to be printed
    // first — the offer she can make would then be unreachable.
    const state = playing('team');
    state.shires.kent.stewardRoleId = OWN_SIDE;
    expect(admit(state, data, { verb: 'offer-contract', payload: { shireId: 'kent' } },
      as(TRADER))).toEqual({ ok: true });
    expect(availableTo(state, data, as(TRADER)).find((c) => c.verb === 'offer-contract'))
      .toMatchObject({ ok: true });
  });

  it('takes the offer off her list only when none of the three is', () => {
    const offering = availableTo(playing('team'), data, as(TRADER))
      .find((c) => c.verb === 'offer-contract');
    expect(offering.ok).toBe(false);
    expect(offering.reason).toContain('own team');
  });

  it('keeps the offer on her list once one of the three is already spoken for', () => {
    // The same "is there any offer at all?" question along the other axis:
    // the first printed shire already carries an offer, so asking after that
    // one alone would grey out the two cards still in her hand.
    const state = playing('maintenance');
    const [first] = data.meta.tradeContractShires;
    state.contracts = [
      { id: 'c1', shireId: first, traderRoleId: TRADER, status: 'offered' },
    ];
    expect(availableTo(state, data, as(TRADER)).find((c) => c.verb === 'offer-contract'))
      .toMatchObject({ ok: true });
  });

  it('keeps an answer on the steward’s list when one offer is his to answer', () => {
    // Two offers on two shires Alfred holds, one of them from his own side.
    // Only one trader is printed, so the second is hand-placed — but the list
    // must still find the offer he could answer rather than stopping at the
    // first on the pile.
    const state = playing('team');
    state.contracts = [
      { id: 'c1', shireId: 'west_country', traderRoleId: TRADER, status: 'offered' },
      { id: 'c2', shireId: 'wiltshire', traderRoleId: 'cenred', status: 'offered' },
    ];
    expect(availableTo(state, data, as('king_alfred'))
      .find((c) => c.verb === 'answer-contract')).toMatchObject({ ok: true });
  });

  it('minds nobody’s allegiance in the Maintenance or Encounter Phase', () => {
    for (const phaseName of ['maintenance', 'encounter']) {
      const state = playing(phaseName);
      const steward = stewardOf(state, 'west_country');
      expect(state.roles[steward].factionId).not.toBe(state.roles[TRADER].factionId);
      const after = run(state, as(TRADER), 'offer-contract', { shireId: 'west_country' });
      expect(admit(after, data, {
        verb: 'answer-contract',
        payload: { contractId: after.contracts.at(-1).id, accept: true },
      }, as(steward)).ok, phaseName).toBe(true);
    }
  });
});

describe('cancelling', () => {
  /** A signed contract on the West Country, moved on to the team phase. */
  function signed() {
    let { state, id } = offered();
    const steward = stewardOf(state, 'west_country');
    state = run(state, as(steward), 'answer-contract', { contractId: id, accept: true });
    // Struck where the two of them could talk; torn up where the card says.
    return { state: toPhase(state, 'team'), id, steward };
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
    state = toPhase(state, 'encounter');
    expect(refusal(state, as(steward), 'cancel-contract', { contractId: id }))
      .toContain('team');
  });

  it('is not held to your own faction, or no contract could ever be torn up', () => {
    // The steward is a Saxon and the trader is a Dane — that is what a
    // contract is — so the Team Phase's own-team rule cannot apply here.
    const { state, id, steward } = signed();
    expect(state.roles[steward].factionId).not.toBe(state.roles[TRADER].factionId);
    expect(state.phase.name).toBe('team');
    for (const party of [steward, TRADER]) {
      expect(admit(state, data, { verb: 'cancel-contract', payload: { contractId: id } },
        as(party)).ok, party).toBe(true);
    }
  });

  it('stops the silver', () => {
    let { state, id, steward } = signed();
    state = run(state, as(TRADER), 'cancel-contract', { contractId: id });
    state = toPhase(state, 'maintenance');
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
    state = toPhase(state, 'team');
    state = run(state, as(steward), 'cancel-contract', { contractId: id });

    const { state: rebuilt, refused } = replay(toSave(state), data);
    expect(refused).toEqual([]);
    expect(rebuilt.contracts).toEqual(state.contracts);
    expect(rebuilt.shires).toEqual(state.shires);
    expect(rebuilt.roles).toEqual(state.roles);
  });
});
