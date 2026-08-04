import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState, rosterFor } from '../../gui/rules/state.js';
import { apply, replay } from '../../gui/rules/reducer.js';
import { admit } from '../../gui/rules/admission.js';
import { toSave } from '../../gui/rules/command-log.js';
import {
  crownsOf, electorate, hasSupport, aftermath, churchesHeld, incomeFor,
} from '../../gui/rules/derive.js';

const data = await loadData();
const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };
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

const shiresOf = (state, roleId) =>
  Object.keys(state.shires).filter((id) => state.shires[id].stewardRoleId === roleId);

describe('a crown nobody wears', () => {
  it('is spoken for by everyone who claims it', () => {
    // Which is the whole of turn zero: Mercia has no king, and Ceowulf and
    // Gainbeald both act as though it were theirs.
    const state = playing();
    expect(crownsOf(state, 'ceowulf')).toEqual(['mercia']);
    expect(crownsOf(state, 'gainbeald')).toEqual(['mercia', 'lindsey']);
  });

  it('answers only to its holder once there is one', () => {
    const state = playing();
    state.crownHolders.mercia = 'ceowulf';
    expect(crownsOf(state, 'ceowulf')).toEqual(['mercia']);
    // Gainbeald keeps Lindsey, which nobody has been crowned for.
    expect(crownsOf(state, 'gainbeald')).toEqual(['lindsey']);
  });

  it('leaves the turn-zero board exactly as printed', () => {
    // The only external evidence the support rule is right. If this moves,
    // the rewrite is wrong however good the reasoning sounded.
    const state = playing();
    const counters = aftermath(state, data);
    expect(counters.paganism.value).toBe(3);
    expect(counters.danelaw.value).toBe(3);
    expect(counters.disorder.value).toBe(3);
  });
});

describe('two crowns are already worn', () => {
  it('seeds Wessex to Alfred and Northumbria to Ecgberht, and nobody else', () => {
    // Unlike Mercia's minor claims, these are not up for grabs at turn zero —
    // Alfred inherited Wessex from his brother, and Ecgberht already answers
    // for Northumbria, whatever he owes Halfdan for it.
    const state = playing();
    expect(state.crownHolders).toMatchObject({
      wessex: 'king_alfred', northumbria: 'king_ecgberht',
    });
    expect(state.crownHolders.mercia).toBeUndefined();
  });

  it('refuses to reopen either as an election', () => {
    const state = playing();
    expect(refusal(state, as('king_alfred'), 'claim-crown', { crown: 'wessex' }))
      .toContain('already has a king');
    expect(refusal(state, as('king_ecgberht'), 'claim-crown', { crown: 'northumbria' }))
      .toContain('already has a king');
  });

  it('is not seeded for a role who was dropped from a short-handed game', () => {
    // Ecgberht is droppable at thirteen players; a crown nobody in the game
    // holds should not survive the roster that removed him.
    const state = createInitialState({
      joinCode: 'RAVEN7Z', seed: 1, data,
      roleIds: rosterFor(data, 13),
    });
    expect(state.crownHolders.northumbria).toBeUndefined();
    expect(state.crownHolders.wessex).toBe('king_alfred');
  });

  it('is lost by the heir, exactly like a won election', () => {
    let state = playing();
    state.roles.king_alfred.wounds = 3;
    state.roles.king_alfred.dead = true;
    state = run(state, FACILITATOR, 'facilitator:heir-arrives', { roleId: 'king_alfred' });
    expect(state.crownHolders.wessex).toBeUndefined();
    // And the throne is open again, to be contested like any other.
    expect(admit(state, data, { verb: 'claim-crown', payload: { crown: 'wessex' } },
      as('king_alfred')).ok).toBe(true);
  });
});

