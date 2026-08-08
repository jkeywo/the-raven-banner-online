import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState, rosterFor } from '../../gui/rules/state.js';
import { apply } from '../../gui/rules/reducer.js';
import { admit } from '../../gui/rules/admission.js';

const data = await loadData();
const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };
const as = (roleId) => ({ seatId: `s-${roleId}`, kind: 'player', roleId });

const fresh = () => createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });

function run(state, actor, verb, payload = {}) {
  const result = apply(state, data, { verb, payload }, actor, { ts: 0 });
  if (!result.ok) throw new Error(`${verb} refused: ${result.reason}`);
  return result.state;
}

const refusal = (state, actor, verb, payload = {}) =>
  admit(state, data, { verb, payload }, actor).reason;

describe('adjusting a number', () => {
  it('adds a delta rather than replacing the value', () => {
    const state = fresh();
    const before = state.roles.king_alfred.silver;
    const after = run(state, FACILITATOR, 'facilitator:adjust',
      { path: ['roles', 'king_alfred', 'silver'], delta: 5 });
    expect(after.roles.king_alfred.silver).toBe(before + 5);
  });

  it('subtracts with a negative delta', () => {
    const state = fresh();
    const before = state.roles.king_alfred.soldiers;
    const after = run(state, FACILITATOR, 'facilitator:adjust',
      { path: ['roles', 'king_alfred', 'soldiers'], delta: -3 });
    expect(after.roles.king_alfred.soldiers).toBe(before - 3);
  });

  it('is race-safe: it reads the value at the moment it actually applies', () => {
    // The facilitator opens the panel seeing 8, a player spends 3 in the
    // meantime, and only then does the facilitator's "+2" land. A naive
    // "read it, add two, write the sum back" done at panel-open time would
    // have clobbered the player's spend; a delta command does not have that
    // moment at all, because the addition happens against whatever the
    // reducer is holding when the command is actually applied.
    let state = fresh();
    // lobby -> team -> battle -> maintenance, where the market is open.
    for (let i = 0; i < 3; i += 1) state = run(state, FACILITATOR, 'facilitator:advance-phase');
    const before = state.roles.king_alfred.silver;
    state = run(state, as('king_alfred'), 'trade', { give: 'food' });   // silver +2
    state = run(state, FACILITATOR, 'facilitator:adjust',
      { path: ['roles', 'king_alfred', 'silver'], delta: -5 });
    expect(state.roles.king_alfred.silver).toBe(before + 2 - 5);
  });

  it('refuses to push a value negative', () => {
    const state = fresh();
    expect(refusal(state, FACILITATOR, 'facilitator:adjust',
      { path: ['roles', 'king_alfred', 'silver'], delta: -999 }))
      .toContain('would go negative');
    // And nothing happened.
    expect(admit(state, data, {
      verb: 'facilitator:adjust', payload: { path: ['roles', 'king_alfred', 'silver'], delta: -999 },
    }, FACILITATOR).ok).toBe(false);
  });

  it('refuses a path that is not a number', () => {
    const state = fresh();
    expect(refusal(state, FACILITATOR, 'facilitator:adjust',
      { path: ['roles', 'king_alfred', 'liegeId'], delta: 1 })).toBe('that is not a number');
  });

  it('refuses a path leading nowhere', () => {
    const state = fresh();
    expect(refusal(state, FACILITATOR, 'facilitator:adjust',
      { path: ['roles', 'nobody', 'silver'], delta: 1 })).toBe('no such value');
  });

  it('is a facilitator\'s to do, never a player\'s', () => {
    const state = fresh();
    expect(admit(state, data, {
      verb: 'facilitator:adjust', payload: { path: ['roles', 'king_alfred', 'silver'], delta: 1 },
    }, as('king_alfred')).ok).toBe(false);
  });
});

describe('handing a shire over by fiat', () => {
  it('sets the steward and its faction together', () => {
    const state = fresh();
    const after = run(state, FACILITATOR, 'facilitator:set-steward',
      { shireId: 'wiltshire', roleId: 'cenred' });
    expect(after.shires.wiltshire.stewardRoleId).toBe('cenred');
    expect(after.shires.wiltshire.factionId).toBe(after.roles.cenred.factionId);
  });

  it('empties a shire when handed to nobody', () => {
    const state = fresh();
    const after = run(state, FACILITATOR, 'facilitator:set-steward',
      { shireId: 'wiltshire', roleId: null });
    expect(after.shires.wiltshire).toMatchObject({ stewardRoleId: null, factionId: null });
  });

  it('refuses an unknown shire or character', () => {
    const state = fresh();
    expect(refusal(state, FACILITATOR, 'facilitator:set-steward',
      { shireId: 'atlantis', roleId: 'cenred' })).toBe('no such shire');
    expect(refusal(state, FACILITATOR, 'facilitator:set-steward',
      { shireId: 'wiltshire', roleId: 'nobody' })).toBe('no such character');
  });
});

