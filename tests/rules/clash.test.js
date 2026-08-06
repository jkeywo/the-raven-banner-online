import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply } from '../../gui/rules/reducer.js';
import { admit } from '../../gui/rules/admission.js';
import { projectView } from '../../gui/rules/views.js';
import {
  createClash, advanceClash, amendLead, confirmLead, resolveClash,
  casualtiesFor, feed, battleScore, leadership,
} from '../../gui/rules/clash.js';
import {
  tally, settleBattle, pairSides, clashesIn, conqueringDeclaration, settlementHold,
} from '../../gui/rules/battle.js';
import { overrides } from '../../gui/rules/command-log.js';

const data = await loadData();

/** A clash with both cards down, ready to have its dice read off. */
function armed({ attacker = 'guthrum_the_old', defender = 'king_alfred',
  cards = {}, lead = {}, rolls = {}, shireId = 'wiltshire' } = {}) {
  const clash = createClash({ id: 'c1', shireId, attacker, defender });
  clash.tactic[attacker] = cards[attacker];
  clash.tactic[defender] = cards[defender];
  clash.lead[attacker] = lead[attacker] ?? false;
  clash.lead[defender] = lead[defender] ?? false;
  clash.rolls[attacker] = rolls[attacker];
  clash.rolls[defender] = rolls[defender];
  clash.stage = 'rolling';
  return clash;
}

describe('the worked example from the rulebook', () => {
  // Players Guide pages 17-18, followed exactly. Guthrum attacks Alfred, who
  // defends a shire with three defended settlements. Guthrum plays Stand Firm
  // and rolls a six; Alfred plays Defensive, leads the charge and rolls a five.
  const clash = armed({
    cards: { guthrum_the_old: '4', king_alfred: '2' },
    lead: { king_alfred: true },
    rolls: { guthrum_the_old: 6, king_alfred: 5 },
  });
  const outcome = resolveClash(clash, data, {
    defendedSettlements: 3,
    food: { guthrum_the_old: 3, king_alfred: 5 },
  });

  it('scores it six all', () => {
    expect(outcome.scores.guthrum_the_old).toBe(6);   // 4 + 2
    expect(outcome.scores.king_alfred).toBe(6);       // 2 + 1 defended + 3 lead
  });

  it('gives it to the attacker on the tie', () => {
    expect(outcome.winner).toBe('guthrum_the_old');
  });

  it('wounds Alfred on the six, and not for leading', () => {
    // Guthrum's six wounds his opponent. Alfred led with +3 against +2, so he
    // was not outshone and takes nothing for it.
    expect(outcome.wounds.king_alfred).toBe(1);
    expect(outcome.wounds.guthrum_the_old).toBe(0);
  });

  it('kills nobody', () => {
    // Guthrum: Alfred's Defensive deals 0, Stand Firm receives 0.
    expect(outcome.casualties.guthrum_the_old).toBe(0);
    // Alfred: Stand Firm deals 1, Defensive receives -1.
    expect(outcome.casualties.king_alfred).toBe(0);
  });

  it('starves one of Guthrum’s four, and none of Alfred’s two', () => {
    expect(outcome.feeding.guthrum_the_old).toEqual({ foodSpent: 3, starved: 1 });
    expect(outcome.feeding.king_alfred).toEqual({ foodSpent: 2, starved: 0 });
  });
});

describe('the maths on its own', () => {
  it('reads the printed leadership table', () => {
    expect([1, 2, 3, 4, 5, 6].map((r) => leadership(data, r, false).bonus))
      .toEqual([0, 0, 0, 1, 1, 2]);
    expect([1, 2, 3, 4, 5, 6].map((r) => leadership(data, r, true).bonus))
      .toEqual([-1, 1, 2, 3, 3, 4]);
    // A six wounds the other side whether or not you were in the front rank.
    expect(leadership(data, 6, false).woundsOpponent).toBe(true);
    expect(leadership(data, 6, true).woundsOpponent).toBe(true);
    expect(leadership(data, 5, true).woundsOpponent).toBe(false);
  });

  it('never turns a negative loss into a gain', () => {
    // Withdraw against Withdraw: -1 dealt, -1 received. The printed rule is
    // emphatic that this is nought, not two free soldiers.
    const clash = armed({ cards: { guthrum_the_old: 'A', king_alfred: 'A' } });
    expect(casualtiesFor(clash, data, 'guthrum_the_old')).toBe(0);
  });

  it('gives the defender a point only where the shire is well held', () => {
    const clash = armed({ cards: { guthrum_the_old: '3', king_alfred: '3' } });
    expect(battleScore(clash, data, 'king_alfred', { defendedSettlements: 3 })).toBe(4);
    expect(battleScore(clash, data, 'king_alfred', { defendedSettlements: 2 })).toBe(3);
    // Attackers never get it, however well defended the place is.
    expect(battleScore(clash, data, 'guthrum_the_old', { defendedSettlements: 3 })).toBe(3);
  });

  it('adds a point for every reinforcing soldier', () => {
    const clash = armed({ cards: { guthrum_the_old: '3', king_alfred: '3' } });
    clash.reinforcements.cenred = 2;
    expect(battleScore(clash, data, 'king_alfred')).toBe(5);
    expect(battleScore(clash, data, 'guthrum_the_old')).toBe(3);
  });

  it('starves whatever cannot be fed', () => {
    expect(feed({ committed: 5, casualties: 1, food: 2 })).toEqual({ foodSpent: 2, starved: 2 });
    expect(feed({ committed: 3, casualties: 3, food: 0 })).toEqual({ foodSpent: 0, starved: 0 });
  });

  it('can take two wounds off one bad charge', () => {
    // Led the charge, rolled a one, and was hit by a six.
    const clash = armed({
      cards: { guthrum_the_old: '3', king_alfred: '3' },
      lead: { king_alfred: true },
      rolls: { guthrum_the_old: 6, king_alfred: 1 },
    });
    const outcome = resolveClash(clash, data, { food: {} });
    expect(outcome.wounds.king_alfred).toBe(2);
  });
});