describe('a coronation bites', () => {
  it('takes the losing claimant’s support away with it', () => {
    // Ceowulf and Gainbeald are on the same team and briefed to want the same
    // crown. This is what that is for.
    const state = playing();
    const mercian = shiresOf(state, 'gainbeald');
    for (const id of mercian) expect(hasSupport(state, data, id)).toBe(true);

    state.crownHolders.mercia = 'ceowulf';
    expect(hasSupport(state, data, 'north_mercia')).toBe(false);
    // Lindsey is his own crown, and Lindsey's support box says so.
    expect(hasSupport(state, data, 'lindsey')).toBe(true);
  });

  it('costs him the income from his defended settlements', () => {
    const state = playing();
    const before = incomeFor(state, data, 'gainbeald');
    state.crownHolders.mercia = 'ceowulf';
    const after = incomeFor(state, data, 'gainbeald');
    expect(after.silver + after.food).toBeLessThan(before.silver + before.food);
  });

  it('adds his shires to the Disorder count', () => {
    const state = playing();
    state.crownHolders.mercia = 'ceowulf';
    expect(aftermath(state, data).disorder.value).toBeGreaterThan(3);
  });

  it('gives a vassal their liege’s crown to stand on', () => {
    // Wenyld has no claim of her own. While Mercia has no king she stands on
    // the kingdom itself; once it has one she must swear to him or lose it —
    // "Should a Mercian king be crowned and she swears fealty to them then she
    // can inherit his claim and gain support."
    const state = playing();
    expect(hasSupport(state, data, 'south_mercia')).toBe(true);

    state.crownHolders.mercia = 'ceowulf';
    expect(hasSupport(state, data, 'south_mercia')).toBe(false);

    state.roles.abbess_wenyld.liegeId = 'ceowulf';
    expect(hasSupport(state, data, 'south_mercia')).toBe(true);
  });

  it('leaves the new king standing on his own kingdom', () => {
    const state = playing();
    state.crownHolders.mercia = 'ceowulf';
    for (const id of shiresOf(state, 'ceowulf')) {
      expect(hasSupport(state, data, id), id).toBe(true);
    }
  });
});

describe('the electorate', () => {
  it('is one vote per supporting shire, plus one per two churches', () => {
    const state = playing();
    const roll = electorate(state, data, 'mercia');
    for (const [roleId, weight] of Object.entries(roll)) {
      const supporting = shiresOf(state, roleId)
        .filter((id) => data.shires.shires[id].support.includes('M')).length;
      expect(weight, roleId).toBe(supporting + Math.floor(churchesHeld(state, roleId) / 2));
    }
  });

  it('counts Saxon stewards only, whoever their liege is', () => {
    const state = playing();
    const roll = electorate(state, data, 'mercia');
    // Cenred follows Alfred and still votes on Mercia, because his shire does.
    expect(state.roles.cenred.liegeId).toBe('king_alfred');
    expect(roll.cenred).toBeGreaterThan(0);
    // Halfdan holds Mercian ground in nobody's eyes: a Dane has no voice here.
    state.shires.north_mercia.stewardRoleId = 'halfdan_ragnarsson';
    expect(electorate(state, data, 'mercia').halfdan_ragnarsson).toBeUndefined();
  });

  it('is empty for a crown no Saxon holds ground for', () => {
    const state = playing();
    for (const shire of Object.values(state.shires)) shire.stewardRoleId = 'halfdan_ragnarsson';
    expect(electorate(state, data, 'mercia')).toEqual({});
  });
});

describe('calling an election', () => {
  it('needs a claim of your own', () => {
    const state = playing();
    expect(refusal(state, as('abbess_wenyld'), 'claim-crown', { crown: 'mercia' }))
      .toBe('you have no claim on that crown');
  });

  it('is barred to a vassal whose liege wants the same crown', () => {
    const state = playing();
    state.roles.gainbeald.liegeId = 'ceowulf';
    expect(refusal(state, as('gainbeald'), 'claim-crown', { crown: 'mercia' }))
      .toBe('you cannot claim a crown your liege claims');
  });

  it('will not reopen a crown that has a king', () => {
    const state = playing();
    state.crownHolders.mercia = 'gainbeald';
    expect(refusal(state, as('ceowulf'), 'claim-crown', { crown: 'mercia' }))
      .toContain('already has a king');
  });

  it('runs one election at a time', () => {
    const state = run(playing(), as('ceowulf'), 'claim-crown', { crown: 'mercia' });
    expect(refusal(state, as('gainbeald'), 'claim-crown', { crown: 'mercia' }))
      .toContain('already being held');
  });

  it('puts every unbarred claimant on the ballot, not just the caller', () => {
    const state = run(playing(), as('ceowulf'), 'claim-crown', { crown: 'mercia' });
    const vote = Object.values(state.votes)[0];
    expect(vote.candidates).toEqual(['ceowulf', 'gainbeald']);
    expect(vote.electorate).toEqual(electorate(state, data, 'mercia'));
  });
});

