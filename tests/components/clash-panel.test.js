// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply } from '../../gui/rules/reducer.js';
import { projectView } from '../../gui/rules/views.js';
import '../../gui/components/rb-clash-panel.js';

const data = await loadData();

const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };
const HALFDAN = { seatId: 's1', kind: 'player', roleId: 'halfdan_ragnarsson' };
const GAINBEALD = { seatId: 's2', kind: 'player', roleId: 'gainbeald' };

/**
 * Two seated fighters taken all the way to the dice through the real reducer.
 *
 * Driving it rather than hand-building a clash is the point: the panel is only
 * ever shown a projection, so a test that hands it one the machine could not
 * have produced would prove nothing about what a player sees.
 */
function atTheDice() {
  let state = createInitialState({ joinCode: 'RAVEN7Z', seed: 7, data });
  state.seats.s9 = {
    id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator',
    connected: true, lastSeen: 0,
  };
  for (const [seatId, roleId] of [['s1', 'halfdan_ragnarsson'], ['s2', 'gainbeald']]) {
    state.seats[seatId] = {
      id: seatId, token: seatId, name: seatId, roleId, kind: 'player',
      connected: true, lastSeen: 0,
    };
  }
  const step = (verb, payload, actor = FACILITATOR) => {
    const result = apply(state, data, { verb, payload }, actor, { ts: 0 });
    if (!result.ok) throw new Error(`${verb} refused: ${result.reason}`);
    state = result.state;
  };

  step('facilitator:advance-phase', {});                                    // team
  step('facilitator:advance-phase', {});                                    // battle
  step('facilitator:announce-targets', {});
  step('join-battle', { shireId: 'lindsey', side: 'attackers' }, HALFDAN);
  step('join-battle', { shireId: 'lindsey', side: 'defenders' }, GAINBEALD);
  step('facilitator:pair-clashes', { shireId: 'lindsey' });

  const clashId = Object.keys(state.battle.clashes)[0];
  step('submit-tactic', { clashId, card: '3' }, HALFDAN);
  step('submit-tactic', { clashId, card: '2' }, GAINBEALD);
  step('declare-lead', { clashId, lead: false }, HALFDAN);
  step('declare-lead', { clashId, lead: false }, GAINBEALD);
  step('confirm-lead', { clashId }, HALFDAN);
  step('confirm-lead', { clashId }, GAINBEALD);

  return { get state() { return state; }, step, clashId };
}

const seenBy = (state, roleId) => projectView(state, data, {
  kind: 'player', seatId: 's1', roleId, teamId: state.roles[roleId].teamId,
});