describe('circling or striking a settlement', () => {
  it('sets defended or destroyed directly', () => {
    const state = fresh();
    const [settlementId] = Object.keys(state.shires.wiltshire.settlements);
    const after = run(state, FACILITATOR, 'facilitator:set-settlement',
      { shireId: 'wiltshire', settlementId, field: 'defended', value: true });
    expect(after.shires.wiltshire.settlements[settlementId].defended).toBe(true);
  });

  it('refuses a settlement that does not exist', () => {
    const state = fresh();
    expect(refusal(state, FACILITATOR, 'facilitator:set-settlement',
      { shireId: 'wiltshire', settlementId: 'nowhere', field: 'defended', value: true }))
      .toBe('no such settlement');
  });

  it('refuses a field that is not defended or destroyed', () => {
    const state = fresh();
    const [settlementId] = Object.keys(state.shires.wiltshire.settlements);
    expect(refusal(state, FACILITATOR, 'facilitator:set-settlement',
      { shireId: 'wiltshire', settlementId, field: 'type', value: 'church' }))
      .toBe('nothing there by that name');
  });
});

describe('claims', () => {
  it('adds one, and refuses to add it twice', () => {
    const state = fresh();
    const after = run(state, FACILITATOR, 'facilitator:add-claim',
      { roleId: 'abbess_wenyld', crown: 'mercia' });
    expect(after.roles.abbess_wenyld.claims).toContain('mercia');
    expect(refusal(after, FACILITATOR, 'facilitator:add-claim',
      { roleId: 'abbess_wenyld', crown: 'mercia' })).toBe('already claims it');
  });

  it('removes one, and refuses to remove what is not there', () => {
    const state = fresh();
    const after = run(state, FACILITATOR, 'facilitator:remove-claim',
      { roleId: 'king_alfred', crown: 'kent' });
    expect(after.roles.king_alfred.claims).not.toContain('kent');
    expect(refusal(after, FACILITATOR, 'facilitator:remove-claim',
      { roleId: 'king_alfred', crown: 'kent' })).toBe('does not claim it');
  });
});

describe('initiative tokens', () => {
  it('moves a token onto a role and off it again', () => {
    const state = fresh();
    let after = run(state, FACILITATOR, 'facilitator:assign-initiative',
      { token: 'bonus', roleId: 'cenred' });
    expect(after.initiative.bonus).toBe('cenred');
    after = run(after, FACILITATOR, 'facilitator:assign-initiative',
      { token: 'bonus', roleId: null });
    expect(after.initiative.bonus).toBeNull();
  });

  it('leaves the other two tokens untouched', () => {
    const state = fresh();
    const before = { white: state.initiative.white, black: state.initiative.black };
    const after = run(state, FACILITATOR, 'facilitator:assign-initiative',
      { token: 'bonus', roleId: 'cenred' });
    expect(after.initiative.white).toBe(before.white);
    expect(after.initiative.black).toBe(before.black);
  });

  it('refuses a token that does not exist', () => {
    const state = fresh();
    expect(refusal(state, FACILITATOR, 'facilitator:assign-initiative',
      { token: 'silver', roleId: 'cenred' })).toBe('no such token');
  });
});