describe('voting', () => {
  /** Ceowulf calls the Mercian election. */
  function election(state = playing()) {
    const after = run(state, as('ceowulf'), 'claim-crown', { crown: 'mercia' });
    return { state: after, id: Object.keys(after.votes)[0] };
  }

  it('is for electors only, and only once', () => {
    let { state, id } = election();
    expect(refusal(state, as('king_alfred'), 'cast-vote', { voteId: id, forRoleId: 'ceowulf' }))
      .toBe('you have no vote in this');
    state = run(state, as('cenred'), 'cast-vote', { voteId: id, forRoleId: 'ceowulf' });
    expect(refusal(state, as('cenred'), 'cast-vote', { voteId: id, forRoleId: 'gainbeald' }))
      .toBe('you have voted');
  });

  it('is only for somebody standing', () => {
    const { state, id } = election();
    expect(refusal(state, as('cenred'), 'cast-vote', { voteId: id, forRoleId: 'abbess_wenyld' }))
      .toBe('they are not standing');
  });

  it('compels a vassal whose liege is standing', () => {
    const { state, id } = election();
    state.roles.abbess_wenyld.liegeId = 'gainbeald';
    expect(refusal(state, as('abbess_wenyld'), 'cast-vote', { voteId: id, forRoleId: 'ceowulf' }))
      .toContain('sworn to vote for them');
    expect(admit(state, data, { verb: 'cast-vote', payload: { voteId: id, forRoleId: 'gainbeald' } },
      as('abbess_wenyld')).ok).toBe(true);
  });

  it('crowns whoever the ground votes for', () => {
    let { state, id } = election();
    for (const who of Object.keys(state.votes[id].electorate)) {
      state = run(state, as(who), 'cast-vote', { voteId: id, forRoleId: 'ceowulf' });
    }
    expect(state.votes[id]).toMatchObject({ resolved: true, outcome: 'crowned', winner: 'ceowulf' });
    expect(state.crownHolders.mercia).toBe('ceowulf');
    // And the loser's ground stops answering to him the moment it is counted.
    expect(hasSupport(state, data, 'north_mercia')).toBe(false);
  });

  it('waits until every elector has spoken', () => {
    let { state, id } = election();
    const [first] = Object.keys(state.votes[id].electorate);
    state = run(state, as(first), 'cast-vote', { voteId: id, forRoleId: 'ceowulf' });
    expect(state.votes[id].resolved).toBe(false);
    expect(state.crownHolders.mercia).toBeUndefined();
  });

  it('leaves the crown unworn on a tie', () => {
    // The app does not break it. A tie fails and the crown is contested again,
    // which is a decision the room can live with.
    let { state, id } = election();
    state.votes[id].electorate = { cenred: 2, uchtred: 2 };
    state = run(state, as('cenred'), 'cast-vote', { voteId: id, forRoleId: 'ceowulf' });
    state = run(state, as('uchtred'), 'cast-vote', { voteId: id, forRoleId: 'gainbeald' });
    expect(state.votes[id]).toMatchObject({ resolved: true, outcome: 'failed', winner: null });
    expect(state.crownHolders.mercia).toBeUndefined();
    // And it can be put again.
    expect(admit(state, data, { verb: 'claim-crown', payload: { crown: 'mercia' } },
      as('ceowulf')).ok).toBe(true);
  });

  it('weighs a vote by the ground behind it', () => {
    let { state, id } = election();
    state.votes[id].electorate = { cenred: 5, uchtred: 1, abbess_wenyld: 1 };
    state = run(state, as('uchtred'), 'cast-vote', { voteId: id, forRoleId: 'gainbeald' });
    state = run(state, as('abbess_wenyld'), 'cast-vote', { voteId: id, forRoleId: 'gainbeald' });
    state = run(state, as('cenred'), 'cast-vote', { voteId: id, forRoleId: 'ceowulf' });
    expect(state.votes[id].tally).toEqual({ ceowulf: 5, gainbeald: 2 });
    expect(state.crownHolders.mercia).toBe('ceowulf');
  });

  it('can be counted early by the facilitator', () => {
    // An election waiting on somebody who has gone home never ends.
    let { state, id } = election();
    state = run(state, as('cenred'), 'cast-vote', { voteId: id, forRoleId: 'ceowulf' });
    state = run(state, FACILITATOR, 'facilitator:close-vote', { voteId: id });
    expect(state.crownHolders.mercia).toBe('ceowulf');
  });

  it('fails a count with nothing in the box', () => {
    const { state, id } = election();
    const after = run(state, FACILITATOR, 'facilitator:close-vote', { voteId: id });
    expect(after.votes[id].outcome).toBe('failed');
    expect(after.crownHolders.mercia).toBeUndefined();
  });
});

