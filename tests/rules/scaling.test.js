import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import {
  createInitialState, rosterFor, castleRemovedAt,
} from '../../gui/rules/state.js';
import { apply, replay } from '../../gui/rules/reducer.js';
import { admit } from '../../gui/rules/admission.js';
import { toSave } from '../../gui/rules/command-log.js';
import { tally } from '../../gui/rules/battle.js';
import { aftermath } from '../../gui/rules/derive.js';

const data = await loadData();
const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };
const as = (roleId) => ({ seatId: `s-${roleId}`, kind: 'player', roleId });

const full = () => createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
const at = (players) => createInitialState({
  joinCode: 'RAVEN7Z', seed: 1, data, roleIds: rosterFor(data, players),
});

function run(state, actor, verb, payload = {}) {
  const result = apply(state, data, { verb, payload }, actor, { ts: 0 });
  if (!result.ok) throw new Error(`${verb} refused: ${result.reason}`);
  return result.state;
}

const refusal = (state, actor, verb, payload = {}) =>
  admit(state, data, { verb, payload }, actor).reason;

describe('the roster', () => {
  it('drops roles in the printed order and no further', () => {
    expect(rosterFor(data, 16)).toHaveLength(16);
    expect(rosterFor(data, 15)).not.toContain('oscatel_the_brave');
    expect(rosterFor(data, 14)).not.toContain('uchtred');
    expect(rosterFor(data, 13)).not.toContain('king_ecgberht');
    expect(rosterFor(data, 12)).not.toContain('godric');
    // "Up to 4 fewer players than maximum" — eleven is not a game.
    expect(rosterFor(data, 8)).toHaveLength(12);
  });

  it('keeps every remaining role in play at each step', () => {
    for (const players of [16, 15, 14, 13, 12]) {
      expect(rosterFor(data, players)).toHaveLength(players);
    }
  });
});

describe('playing short-handed', () => {
  it('tops the survivors up exactly as the guide’s table says', () => {
    const before = full();
    const after = at(15);
    expect(after.roles.oscatel_the_brave).toBeUndefined();
    expect(after.roles.guthrum_the_old.soldiers)
      .toBe(before.roles.guthrum_the_old.soldiers + 3);
    expect(after.roles.guthrum_the_old.silver)
      .toBe(before.roles.guthrum_the_old.silver + 4);
    expect(after.roles.gyda_the_bold.ships)
      .toBe(before.roles.gyda_the_bold.ships + 2);
  });

  it('stacks the top-ups when more than one role is missing', () => {
    const before = full();
    // Guthrum is compensated for Oscatel and nobody else; Ceowulf for Uchtred.
    expect(at(14).roles.guthrum_the_old.soldiers)
      .toBe(before.roles.guthrum_the_old.soldiers + 3);
    expect(at(14).roles.ceowulf.soldiers).toBe(before.roles.ceowulf.soldiers + 1);
    expect(at(14).roles.ceowulf.silver).toBe(before.roles.ceowulf.silver + 2);
  });

  it('hands a dropped role’s lands to whoever the guide names', () => {
    const short = at(14);
    // Uchtred's lands go to the Abbess.
    expect(short.shires.middle_anglia.stewardRoleId).toBe('abbess_wenyld');
    expect(short.shires.lundenwic.stewardRoleId).toBe('abbess_wenyld');
    // Ecgberht's go to Halfdan, one drop later.
    expect(at(13).shires.bernicia.stewardRoleId).toBe('halfdan_ragnarsson');
  });

  it('leaves no shire unheld, so the counters still mean something', () => {
    for (const players of [16, 15, 14, 13, 12]) {
      const state = at(players);
      const unheld = Object.values(state.shires).filter((s) => !s.stewardRoleId);
      expect(unheld.map((s) => s.id), `at ${players}`).toEqual([]);
    }
  });

  it('keeps the turn-zero counters where the tracker prints them', () => {
    // Bernicia passing to a Dane moves the Danish count, and that is the
    // guide's own instruction rather than a bug — but the others must hold.
    for (const players of [16, 15, 14]) {
      const counters = aftermath(at(players), data);
      expect(counters.paganism.value, `at ${players}`).toBe(3);
      expect(counters.danelaw.value, `at ${players}`).toBe(3);
      expect(counters.disorder.value, `at ${players}`).toBe(3);
    }
  });
});

