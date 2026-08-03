import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply } from '../../gui/rules/reducer.js';
import { admit } from '../../gui/rules/admission.js';
import { incomeFor, momentumGain, factionChurches } from '../../gui/rules/derive.js';
import { shipPrice } from '../../gui/rules/commands.js';

const data = await loadData();
const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };

/** A game sitting in a chosen phase, with one role seated. */
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

describe('income, as the sheets print it', () => {
  it('pays a Saxon Warrior two momentum and their lands', () => {
    const { state, actor } = playing('king_alfred');
    const after = run(state, actor, 'collect-income');
    expect(after.roles.king_alfred).toMatchObject({ momentum: 2, silver: 8, food: 7 });
  });

  it('gives a landless Saxon Warrior two food and a soldier', () => {
    const { state } = playing('godric');
    expect(incomeFor(state, data, 'godric'))
      .toMatchObject({ silver: 0, food: 2, soldiers: 1, landless: true });
  });

  it('gives a landless Saxon Priest silver instead of a soldier', () => {
    // The sheets are precise about what a churchman is for.
    const { state } = playing('abbess_wenyld');
    state.shires.hwicce.stewardRoleId = null;
    state.shires.south_mercia.stewardRoleId = null;
    expect(incomeFor(state, data, 'abbess_wenyld'))
      .toMatchObject({ silver: 3, food: 2, soldiers: 0, landless: true });
  });

  it('gives a priest a third momentum while their faction holds ten churches', () => {
    // The faction's churches, not the priest's own: the bonus is for belonging
    // to a strong church rather than for personally owning one. Both
    // kingdoms start well over the line — Mercia holds fourteen and Wessex
    // sixteen — so both priests draw three momentum from the first turn, and
    // the bonus is something to lose rather than something to earn.
    const { state, actor } = playing('abbess_wenyld');
    expect(factionChurches(state, 'abbess_wenyld')).toBe(14);
    expect(factionChurches(state, 'archbishop_aethelred')).toBe(16);
    expect(momentumGain(state, data, 'abbess_wenyld')).toBe(3);
    expect(run(state, actor, 'collect-income').roles.abbess_wenyld.momentum).toBe(3);
  });

  it('takes the bonus away when the churches burn', () => {
    const { state, actor } = playing('abbess_wenyld');
    // Raid Mercia down below ten and the abbess feels it immediately.
    let standing = factionChurches(state, 'abbess_wenyld');
    for (const shire of Object.values(state.shires)) {
      for (const settlement of Object.values(shire.settlements)) {
        if (standing > 9 && settlement.type === 'church'
            && state.roles[shire.stewardRoleId]?.factionId === 'mercia') {
          settlement.destroyed = true;
          standing -= 1;
        }
      }
    }
    expect(factionChurches(state, 'abbess_wenyld')).toBe(9);
    expect(momentumGain(state, data, 'abbess_wenyld')).toBe(2);
    expect(run(state, actor, 'collect-income').roles.abbess_wenyld.momentum).toBe(2);
  });

  it('gives a warrior no church bonus however many they hold', () => {
    const { state } = playing('king_alfred');
    expect(factionChurches(state, 'king_alfred')).toBeGreaterThanOrEqual(10);
    expect(momentumGain(state, data, 'king_alfred')).toBe(2);
  });

  it('never lets momentum past its cap', () => {
    const { state, actor } = playing('king_alfred');
    state.roles.king_alfred.momentum = 3;
    expect(run(state, actor, 'collect-income').roles.king_alfred.momentum)
      .toBe(Number(data.meta.momentumCap));
  });
});