describe('asking to rebel', () => {
  /** Cenred asks, naming the first shire he holds. */
  function asked(state = playing()) {
    const shireId = shiresOf(state, 'cenred')[0];
    const after = run(state, as('cenred'), 'request-rebel', { shireId });
    return { state: after, id: Object.keys(after.rebellions)[0], shireId };
  }

  it('opens a petition rather than doing anything, until it is priced', () => {
    const before = playing();
    const { state } = asked(before);
    expect(state.roles.cenred).toMatchObject({
      liegeId: 'king_alfred',
      soldiers: before.roles.cenred.soldiers,
    });
    expect(Object.values(state.rebellions)).toHaveLength(1);
    expect(Object.values(state.rebellions)[0]).toMatchObject({
      roleId: 'cenred', liegeId: 'king_alfred', status: 'pending', cost: null,
    });
  });

  it('is a Saxon\'s to ask — a Dane already changes liege for free', () => {
    const state = playing();
    expect(refusal(state, as('ubba_ragnarsson'), 'request-rebel', {}))
      .toBe('a Dane simply changes liege — no rebellion needed');
  });

  it('is nothing to a man who answers to nobody', () => {
    const state = playing();
    expect(refusal(state, as('king_alfred'), 'request-rebel', {}))
      .toBe('you answer to nobody already');
  });

  it('names which shire he would offer, if he holds any', () => {
    const state = playing();
    expect(refusal(state, as('cenred'), 'request-rebel', {}))
      .toBe('name the shire you would hand over');
    expect(refusal(state, as('cenred'), 'request-rebel', { shireId: 'wiltshire' }))
      .toBe('that is not yours to offer');
  });

  it('asks nothing of a landless vassal', () => {
    const state = playing();
    for (const id of shiresOf(state, 'cenred')) state.shires[id].stewardRoleId = 'king_alfred';
    expect(admit(state, data, { verb: 'request-rebel', payload: {} }, as('cenred')).ok).toBe(true);
  });

  it('will not run two petitions from the same vassal at once', () => {
    const { state, shireId } = asked();
    expect(refusal(state, as('cenred'), 'request-rebel', { shireId }))
      .toBe('you have already asked to rebel');
  });
});