describe('the ratchet', () => {
  function upToReveal() {
    const clash = createClash({ id: 'c1', shireId: 'wiltshire', attacker: 'a', defender: 'd' });
    clash.tactic.a = '3';
    clash.tactic.d = '3';
    advanceClash(clash);
    clash.lead.a = false;
    clash.lead.d = false;
    advanceClash(clash);
    return clash;
  }

  it('reveals both declarations once both are in', () => {
    expect(upToReveal().stage).toBe('lead_revealed');
  });

  it('lets you join a charge you did not expect', () => {
    const clash = upToReveal();
    expect(amendLead(clash, 'a', true)).toEqual({ ok: true });
    expect(clash.lead.a).toBe(true);
    // The other side now has something new to answer.
    expect(clash.confirmed.d).toBe(false);
  });

  it('will not let you step back out of one', () => {
    // The whole reason the printed rule terminates. Read as a free switch it
    // never would: each side would keep answering the other.
    const clash = upToReveal();
    amendLead(clash, 'a', true);
    expect(amendLead(clash, 'd', false))
      .toMatchObject({ ok: false, reason: 'you can join the charge, but you cannot leave it' });
  });

  it('settles after at most two changes of mind', () => {
    const clash = upToReveal();
    amendLead(clash, 'a', true);     // one flips up
    advanceClash(clash);
    expect(clash.stage).toBe('lead_revealed');
    amendLead(clash, 'd', true);     // the other answers
    advanceClash(clash);
    // Both are now leading; there is nothing either could still change.
    expect(clash.stage).toBe('rolling');
  });

  it('settles just as well when nobody moves', () => {
    const clash = upToReveal();
    confirmLead(clash, 'a');
    confirmLead(clash, 'd');
    expect(advanceClash(clash)).toBe('rolling');
  });

  it('needs nothing from someone already leading', () => {
    const clash = createClash({ id: 'c1', shireId: 'wiltshire', attacker: 'a', defender: 'd' });
    clash.tactic.a = '3'; clash.tactic.d = '3';
    advanceClash(clash);
    clash.lead.a = true; clash.lead.d = false;
    advanceClash(clash);
    // The one in the front rank has no decision left; only the other does.
    expect(clash.confirmed.a).toBe(true);
    expect(clash.confirmed.d).toBe(false);
  });
});

describe('pairing', () => {
  it('seeds an unopposed attacker as an already-won clash', () => {
    // The printed rules count walking in as a victory, so it is one clash in
    // the tally like any other rather than a special case in the count.
    const { clashes } = pairSides({
      attackers: ['a1', 'a2'], defenders: ['d1'], shireId: 'wiltshire',
    });
    expect(clashes).toHaveLength(2);
    expect(clashes[1]).toMatchObject({ auto: true, stage: 'resolved' });
    expect(clashes[1].result.winner).toBe('a2');
  });

  it('leaves spare defenders free to reinforce or scout', () => {
    const { spareDefenders } = pairSides({
      attackers: ['a1'], defenders: ['d1', 'd2', 'd3'], shireId: 'wiltshire',
    });
    expect(spareDefenders).toEqual(['d2', 'd3']);
  });

  it('honours a pairing the facilitator gives it', () => {
    // Rivalries get announced out loud in the room, and the umpire honours them.
    const { clashes } = pairSides({
      attackers: ['a1', 'a2'], defenders: ['d1', 'd2'], shireId: 'wiltshire',
      pairs: [['a2', 'd1'], ['a1', 'd2']],
    });
    expect(clashes.map((c) => [c.attacker, c.defender])).toEqual([['a2', 'd1'], ['a1', 'd2']]);
  });
});

