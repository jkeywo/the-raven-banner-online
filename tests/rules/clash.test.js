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
import { tally, settleBattle, pairSides } from '../../gui/rules/battle.js';

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
    step('declare-initiative-target', { shireId: 'lindsey' },
      { seatId: 's1', kind: 'player', roleId: 'halfdan_ragnarsson' });
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

  it('runs a clash from cards to a settled shire', () => {
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

    game.step('facilitator:resolve-clash', { clashId });
    const clash = game.state.battle.clashes[clashId];
    expect(clash.stage).toBe('resolved');
    expect(clash.result.winner).toBeTruthy();
    expect(clash.rolls.halfdan_ragnarsson).toBeGreaterThanOrEqual(1);
    expect(clash.rolls.halfdan_ragnarsson).toBeLessThanOrEqual(6);
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
  });

  it('lets nothing change hands while blades are out', () => {
    const game = battling();
    expect(admit(game.state, data,
      { verb: 'give', payload: { toRoleId: 'gainbeald', what: 'silver', amount: 1 } }, HALFDAN)
      .reason).toContain('phase');
  });
});
