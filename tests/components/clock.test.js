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

describe('the clock saying when it has crossed a line', () => {
  /** Re-render at a moment, as a tick would, and collect what was raised. */
  const tick = (clock, at) => { clock.now = () => at; clock.phase = clock._phase; };

  const listening = (clock) => {
    const heard = [];
    for (const kind of ['rb-time-up', 'rb-overtime']) {
      clock.addEventListener(kind, (e) => heard.push(`${kind}@${Math.round(e.detail.overMs)}`));
    }
    return heard;
  };

  it('says nothing while there is time left', () => {
    const clock = clockAt({ endsAt: 5 * MINUTE }, 0);
    const heard = listening(clock);
    tick(clock, 4 * MINUTE);
    tick(clock, 5 * MINUTE - 1);
    expect(heard).toEqual([]);
  });

  it('says the time is up once, however often it is asked', () => {
    const clock = clockAt({ endsAt: 5 * MINUTE }, 0);
    const heard = listening(clock);
    tick(clock, 5 * MINUTE + 100);
    tick(clock, 5 * MINUTE + 600);
    tick(clock, 5 * MINUTE + 1_100);
    expect(heard).toEqual(['rb-time-up@100']);
  });

  it('marks each ten seconds of overtime, once each', () => {
    const clock = clockAt({ endsAt: 5 * MINUTE }, 0);
    const heard = listening(clock);
    tick(clock, 5 * MINUTE + 1_000);        // time up
    tick(clock, 5 * MINUTE + 9_000);        // still the first ten seconds
    tick(clock, 5 * MINUTE + 10_500);       // second step
    tick(clock, 5 * MINUTE + 15_000);       // same step, nothing new
    tick(clock, 5 * MINUTE + 21_000);       // third
    expect(heard).toEqual([
      'rb-time-up@1000', 'rb-overtime@10500', 'rb-overtime@21000',
    ]);
  });

  it('does not empty a backlog at a facilitator who was on Discord', () => {
    // The reason this counts steps rather than elapsed time. A background tab
    // is throttled and can come back a long way behind; three minutes away
    // should be one beep on return, not eighteen.
    const clock = clockAt({ endsAt: 5 * MINUTE }, 0);
    const heard = listening(clock);
    tick(clock, 5 * MINUTE + 500);
    tick(clock, 8 * MINUTE);
    expect(heard).toEqual(['rb-time-up@500', 'rb-overtime@180000']);
  });

  it('starts again on the next phase', () => {
    const clock = clockAt({ endsAt: 5 * MINUTE }, 0);
    const heard = listening(clock);
    // First sight of this clock is already twelve seconds over, which is one
    // crossing and not two: the step it landed in is the step it starts from.
    tick(clock, 5 * MINUTE + 12_000);
    expect(heard).toEqual(['rb-time-up@12000']);

    clock.phase = { turn: 1, name: 'battle', endsAt: 20 * MINUTE, paused: false };
    tick(clock, 20 * MINUTE + 300);
    expect(heard).toEqual(['rb-time-up@12000', 'rb-time-up@300']);
  });

  it('goes quiet while paused, and does not shout on resume', () => {
    // A paused clock is not running out of anything. And the pause has to
    // clear what was counted, or resuming into overtime would say nothing
    // until the step it was already past came round again.
    const clock = clockAt({ endsAt: 5 * MINUTE }, 0);
    const heard = listening(clock);
    clock.phase = { turn: 1, name: 'team', endsAt: 5 * MINUTE, paused: true, pausedRemainingMs: -5_000 };
    tick(clock, 9 * MINUTE);
    expect(heard).toEqual([]);

    clock.phase = { turn: 1, name: 'team', endsAt: 5 * MINUTE, paused: false };
    tick(clock, 9 * MINUTE);
    expect(heard).toEqual(['rb-time-up@240000']);
  });

  it('says nothing in the lobby or the aftermath, which have no deadline', () => {
    const clock = clockAt({ endsAt: null, name: 'lobby' }, 9 * MINUTE);
    const heard = listening(clock);
    tick(clock, 99 * MINUTE);
    expect(heard).toEqual([]);
  });
});

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

  it('says a rebellion is waiting on the facilitator before it is priced', () => {
    const view = seated('team');
    view.rebellions = {
      r1: { id: 'r1', roleId: 'king_alfred', liegeId: 'nobody', status: 'pending', cost: null },
    };
    const list = mount('rb-action-list');
    list.data = data;
    list.view = view;
    const cancel = list.querySelector('[data-verb="cancel-rebel"]')?.closest('.rb-action');
    expect(cancel?.textContent).toContain('Waiting on the facilitator to set a price');
  });

  it('shows the priced cost once the facilitator has set one', () => {
    const view = seated('team');
    view.rebellions = {
      r1: {
        id: 'r1', roleId: 'king_alfred', liegeId: 'nobody',
        status: 'priced', cost: { shires: 1, soldiers: 2 },
      },
    };
    const list = mount('rb-action-list');
    list.data = data;
    list.view = view;
    const confirm = list.querySelector('[data-verb="confirm-rebel"]')?.closest('.rb-action');
    expect(confirm?.textContent).toContain('Costs 1 shire and 2 soldiers');
  });
});