describe('what a battle adds up to', () => {
  /** A state with a battle over a shire, already fought. */
  function fought({ castles = 2, attackerWins = 0, defenderWins = 0, scouts = 0 }) {
    const state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
    state.shires.lindsey.castles = castles;
    state.battle.targets = ['lindsey'];
    state.initiative.declared = {
      white: { roleId: 'halfdan_ragnarsson', shireId: 'lindsey', revealed: true },
    };
    let n = 0;
    for (let i = 0; i < attackerWins; i++) {
      const c = createClash({ id: `lindsey:${++n}`, shireId: 'lindsey', attacker: 'halfdan_ragnarsson', defender: 'gainbeald' });
      c.stage = 'resolved'; c.result = { winner: 'halfdan_ragnarsson' };
      state.battle.clashes[c.id] = c;
    }
    for (let i = 0; i < defenderWins; i++) {
      const c = createClash({ id: `lindsey:${++n}`, shireId: 'lindsey', attacker: 'ubba_ragnarsson', defender: 'gainbeald' });
      c.stage = 'resolved'; c.result = { winner: 'gainbeald' };
      state.battle.clashes[c.id] = c;
    }
    state.battle.scouts = { lindsey: Array.from({ length: scouts }, (_, i) => `scout${i}`) };
    return state;
  }

  it('takes a shire on one win per castle, however many were lost', () => {
    expect(tally(fought({ castles: 2, attackerWins: 2, defenderWins: 3 }), 'lindsey').shireFalls)
      .toBe(true);
    expect(tally(fought({ castles: 3, attackerWins: 2, defenderWins: 0 }), 'lindsey').shireFalls)
      .toBe(false);
  });

  it('moves the shire and knocks a castle down, never below two', () => {
    const state = fought({ castles: 3, attackerWins: 3 });
    settleBattle(state, data, 'lindsey', { newSteward: 'ubba_ragnarsson' });
    expect(state.shires.lindsey.stewardRoleId).toBe('ubba_ragnarsson');
    expect(state.shires.lindsey.castles).toBe(2);

    const floor = fought({ castles: 2, attackerWins: 2 });
    settleBattle(floor, data, 'lindsey', { newSteward: 'ubba_ragnarsson' });
    expect(floor.shires.lindsey.castles).toBe(2);
  });

  it('gives the token to a defender who won twice, even losing the shire', () => {
    // The rule that stops a strong faction simply rolling forward.
    const state = fought({ castles: 2, attackerWins: 2, defenderWins: 2 });
    settleBattle(state, data, 'lindsey');
    expect(state.shires.lindsey.stewardRoleId).not.toBe('gainbeald');   // it fell
    expect(state.initiative.white).toBe('gainbeald');                   // and yet
  });

  it('counts a scout toward the token and toward nothing else', () => {
    const state = fought({ castles: 4, attackerWins: 1, defenderWins: 1, scouts: 1 });
    const result = tally(state, 'lindsey');
    expect(result.tokenChangesHands).toBe(true);
    expect(result.shireFalls).toBe(false);
  });
});