describe('the umpire prices it', () => {
  function asked(state = playing()) {
    const shireId = shiresOf(state, 'cenred')[0];
    const after = run(state, as('cenred'), 'request-rebel', { shireId });
    return { state: after, shireId };
  }

  it('names the full printed price, or anything less down to nothing', () => {
    const { state } = asked();
    const priced = run(state, FACILITATOR, 'facilitator:price-rebellion',
      { roleId: 'cenred', shires: 1, soldiers: 2 });
    expect(Object.values(priced.rebellions)[0])
      .toMatchObject({ status: 'priced', cost: { shires: 1, soldiers: 2 } });
  });

  it('is refused a price that is not a rebellion\'s to charge', () => {
    const { state } = asked();
    expect(refusal(state, FACILITATOR, 'facilitator:price-rebellion',
      { roleId: 'cenred', shires: 3, soldiers: 0 })).toContain('one shire or none');
    expect(refusal(state, FACILITATOR, 'facilitator:price-rebellion',
      { roleId: 'cenred', shires: 1, soldiers: 5 })).toContain('two soldiers');
  });

  it('has nobody to price when nobody has asked', () => {
    const state = playing();
    expect(refusal(state, FACILITATOR, 'facilitator:price-rebellion',
      { roleId: 'cenred', shires: 1, soldiers: 2 })).toContain('nobody is waiting');
  });

  it('records why, for the debrief', () => {
    const { state } = asked();
    const priced = run(state, FACILITATOR, 'facilitator:price-rebellion',
      { roleId: 'cenred', shires: 0, soldiers: 0, note: 'Alfred let the Danes into Wessex' });
    expect(Object.values(priced.rebellions)[0].note).toBe('Alfred let the Danes into Wessex');
  });
});