describe('correcting a declared target', () => {
  it('overrides even a turn-one target fixed by the rules', () => {
    let state = fresh();
    state = run(state, FACILITATOR, 'facilitator:advance-phase');   // lobby -> team
    expect(state.initiative.declared.white.fixed).toBe(true);
    const after = run(state, FACILITATOR, 'facilitator:set-initiative-target',
      { token: 'white', shireId: 'wiltshire' });
    expect(after.initiative.declared.white.shireId).toBe('wiltshire');
    expect(after.initiative.declared.white.roleId).toBe(state.initiative.white);
  });

  it('leaves the other tokens alone', () => {
    let state = fresh();
    state = run(state, FACILITATOR, 'facilitator:advance-phase');
    const blackBefore = state.initiative.declared.black;
    const after = run(state, FACILITATOR, 'facilitator:set-initiative-target',
      { token: 'white', shireId: 'wiltshire' });
    expect(after.initiative.declared.black).toEqual(blackBefore);
  });

  it('refuses once the targets are already announced', () => {
    let state = fresh();
    state = run(state, FACILITATOR, 'facilitator:advance-phase');   // team
    state = run(state, FACILITATOR, 'facilitator:advance-phase');   // battle
    state = run(state, FACILITATOR, 'facilitator:announce-targets');
    expect(refusal(state, FACILITATOR, 'facilitator:set-initiative-target',
      { token: 'white', shireId: 'wiltshire' })).toBe('the targets are already announced');
  });

  it('refuses a token nobody holds', () => {
    let state = fresh();
    state = run(state, FACILITATOR, 'facilitator:advance-phase');
    state = run(state, FACILITATOR, 'facilitator:assign-initiative', { token: 'bonus', roleId: null });
    expect(refusal(state, FACILITATOR, 'facilitator:set-initiative-target',
      { token: 'bonus', shireId: 'wiltshire' })).toBe('nobody holds that token');
  });

  it('refuses a shire that does not exist', () => {
    let state = fresh();
    state = run(state, FACILITATOR, 'facilitator:advance-phase');
    expect(refusal(state, FACILITATOR, 'facilitator:set-initiative-target',
      { token: 'white', shireId: 'atlantis' })).toBe('no such shire');
  });

  it('refuses a player, even for their own token', () => {
    let state = fresh();
    state = run(state, FACILITATOR, 'facilitator:advance-phase');
    const holder = state.initiative.white;
    expect(refusal(state, as(holder), 'facilitator:set-initiative-target',
      { token: 'white', shireId: 'wiltshire' })).toBeTruthy();
  });
});

describe('adding a role mid-game', () => {
  const at13 = () => createInitialState({
    joinCode: 'RAVEN7Z', seed: 1, data, roleIds: rosterFor(data, 13),
  });

  it('refuses a role already at the table', () => {
    const state = fresh();
    expect(refusal(state, FACILITATOR, 'facilitator:add-role', { roleId: 'king_alfred' }))
      .toBe('already in the game');
  });

  it('refuses a role that does not exist in the data at all', () => {
    const state = fresh();
    expect(refusal(state, FACILITATOR, 'facilitator:add-role', { roleId: 'nobody' }))
      .toBe('no such role in this game');
  });

  it('builds a full role from the printed sheet plus whatever was committed', () => {
    // Ecgberht is out at thirteen players; bring him back with the console's
    // prefill, adjusted before the umpire committed it.
    const state = at13();
    expect(state.roles.king_ecgberht).toBeUndefined();
    const after = run(state, FACILITATOR, 'facilitator:add-role', {
      roleId: 'king_ecgberht',
      resources: { silver: 9 },
      stewardship: ['bernicia'],
    });
    const role = after.roles.king_ecgberht;
    expect(role).toMatchObject({
      id: 'king_ecgberht', silver: 9, wounds: 0, dead: false, generation: 0,
    });
    expect(after.shires.bernicia.stewardRoleId).toBe('king_ecgberht');
    expect(after.shires.bernicia.factionId).toBe(role.factionId);
  });

  it('defaults claims and resources to the printed sheet when nothing is committed', () => {
    const state = at13();
    const after = run(state, FACILITATOR, 'facilitator:add-role', { roleId: 'king_ecgberht' });
    expect(after.roles.king_ecgberht.claims).toEqual(data.roles.roles.king_ecgberht.claims);
    expect(after.roles.king_ecgberht.silver)
      .toBe(data.roles.roles.king_ecgberht.start.silver);
  });

  it('leaves a role with no printed lands with none, unless the form added some', () => {
    const state = at13();
    // Frida the Danish Trader holds nothing to start with.
    const traderStart = data.roles.roles.frida_anundottir.start;
    expect(traderStart.silver).toBeGreaterThan(0);
    const held = Object.values(state.shires).filter((s) => s.stewardRoleId === 'frida_anundottir');
    expect(held).toEqual([]);
  });
});