describe('a pagan Dane owes their followers', () => {
  it('will not collect until the choice is made', () => {
    const { state, actor } = playing('halfdan_ragnarsson');
    expect(refusal(state, actor, 'collect-income'))
      .toContain('pay five silver for two soldiers, or lose one');
  });

  it('pays five silver for two soldiers', () => {
    const { state, actor } = playing('halfdan_ragnarsson');
    const before = state.roles.halfdan_ragnarsson;
    const after = run(state, actor, 'collect-income', { upkeep: 'pay' });
    expect(after.roles.halfdan_ragnarsson.soldiers).toBe(before.soldiers + 2);
    // Five out for the followers, then whatever Jorvik and Ribble pay in.
    expect(after.roles.halfdan_ragnarsson.silver)
      .toBe(before.silver - 5 + incomeFor(state, data, 'halfdan_ragnarsson').silver);
  });

  it('or loses a soldier instead', () => {
    const { state, actor } = playing('halfdan_ragnarsson');
    const before = state.roles.halfdan_ragnarsson.soldiers;
    expect(run(state, actor, 'collect-income', { upkeep: 'lose' })
      .roles.halfdan_ragnarsson.soldiers).toBe(before - 1);
  });

  it('says so when there is not enough silver to pay', () => {
    const { state, actor } = playing('halfdan_ragnarsson');
    state.roles.halfdan_ragnarsson.silver = 2;
    expect(refusal(state, actor, 'collect-income', { upkeep: 'pay' }))
      .toContain('you must lose a soldier');
  });

  it('stops owing anything once baptised', () => {
    // A large part of why anyone would consider it.
    const { state, actor } = playing('halfdan_ragnarsson');
    state.roles.halfdan_ragnarsson.baptised = true;
    const after = run(state, actor, 'collect-income');
    expect(after.roles.halfdan_ragnarsson.soldiers).toBe(12);
  });

  it('does not fall on a Christian steward of a Danish shire', () => {
    // Ecgberht sits on the Danish side of the board and is a Saxon Warrior.
    const { state, actor } = playing('king_ecgberht');
    expect(run(state, actor, 'collect-income').roles.king_ecgberht.soldiers).toBe(2);
  });
});

describe('the Danish Trader', () => {
  it('is paid two silver for every contract in use', () => {
    const { state, actor } = playing('frida_anundottir');
    state.contracts = [
      { id: 'c1', shireId: 'kent', active: true },
      { id: 'c2', shireId: 'west_country', active: true },
      { id: 'c3', shireId: 'wrekinsets', active: false },
    ];
    const before = state.roles.frida_anundottir.silver;
    // Landless, so no income of her own — just the contracts.
    expect(run(state, actor, 'collect-income', { upkeep: 'lose' })
      .roles.frida_anundottir.silver).toBe(before + 4);
  });
});

describe('ships', () => {
  it('lets a Saxon build only where there is a yard', () => {
    const { state, actor } = playing('cenred');
    expect(refusal(state, actor, 'build-ship')).toContain('Wiltshire, Lundenwic, Jorvik');

    const alfred = playing('king_alfred');
    expect(admit(alfred.state, data, { verb: 'build-ship' }, alfred.actor).ok).toBe(true);
  });

  it('charges a Saxon two for the first each turn and four after', () => {
    const { state } = playing('king_alfred');
    expect(shipPrice(state, data, 'king_alfred')).toBe(2);
    state.roles.king_alfred.perTurn.shipsBuilt = 1;
    expect(shipPrice(state, data, 'king_alfred')).toBe(4);
  });

  it('lets a Dane build anywhere, for more', () => {
    // He arrived by sea with his own shipwrights.
    const { state, actor } = playing('guthrum_the_old');
    expect(shipPrice(state, data, 'guthrum_the_old')).toBe(3);
    expect(admit(state, data, { verb: 'build-ship' }, actor).ok).toBe(true);
  });

  it('gives a Dane holding a yard one cheap ship a turn', () => {
    const { state } = playing('halfdan_ragnarsson');   // steward of Jorvik
    expect(shipPrice(state, data, 'halfdan_ragnarsson')).toBe(2);
    state.roles.halfdan_ragnarsson.perTurn.shipsBuilt = 1;
    expect(shipPrice(state, data, 'halfdan_ragnarsson')).toBe(3);
  });

  it('does not let a Danish Warrior recruit with silver', () => {
    const { state, actor } = playing('guthrum_the_old');
    expect(refusal(state, actor, 'recruit-soldiers')).toContain('cannot recruit');
  });
});

