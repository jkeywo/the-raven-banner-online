import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState, PHASES } from '../../gui/rules/state.js';
import { apply } from '../../gui/rules/reducer.js';
import { admit } from '../../gui/rules/admission.js';
import { remainingMs } from '../../gui/rules/commands.js';

const data = await loadData();
const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };
const MINUTE = 60_000;

function fresh() {
  const state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
  state.seats.s9 = { id: 's9', token: 't', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
  return state;
}

/** Run a facilitator command at a given moment. */
function at(state, ts, verb, payload = {}) {
  const result = apply(state, data, { verb, payload }, FACILITATOR, { ts });
  if (!result.ok) throw new Error(`${verb} refused: ${result.reason}`);
  return result.state;
}

describe('the clock is a deadline, not a countdown', () => {
  it('sets an end time from the printed length of the phase', () => {
    const state = at(fresh(), 1_000_000, 'facilitator:advance-phase');
    expect(state.phase.name).toBe('team');
    // Five minutes, as printed on the reference sheets.
    expect(state.phase.endsAt).toBe(1_000_000 + 5 * MINUTE);
  });

  it('gives the encounter phase its full ten minutes', () => {
    let state = fresh();
    let now = 0;
    for (const phase of PHASES) {
      state = at(state, now, 'facilitator:advance-phase');
      expect(state.phase.name).toBe(phase);
      const printed = data.meta.phases.find((p) => p.id === phase);
      expect(state.phase.endsAt - now).toBe(printed.minutes * MINUTE);
      now += 1000;
    }
    expect(state.phase.name).toBe('encounter');
  });

  it('is derived from the wall clock, so a throttled tab cannot drift', () => {
    // Nothing accumulates. Whatever the tab was doing, the answer is always
    // "the deadline, minus what time it is now".
    const state = at(fresh(), 0, 'facilitator:advance-phase');
    expect(remainingMs(state.phase, 0)).toBe(5 * MINUTE);
    expect(remainingMs(state.phase, 4 * MINUTE)).toBe(MINUTE);
    // And it keeps going past zero rather than stopping, because a phase ends
    // when the facilitator says so.
    expect(remainingMs(state.phase, 7 * MINUTE)).toBe(-2 * MINUTE);
  });

  it('leaves the lobby and the epilogue without a deadline', () => {
    expect(fresh().phase.endsAt).toBe(null);
    // One advance out of the lobby, then five turns of four phases: twenty-one
    // in all before the game is over.
    let state = fresh();
    let now = 0;
    let advances = 0;
    while (state.phase.name !== 'epilogue' && advances < 40) {
      state = at(state, now, 'facilitator:advance-phase');
      now += 1000;
      advances += 1;
    }
    expect(advances).toBe(1 + 5 * PHASES.length);
    expect(state.phase).toMatchObject({ turn: 5, name: 'epilogue', endsAt: null });
    expect(admit(state, data, { verb: 'facilitator:advance-phase' }, FACILITATOR))
      .toMatchObject({ ok: false, reason: 'the game is over' });
  });
});

describe('pausing', () => {
  it('keeps what was left and hands it back', () => {
    // A five-minute argument about a rule must not eat the phase it
    // interrupted, so the remaining time is stored rather than the deadline.
    let state = at(fresh(), 0, 'facilitator:advance-phase');
    state = at(state, 2 * MINUTE, 'facilitator:pause-clock');
    expect(state.phase).toMatchObject({ paused: true, endsAt: null, pausedRemainingMs: 3 * MINUTE });

    // Time passes while paused, and none of it counts.
    expect(remainingMs(state.phase, 30 * MINUTE)).toBe(3 * MINUTE);

    state = at(state, 10 * MINUTE, 'facilitator:pause-clock');
    expect(state.phase).toMatchObject({ paused: false, pausedRemainingMs: null });
    expect(state.phase.endsAt).toBe(13 * MINUTE);
  });

  it('refuses when there is no clock to pause', () => {
    expect(admit(fresh(), data, { verb: 'facilitator:pause-clock' }, FACILITATOR))
      .toMatchObject({ ok: false, reason: 'there is no clock running' });
  });

  it('starts the next phase running, whatever the last one was doing', () => {
    let state = at(fresh(), 0, 'facilitator:advance-phase');
    state = at(state, MINUTE, 'facilitator:pause-clock');
    state = at(state, 2 * MINUTE, 'facilitator:advance-phase');
    expect(state.phase).toMatchObject({ name: 'battle', paused: false, pausedRemainingMs: null });
    expect(state.phase.endsAt).toBe(2 * MINUTE + 5 * MINUTE);
  });
});

describe('stretching a phase', () => {
  it('adds and removes minutes', () => {
    let state = at(fresh(), 0, 'facilitator:advance-phase');
    state = at(state, 0, 'facilitator:extend-clock', { minutes: 2 });
    expect(state.phase.endsAt).toBe(7 * MINUTE);
    state = at(state, 0, 'facilitator:extend-clock', { minutes: -3 });
    expect(state.phase.endsAt).toBe(4 * MINUTE);
  });

  it('will not push a deadline into the past', () => {
    let state = at(fresh(), 0, 'facilitator:advance-phase');
    state = at(state, MINUTE, 'facilitator:extend-clock', { minutes: -30 });
    expect(state.phase.endsAt).toBe(MINUTE);   // now, not before now
  });

  it('stretches the stored remainder while paused', () => {
    let state = at(fresh(), 0, 'facilitator:advance-phase');
    state = at(state, MINUTE, 'facilitator:pause-clock');
    state = at(state, MINUTE, 'facilitator:extend-clock', { minutes: 2 });
    expect(state.phase.pausedRemainingMs).toBe(6 * MINUTE);
  });

  it('wants to be told how many minutes', () => {
    const state = at(fresh(), 0, 'facilitator:advance-phase');
    expect(admit(state, data, { verb: 'facilitator:extend-clock', payload: {} }, FACILITATOR))
      .toMatchObject({ ok: false, reason: 'say how many minutes' });
    expect(admit(state, data, { verb: 'facilitator:extend-clock', payload: { minutes: 0 } },
      FACILITATOR).ok).toBe(false);
  });
});

describe('the turn', () => {
  it('rolls over after the encounter phase and resets what is per-turn', () => {
    let state = fresh();
    let now = 0;
    for (const _ of PHASES) { state = at(state, now, 'facilitator:advance-phase'); now += 1000; }
    state.roles.king_alfred.perTurn.tradesUsed = 1;
    state.initiative.declared = { white: { roleId: 'halfdan_ragnarsson', shireId: 'lindsey', revealed: true } };

    state = at(state, now, 'facilitator:advance-phase');
    expect(state.phase).toMatchObject({ turn: 2, name: 'team' });
    expect(state.roles.king_alfred.perTurn.tradesUsed).toBe(0);
    expect(state.initiative.declared).toEqual({});
  });

  it('replays to the same deadlines it had the first time', async () => {
    // The clock is in state, so a restored game is not merely at the right
    // phase — it is the right distance into it.
    const { replay } = await import('../../gui/rules/reducer.js');
    const { toSave } = await import('../../gui/rules/command-log.js');
    let state = at(fresh(), 500_000, 'facilitator:advance-phase');
    state = at(state, 600_000, 'facilitator:extend-clock', { minutes: 3 });
    const { state: rebuilt, refused } = replay(toSave(state), data);
    expect(refused).toEqual([]);
    expect(rebuilt.phase).toMatchObject({ name: 'team', endsAt: state.phase.endsAt });
  });
});