describe('clearing a seat out of the roster', () => {
  const seated = (extra = {}) => {
    const state = fresh();
    state.seats.s1 = {
      id: 's1', token: 'tok-1', name: 'Jo', roleId: 'king_alfred', kind: 'player',
      connected: false, lastSeen: 0, ...extra,
    };
    state.seatByToken['tok-1'] = 's1';
    return state;
  };

  it('refuses a seat that is not there', () => {
    expect(refusal(fresh(), FACILITATOR, 'facilitator:remove-seat', { seatId: 'nobody' }))
      .toBe('no such seat');
  });

  it('empties the chair without touching the character', () => {
    // The whole difference from remove-role. Half a game in, a player going
    // home must not take two shires and their silver off the board with them —
    // somebody at the table would like to pick Alfred up exactly as he is.
    const state = seated();
    const held = Object.keys(state.shires)
      .filter((id) => state.shires[id].stewardRoleId === 'king_alfred');
    expect(held.length).toBeGreaterThan(0);

    const after = run(state, FACILITATOR, 'facilitator:remove-seat', { seatId: 's1' });

    expect(after.seats.s1).toBeUndefined();
    expect(after.roles.king_alfred).toBeTruthy();
    expect(after.roles.king_alfred.silver).toBe(state.roles.king_alfred.silver);
    for (const id of held) expect(after.shires[id].stewardRoleId).toBe('king_alfred');
    expect(after.crownHolders.wessex).toBe('king_alfred');
  });

  it('takes the token with it, so the seat cannot let itself back in', () => {
    // The one thing this command exists to prevent. A token left behind is a
    // browser that resumes straight back into the chair just cleared.
    const after = run(seated(), FACILITATOR, 'facilitator:remove-seat', { seatId: 's1' });
    expect(after.seatByToken['tok-1']).toBeUndefined();
    expect(Object.values(after.seatByToken)).not.toContain('s1');
  });

  it('frees the role for somebody else to take', () => {
    let state = seated();
    state = run(state, FACILITATOR, 'facilitator:remove-seat', { seatId: 's1' });
    state.seats.s2 = {
      id: 's2', token: 'tok-2', name: 'Sam', roleId: null, kind: 'player',
      connected: true, lastSeen: 0,
    };
    const after = run(state, { seatId: 's2', kind: 'player', roleId: null },
      'claim-role', { roleId: 'king_alfred' });
    expect(after.seats.s2.roleId).toBe('king_alfred');
  });

  it('does not argue about whether they look connected', () => {
    // Connection is a guess about a network, not a fact about a person: a seat
    // reads as connected because a tab is open on a laptop in somebody's bag.
    // The console offers the button where it is obviously right; the command
    // does what the umpire in the room tells it.
    const after = run(seated({ connected: true }), FACILITATOR,
      'facilitator:remove-seat', { seatId: 's1' });
    expect(after.seats.s1).toBeUndefined();
  });

  it('leaves every other seat where it is', () => {
    const state = seated();
    state.seats.s2 = {
      id: 's2', token: 'tok-2', name: 'Sam', roleId: 'cenred', kind: 'player',
      connected: true, lastSeen: 0,
    };
    state.seatByToken['tok-2'] = 's2';
    const after = run(state, FACILITATOR, 'facilitator:remove-seat', { seatId: 's1' });
    expect(after.seats.s2).toMatchObject({ roleId: 'cenred', name: 'Sam' });
    expect(after.seatByToken['tok-2']).toBe('s2');
  });
});

describe('removing a role mid-game', () => {
  it('refuses a role not in the game', () => {
    const state = createInitialState({
      joinCode: 'RAVEN7Z', seed: 1, data, roleIds: rosterFor(data, 13),
    });
    expect(refusal(state, FACILITATOR, 'facilitator:remove-role', { roleId: 'king_ecgberht' }))
      .toBe('not in the game');
  });

  it('empties every shire they stewarded', () => {
    const state = fresh();
    const held = Object.keys(state.shires).filter((id) => state.shires[id].stewardRoleId === 'king_alfred');
    expect(held.length).toBeGreaterThan(0);
    const after = run(state, FACILITATOR, 'facilitator:remove-role', { roleId: 'king_alfred' });
    for (const id of held) expect(after.shires[id]).toMatchObject({ stewardRoleId: null, factionId: null });
  });

  it('un-seats anyone playing them', () => {
    let state = fresh();
    state.seats.s1 = {
      id: 's1', token: 't', name: 'A', roleId: 'king_alfred', kind: 'player',
      connected: true, lastSeen: 0,
    };
    const after = run(state, FACILITATOR, 'facilitator:remove-role', { roleId: 'king_alfred' });
    expect(after.seats.s1.roleId).toBeNull();
  });

  it('clears any initiative token and crown they held', () => {
    let state = fresh();
    state = run(state, FACILITATOR, 'facilitator:assign-initiative',
      { token: 'bonus', roleId: 'king_alfred' });
    const after = run(state, FACILITATOR, 'facilitator:remove-role', { roleId: 'king_alfred' });
    expect(after.initiative.bonus).toBeNull();
    expect(after.crownHolders.wessex).toBeUndefined();
  });

  it('frees a vassal, the way losing a liege to death already does', () => {
    const state = fresh();
    expect(state.roles.cenred.liegeId).toBe('king_alfred');
    const after = run(state, FACILITATOR, 'facilitator:remove-role', { roleId: 'king_alfred' });
    expect(after.roles.cenred).toMatchObject({ liegeId: null, factionId: 'cenred' });
  });
});