describe('the rebel\'s final say', () => {
  /** Cenred's petition, priced at the full rate. */
  function priced(cost = { shires: 1, soldiers: 2 }) {
    let state = playing();
    const shireId = shiresOf(state, 'cenred')[0];
    state = run(state, as('cenred'), 'request-rebel', { shireId });
    state = run(state, FACILITATOR, 'facilitator:price-rebellion', { roleId: 'cenred', ...cost });
    return { state, shireId };
  }

  it('cannot be confirmed before it is priced', () => {
    let state = playing();
    state = run(state, as('cenred'), 'request-rebel', { shireId: shiresOf(state, 'cenred')[0] });
    expect(refusal(state, as('cenred'), 'confirm-rebel', {})).toContain('nothing priced yet');
  });

  it('costs a shire and two soldiers, both to the liege, once confirmed', () => {
    const { state, shireId } = priced();
    const before = {
      cenred: state.roles.cenred.soldiers,
      alfred: state.roles.king_alfred.soldiers,
    };
    const after = run(state, as('cenred'), 'confirm-rebel', {});

    expect(after.roles.cenred.soldiers).toBe(before.cenred - 2);
    expect(after.roles.king_alfred.soldiers).toBe(before.alfred + 2);
    expect(after.shires[shireId].stewardRoleId).toBe('king_alfred');
    expect(Object.values(after.rebellions)[0].status).toBe('done');
  });

  it('leaves the faction, and takes his remaining lands with him', () => {
    let state = playing();
    state.shires.redding.stewardRoleId = 'cenred';
    state.shires.sussex.stewardRoleId = 'cenred';
    state = run(state, as('cenred'), 'request-rebel', { shireId: 'redding' });
    state = run(state, FACILITATOR, 'facilitator:price-rebellion',
      { roleId: 'cenred', shires: 1, soldiers: 2 });
    const after = run(state, as('cenred'), 'confirm-rebel', {});

    expect(after.roles.cenred).toMatchObject({ liegeId: null, factionId: 'cenred' });
    expect(after.shires.sussex.factionId).toBe('cenred');
    // And the shire he handed over is his liege's, faction and all.
    expect(after.shires.redding.factionId).toBe(after.roles.king_alfred.factionId);
  });

  it('frees him to claim a crown of his own', () => {
    // Kent, not Wessex: Wessex is Alfred's outright from the start, and
    // rebelling against a king does not dethrone him. An unheld claim they
    // share is what the liege-block actually gates.
    let state = playing();
    state.roles.cenred.claims = ['kent'];
    expect(refusal(state, as('cenred'), 'claim-crown', { crown: 'kent' }))
      .toBe('you cannot claim a crown your liege claims');
    state = run(state, as('cenred'), 'request-rebel', { shireId: shiresOf(state, 'cenred')[0] });
    state = run(state, FACILITATOR, 'facilitator:price-rebellion',
      { roleId: 'cenred', shires: 1, soldiers: 2 });
    const after = run(state, as('cenred'), 'confirm-rebel', {});
    expect(admit(after, data, { verb: 'claim-crown', payload: { crown: 'kent' } },
      as('cenred')).ok).toBe(true);
  });

  it('costs nothing when the umpire has heard enough', () => {
    // "This cost will be reduced (potentially down to zero) by the organisers
    // if the liege has lost the favour of God."
    const { state } = priced({ shires: 0, soldiers: 0 });
    const held = shiresOf(state, 'cenred');
    const before = state.roles.cenred.soldiers;
    const after = run(state, as('cenred'), 'confirm-rebel', {});
    expect(after.roles.cenred.soldiers).toBe(before);
    expect(shiresOf(after, 'cenred')).toEqual(held);
    expect(after.roles.cenred.liegeId).toBe(null);
  });

  it('takes only the soldiers from a landless vassal', () => {
    let state = playing();
    for (const id of shiresOf(state, 'cenred')) state.shires[id].stewardRoleId = 'king_alfred';
    state = run(state, as('cenred'), 'request-rebel', {});
    state = run(state, FACILITATOR, 'facilitator:price-rebellion',
      { roleId: 'cenred', shires: 1, soldiers: 2 });
    const before = state.roles.king_alfred.soldiers;
    const after = run(state, as('cenred'), 'confirm-rebel', {});
    expect(after.roles.cenred.liegeId).toBe(null);
    expect(after.roles.king_alfred.soldiers).toBe(before + 2);
  });

  it('is refused when the price can no longer be paid', () => {
    const { state } = priced();
    state.roles.cenred.soldiers = 1;
    expect(refusal(state, as('cenred'), 'confirm-rebel', {})).toContain('not enough soldiers');
  });

  it('can be called off instead, at any stage, for nothing', () => {
    let state = playing();
    state = run(state, as('cenred'), 'request-rebel', { shireId: shiresOf(state, 'cenred')[0] });
    const beforePrice = run(state, as('cenred'), 'cancel-rebel', {});
    expect(Object.values(beforePrice.rebellions)[0].status).toBe('cancelled');
    expect(beforePrice.roles.cenred.liegeId).toBe('king_alfred');

    // And once cancelled, he is free to ask again.
    expect(admit(beforePrice, data,
      { verb: 'request-rebel', payload: { shireId: shiresOf(beforePrice, 'cenred')[0] } },
      as('cenred')).ok).toBe(true);
  });

  it('has nothing to call off once it is already settled', () => {
    const state = playing();
    expect(refusal(state, as('cenred'), 'cancel-rebel', {})).toBe('nothing to call off');
  });
});