function mount(view) {
  const panel = document.createElement('rb-clash-panel');
  document.body.append(panel);
  panel.data = data;
  panel.view = view;
  return panel;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('<rb-clash-panel> at the dice', () => {
  it('offers a fighter their own die', () => {
    const game = atTheDice();
    const panel = mount(seenBy(game.state, 'halfdan_ragnarsson'));

    let raised = null;
    panel.addEventListener('rb-command', (event) => { raised = event.detail; });
    panel.querySelector('[data-roll]').click();

    expect(raised).toEqual({ verb: 'submit-roll', payload: { clashId: game.clashId } });
  });

  it('shows you your own die and says who it is waiting on', () => {
    const game = atTheDice();
    game.step('submit-roll', { clashId: game.clashId }, HALFDAN);
    const panel = mount(seenBy(game.state, 'halfdan_ragnarsson'));

    const thrown = game.state.battle.clashes[game.clashId].rolls.halfdan_ragnarsson;
    expect(panel.querySelector('.rb-rolled').textContent).toContain(String(thrown));
    // Thrown once and that is that.
    expect(panel.querySelector('[data-roll]')).toBeNull();
    expect(panel.textContent).toContain('Waiting for them to throw');
  });

  it('tells the other fighter that a die is down without saying what it is', () => {
    const game = atTheDice();
    game.step('submit-roll', { clashId: game.clashId }, HALFDAN);
    const view = seenBy(game.state, 'gainbeald');
    const panel = mount(view);

    expect(panel.textContent).toContain('They have thrown');
    // The number itself never arrived, so there is nothing to render badly.
    expect(view.battle.clashes[game.clashId].rolls.halfdan_ragnarsson).toBeUndefined();
    expect(panel.querySelector('[data-roll]')).not.toBeNull();
  });

  it('reads both dice back once the clash has settled', () => {
    const game = atTheDice();
    game.step('submit-roll', { clashId: game.clashId }, HALFDAN);
    game.step('submit-roll', { clashId: game.clashId }, GAINBEALD);
    const clash = game.state.battle.clashes[game.clashId];
    const panel = mount(seenBy(game.state, 'gainbeald'));

    const rolls = panel.querySelector('.rb-detail').textContent;
    expect(rolls).toContain(String(clash.rolls.gainbeald));
    expect(rolls).toContain(String(clash.rolls.halfdan_ragnarsson));
    // And the die is no longer on offer.
    expect(panel.querySelector('[data-roll]')).toBeNull();
  });
});

describe('<rb-clash-panel> when the shire has fallen', () => {
  /**
   * Lindsey taken, with a second attacker to give away to.
   *
   * The clashes are written resolved rather than thrown for, because whether
   * the shire falls is the premise of every test below and a seeded die is not
   * a premise. Everything before that — the phase, the announcement, who is on
   * which side — is the real reducer's doing.
   */
  function takenLindsey() {
    const game = atTheDice();
    const state = game.state;
    state.shires.lindsey.castles = 2;
    state.battle.sides.lindsey.attackers.push('ubba_ragnarsson');
    const clashId = Object.keys(state.battle.clashes)[0];
    state.battle.clashes[clashId].stage = 'resolved';
    state.battle.clashes[clashId].result = { winner: 'halfdan_ragnarsson' };
    state.battle.clashes['lindsey:2'] = {
      id: 'lindsey:2', shireId: 'lindsey', stage: 'resolved', auto: true,
      attacker: 'ubba_ragnarsson', defender: null,
      tactic: {}, lead: {}, reinforcements: {}, rolls: {}, scouts: [],
      result: { winner: 'ubba_ragnarsson', unopposed: true }, amendWindowEndsAt: null,
    };
    return game;
  }

  it('offers the conqueror the men who fought for it', () => {
    const game = takenLindsey();
    const panel = mount(seenBy(game.state, 'halfdan_ragnarsson'));

    const offered = [...panel.querySelectorAll('[data-name-steward]')]
      .map((button) => button.dataset.nameSteward);
    expect(offered).toEqual(['halfdan_ragnarsson', 'ubba_ragnarsson']);
    expect(panel.querySelector('[data-spoils="lindsey"]').textContent)
      .toContain('is yours to give');
  });

  it('sends the pick as the holder\'s own command, not the facilitator\'s', () => {
    const game = takenLindsey();
    const panel = mount(seenBy(game.state, 'halfdan_ragnarsson'));

    let raised = null;
    panel.addEventListener('rb-command', (event) => { raised = event.detail; });
    panel.querySelector('[data-name-steward="ubba_ragnarsson"]').click();

    expect(raised).toEqual({
      verb: 'name-new-steward',
      payload: { shireId: 'lindsey', stewardRoleId: 'ubba_ragnarsson' },
    });
    // And the host takes it, which is the half a raised event cannot prove.
    game.step('name-new-steward', raised.payload, HALFDAN);
    expect(game.state.battle.stewardPicks.lindsey).toBe('ubba_ragnarsson');
  });

  it('takes the whole section away once the naming has settled the battle', () => {
    // Naming was the last thing owed, so the shire changed hands there and
    // then. `name-new-steward` refuses a second one, so leaving the buttons up
    // would leave a row of guaranteed refusals — each of which would first ask
    // "that settles the battle?" about a battle already settled.
    const game = takenLindsey();
    game.step('name-new-steward',
      { shireId: 'lindsey', stewardRoleId: 'ubba_ragnarsson' }, HALFDAN);
    expect(game.state.battle.settled.lindsey).toBe(true);
    expect(game.state.shires.lindsey.stewardRoleId).toBe('ubba_ragnarsson');

    const panel = mount(seenBy(game.state, 'halfdan_ragnarsson'));
    expect(panel.querySelector('[data-spoils="lindsey"]')).toBeNull();
    expect(panel.querySelector('[data-name-steward]')).toBeNull();
  });

  it('offers nothing to a player whose token took nothing', () => {
    // Gainbeald just lost the shire, and no control on his screen invites him
    // to say who gets it. Nor is anybody else's pick in his copy of the game
    // to draw one from.
    const game = takenLindsey();
    game.step('name-new-steward',
      { shireId: 'lindsey', stewardRoleId: 'ubba_ragnarsson' }, HALFDAN);
    const view = seenBy(game.state, 'gainbeald');
    const panel = mount(view);

    expect(panel.querySelector('[data-name-steward]')).toBeNull();
    expect(panel.querySelector('[data-spoils]')).toBeNull();
    expect(view.battle.stewardPicks).toBeUndefined();
  });

  it('offers nothing while the fighting is still going on', () => {
    // The panel and the reducer read the same board through the same
    // functions, so a control cannot appear before the command would take it.
    const game = atTheDice();
    game.state.shires.lindsey.castles = 2;
    const panel = mount(seenBy(game.state, 'halfdan_ragnarsson'));

    expect(panel.querySelector('[data-spoils]')).toBeNull();
  });
});