describe('reinforcing', () => {
  it('circles an undefended settlement for a momentum', () => {
    const { state, actor } = playing('king_alfred');
    state.roles.king_alfred.momentum = 2;
    const target = Object.values(state.shires.wiltshire.settlements).find((s) => !s.defended);
    const after = run(state, actor, 'reinforce',
      { shireId: 'wiltshire', settlementId: target.id });
    expect(after.shires.wiltshire.settlements[target.id].defended).toBe(true);
    expect(after.roles.king_alfred.momentum).toBe(1);
  });

  it('refuses one that is already defended, or in someone else’s shire', () => {
    const { state, actor } = playing('king_alfred');
    state.roles.king_alfred.momentum = 2;
    const target = Object.values(state.shires.wiltshire.settlements)[0];
    target.defended = true;
    expect(refusal(state, actor, 'reinforce', { shireId: 'wiltshire', settlementId: target.id }))
      .toContain('already defended');

    const elsewhere = Object.values(state.shires.jorvik.settlements)[0];
    expect(refusal(state, actor, 'reinforce', { shireId: 'jorvik', settlementId: elsewhere.id }))
      .toContain('you steward');
  });

  it('lets a priest reinforce wherever a missionary cross stands', () => {
    // The reward for having sent one.
    const { state, actor } = playing('abbess_wenyld');
    state.roles.abbess_wenyld.momentum = 2;
    state.shires.jorvik.missionaryCross = true;
    const target = Object.values(state.shires.jorvik.settlements).find((s) => !s.defended);
    expect(run(state, actor, 'reinforce', { shireId: 'jorvik', settlementId: target.id })
      .shires.jorvik.settlements[target.id].defended).toBe(true);
  });
});

describe('the team phase', () => {
  it('hands a shire over, and its faction with it', () => {
    const { state, actor } = playing('king_alfred', 'team');
    const after = run(state, actor, 'transfer-stewardship',
      { shireId: 'wiltshire', toRoleId: 'cenred' });
    expect(after.shires.wiltshire.stewardRoleId).toBe('cenred');
    expect(after.shires.wiltshire.factionId).toBe(after.roles.cenred.factionId);
  });

  it('will not give away what you do not hold', () => {
    const { state, actor } = playing('king_alfred', 'team');
    expect(refusal(state, actor, 'transfer-stewardship', { shireId: 'jorvik', toRoleId: 'cenred' }))
      .toContain('not the steward');
  });
});

describe('giving', () => {
  it('moves silver between players', () => {
    const { state, actor } = playing('king_alfred', 'encounter');
    const after = run(state, actor, 'give',
      { toRoleId: 'cenred', what: 'silver', amount: 3 });
    expect(after.roles.king_alfred.silver).toBe(1);
    expect(after.roles.cenred.silver).toBe(7);
  });

  it('will not move soldiers or momentum, ever', () => {
    // Yours alone, in both directions: they are what you are, not what you have.
    const { state, actor } = playing('king_alfred', 'encounter');
    for (const what of ['soldiers', 'momentum']) {
      expect(refusal(state, actor, 'give', { toRoleId: 'cenred', what, amount: 1 }))
        .toContain('cannot change hands');
    }
  });

  it('will not move anything during a battle', () => {
    const { state, actor } = playing('king_alfred', 'battle');
    expect(refusal(state, actor, 'give', { toRoleId: 'cenred', what: 'silver', amount: 1 }))
      .toContain('phase');
  });

  it('will not give away more than you have', () => {
    const { state, actor } = playing('king_alfred', 'encounter');
    expect(refusal(state, actor, 'give', { toRoleId: 'cenred', what: 'silver', amount: 99 }))
      .toContain('not enough silver');
  });
});