describe('swearing homage', () => {
  it('is a Dane’s to do freely, and a Saxon’s to ask for', () => {
    const state = playing();
    expect(admit(state, data, { verb: 'swear-allegiance', payload: { liegeId: 'guthrum_the_old' } },
      as('ubba_ragnarsson')).ok).toBe(true);
    expect(refusal(state, as('abbess_wenyld'), 'swear-allegiance', { liegeId: 'ceowulf' }))
      .toContain('in front of a facilitator');
    expect(refusal(state, as('ubba_ragnarsson'), 'request-allegiance', { liegeId: 'guthrum_the_old' }))
      .toContain('needs nobody');
  });

  it('cannot be offered to a Saxon who wears no crown', () => {
    // "Target: The holder of a Saxon crown, or a Dane." Which at turn zero
    // means the Danes, and nobody else — there are no kings yet.
    const state = playing();
    expect(refusal(state, as('abbess_wenyld'), 'request-allegiance', { liegeId: 'ceowulf' }))
      .toContain('wear no crown');
    expect(admit(state, data,
      { verb: 'request-allegiance', payload: { liegeId: 'halfdan_ragnarsson' } },
      as('abbess_wenyld')).ok).toBe(true);
  });

  it('opens once a king is crowned', () => {
    const state = playing();
    state.crownHolders.mercia = 'ceowulf';
    expect(admit(state, data, { verb: 'request-allegiance', payload: { liegeId: 'ceowulf' } },
      as('abbess_wenyld')).ok).toBe(true);
  });

  it('needs the man you would follow to accept you', () => {
    let state = playing();
    state.crownHolders.mercia = 'ceowulf';
    state = run(state, as('abbess_wenyld'), 'request-allegiance', { liegeId: 'ceowulf' });
    const id = Object.keys(state.consents)[0];
    expect(state.roles.abbess_wenyld.liegeId).toBe(null);

    state = run(state, as('ceowulf'), 'answer-consent', { consentId: id, granted: true });
    expect(state.roles.abbess_wenyld.liegeId).toBe('ceowulf');
    // And her lands answer to his faction now, which is what a vassal is.
    expect(state.roles.abbess_wenyld.factionId).toBe(state.roles.ceowulf.factionId);
    expect(state.shires.south_mercia.factionId).toBe(state.roles.ceowulf.factionId);
    // The crown she has sworn to now supports her.
    expect(hasSupport(state, data, 'south_mercia')).toBe(true);
  });

  it('leaves her where she was if he says no', () => {
    let state = playing();
    state.crownHolders.mercia = 'ceowulf';
    state = run(state, as('abbess_wenyld'), 'request-allegiance', { liegeId: 'ceowulf' });
    const id = Object.keys(state.consents)[0];
    state = run(state, as('ceowulf'), 'answer-consent', { consentId: id, granted: false });
    expect(state.roles.abbess_wenyld.liegeId).toBe(null);
    expect(hasSupport(state, data, 'south_mercia')).toBe(false);
  });

  it('is closed to a Saxon who already has a lord', () => {
    const state = playing();
    state.crownHolders.mercia = 'ceowulf';
    expect(refusal(state, as('cenred'), 'request-allegiance', { liegeId: 'ceowulf' }))
      .toContain('rebel first');
  });

  it('refuses a circle of homage', () => {
    const state = playing();
    state.crownHolders.mercia = 'ceowulf';
    state.roles.ceowulf.liegeId = 'abbess_wenyld';
    expect(refusal(state, as('abbess_wenyld'), 'request-allegiance', { liegeId: 'ceowulf' }))
      .toContain('circle');
  });
});

describe('the feudal system replays', () => {
  it('rebuilds a coronation and a rebellion to the same board', () => {
    let state = playing();
    state = run(state, as('ceowulf'), 'claim-crown', { crown: 'mercia' });
    const id = Object.keys(state.votes)[0];
    for (const who of Object.keys(state.votes[id].electorate)) {
      state = run(state, as(who), 'cast-vote', { voteId: id, forRoleId: 'ceowulf' });
    }
    state = run(state, as('cenred'), 'request-rebel', { shireId: shiresOf(state, 'cenred')[0] });
    state = run(state, FACILITATOR, 'facilitator:price-rebellion',
      { roleId: 'cenred', shires: 1, soldiers: 2 });
    state = run(state, as('cenred'), 'confirm-rebel', {});
    state = run(state, as('abbess_wenyld'), 'request-allegiance', { liegeId: 'ceowulf' });
    const consentId = Object.keys(state.consents)[0];
    state = run(state, as('ceowulf'), 'answer-consent', { consentId, granted: true });

    const { state: rebuilt, refused } = replay(toSave(state), data);
    expect(refused).toEqual([]);
    expect(rebuilt.crownHolders).toEqual(state.crownHolders);
    expect(rebuilt.votes).toEqual(state.votes);
    expect(rebuilt.roles).toEqual(state.roles);
    expect(rebuilt.shires).toEqual(state.shires);
  });
});
