import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState, rosterFor, tokenHeldBy } from '../../gui/rules/state.js';
import { apply } from '../../gui/rules/reducer.js';
import { admit, availableTo } from '../../gui/rules/admission.js';
import { reachableFrom } from '../../gui/rules/derive.js';
import {
  seizeInitiative, settleBattle, heldBackToken, battleNoteKey,
} from '../../gui/rules/battle.js';
import { createClash } from '../../gui/rules/clash.js';
import { ruleFor, FACILITATOR as FACILITATOR_ONLY } from '../../gui/rules/visibility.js';

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

/** The team phase of turn two, which is where declaring becomes a choice. */
function turnTwo() {
  let state = fresh();
  state.seats.s9 = {
    id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0,
  };
  for (let i = 0; i < 5; i += 1) state = run(state, FACILITATOR, 'facilitator:advance-phase');
  return state;
}

describe('a token names somewhere you could actually march', () => {
  it('refuses a shire the holder cannot reach', () => {
    const state = turnTwo();
    expect(reachableFrom(state, data, 'halfdan_ragnarsson')).not.toContain('wiltshire');
    expect(refusal(state, as('halfdan_ragnarsson'), 'declare-initiative-target',
      { shireId: 'wiltshire' })).toBe('you cannot reach that shire');
  });

  it('takes one they can, and writes it down against their token', () => {
    let state = turnTwo();
    expect(reachableFrom(state, data, 'halfdan_ragnarsson')).toContain('north_mercia');
    state = run(state, as('halfdan_ragnarsson'), 'declare-initiative-target',
      { shireId: 'north_mercia' });
    expect(state.initiative.declared.white).toMatchObject({
      roleId: 'halfdan_ragnarsson', shireId: 'north_mercia', revealed: false,
    });
  });

  it('says the shire does not exist before it says you cannot reach it', () => {
    const state = turnTwo();
    expect(refusal(state, as('halfdan_ragnarsson'), 'declare-initiative-target',
      { shireId: 'atlantis' })).toBe('no such shire');
  });

  it('still refuses a non-holder for the reason that is actually theirs', () => {
    const state = turnTwo();
    expect(refusal(state, as('cenred'), 'declare-initiative-target',
      { shireId: 'wiltshire' })).toBe('you do not hold an initiative token');
  });

  it('leaves the verb available to a holder whose reach starts nowhere near the first shire', () => {
    // The probe has to name a shire this holder can actually attack. Guthrum
    // can reach two shires and neither is the one the map happens to list
    // first, so a probe that asked after that one would report the whole verb
    // refused and the console would grey his Target button out permanently.
    const state = turnTwo();
    const first = Object.keys(state.shires)[0];
    expect(reachableFrom(state, data, 'guthrum_the_old')).not.toContain(first);

    const target = availableTo(state, data, as('guthrum_the_old'))
      .find((a) => a.verb === 'declare-initiative-target');
    expect(target).toMatchObject({ ok: true });
  });

  it('greys the verb out for somebody holding no token, as it always did', () => {
    const state = turnTwo();
    const target = availableTo(state, data, as('cenred'))
      .find((a) => a.verb === 'declare-initiative-target');
    expect(target).toMatchObject({ ok: false, reason: 'you do not hold an initiative token' });
  });
});