describe('who takes a shire that falls', () => {
  const HALFDAN = { seatId: 's1', kind: 'player', roleId: 'halfdan_ragnarsson' };
  const UBBA = { seatId: 's2', kind: 'player', roleId: 'ubba_ragnarsson' };
  const GAINBEALD = { seatId: 's3', kind: 'player', roleId: 'gainbeald' };
  const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };

  const run = (state, actor, verb, payload = {}) => {
    const result = apply(state, data, { verb, payload }, actor, { ts: 0 });
    if (!result.ok) throw new Error(`${verb} refused: ${result.reason}`);
    return result.state;
  };
  const refusal = (state, actor, verb, payload = {}) =>
    admit(state, data, { verb, payload }, actor).reason;

  /**
   * Lindsey taken: two attackers, two castles, a clash won for each.
   *
   * Hand-built rather than driven through the dice, because what is under test
   * is what happens after the fighting, and a seeded die that came up the
   * wrong way would decide whether the test ran at all.
   */
  function taken({ castles = 2, declared, picks } = {}) {
    const state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
    state.phase.name = 'battle';
    state.shires.lindsey.castles = castles;
    state.battle.targets = ['lindsey'];
    state.battle.sides = {
      lindsey: {
        attackers: ['halfdan_ragnarsson', 'ubba_ragnarsson'],
        defenders: ['gainbeald'],
      },
    };
    state.initiative.declared = declared ?? {
      white: { roleId: 'halfdan_ragnarsson', shireId: 'lindsey', revealed: true },
    };
    ['halfdan_ragnarsson', 'ubba_ragnarsson'].forEach((attacker, i) => {
      const clash = createClash({
        id: `lindsey:${i + 1}`,
        shireId: 'lindsey',
        attacker,
        defender: i === 0 ? 'gainbeald' : null,
      });
      clash.stage = 'resolved';
      clash.result = { winner: attacker };
      state.battle.clashes[clash.id] = clash;
    });
    if (picks) state.battle.stewardPicks = picks;
    return state;
  }

  it('is whoever the token holder named, ahead of the first attacker', () => {
    // The default is "whoever the pairing happened to put first", which is an
    // accident of the facilitator's clicking, not a decision anybody made.
    const state = taken();
    expect(clashesIn(state, 'lindsey')[0].attacker).toBe('halfdan_ragnarsson');

    const after = run(state, HALFDAN, 'name-new-steward',
      { shireId: 'lindsey', stewardRoleId: 'ubba_ragnarsson' });
    settleBattle(after, data, 'lindsey');
    expect(after.shires.lindsey.stewardRoleId).toBe('ubba_ragnarsson');
    expect(after.shires.lindsey.factionId).toBe(after.roles.ubba_ragnarsson.factionId);
  });

  it('beats a taker the facilitator handed in by hand', () => {
    // The whole point of the command: the umpire facilitates the choice, they
    // do not make it. `newSteward` survives as the last resort for a shire
    // whose holder has left the table, and it loses to a holder who has not.
    const state = taken({ picks: { lindsey: 'ubba_ragnarsson' } });
    settleBattle(state, data, 'lindsey', { newSteward: 'halfdan_ragnarsson' });
    expect(state.shires.lindsey.stewardRoleId).toBe('ubba_ragnarsson');
  });

  it('falls back to the first attacker when nobody named anybody', () => {
    const state = taken();
    settleBattle(state, data, 'lindsey');
    expect(state.shires.lindsey.stewardRoleId).toBe('halfdan_ragnarsson');
  });

  it('is not for a player whose token declared nothing there', () => {
    const state = taken();
    expect(refusal(state, UBBA, 'name-new-steward',
      { shireId: 'lindsey', stewardRoleId: 'ubba_ragnarsson' }))
      .toBe('only the holder whose token declared that attack names its steward');
    // Nor for the defender, who has just lost it.
    expect(refusal(state, GAINBEALD, 'name-new-steward',
      { shireId: 'lindsey', stewardRoleId: 'ubba_ragnarsson' }))
      .toBe('only the holder whose token declared that attack names its steward');
  });

  it('waits until the shire has actually fallen', () => {
    const unfinished = taken();
    unfinished.battle.clashes['lindsey:2'].stage = 'rolling';
    unfinished.battle.clashes['lindsey:2'].result = null;
    expect(refusal(unfinished, HALFDAN, 'name-new-steward',
      { shireId: 'lindsey', stewardRoleId: 'ubba_ragnarsson' })).toBe('the fighting is not over');

    // Fought to the end and held: there is nothing to give away.
    const held = taken({ castles: 3 });
    expect(refusal(held, HALFDAN, 'name-new-steward',
      { shireId: 'lindsey', stewardRoleId: 'ubba_ragnarsson' })).toBe('the shire held');
  });

  it('names somebody who was actually there', () => {
    const state = taken();
    expect(refusal(state, HALFDAN, 'name-new-steward',
      { shireId: 'lindsey', stewardRoleId: 'gainbeald' })).toBe('name somebody who attacked it');
    expect(refusal(state, HALFDAN, 'name-new-steward',
      { shireId: 'lindsey', stewardRoleId: 'nobody_at_all' })).toBe('no such role in this game');
  });

  it('settles the battle the moment it lands, and there is no second word', () => {
    // The fighting was already over, so the pick was the last thing owed —
    // and a battle that owes nothing settles itself. That makes naming a
    // steward final, which is why the console asks before sending it.
    let state = taken();
    state = run(state, HALFDAN, 'name-new-steward',
      { shireId: 'lindsey', stewardRoleId: 'ubba_ragnarsson' });
    expect(state.shires.lindsey.stewardRoleId).toBe('ubba_ragnarsson');
    expect(state.battle.settled.lindsey).toBe(true);

    expect(refusal(state, HALFDAN, 'name-new-steward',
      { shireId: 'lindsey', stewardRoleId: 'halfdan_ragnarsson' }))
      .toBe('that battle is already settled');
  });

  it('goes with the battle when the phase ends', () => {
    // Turn-scoped for free: a pick is about a battle on the board, and
    // end-battles clears the board.
    let state = run(taken(), HALFDAN, 'name-new-steward',
      { shireId: 'lindsey', stewardRoleId: 'ubba_ragnarsson' });
    state = run(state, FACILITATOR, 'facilitator:end-battles', {});
    expect(state.battle.stewardPicks).toEqual({});
  });

  it('survives a replay, because it went through the reducer like everything else', () => {
    let state = taken();
    state = run(state, HALFDAN, 'name-new-steward',
      { shireId: 'lindsey', stewardRoleId: 'ubba_ragnarsson' });
    expect(overrides(state.log).map((e) => e.verb)).not.toContain('name-new-steward');
    expect(state.log.at(-1)).toMatchObject({
      verb: 'name-new-steward', roleId: 'halfdan_ragnarsson',
    });
  });

  describe('when two tokens declared the same shire', () => {
    // Announce refuses while two live tokens name Lindsey, so this state
    // never reaches a battle by the ordinary route — but it exists during the
    // team phase, and can still arrive by a raw facilitator:set or an old
    // save. So the tie-break is written down rather than left to whichever
    // declaration happened to be recorded first.
    const bothAtLindsey = (order) => Object.fromEntries(order.map((token) => [token, {
      roleId: token === 'white' ? 'halfdan_ragnarsson' : 'ubba_ragnarsson',
      shireId: 'lindsey',
      revealed: true,
    }]));

    it('answers with the earlier token, whichever was written down first', () => {
      for (const order of [['white', 'black'], ['black', 'white']]) {
        const state = taken({ declared: bothAtLindsey(order) });
        expect(conqueringDeclaration(state, 'lindsey'))
          .toEqual({ token: 'white', roleId: 'halfdan_ragnarsson' });
      }
    });

    it('lets only that holder name the steward', () => {
      const state = taken({ declared: bothAtLindsey(['black', 'white']) });
      expect(refusal(state, UBBA, 'name-new-steward',
        { shireId: 'lindsey', stewardRoleId: 'ubba_ragnarsson' }))
        .toBe('only the holder whose token declared that attack names its steward');
      const after = run(state, HALFDAN, 'name-new-steward',
        { shireId: 'lindsey', stewardRoleId: 'ubba_ragnarsson' });
      expect(after.battle.stewardPicks.lindsey).toBe('ubba_ragnarsson');
    });

    it('moves the same token it let name the steward', () => {
      // One declaration owns the battle. A defender who won twice takes the
      // white token because white is who the steward pick answered to, rather
      // than the two questions being settled by two different declarations.
      const state = taken({ castles: 3, declared: bothAtLindsey(['black', 'white']) });
      for (const clash of Object.values(state.battle.clashes)) {
        clash.result = { winner: 'gainbeald' };
      }
      settleBattle(state, data, 'lindsey');
      expect(state.initiative.white).toBe('gainbeald');
      expect(state.initiative.black).toBe('guthrum_the_old');
    });
  });
});

