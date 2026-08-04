// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { projectView } from '../../gui/rules/views.js';
import { apply } from '../../gui/rules/reducer.js';
import { formatDuration } from '../../gui/components/rb-phase-clock.js';
import '../../gui/components/rb-phase-clock.js';
import '../../gui/components/rb-action-list.js';

const data = await loadData();
const MINUTE = 60_000;

const mount = (tag) => {
  const element = document.createElement(tag);
  document.body.append(element);
  return element;
};

/** A clock frozen at a chosen moment. */
function clockAt({ endsAt = null, paused = false, pausedRemainingMs = null,
  name = 'team', turn = 1 }, now) {
  const clock = mount('rb-phase-clock');
  clock.now = () => now;
  clock.phase = { turn, name, endsAt, paused, pausedRemainingMs };
  return clock;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('<rb-phase-clock>', () => {
  it('reads the time off the wall rather than counting ticks', () => {
    // The reason the component takes a deadline: a background tab has its
    // timers throttled, and a clock built by accumulating intervals comes back
    // minutes wrong. Here, three minutes of being throttled changes nothing —
    // the answer only depends on what time it is.
    const clock = clockAt({ endsAt: 5 * MINUTE }, 2 * MINUTE);
    expect(clock.querySelector('time').textContent).toBe('3:00');
    clock.now = () => 4 * MINUTE + 30_000;
    clock.phase = clock._phase;         // a re-render, as a tick would do
    expect(clock.querySelector('time').textContent).toBe('0:30');
  });

  it('runs past zero into overtime instead of stopping', () => {
    // A phase ends when the facilitator says so. An app that cut a negotiation
    // off at zero would be wrong about the game and maddening besides.
    const clock = clockAt({ endsAt: 5 * MINUTE }, 6 * MINUTE + 5000);
    expect(clock.querySelector('time').textContent).toBe('+1:05');
    expect(clock.dataset.state).toBe('over');
    expect(clock.textContent).toContain('the facilitator will call it');
  });

  it('warns in the last minute', () => {
    expect(clockAt({ endsAt: 5 * MINUTE }, 4 * MINUTE + 10_000).dataset.state).toBe('soon');
    expect(clockAt({ endsAt: 5 * MINUTE }, MINUTE).dataset.state).toBe('running');
  });

  it('holds still while paused, however long that lasts', () => {
    const clock = clockAt({ paused: true, pausedRemainingMs: 3 * MINUTE }, 99 * MINUTE);
    expect(clock.querySelector('time').textContent).toBe('3:00');
    expect(clock.dataset.state).toBe('paused');
    expect(clock.textContent).toContain('Paused');
  });

  it('shows no time at all in the lobby', () => {
    const clock = clockAt({ name: 'lobby' }, 0);
    expect(clock.querySelector('time').textContent).toBe('');
    expect(clock.textContent).toContain('Waiting to begin');
    expect(clock.dataset.state).toBe('idle');
  });

  it('names the phase and says what it is for', () => {
    const clock = clockAt({ name: 'encounter', turn: 3, endsAt: MINUTE }, 0);
    expect(clock.textContent).toContain('Turn 3');
    expect(clock.textContent).toContain('Encounter Phase');
    expect(clock.textContent).toContain('Talk to anyone');
  });

  it('formats as minutes and seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(10 * MINUTE)).toBe('10:00');
  });
});