describe('one role, one token', () => {
  it('refuses to hand a second token to somebody already holding one', () => {
    const state = fresh();
    expect(state.initiative.white).toBe('halfdan_ragnarsson');
    expect(refusal(state, FACILITATOR, 'facilitator:assign-initiative',
      { token: 'bonus', roleId: 'halfdan_ragnarsson' }))
      .toBe('Halfdan Ragnarsson already holds the white token');
  });

  it('refuses it the other way round too, with the bonus token held first', () => {
    // The bonus token specifically: it used to be written in a different shape
    // from white and black, which made its holder invisible to every check.
    let state = run(fresh(), FACILITATOR, 'facilitator:assign-initiative',
      { token: 'bonus', roleId: 'cenred' });
    expect(state.initiative.bonus).toBe('cenred');
    expect(refusal(state, FACILITATOR, 'facilitator:assign-initiative',
      { token: 'white', roleId: 'cenred' }))
      .toBe('Cenred already holds the bonus token');
    // And the white token is still where it was, rather than half-moved.
    state = fresh();
    expect(state.initiative.white).toBe('halfdan_ragnarsson');
  });

  it('lets a facilitator re-affirm the token somebody already holds', () => {
    const state = fresh();
    const after = run(state, FACILITATOR, 'facilitator:assign-initiative',
      { token: 'white', roleId: 'halfdan_ragnarsson' });
    expect(after.initiative.white).toBe('halfdan_ragnarsson');
  });

  it('always allows taking a token off, which is the way round a refusal', () => {
    let state = fresh();
    expect(refusal(state, FACILITATOR, 'facilitator:assign-initiative',
      { token: 'bonus', roleId: 'halfdan_ragnarsson' })).toBeTruthy();
    state = run(state, FACILITATOR, 'facilitator:assign-initiative',
      { token: 'white', roleId: null });
    expect(state.initiative.white).toBeNull();
    state = run(state, FACILITATOR, 'facilitator:assign-initiative',
      { token: 'bonus', roleId: 'halfdan_ragnarsson' });
    expect(tokenHeldBy(state.initiative, 'halfdan_ragnarsson')).toBe('bonus');
  });

  it('holds the invariant across the whole roster at the start of a game', () => {
    const state = fresh();
    const holders = ['white', 'black', 'bonus']
      .map((token) => state.initiative[token]).filter(Boolean);
    expect(new Set(holders).size).toBe(holders.length);
  });

  it('tells the facilitator when a target edit would name a double holder', () => {
    // set-initiative-target never moves a token onto anybody, so it cannot
    // create this itself — it can only inherit it from a raw override or an
    // old save. That is exactly when the facilitator wants telling.
    let state = run(fresh(), FACILITATOR, 'facilitator:advance-phase');
    state = run(state, FACILITATOR, 'facilitator:set',
      { path: ['initiative', 'black'], value: 'halfdan_ragnarsson' });
    expect(refusal(state, FACILITATOR, 'facilitator:set-initiative-target',
      { token: 'white', shireId: 'wiltshire' }))
      .toBe('Halfdan Ragnarsson also holds the black token — clear one first');
  });

  it('refuses a declaration from a double holder too, and names both tokens', () => {
    // Reached exactly the way the set-initiative-target case above is reached:
    // facilitator:set admits unconditionally by design. Without this gate
    // `effects` would write the declaration under white only, black's would
    // never be made, nobody would be told — and the facilitator's own retarget
    // control would be refusing on the very same state. Two commands reading
    // one board have to agree about it.
    let state = turnTwo();
    state = run(state, FACILITATOR, 'facilitator:set',
      { path: ['initiative', 'black'], value: 'halfdan_ragnarsson' });
    expect(tokenHeldBy(state.initiative, 'halfdan_ragnarsson')).toBe('white');

    expect(reachableFrom(state, data, 'halfdan_ragnarsson')).toContain('north_mercia');
    expect(refusal(state, as('halfdan_ragnarsson'), 'declare-initiative-target',
      { shireId: 'north_mercia' }))
      .toBe('you hold the white and black tokens — the facilitator must clear one first');

    // The facilitator's own control refuses the same state, which is the
    // agreement this test exists to hold.
    expect(refusal(state, FACILITATOR, 'facilitator:set-initiative-target',
      { token: 'white', shireId: 'north_mercia' }))
      .toBe('Halfdan Ragnarsson also holds the black token — clear one first');

    // Clearing one is the way out, for the player as much as the umpire.
    state = run(state, FACILITATOR, 'facilitator:assign-initiative',
      { token: 'black', roleId: null });
    state = run(state, as('halfdan_ragnarsson'), 'declare-initiative-target',
      { shireId: 'north_mercia' });
    expect(state.initiative.declared.white.shireId).toBe('north_mercia');
  });

  it('still refuses a non-holder before it complains about a second token', () => {
    const state = turnTwo();
    expect(refusal(state, as('cenred'), 'declare-initiative-target',
      { shireId: 'north_mercia' })).toBe('you do not hold an initiative token');
  });

  it('sets a target normally while each token has its own holder', () => {
    let state = run(fresh(), FACILITATOR, 'facilitator:advance-phase');
    state = run(state, FACILITATOR, 'facilitator:set-initiative-target',
      { token: 'white', shireId: 'wiltshire' });
    expect(state.initiative.declared.white)
      .toMatchObject({ roleId: 'halfdan_ragnarsson', shireId: 'wiltshire' });
  });
});