describe('the secrets hold', () => {
  /** Two seated fighters, mid-clash. */
  function midClash(stage) {
    const state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
    const clash = createClash({
      id: 'c1', shireId: 'lindsey', attacker: 'halfdan_ragnarsson', defender: 'gainbeald',
    });
    clash.tactic.halfdan_ragnarsson = '5';
    clash.tactic.gainbeald = '2';
    clash.lead.halfdan_ragnarsson = true;
    clash.lead.gainbeald = false;
    clash.stage = stage;
    state.battle.clashes.c1 = clash;
    return state;
  }

  const seenBy = (state, roleId) => projectView(state, data, {
    kind: 'player', seatId: 's1', roleId, teamId: state.roles[roleId].teamId,
  });

  it('keeps a card from the other fighter until both are down', () => {
    const seen = seenBy(midClash('awaiting_tactics'), 'gainbeald');
    expect(seen.battle.clashes.c1.tactic.gainbeald).toBe('2');
    expect(seen.battle.clashes.c1.tactic.halfdan_ragnarsson).toBeUndefined();
    // But you can see you are waiting on somebody, which you need to.
    expect(seen.clashProgress.c1.tacticSubmitted.halfdan_ragnarsson).toBe(true);
  });

  it('opens both the moment the machine says so', () => {
    const seen = seenBy(midClash('tactics_revealed'), 'gainbeald');
    expect(seen.battle.clashes.c1.tactic.halfdan_ragnarsson).toBe('5');
    // The leadership declarations are still to come.
    expect(seen.battle.clashes.c1.lead?.halfdan_ragnarsson).toBeUndefined();
  });

  it('opens the declarations only at their own reveal', () => {
    const seen = seenBy(midClash('lead_revealed'), 'gainbeald');
    expect(seen.battle.clashes.c1.lead.halfdan_ragnarsson).toBe(true);
  });

  it('shows a bystander the shape of a clash but neither card', () => {
    const seen = seenBy(midClash('awaiting_tactics'), 'king_alfred');
    expect(seen.battle.clashes.c1.attacker).toBe('halfdan_ragnarsson');
    expect(seen.battle.clashes.c1.tactic).toBeUndefined();
  });
});

