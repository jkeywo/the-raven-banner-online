import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply, replay, openingPosition } from '../../gui/rules/reducer.js';
import { toSave } from '../../gui/rules/command-log.js';
import { ReplayCursor, CHECKPOINT_EVERY } from '../../gui/rules/replay-cursor.js';

const data = await loadData();

const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };
const HALFDAN = { seatId: 's1', kind: 'player', roleId: 'halfdan_ragnarsson' };
const GAINBEALD = { seatId: 's2', kind: 'player', roleId: 'gainbeald' };

/**
 * A real game, long enough to cross several checkpoint boundaries.
 *
 * Driven through the reducer rather than hand-written, and taken as far as a
 * clash with both dice thrown — the cursor's whole claim is that it reproduces
 * the game exactly, and a log with no randomness in it would let a broken one
 * pass. `rngCursor` lives in state, so every equality below is also an
 * assertion about the dice.
 */
function playedOut() {
  let state = createInitialState({ joinCode: 'REPLAY1', seed: 7, data });
  state.seats.s9 = { id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
  state.seats.s1 = { id: 's1', token: 't1', name: 'H', roleId: 'halfdan_ragnarsson', kind: 'player', connected: true, lastSeen: 0 };
  state.seats.s2 = { id: 's2', token: 't2', name: 'G', roleId: 'gainbeald', kind: 'player', connected: true, lastSeen: 0 };

  const step = (verb, payload = {}, actor = FACILITATOR) => {
    const result = apply(state, data, { verb, payload }, actor, { ts: 1000 + state.log.length });
    if (!result.ok) throw new Error(`${verb} refused: ${result.reason}`);
    state = result.state;
  };

  step('facilitator:advance-phase');                                    // team
  step('facilitator:advance-phase');                                    // battle
  step('facilitator:announce-targets');
  step('join-battle', { shireId: 'lindsey', side: 'attackers' }, HALFDAN);
  step('join-battle', { shireId: 'lindsey', side: 'defenders' }, GAINBEALD);
  step('facilitator:pair-clashes', { shireId: 'lindsey' });

  const clashId = Object.keys(state.battle.clashes)[0];
  step('submit-tactic', { clashId, card: '5' }, HALFDAN);
  step('submit-tactic', { clashId, card: '2' }, GAINBEALD);
  step('declare-lead', { clashId, lead: false }, HALFDAN);
  step('declare-lead', { clashId, lead: false }, GAINBEALD);
  step('confirm-lead', { clashId }, HALFDAN);
  step('confirm-lead', { clashId }, GAINBEALD);
  step('submit-roll', { clashId }, HALFDAN);
  step('submit-roll', { clashId }, GAINBEALD);

  // Padding, so the log runs well past several snapshots. An umpire's running
  // note and a nudged counter are the two edits that really do happen dozens
  // of times in an evening.
  for (let i = 0; i < 80; i += 1) {
    step('facilitator:set', { path: ['aftermath', 'foreignInfluence'], value: `note ${i}` });
    step('facilitator:adjust', { path: ['roles', 'gainbeald', 'silver'], delta: 1 });
  }

  return toSave(state);
}

const save = playedOut();

/**
 * The same game cut short.
 *
 * Checking every position against a replay from the seed costs a full replay
 * per position, so it is done over a prefix rather than the whole log — long
 * enough to cross a dozen snapshots and to contain the dice, short enough that
 * the quadratic does not turn a correctness test into a slow one. The
 * full-length log is still walked end to end below; it is only the
 * position-by-position sweep that uses this.
 */
const prefix = { ...save, log: save.log.slice(0, 60) };

/** The reference answer: the reducer's own replay over a truncated log. */
const rebuiltAt = (position, of = save) =>
  replay({ ...of, log: of.log.slice(0, position) }, data).state;

describe('the fixture is worth asserting against', () => {
  it('is a long log with dice in it', () => {
    expect(save.log.length).toBeGreaterThan(CHECKPOINT_EVERY * 4);
    expect(replay(save, data).state.rngCursor).toBeGreaterThan(0);
  });

  it('replays cleanly, so a refusal below is the cursor’s doing and not the log’s', () => {
    expect(replay(save, data).refused).toEqual([]);
  });
});

describe('a cursor over a saved game', () => {
  it('opens on the position the game started from', () => {
    const cursor = new ReplayCursor(save, data);
    expect(cursor.position).toBe(0);
    expect(cursor.length).toBe(save.log.length);
    expect(cursor.state).toEqual(openingPosition(save, data));
  });

  it('reaches the end the same way whether it walks or jumps', () => {
    // The assertion the whole module exists for. A scrub that took a
    // short cut to a different board would show a game nobody played.
    const walked = new ReplayCursor(save, data);
    for (let i = 0; i < save.log.length; i += 1) walked.step();

    const jumped = new ReplayCursor(save, data).toEnd();

    expect(walked.position).toBe(save.log.length);
    expect(walked.state).toEqual(jumped);
    expect(walked.state).toEqual(replay(save, data).state);
  });

  it('agrees with a replay from the seed at every single position', () => {
    // Exhaustive rather than sampled: the failure this guards against is a
    // snapshot taken one entry off, which shows up at exactly one position
    // and nowhere else.
    const cursor = new ReplayCursor(prefix, data, { every: 7 });
    for (let position = 0; position <= prefix.log.length; position += 1) {
      expect(cursor.seek(position), `forwards to ${position}`)
        .toEqual(rebuiltAt(position, prefix));
    }
    for (let position = prefix.log.length; position >= 0; position -= 1) {
      expect(cursor.seek(position), `backwards to ${position}`)
        .toEqual(rebuiltAt(position, prefix));
    }
  });

  it('rewinds a long way and lands on the same board it left', () => {
    const cursor = new ReplayCursor(save, data);
    const early = structuredClone(cursor.seek(9));
    cursor.toEnd();
    expect(cursor.seek(9)).toEqual(early);
  });

  it('gives the same answer whatever the snapshot interval', () => {
    // The interval is a performance dial. If it were ever also a correctness
    // one, a tuning change would silently rewrite history.
    const positions = [0, 1, 13, 40, 99, save.log.length];
    for (const every of [1, 3, CHECKPOINT_EVERY, save.log.length * 2]) {
      const cursor = new ReplayCursor(save, data, { every });
      for (const position of positions) {
        expect(cursor.seek(position), `every ${every}, position ${position}`)
          .toEqual(rebuiltAt(position));
      }
    }
  });

  it('clamps rather than running off either end', () => {
    const cursor = new ReplayCursor(save, data);
    expect(cursor.step(-5)).toEqual(openingPosition(save, data));
    expect(cursor.position).toBe(0);
    cursor.seek(save.log.length + 500);
    expect(cursor.position).toBe(save.log.length);
    expect(cursor.state).toEqual(replay(save, data).state);
  });

  it('steps in tens as readily as in ones', () => {
    const cursor = new ReplayCursor(save, data);
    cursor.step(10);
    expect(cursor.position).toBe(10);
    expect(cursor.state).toEqual(rebuiltAt(10));
    cursor.step(-10);
    expect(cursor.position).toBe(0);
  });

  it('warms the whole log without moving', () => {
    const cursor = new ReplayCursor(save, data);
    cursor.seek(12);
    const where = structuredClone(cursor.state);
    cursor.warm();
    expect(cursor.position).toBe(12);
    expect(cursor.state).toEqual(where);
  });
});

describe('a log the rules have moved under', () => {
  /** The same game with one entry nothing could admit. */
  const tampered = {
    ...save,
    log: [
      ...save.log.slice(0, 4),
      {
        seq: 999, ts: 1, seatId: 's1', roleId: 'halfdan_ragnarsson',
        verb: 'recruit-soldiers', payload: {}, rngCursorBefore: 0, override: false,
      },
      ...save.log.slice(4),
    ],
  };

  it('reports the refusal the reducer would, and carries on past it', () => {
    const cursor = new ReplayCursor(tampered, data).warm();
    expect(cursor.refusals.map((r) => r.verb)).toEqual(['recruit-soldiers']);
    expect(cursor.refusalAt(4).reason).toEqual(replay(tampered, data).refused[0].reason);
    expect(cursor.refusalAt(0)).toBe(null);
    expect(cursor.toEnd()).toEqual(replay(tampered, data).state);
  });

  it('leaves a refused entry no trace beyond the seat that tried it', () => {
    // Position 4 and position 5 straddle the entry nothing admitted, so the
    // only difference between them is the chair its author was sitting in.
    const cursor = new ReplayCursor(tampered, data);
    const before = structuredClone(cursor.seek(4));
    const after = cursor.seek(5);
    expect({ ...after, seats: before.seats }).toEqual(before);
  });
});
