import { describe, it, expect } from 'vitest';
import { createBeeper, createPhaseAnnouncer } from '../../gui/sound.js';

describe('telling a player the game has moved on', () => {
  const spy = () => {
    const beeps = [];
    return [{ beep: (count, hz) => beeps.push(`${count}@${hz}`) }, beeps];
  };

  it('says nothing about the phase a seat arrives in', () => {
    // The whole of the logic worth having. A player joining a game already in
    // the Battle Phase is not being told the Battle Phase has started, and a
    // laptop waking up and being caught up is not news either — both would be
    // a seat announcing history.
    const [beeper, beeps] = spy();
    const announce = createPhaseAnnouncer({ beeper });
    announce({ turn: 2, name: 'battle' });
    expect(beeps).toEqual([]);
  });

  it('speaks up when the facilitator moves it on', () => {
    const [beeper, beeps] = spy();
    const announce = createPhaseAnnouncer({ beeper });
    announce({ turn: 1, name: 'team' });
    announce({ turn: 1, name: 'battle' });
    expect(beeps).toEqual(['2@740']);
  });

  it('stays quiet through the projections that change everything else', () => {
    // A seat gets a projection on every command anybody plays. Only the phase
    // is worth a noise, and one phase is worth exactly one.
    const [beeper, beeps] = spy();
    const announce = createPhaseAnnouncer({ beeper });
    announce({ turn: 1, name: 'team' });
    for (let i = 0; i < 20; i += 1) announce({ turn: 1, name: 'team' });
    expect(beeps).toEqual([]);
  });

  it('hears the next turn, even though the phase is named the same', () => {
    const [beeper, beeps] = spy();
    const announce = createPhaseAnnouncer({ beeper });
    announce({ turn: 1, name: 'team' });
    announce({ turn: 1, name: 'encounter' });
    announce({ turn: 2, name: 'team' });
    expect(beeps).toEqual(['2@740', '2@740']);
  });

  it('does not fall over without a projection to read', () => {
    const [beeper, beeps] = spy();
    const announce = createPhaseAnnouncer({ beeper });
    expect(() => announce(undefined)).not.toThrow();
    expect(beeps).toEqual([]);
  });
});

describe('the beeper, where there is nothing to beep with', () => {
  it('is silent rather than broken when the browser has no audio', () => {
    // Which is every test run, and a real browser with audio disabled, and a
    // tab that has never been clicked in. None of those are a facilitator's
    // problem to solve mid-game, so none of them may break the console.
    const beeper = createBeeper({ Ctx: undefined });
    expect(() => beeper.beep(3)).not.toThrow();
    expect(() => beeper.close()).not.toThrow();
  });

  it('survives a browser that hands out a context and then refuses to play', () => {
    class Hostile {
      constructor() { this.state = 'running'; this.currentTime = 0; }

      createOscillator() { throw new Error('no'); }

      createGain() { throw new Error('no'); }
    }
    const beeper = createBeeper({ Ctx: Hostile });
    expect(() => beeper.beep(3)).not.toThrow();
  });

  it('asks a suspended context to resume, since that is the browser rule', () => {
    let resumed = 0;
    const made = [];
    class Sleepy {
      constructor() {
        this.state = 'suspended';
        this.currentTime = 0;
        this.destination = {};
        made.push(this);
      }

      resume() { resumed += 1; this.state = 'running'; return Promise.resolve(); }

      createOscillator() {
        const node = {
          frequency: {}, connect: (n) => n, start() {}, stop() {},
        };
        return node;
      }

      createGain() {
        return {
          gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          connect: (n) => n,
        };
      }
    }
    const beeper = createBeeper({ Ctx: Sleepy });
    beeper.beep(2);
    expect(resumed).toBe(1);
    // One context for the page, not one per beep.
    beeper.beep(1);
    expect(made).toHaveLength(1);
  });
});