describe('the bonus token is a plain role id, like the other two', () => {
  /** Three factions in the fighting, Wessex sitting it out. */
  function wessexStayedOut(state) {
    state.battle.clashes = {
      c1: createClash({
        id: 'c1', shireId: 'lindsey', attacker: 'halfdan_ragnarsson', defender: 'gainbeald',
      }),
      c2: createClash({
        id: 'c2', shireId: 'essex', attacker: 'guthrum_the_old', defender: 'gainbeald',
      }),
    };
    return state;
  }

  it('is written as a role id, not as a record with an expiry nothing reads', () => {
    const state = wessexStayedOut(fresh());
    expect(seizeInitiative(state)).toBe('king_alfred');
    expect(state.initiative.bonus).toBe('king_alfred');
  });

  it('is visible to the checks that look for a holder, once seized', () => {
    const state = wessexStayedOut(fresh());
    seizeInitiative(state);
    expect(tokenHeldBy(state.initiative, 'king_alfred')).toBe('bonus');
    expect(refusal(state, FACILITATOR, 'facilitator:assign-initiative',
      { token: 'white', roleId: 'king_alfred' }))
      .toBe('King Alfred already holds the bonus token');
  });

  it('is cleared when its holder is taken out of the game', () => {
    // The bug the two shapes caused: remove-role compared with === against a
    // string, so a seized bonus token survived its holder's removal.
    const state = wessexStayedOut(fresh());
    seizeInitiative(state);
    const after = run(state, FACILITATOR, 'facilitator:remove-role', { roleId: 'king_alfred' });
    expect(after.initiative.bonus).toBeNull();
  });

  it('lets its holder declare a target, subject to the same reach gate', () => {
    const state = wessexStayedOut(turnTwo());
    seizeInitiative(state);
    state.phase.name = 'team';
    const reach = reachableFrom(state, data, 'king_alfred');
    expect(refusal(state, as('king_alfred'), 'declare-initiative-target',
      { shireId: reach[0] })).toBeUndefined();
    const beyond = Object.keys(state.shires).find((id) => !reach.includes(id));
    expect(refusal(state, as('king_alfred'), 'declare-initiative-target',
      { shireId: beyond })).toBe('you cannot reach that shire');
  });
});