describe('mercenary cards', () => {
  it('go to whoever the head count names', () => {
    const holders = (state) => Object.values(state.roles)
      .filter((r) => r.mercenary).map((r) => r.id).sort();
    expect(holders(full())).toEqual([]);
    expect(holders(at(15))).toEqual(
      ['anwend_the_steady', 'guthrum_the_old', 'gyda_the_bold'].sort());
    expect(holders(at(14))).toEqual(['ceowulf', 'guthrum_the_old'].sort());
    expect(holders(at(13))).toEqual(
      ['ceowulf', 'guthrum_the_old', 'halfdan_ragnarsson'].sort());
  });

  it('are not used at twelve — a castle comes off instead', () => {
    const twelve = at(12);
    expect(Object.values(twelve.roles).filter((r) => r.mercenary)).toEqual([]);

    const shireId = castleRemovedAt(data, rosterFor(data, 12));
    expect(data.shires.shires[shireId].castles).toBe(4);
    expect(twelve.shires[shireId].castles).toBe(3);
    // And only that one.
    for (const [id, shire] of Object.entries(twelve.shires)) {
      if (id !== shireId) expect(shire.castles).toBe(data.shires.shires[id].castles);
    }
  });
});

describe('calling the mercenaries in', () => {
  /** A battle at Lindsey with both sides declared, before pairing. */
  function battle(players = 13) {
    let state = at(players);
    state.seats.s9 = { id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
    state = run(state, FACILITATOR, 'facilitator:advance-phase');   // team
    state = run(state, FACILITATOR, 'facilitator:advance-phase');   // battle
    state = run(state, FACILITATOR, 'facilitator:announce-targets');
    state = run(state, as('halfdan_ragnarsson'), 'join-battle',
      { shireId: 'lindsey', side: 'attackers' });
    state = run(state, as('gainbeald'), 'join-battle',
      { shireId: 'lindsey', side: 'defenders' });
    return state;
  }

  it('wins a clash nobody fought', () => {
    let state = battle();
    expect(tally(state, 'lindsey').attackerWins).toBe(0);
    state = run(state, as('halfdan_ragnarsson'), 'use-mercenary', { shireId: 'lindsey' });
    expect(tally(state, 'lindsey').attackerWins).toBe(1);
    expect(tally(state, 'lindsey').defenderWins).toBe(0);
  });

  it('is spent, and spent once', () => {
    let state = battle();
    state = run(state, as('halfdan_ragnarsson'), 'use-mercenary', { shireId: 'lindsey' });
    expect(state.roles.halfdan_ragnarsson.mercenary).toBe(false);
    expect(refusal(state, as('halfdan_ragnarsson'), 'use-mercenary', { shireId: 'lindsey' }))
      .toBe('you have no mercenaries to call on');
  });

  it('is not for somebody who was never dealt one', () => {
    const state = battle();
    expect(refusal(state, as('gainbeald'), 'use-mercenary', { shireId: 'lindsey' }))
      .toBe('you have no mercenaries to call on');
  });

  it('comes too late once the fighters are paired', () => {
    // After sides are set and before pairing: you commit knowing who joined,
    // not knowing who you face.
    let state = battle();
    state = run(state, FACILITATOR, 'facilitator:pair-clashes', { shireId: 'lindsey' });
    expect(refusal(state, as('halfdan_ragnarsson'), 'use-mercenary', { shireId: 'lindsey' }))
      .toBe('the fighters are already paired');
  });

  it('is refused to somebody standing outside the battle', () => {
    const state = battle();
    expect(refusal(state, as('ceowulf'), 'use-mercenary', { shireId: 'lindsey' }))
      .toBe('you are not in that battle');
  });
});

describe('turn one is written down for you', () => {
  it('sends Halfdan at Lindsey and Guthrum at Essex without asking', () => {
    const state = full();
    expect(state.initiative.declared.white)
      .toMatchObject({ roleId: 'halfdan_ragnarsson', shireId: 'lindsey', fixed: true });
    expect(state.initiative.declared.black)
      .toMatchObject({ roleId: 'guthrum_the_old', shireId: 'essex', fixed: true });
  });

  it('refuses to let the holder pick something else', () => {
    let state = full();
    state.seats.s9 = { id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
    state = run(state, FACILITATOR, 'facilitator:advance-phase');
    expect(refusal(state, as('halfdan_ragnarsson'), 'declare-initiative-target',
      { shireId: 'wiltshire' })).toContain('fixed by the rules');
  });

  it('hands the plan over from turn two', () => {
    let state = full();
    state.seats.s9 = { id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
    for (let i = 0; i < 5; i += 1) {
      state = run(state, FACILITATOR, 'facilitator:advance-phase');
    }
    expect(state.phase).toMatchObject({ turn: 2, name: 'team' });
    // Somewhere he can actually march: a token names an attack, and an attack
    // has to reach. Wiltshire is the far side of England from the Danish
    // landing, which is why it was never a legal declaration for him.
    state = run(state, as('halfdan_ragnarsson'), 'declare-initiative-target',
      { shireId: 'north_mercia' });
    expect(state.initiative.declared.white.shireId).toBe('north_mercia');
  });
});

describe('the heir', () => {
  function dead() {
    let state = full();
    state.seats.s9 = { id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
    state = run(state, FACILITATOR, 'facilitator:advance-phase');   // into the team phase
    state.roles.ceowulf.wounds = 3;
    state.roles.ceowulf.dead = true;
    state.crownHolders.mercia = 'ceowulf';
    return state;
  }

  it('takes the same sheet with the wounds wiped', () => {
    // "They return immediately with a replacement character — usually their
    // heir. They keep the same character sheet."
    const before = dead();
    const after = run(before, FACILITATOR, 'facilitator:heir-arrives', { roleId: 'ceowulf' });
    expect(after.roles.ceowulf).toMatchObject({ dead: false, wounds: 0, generation: 1 });
    expect(after.roles.ceowulf.silver).toBe(before.roles.ceowulf.silver);
    expect(after.shires.wrekinsets.stewardRoleId).toBe('ceowulf');
  });

  it('has to win his father’s crown again', () => {
    const after = run(dead(), FACILITATOR, 'facilitator:heir-arrives', { roleId: 'ceowulf' });
    expect(after.crownHolders.mercia).toBeUndefined();
    // Which he may now stand for, since the claim is still on the sheet.
    expect(admit(after, data, { verb: 'claim-crown', payload: { crown: 'mercia' } },
      as('ceowulf')).ok).toBe(true);
  });

  it('can be given a claim, or have one taken away', () => {
    // The umpire's lever for making a losing game interesting again.
    const after = run(dead(), FACILITATOR, 'facilitator:heir-arrives',
      { roleId: 'ceowulf', addClaim: 'wessex', dropClaim: 'mercia' });
    expect(after.roles.ceowulf.claims).toEqual(['wessex']);
  });

  it('records what the umpire changed, in their words', () => {
    const after = run(dead(), FACILITATOR, 'facilitator:heir-arrives',
      { roleId: 'ceowulf', note: 'His son wants peace with the Danes.' });
    expect(after.facilitatorNotes['heir:ceowulf:1'])
      .toBe('His son wants peace with the Danes.');
  });

  it('counts the generations, so a third Ceowulf is not the second', () => {
    let state = run(dead(), FACILITATOR, 'facilitator:heir-arrives', { roleId: 'ceowulf' });
    state = run(state, FACILITATOR, 'facilitator:heir-arrives', { roleId: 'ceowulf' });
    expect(state.roles.ceowulf.generation).toBe(2);
  });
});

describe('a short-handed game replays', () => {
  it('rebuilds from its roster, not from the full one', () => {
    let state = at(13);
    state.seats.s9 = { id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
    state = run(state, FACILITATOR, 'facilitator:advance-phase');
    state = run(state, FACILITATOR, 'facilitator:advance-phase');
    state = run(state, FACILITATOR, 'facilitator:announce-targets');
    state = run(state, as('halfdan_ragnarsson'), 'join-battle',
      { shireId: 'lindsey', side: 'attackers' });
    state = run(state, as('halfdan_ragnarsson'), 'use-mercenary', { shireId: 'lindsey' });

    const { state: rebuilt, refused } = replay(toSave(state), data,
      { roleIds: rosterFor(data, 13) });
    expect(refused).toEqual([]);
    expect(rebuilt.battle.mercenaries).toEqual(state.battle.mercenaries);
    expect(rebuilt.roles).toEqual(state.roles);
    expect(rebuilt.shires).toEqual(state.shires);
  });
});
