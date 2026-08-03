import { describe, it, expect } from 'vitest';
import { validateData, dataExists, CHECKSUMS } from '../../tools/validate-data.mjs';

// data/ is generated from the gamespec project and is not present until M1.
// Resolved once, at module scope, so the suite below can branch on it.
const HAVE_DATA = await dataExists();

describe('data/ checksums', () => {
  it('states the published turn-zero values it gates against', () => {
    // Not a tautology: these are transcribed from the "England in the
    // Aftermath" sheet, and this test is where a future reader finds out
    // where the magic numbers came from.
    expect(CHECKSUMS.settlements).toBe(74);
    expect(CHECKSUMS.shires).toBe(18);
    expect(CHECKSUMS.paganShires).toBe(3);
    expect(CHECKSUMS.danishShires).toBe(3);
    expect(CHECKSUMS.unsupportedShires).toBe(3);
  });

  it.runIf(HAVE_DATA)('finds nothing wrong with the dataset', async () => {
    expect(await validateData()).toEqual([]);
  });
});