describe('handing a token out never quietly creates a second one', () => {
  /** A battle at Lindsey the defender won twice, so the token should move. */
  function foughtAtLindsey() {
    const state = fresh();
    state.shires.lindsey.castles = 2;
    state.battle.targets = ['lindsey'];
    state.initiative.declared = {
      white: { roleId: 'halfdan_ragnarsson', shireId: 'lindsey', revealed: true },
    };
    let n = 0;
    for (let i = 0; i < 2; i += 1) {
      const clash = createClash({
        id: `lindsey:${(n += 1)}`,
        shireId: 'lindsey',
        attacker: 'ubba_ragnarsson',
        defender: 'gainbeald',
      });
      clash.stage = 'resolved';
      clash.result = { winner: 'gainbeald' };
      state.battle.clashes[clash.id] = clash;
    }
    return state;
  }

  it('passes the token to a defender who was holding nothing', () => {
    const state = foughtAtLindsey();
    settleBattle(state, data, 'lindsey');
    expect(state.initiative.white).toBe('gainbeald');
  });

  it('leaves it where it was rather than giving a defender a second one', () => {
    // No refusal is available inside effects, so the answer is not to create
    // the situation. The facilitator is standing over the battle and can move
    // the counter by hand.
    const state = foughtAtLindsey();
    state.initiative.black = 'gainbeald';
    settleBattle(state, data, 'lindsey');
    expect(state.initiative.white).toBe('halfdan_ragnarsson');
    expect(tokenHeldBy(state.initiative, 'gainbeald')).toBe('black');
  });

  it('says so, because nothing else would — not the return, not the grid', () => {
    // Rewritten from a version that asserted a note written into
    // facilitatorNotes. `tokenChangesHands` goes on reading true and
    // facilitator:settle-battle throws the return away, so it still has to be
    // said — but it is read off the board rather than filed away, so this
    // asserts the condition the grid draws its line from.
    const state = foughtAtLindsey();
    state.initiative.black = 'gainbeald';
    const result = settleBattle(state, data, 'lindsey');
    expect(result.tokenChangesHands).toBe(true);
    expect(result.tokenHeldBack).toBe(true);

    expect(heldBackToken(state, 'lindsey')).toEqual({
      token: 'white', steward: 'gainbeald', alsoHolds: 'black', stays: 'halfdan_ragnarsson',
    });
  });

  it('is answerable before the settling as well as after it', () => {
    // The same question about the same board. It is what makes the warning
    // derivable rather than an event that had to be caught as it went past.
    const state = foughtAtLindsey();
    state.initiative.black = 'gainbeald';
    expect(heldBackToken(state, 'lindsey')).toMatchObject({ token: 'white', alsoHolds: 'black' });
  });

  it('stops being true the moment the facilitator moves the counters', () => {
    // The dismissal a stored note never had. A facilitator who does what they
    // were told — clear the stray, hand the right token over — must not be
    // left looking at the warning for the rest of the phase.
    const state = foughtAtLindsey();
    state.phase.name = 'battle';
    state.initiative.black = 'gainbeald';
    let after = run(state, FACILITATOR, 'facilitator:settle-battle', { shireId: 'lindsey' });
    expect(heldBackToken(after, 'lindsey')).not.toBeNull();

    after = run(after, FACILITATOR, 'facilitator:assign-initiative',
      { token: 'black', roleId: null });
    after = run(after, FACILITATOR, 'facilitator:assign-initiative',
      { token: 'white', roleId: 'gainbeald' });
    expect(heldBackToken(after, 'lindsey')).toBeNull();
  });

  it('says nothing when the token did change hands', () => {
    const state = foughtAtLindsey();
    const result = settleBattle(state, data, 'lindsey');
    expect(result.tokenHeldBack).toBe(false);
    expect(state.initiative.white).toBe('gainbeald');
    expect(heldBackToken(state, 'lindsey')).toBeNull();
  });

  it('stores nothing about it, in either notes channel', () => {
    // Rewritten from a version that asserted the opposite. A derived value
    // that is also written down is how the grid and the board come to
    // disagree — and this one would have outlived the facilitator fixing it.
    const state = foughtAtLindsey();
    state.phase.name = 'battle';
    state.initiative.black = 'gainbeald';
    const after = run(state, FACILITATOR, 'facilitator:settle-battle', { shireId: 'lindsey' });
    expect(after.facilitatorNotes).toEqual({});
    expect(after.battleNotes).toEqual({});
  });

  it('names nobody rather than null when the token it held back is unheld', () => {
    // Reachable: facilitator:remove-role nulls a token but leaves the
    // declaration made with it standing. The derived answer has to survive
    // that, because the string it feeds is read out loud.
    const state = foughtAtLindsey();
    state.phase.name = 'battle';
    state.initiative.black = 'gainbeald';
    const after = run(state, FACILITATOR, 'facilitator:remove-role',
      { roleId: 'halfdan_ragnarsson' });
    expect(after.initiative.white).toBeNull();
    expect(after.initiative.declared.white.shireId).toBe('lindsey');
    expect(heldBackToken(after, 'lindsey')).toMatchObject({ token: 'white', stays: null });
  });

  it('gives the seized token to a faction member who is empty-handed', () => {
    const state = fresh();
    state.battle.clashes = {
      c1: createClash({
        id: 'c1', shireId: 'lindsey', attacker: 'halfdan_ragnarsson', defender: 'gainbeald',
      }),
      c2: createClash({
        id: 'c2', shireId: 'essex', attacker: 'guthrum_the_old', defender: 'gainbeald',
      }),
    };
    state.initiative.white = 'king_alfred';   // first in Wessex, and already holding
    expect(seizeInitiative(state)).toBe('cenred');
    expect(state.initiative.bonus).toBe('cenred');
  });

  it('gives it to nobody when the whole quiet faction is already holding', () => {
    const state = createInitialState({
      joinCode: 'RAVEN7Z', seed: 1, data, roleIds: rosterFor(data, 12),
    });
    state.battle.clashes = {
      c1: createClash({
        id: 'c1', shireId: 'lindsey', attacker: 'halfdan_ragnarsson', defender: 'gainbeald',
      }),
      c2: createClash({
        id: 'c2', shireId: 'essex', attacker: 'guthrum_the_old', defender: 'gainbeald',
      }),
    };
    // Wessex is three roles at twelve players, and there are three tokens.
    state.initiative.white = 'king_alfred';
    state.initiative.black = 'cenred';
    state.initiative.bonus = 'archbishop_aethelred';
    expect(seizeInitiative(state)).toBeNull();
    expect(state.initiative.bonus).toBe('archbishop_aethelred');
    // And says why. The button reads "hand out the spare token", so "nobody
    // was empty-handed" and "handed out" must not look identical.
    expect(state.battleNotes[battleNoteKey(state.phase.turn, 'spare')])
      .toContain('already holding one');
  });

  it('says so too when more than one faction stayed out of the fighting', () => {
    // Already silent before this change, and cheap to bring into the same
    // reporting — it is the same button telling the same lie by omission.
    const state = fresh();
    expect(seizeInitiative(state)).toBeNull();
    expect(state.battleNotes[battleNoteKey(state.phase.turn, 'spare')])
      .toContain('factions stayed out');
  });

  it('leaves no note behind when a spare token did go out', () => {
    const state = fresh();
    state.battle.clashes = {
      c1: createClash({
        id: 'c1', shireId: 'lindsey', attacker: 'halfdan_ragnarsson', defender: 'gainbeald',
      }),
      c2: createClash({
        id: 'c2', shireId: 'essex', attacker: 'guthrum_the_old', defender: 'gainbeald',
      }),
    };
    const key = battleNoteKey(state.phase.turn, 'spare');
    state.battleNotes[key] = 'left over from last turn';
    expect(seizeInitiative(state)).toBe('king_alfred');
    expect(state.battleNotes[key]).toBeUndefined();
  });
});