describe('through the reducer', () => {
  /** A game in the battle phase with a clash under way. */
  function battling() {
    let state = createInitialState({ joinCode: 'RAVEN7Z', seed: 7, data });
    const facilitator = { seatId: 's9', kind: 'facilitator', roleId: null };
    state.seats.s9 = { id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
    for (const seat of [['s1', 'halfdan_ragnarsson'], ['s2', 'gainbeald']]) {
      state.seats[seat[0]] = { id: seat[0], token: seat[0], name: seat[0], roleId: seat[1], kind: 'player', connected: true, lastSeen: 0 };
    }
    const step = (verb, payload, actor = facilitator) => {
      const result = apply(state, data, { verb, payload }, actor, { ts: 0 });
      if (!result.ok) throw new Error(`${verb} refused: ${result.reason}`);
      state = result.state;
    };
    step('facilitator:advance-phase', {});                                    // team
    // No declaration: turn one's targets are fixed, and Halfdan's is Lindsey.
    step('facilitator:advance-phase', {});                                    // battle
    step('facilitator:announce-targets', {});
    step('join-battle', { shireId: 'lindsey', side: 'attackers' },
      { seatId: 's1', kind: 'player', roleId: 'halfdan_ragnarsson' });
    step('join-battle', { shireId: 'lindsey', side: 'defenders' },
      { seatId: 's2', kind: 'player', roleId: 'gainbeald' });
    step('facilitator:pair-clashes', { shireId: 'lindsey' });
    return { get state() { return state; }, step, facilitator };
  }

  const HALFDAN = { seatId: 's1', kind: 'player', roleId: 'halfdan_ragnarsson' };
  const GAINBEALD = { seatId: 's2', kind: 'player', roleId: 'gainbeald' };

  /** Both fighters through cards and declarations, stopped at the dice. */
  function upToTheDice() {
    const game = battling();
    const clashId = Object.keys(game.state.battle.clashes)[0];

    game.step('submit-tactic', { clashId, card: '5' }, HALFDAN);
    game.step('submit-tactic', { clashId, card: '2' }, GAINBEALD);
    expect(game.state.battle.clashes[clashId].stage).toBe('awaiting_lead');

    game.step('declare-lead', { clashId, lead: false }, HALFDAN);
    game.step('declare-lead', { clashId, lead: false }, GAINBEALD);
    expect(game.state.battle.clashes[clashId].stage).toBe('lead_revealed');

    game.step('confirm-lead', { clashId }, HALFDAN);
    game.step('confirm-lead', { clashId }, GAINBEALD);
    expect(game.state.battle.clashes[clashId].stage).toBe('rolling');
    return { game, clashId };
  }

  it('runs a clash from cards to a settled shire', () => {
    // Each fighter throws their own die, and the second one down settles it.
    // Rewritten from a single facilitator roll: that is now the override, and
    // this is the path the room actually walks.
    const { game, clashId } = upToTheDice();

    game.step('submit-roll', { clashId }, HALFDAN);
    expect(game.state.battle.clashes[clashId].stage).toBe('rolling');
    expect(game.state.battle.clashes[clashId].rolls.gainbeald).toBeNull();

    game.step('submit-roll', { clashId }, GAINBEALD);
    const clash = game.state.battle.clashes[clashId];
    expect(clash.stage).toBe('resolved');
    expect(clash.result.winner).toBeTruthy();
    for (const roleId of ['halfdan_ragnarsson', 'gainbeald']) {
      expect(clash.rolls[roleId]).toBeGreaterThanOrEqual(1);
      expect(clash.rolls[roleId]).toBeLessThanOrEqual(6);
    }
    // Two dice, two turns of the cursor, and nothing else drew from it.
    expect(game.state.rngCursor).toBe(2);
    // Neither die was the facilitator's doing.
    expect(overrides(game.state.log).map((e) => e.verb)).not.toContain('submit-roll');
  });

  it('spends a reinforcing bystander their soldiers, once, on the players\' own path', () => {
    // The settlement block moved out of the facilitator's command so both
    // paths could share it, and a reinforcer's upkeep is the part of it
    // reached from neither of the two tests above — the soldiers come off
    // somebody who is not in the clash at all, now via a settlement no
    // facilitator triggered.
    const game = battling();
    // A third defender, left without a clash of their own by the pairing, is
    // the only kind of role allowed to reinforce one.
    game.state.seats.s3 = {
      id: 's3', token: 's3', name: 's3', roleId: 'ubba_ragnarsson',
      kind: 'player', connected: true, lastSeen: 0,
    };
    const UBBA = { seatId: 's3', kind: 'player', roleId: 'ubba_ragnarsson' };
    const clashId = Object.keys(game.state.battle.clashes)[0];
    game.state.battle.spare = { lindsey: ['ubba_ragnarsson'] };
    const before = game.state.roles.ubba_ragnarsson.soldiers;

    game.step('reinforce_clash', { clashId, soldiers: 1 }, UBBA);
    game.step('submit-tactic', { clashId, card: '5' }, HALFDAN);
    game.step('submit-tactic', { clashId, card: '2' }, GAINBEALD);
    game.step('declare-lead', { clashId, lead: false }, HALFDAN);
    game.step('declare-lead', { clashId, lead: false }, GAINBEALD);
    game.step('confirm-lead', { clashId }, HALFDAN);
    game.step('confirm-lead', { clashId }, GAINBEALD);
    game.step('submit-roll', { clashId }, HALFDAN);
    game.step('submit-roll', { clashId }, GAINBEALD);

    expect(game.state.battle.clashes[clashId].stage).toBe('resolved');
    expect(game.state.roles.ubba_ragnarsson.soldiers).toBe(before - 1);
  });

  it('takes one die per fighter and no more', () => {
    const { game, clashId } = upToTheDice();
    game.step('submit-roll', { clashId }, HALFDAN);
    expect(admit(game.state, data, { verb: 'submit-roll', payload: { clashId } }, HALFDAN).reason)
      .toContain('already rolled');
  });

  it('will not take a die before there is anything to throw it at', () => {
    const game = battling();
    const clashId = Object.keys(game.state.battle.clashes)[0];
    expect(admit(game.state, data, { verb: 'submit-roll', payload: { clashId } }, HALFDAN).reason)
      .toContain('still something to decide');
  });

  it('refuses a die from someone not in the clash', () => {
    const { game, clashId } = upToTheDice();
    expect(admit(game.state, data, { verb: 'submit-roll', payload: { clashId } },
      { seatId: 's3', kind: 'player', roleId: 'king_alfred' }).reason)
      .toContain('not fighting in that clash');
  });

  it('keeps the first die from the other fighter until both are down', () => {
    const { game, clashId } = upToTheDice();
    game.step('submit-roll', { clashId }, HALFDAN);
    const seen = projectView(game.state, data, {
      kind: 'player', seatId: 's2', roleId: 'gainbeald',
      teamId: game.state.roles.gainbeald.teamId,
    });
    expect(seen.battle.clashes[clashId].rolls.halfdan_ragnarsson).toBeUndefined();
    // But you can see you are the one being waited on.
    expect(seen.clashProgress[clashId].rollSubmitted.halfdan_ragnarsson).toBe(true);
    expect(seen.clashProgress[clashId].rollsRevealed).toBe(false);

    game.step('submit-roll', { clashId }, GAINBEALD);
    const after = projectView(game.state, data, {
      kind: 'player', seatId: 's2', roleId: 'gainbeald',
      teamId: game.state.roles.gainbeald.teamId,
    });
    expect(after.battle.clashes[clashId].rolls.halfdan_ragnarsson)
      .toBe(game.state.battle.clashes[clashId].rolls.halfdan_ragnarsson);
    expect(after.clashProgress[clashId].rollsRevealed).toBe(true);
  });

  it('refuses a card committing more soldiers than you have', () => {
    const game = battling();
    const clashId = Object.keys(game.state.battle.clashes)[0];
    // Gainbeald has three soldiers; Charge commits five.
    expect(admit(game.state, data, { verb: 'submit-tactic', payload: { clashId, card: '5' } },
      GAINBEALD).reason).toContain('only 3 soldiers');
  });

  it('refuses a card from someone not in the clash', () => {
    const game = battling();
    const clashId = Object.keys(game.state.battle.clashes)[0];
    expect(admit(game.state, data, { verb: 'submit-tactic', payload: { clashId, card: '2' } },
      { seatId: 's3', kind: 'player', roleId: 'king_alfred' }).reason)
      .toContain('not fighting in that clash');
  });

  it('finishes a clash whose fighter has walked away', () => {
    // A facilitator can always force it through, taking the least the absent
    // player could have committed rather than stalling the whole phase.
    const game = battling();
    const clashId = Object.keys(game.state.battle.clashes)[0];
    game.step('submit-tactic', { clashId, card: '3' }, HALFDAN);
    game.step('facilitator:resolve-clash', { clashId });
    const clash = game.state.battle.clashes[clashId];
    expect(clash.tactic.gainbeald).toBe('A');       // Withdraw
    expect(clash.stage).toBe('resolved');
    expect(clash.result.winner).toBeTruthy();
    // Both dice were thrown for them, and the log says who did it.
    expect(clash.rolls.halfdan_ragnarsson).toBeGreaterThanOrEqual(1);
    expect(clash.rolls.gainbeald).toBeGreaterThanOrEqual(1);
    expect(overrides(game.state.log).map((e) => e.verb))
      .toContain('facilitator:resolve-clash');
    expect(game.state.log.at(-1)).toMatchObject({
      verb: 'facilitator:resolve-clash', override: true,
    });
  });

  it('keeps a die a fighter has already thrown when it forces the rest', () => {
    // The override exists to unstick a clash, not to re-throw somebody's five
    // into a two. Whatever a player committed stands.
    const { game, clashId } = upToTheDice();
    game.step('submit-roll', { clashId }, HALFDAN);
    const thrown = game.state.battle.clashes[clashId].rolls.halfdan_ragnarsson;

    game.step('facilitator:resolve-clash', { clashId });
    const clash = game.state.battle.clashes[clashId];
    expect(clash.rolls.halfdan_ragnarsson).toBe(thrown);
    expect(clash.rolls.gainbeald).toBeGreaterThanOrEqual(1);
    expect(clash.stage).toBe('resolved');
    // One player's die and one the umpire drew: two turns of the cursor, not
    // three, because the first was not thrown twice.
    expect(game.state.rngCursor).toBe(2);
  });

  it('refuses to force a clash that is already settled', () => {
    const { game, clashId } = upToTheDice();
    game.step('submit-roll', { clashId }, HALFDAN);
    game.step('submit-roll', { clashId }, GAINBEALD);
    expect(admit(game.state, data, { verb: 'facilitator:resolve-clash', payload: { clashId } },
      game.facilitator).reason).toContain('already settled');
  });

  it('lets nothing change hands while blades are out', () => {
    const game = battling();
    expect(admit(game.state, data,
      { verb: 'give', payload: { toRoleId: 'gainbeald', what: 'silver', amount: 1 } }, HALFDAN)
      .reason).toContain('phase');
  });
});

describe('a battle nobody has to settle by hand', () => {
  const HALFDAN = { seatId: 's1', kind: 'player', roleId: 'halfdan_ragnarsson' };
  const GAINBEALD = { seatId: 's2', kind: 'player', roleId: 'gainbeald' };
  const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };

  function run(state, actor, verb, payload = {}) {
    const result = apply(state, data, { verb, payload }, actor, { ts: 0 });
    if (!result.ok) throw new Error(`${verb} refused: ${result.reason}`);
    return result.state;
  }

  const refusal = (state, actor, verb, payload = {}) =>
    admit(state, data, { verb, payload }, actor).reason;

  /** A one-clash battle over Lindsey, both sides paired and ready to throw. */
  function readyToRoll({ castles = 1 } = {}) {
    const state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
    state.phase.name = 'battle';
    state.shires.lindsey.castles = castles;
    state.battle.targets = ['lindsey'];
    state.battle.sides = {
      lindsey: { attackers: ['halfdan_ragnarsson'], defenders: ['gainbeald'] },
    };
    state.battle.pairingComplete = true;
    state.initiative.declared = {
      white: { roleId: 'halfdan_ragnarsson', shireId: 'lindsey', revealed: true },
    };
    const clash = createClash({
      id: 'lindsey:1', shireId: 'lindsey', attacker: 'halfdan_ragnarsson', defender: 'gainbeald',
    });
    clash.stage = 'rolling';
    state.battle.clashes[clash.id] = clash;
    return state;
  }

  it('holds at the last die while the conqueror has not named anyone', () => {
    // Both dice in, the shire falls, and nothing settles — because handing it
    // to whichever attacker was paired first is a default nobody chose, on the
    // one decision the whole battle was fought over.
    let state = readyToRoll();
    state = run(state, HALFDAN, 'submit-roll', { clashId: 'lindsey:1' });
    state = run(state, GAINBEALD, 'submit-roll', { clashId: 'lindsey:1' });

    expect(state.battle.clashes['lindsey:1'].stage).toBe('resolved');
    expect(tally(state, 'lindsey').shireFalls).toBe(true);
    expect(settlementHold(state, 'lindsey')).toBe('awaiting-steward-pick');
    expect(state.battle.settled.lindsey).toBeUndefined();
    expect(state.shires.lindsey.stewardRoleId).not.toBe('halfdan_ragnarsson');
  });

  it('settles itself the moment the pick arrives, with nobody pressing anything', () => {
    let state = readyToRoll();
    state = run(state, HALFDAN, 'submit-roll', { clashId: 'lindsey:1' });
    state = run(state, GAINBEALD, 'submit-roll', { clashId: 'lindsey:1' });
    state = run(state, HALFDAN, 'name-new-steward',
      { shireId: 'lindsey', stewardRoleId: 'halfdan_ragnarsson' });

    expect(state.battle.settled.lindsey).toBe(true);
    expect(state.shires.lindsey.stewardRoleId).toBe('halfdan_ragnarsson');
  });

  it('settles on the last die when the shire holds, because nothing is owed', () => {
    // No pick is possible for a shire that did not fall, so there is nothing
    // to wait for and the battle finishes on its own.
    let state = readyToRoll({ castles: 9 });
    state = run(state, HALFDAN, 'submit-roll', { clashId: 'lindsey:1' });
    state = run(state, GAINBEALD, 'submit-roll', { clashId: 'lindsey:1' });

    expect(tally(state, 'lindsey').shireFalls).toBe(false);
    expect(settlementHold(state, 'lindsey')).toBeNull();
    expect(state.battle.settled.lindsey).toBe(true);
  });

  it('settles on the last die when the pick was made first', () => {
    // The other order. Either arrival can be the last thing owed, so neither
    // assumes it was.
    let state = readyToRoll();
    state = run(state, HALFDAN, 'submit-roll', { clashId: 'lindsey:1' });
    state.battle.stewardPicks = { lindsey: 'halfdan_ragnarsson' };
    state = run(state, GAINBEALD, 'submit-roll', { clashId: 'lindsey:1' });

    expect(state.battle.settled.lindsey).toBe(true);
    expect(state.shires.lindsey.stewardRoleId).toBe('halfdan_ragnarsson');
  });

  it('says it is still unfought before the dice are in', () => {
    expect(settlementHold(readyToRoll(), 'lindsey')).toBe('unfought');
  });

  it('lets the facilitator force a stalled table past the hold', () => {
    let state = readyToRoll();
    state = run(state, HALFDAN, 'submit-roll', { clashId: 'lindsey:1' });
    state = run(state, GAINBEALD, 'submit-roll', { clashId: 'lindsey:1' });
    expect(settlementHold(state, 'lindsey')).toBe('awaiting-steward-pick');

    state = run(state, FACILITATOR, 'facilitator:settle-battle', { shireId: 'lindsey' });
    expect(state.battle.settled.lindsey).toBe(true);
    // Fell back to the only attacker, which is what a default is for.
    expect(state.shires.lindsey.stewardRoleId).toBe('halfdan_ragnarsson');
  });

  it('settles a two-clash battle exactly once, on the very last die', () => {
    // The guard's real job. `submit-roll` asks `settleIfReady` after EVERY
    // clash it resolves, so a battle of two clashes asks twice — and a castle
    // coming down twice for one battle would be a silent, permanent error on
    // the board.
    const state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
    state.phase.name = 'battle';
    state.shires.lindsey.castles = 2;
    state.battle.targets = ['lindsey'];
    state.battle.pairingComplete = true;
    state.battle.sides = {
      lindsey: {
        attackers: ['halfdan_ragnarsson', 'ubba_ragnarsson'],
        defenders: ['gainbeald', 'ceowulf'],
      },
    };
    state.initiative.declared = {
      white: { roleId: 'halfdan_ragnarsson', shireId: 'lindsey', revealed: true },
    };
    for (const [i, [attacker, defender]] of [
      ['halfdan_ragnarsson', 'gainbeald'], ['ubba_ragnarsson', 'ceowulf'],
    ].entries()) {
      const clash = createClash({
        id: `lindsey:${i + 1}`, shireId: 'lindsey', attacker, defender,
      });
      clash.stage = 'rolling';
      state.battle.clashes[clash.id] = clash;
    }
    state.battle.stewardPicks = { lindsey: 'ubba_ragnarsson' };
    const castlesBefore = state.shires.lindsey.castles;

    let at = state;
    const throwFor = (roleId, clashId) =>
      apply(at, data, { verb: 'submit-roll', payload: { clashId } },
        { seatId: `s-${roleId}`, kind: 'player', roleId }, { ts: 0 });

    at = throwFor('halfdan_ragnarsson', 'lindsey:1').state;
    at = throwFor('gainbeald', 'lindsey:1').state;
    // One clash down, one still rolling: nothing may have settled yet.
    expect(at.battle.settled.lindsey).toBeUndefined();
    expect(at.shires.lindsey.castles).toBe(castlesBefore);

    at = throwFor('ubba_ragnarsson', 'lindsey:2').state;
    at = throwFor('ceowulf', 'lindsey:2').state;

    expect(at.battle.settled.lindsey).toBe(true);
    if (tally(at, 'lindsey').shireFalls) {
      expect(at.shires.lindsey.castles).toBe(castlesBefore - 1);
      expect(at.shires.lindsey.stewardRoleId).toBe('ubba_ragnarsson');
    } else {
      expect(at.shires.lindsey.castles).toBe(castlesBefore);
    }
  });

  it('never settles the same battle twice, however it got there', () => {
    // Settling moves a steward and takes a castle down, so twice is not the
    // same as once.
    let state = readyToRoll({ castles: 3 });
    state = run(state, HALFDAN, 'submit-roll', { clashId: 'lindsey:1' });
    state = run(state, GAINBEALD, 'submit-roll', { clashId: 'lindsey:1' });
    const castlesAfter = state.shires.lindsey.castles;
    expect(state.battle.settled.lindsey).toBe(true);

    expect(refusal(state, FACILITATOR, 'facilitator:settle-battle', { shireId: 'lindsey' }))
      .toBe('that battle is already settled');
    expect(state.shires.lindsey.castles).toBe(castlesAfter);
  });

  it('clears the settled marks with the rest of the board', () => {
    let state = readyToRoll({ castles: 9 });
    state = run(state, HALFDAN, 'submit-roll', { clashId: 'lindsey:1' });
    state = run(state, GAINBEALD, 'submit-roll', { clashId: 'lindsey:1' });
    expect(state.battle.settled.lindsey).toBe(true);

    state = run(state, FACILITATOR, 'facilitator:end-battles', {});
    expect(state.battle.settled).toEqual({});
  });
});
