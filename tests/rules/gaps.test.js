import { describe, it, expect } from 'vitest';
import { KNOWN_GAPS } from '../../gui/rules/gaps.js';
import { COMMANDS } from '../../gui/rules/commands.js';

describe('the gaps table', () => {
  it('says what was silent, what was decided, and why', () => {
    // A ruling with no reasoning is not reviewable, and this list exists to be
    // reviewed — by the facilitator on the night, and by the author later.
    for (const gap of KNOWN_GAPS) {
      expect(gap.id, JSON.stringify(gap)).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(gap.about?.length, `${gap.id}.about`).toBeGreaterThan(3);
      for (const field of ['silent', 'ruling', 'because']) {
        expect(gap[field]?.length, `${gap.id}.${field}`).toBeGreaterThan(20);
      }
    }
  });

  it('names each gap once', () => {
    const ids = KNOWN_GAPS.map((gap) => gap.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the rulings match the code', () => {
  it('makes a contract in every phase but the battle, lobby and epilogue', () => {
    expect(COMMANDS['offer-contract'].phases).toEqual(['team', 'maintenance', 'encounter']);
    expect(COMMANDS['answer-contract'].phases).toEqual(COMMANDS['offer-contract'].phases);
  });

  it('cancels one only in the Team Phase, which is the printed part', () => {
    expect(COMMANDS['cancel-contract'].phases).toEqual(['team']);
  });

  it('charges nothing for a baptism or for Christian banners', () => {
    // If either ever gains a price, the gaps table is wrong and should be
    // corrected rather than quietly left behind.
    expect(String(COMMANDS.baptise.effects)).not.toMatch(/spend\(/);
    expect(String(COMMANDS['raise-christian-banners'].effects)).not.toMatch(/spend\(/);
  });
});