describe('the spare-token note is written down because nothing could derive it', () => {
  it('outlives the command that clears the board under it', () => {
    // facilitator:end-battles calls seizeInitiative and then wipes
    // draft.battle, so "was anybody left out of the fighting?" has no answer
    // a moment later. That is the whole reason this one is state.
    let state = run(fresh(), FACILITATOR, 'facilitator:advance-phase');
    state = run(state, FACILITATOR, 'facilitator:advance-phase');   // team -> battle
    const after = run(state, FACILITATOR, 'facilitator:end-battles');

    expect(after.battle.clashes).toEqual({});
    expect(after.battleNotes[battleNoteKey(after.phase.turn, 'spare')])
      .toContain('No spare initiative token was handed out');
  });

  it('is filed where only a facilitator can read it', () => {
    expect(ruleFor(['battleNotes', 'initiative:t1:spare']).audience).toBe(FACILITATOR_ONLY);
  });

  it('is kept out of facilitatorNotes, which the epilogue prints', () => {
    let state = run(fresh(), FACILITATOR, 'facilitator:advance-phase');
    state = run(state, FACILITATOR, 'facilitator:advance-phase');
    const after = run(state, FACILITATOR, 'facilitator:end-battles');
    expect(after.facilitatorNotes).toEqual({});
  });
});
