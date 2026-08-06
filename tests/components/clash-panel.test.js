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