describe('<rb-action-list>', () => {
  /** A seated player, projected, with the game moved to a chosen phase. */
  function seated(phaseName) {
    let state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
    state.seats.s1 = { id: 's1', token: 't', name: 'A', roleId: 'king_alfred', kind: 'player', connected: true, lastSeen: 0 };
    state.seats.s9 = { id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
    const facilitator = { seatId: 's9', kind: 'facilitator', roleId: null };
    while (state.phase.name !== phaseName) {
      state = apply(state, data, { verb: 'facilitator:advance-phase', payload: {} },
        facilitator, { ts: 0 }).state;
    }
    return projectView(state, data, {
      kind: 'player', seatId: 's1', roleId: 'king_alfred', teamId: 'wessex',
    });
  }

  it('offers the maintenance actions in the maintenance phase', () => {
    const list = mount('rb-action-list');
    list.data = data;
    list.view = seated('maintenance');
    const verbs = [...list.querySelectorAll('[data-verb]')].map((b) => b.dataset.verb);
    expect(verbs).toContain('collect-income');
    expect(verbs).toContain('recruit-soldiers');
    expect(verbs).not.toContain('declare-initiative-target');
  });

  it('shows a refused action with its reason rather than hiding it', () => {
    // A player who cannot see that recruiting exists cannot learn what it
    // costs. "Why can't I afford that?" is a better question than "why is
    // there nothing here?".
    const view = seated('maintenance');
    view.roles.king_alfred.silver = 1;
    const list = mount('rb-action-list');
    list.data = data;
    list.view = view;

    const recruit = [...list.querySelectorAll('.rb-action')]
      .find((li) => li.querySelector('[data-verb="recruit-soldiers"]'));
    expect(recruit.dataset.ok).toBe('false');
    expect(recruit.querySelector('button').disabled).toBe(true);
    expect(recruit.textContent).toContain('not enough silver');
  });

  it('offers the battle actions in the battle phase', () => {
    const list = mount('rb-action-list');
    list.data = data;
    list.view = seated('battle');
    const verbs = [...list.querySelectorAll('[data-verb]')].map((b) => b.dataset.verb);
    expect(verbs).toContain('join-battle');
    // Nothing may change hands while blades are out.
    expect(verbs).not.toContain('give');
    expect(verbs).not.toContain('trade');
  });

  it('offers trading as available rather than as refused for want of a choice', () => {
    // Probing with an empty payload made this report "trade silver for food,
    // or food for silver" as though it were a refusal, which reads to a
    // player as "you can't" when the answer is "which way?".
    const list = mount('rb-action-list');
    list.data = data;
    list.view = seated('maintenance');
    const trade = [...list.querySelectorAll('.rb-action')]
      .find((li) => li.querySelector('[data-verb="trade"]'));
    expect(trade.dataset.ok).toBe('true');
    expect(trade.querySelector('button').disabled).toBe(false);
  });

  it('never offers a facilitator command to a player', () => {
    const list = mount('rb-action-list');
    list.data = data;
    list.view = seated('team');
    const verbs = [...list.querySelectorAll('[data-verb]')].map((b) => b.dataset.verb);
    expect(verbs.some((v) => v.startsWith('facilitator:'))).toBe(false);
  });

  it('lists what is refused separately from what can actually be done', () => {
    const view = seated('maintenance');
    view.roles.king_alfred.silver = 1;
    const list = mount('rb-action-list');
    list.data = data;
    list.view = view;

    expect(list.querySelector('.rb-actions-available [data-verb="collect-income"]')).toBeTruthy();
    expect(list.querySelector('.rb-actions-unavailable [data-verb="recruit-soldiers"]')).toBeTruthy();
    expect(list.querySelector('.rb-actions-available [data-verb="recruit-soldiers"]')).toBeNull();
  });

  it('promotes and marks an available action once a shire it could target is clicked', () => {
    const list = mount('rb-action-list');
    list.data = data;
    list.view = seated('team');
    // Alfred stewards Wiltshire, so transfer-stewardship can target it.
    list.focusShireId = 'wiltshire';

    const row = list.querySelector('[data-verb="transfer-stewardship"]').closest('.rb-action');
    expect(row.dataset.relevant).toBe('true');
    // And it leads the available list, ahead of actions the click said
    // nothing about.
    expect(list.querySelector('.rb-actions-available .rb-action').dataset.relevant).toBe('true');
  });

  it('marks nothing once the focus is cleared', () => {
    const list = mount('rb-action-list');
    list.data = data;
    list.view = seated('team');
    list.focusShireId = 'wiltshire';
    list.focusShireId = null;
    expect(list.querySelectorAll('[data-relevant="true"]')).toHaveLength(0);
  });

  it('never promotes a refused action, whatever it could target', () => {
    // Declaring is a facilitator-only concern for a role with no initiative
    // token, so it should never be marked relevant no matter what is clicked.
    const list = mount('rb-action-list');
    list.data = data;
    list.view = seated('team');
    list.focusShireId = 'wiltshire';
    const row = list.querySelector('[data-verb="declare-initiative-target"]')?.closest('.rb-action');
    if (row) expect(row.dataset.relevant).toBe('false');
  });
});
