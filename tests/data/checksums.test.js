import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  validateData, dataExists, DATA_DIR, CHECKSUMS, KNOWN_DISCREPANCIES,
} from '../../tools/validate-data.mjs';

const HAVE_DATA = await dataExists();
const load = async (name) => JSON.parse(await readFile(join(DATA_DIR, name), 'utf8'));

describe('data/ checksums', () => {
  it('states the published turn-zero values it gates against', () => {
    // Not a tautology: these are transcribed from the "England in the
    // Aftermath" sheet, and this is where a future reader finds out where
    // the magic numbers came from.
    expect(CHECKSUMS).toMatchObject({
      shires: 18, shiresPerMap: 6, roles: 16, landedRoles: 10,
      paganShires: 3, danishShires: 3, unsupportedShires: 3, settlements: 74,
    });
  });

  it('records the one place the artwork and the printed tracker disagree', () => {
    // Kept visible rather than quietly accommodated. If this ever resolves,
    // the discrepancy entry goes away and the counts simply agree.
    expect(KNOWN_DISCREPANCIES.settlements).toMatchObject({ published: 74, extracted: 75 });
    expect(KNOWN_DISCREPANCIES.settlements.note).toMatch(/author/);
  });

  it.runIf(HAVE_DATA)('finds nothing wrong with the dataset', async () => {
    expect(await validateData()).toEqual([]);
  });
});

describe.runIf(HAVE_DATA)('the role table', () => {
  // Transcribed independently of data/roles.json, from the printed reference
  // sheets. Two transcriptions agreeing is evidence; one agreeing with itself
  // is not. Silver / food / soldiers / ships.
  const PRINTED = {
    king_alfred: [4, 4, 4, 0], cenred: [4, 4, 3, 0], godric: [6, 4, 6, 0],
    archbishop_aethelred: [4, 3, 4, 0], ceowulf: [4, 4, 3, 0], gainbeald: [4, 4, 3, 0],
    uchtred: [4, 4, 3, 0], abbess_wenyld: [4, 3, 4, 0], king_ecgberht: [4, 5, 2, 0],
    halfdan_ragnarsson: [8, 3, 12, 4], ubba_ragnarsson: [8, 3, 12, 4],
    frida_anundottir: [12, 3, 8, 6], guthrum_the_old: [8, 3, 12, 4],
    gyda_the_bold: [8, 3, 12, 4], anwend_the_steady: [8, 3, 12, 4],
    oscatel_the_brave: [8, 3, 12, 4],
  };

  it('matches an independent transcription of the printed sheets', async () => {
    const { roles } = await load('roles.json');
    expect(Object.keys(roles).sort()).toEqual(Object.keys(PRINTED).sort());
    for (const [id, [silver, food, soldiers, ships]] of Object.entries(PRINTED)) {
      expect(roles[id].start, id).toMatchObject({ silver, food, soldiers, ships, momentum: 0 });
    }
  });

  it('gives every role a private brief with at least one goal', async () => {
    const { roles } = await load('roles.json');
    const { briefs } = await load('briefs.json');
    for (const id of Object.keys(roles)) {
      expect(briefs[id]?.goals.length, id).toBeGreaterThan(0);
    }
  });

  it('does not cut a brief off mid-sentence', async () => {
    // Guidance runs from a heading to the team name that closes the page, and
    // two of the teams are called "Great ... Army" — so a stop pattern
    // matching the bare word truncated every line that mentioned one.
    // Alfred's advice about Guthrum ended at "Guthrum and his" and read as
    // perfectly complete, which is why this looks for the actual signature
    // rather than for a full stop: plenty of real bullets are as terse as
    // "Amass silver" and never had one.
    const DANGLING = /\b(and|or|but|the|a|an|of|to|with|for|in|on|at|by|from|his|her|their|its|your|that|which|is|are|was|were)$/i;
    const { briefs } = await load('briefs.json');
    const truncated = [];
    for (const [id, brief] of Object.entries(briefs)) {
      for (const line of [...brief.goals, ...brief.guidance]) {
        if (DANGLING.test(line.trim())) truncated.push(`${id}: "${line}"`);
      }
    }
    expect(truncated).toEqual([]);
  });

  it('keeps every line of guidance the sheets print', async () => {
    const { briefs } = await load('briefs.json');
    const lines = Object.values(briefs).reduce((n, b) => n + b.guidance.length, 0);
    expect(lines).toBe(70);
    // The line that was silently losing its second half.
    expect(briefs.king_alfred.guidance[1]).toMatch(/Great Summer Army are your immediate threat/);
  });

  it('splits the sixteen roles across four archetypes as printed', async () => {
    const { roles } = await load('roles.json');
    const tally = {};
    for (const r of Object.values(roles)) tally[r.archetype] = (tally[r.archetype] ?? 0) + 1;
    expect(tally).toEqual({
      saxon_warrior: 7, saxon_priest: 2, danish_warrior: 6, danish_trader: 1,
    });
  });
});

describe.runIf(HAVE_DATA)('the tactic table', () => {
  it('matches the clash table printed on every action sheet', async () => {
    const { tactics } = await load('tactics.json');
    // card: [battle score, losses dealt, losses received]
    const PRINTED = {
      A: [1, -1, -1], 2: [2, 0, -1], 3: [3, 2, 0], 4: [4, 1, 0], 5: [5, 2, 1],
    };
    for (const [card, [score, lossesDealt, lossesReceived]] of Object.entries(PRINTED)) {
      expect(tactics[card], card).toMatchObject({ score, lossesDealt, lossesReceived });
    }
  });

  it('scores leadership as printed, with a wound on a six either way', async () => {
    const { leadership } = await load('meta.json');
    expect(leadership.normal).toEqual({ 1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 2 });
    expect(leadership.lead).toEqual({ 1: -1, 2: 1, 3: 2, 4: 3, 5: 3, 6: 4 });
    expect(leadership.woundOnSix).toBe(true);
  });
});

/** Ray casting against an SVG polyline of the form "M x,y L x,y ... Z". */
function pointInPath(d, [px, py]) {
  const pts = d.replace(/^M\s*/, '').replace(/\s*Z$/, '').split(/\s*L\s*/)
    .map((p) => p.split(',').map(Number));
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

describe.runIf(HAVE_DATA)('map geometry', () => {
  it('places every settlement inside the shire it was assigned to', async () => {
    // This is the check that a settlement letter was read into the right
    // shire. The outlines come from flooding the drawn borders and the anchors
    // from where the letters were printed, so the two are independent: a pip
    // outside its own outline means the assignment is wrong, which no count
    // would catch because the totals would still come out right.
    const { shires } = await load('shires.json');
    const geometry = await load('geometry.json');
    const strays = [];
    for (const [id, shire] of Object.entries(shires)) {
      const g = geometry.shires[id];
      g.settlements.forEach((at, n) => {
        if (!pointInPath(g.polygon, at)) {
          strays.push(`${id} ${shire.settlements[n].type} at ${at}`);
        }
      });
    }
    expect(strays).toEqual([]);
  });

  it('does not let one shire swallow another’s settlements', async () => {
    // The outlines come from labelled regions, so they cannot overlap by
    // construction — unless one escapes its drawn borders, which is what the
    // coastal shires did while the pale shallows read as land. Ribble reached
    // seventeen per cent of the sheet and out past two neighbours' shores.
    //
    // Not a proof: a region can leak into open water without touching another
    // shire's pips, and only looking at the artwork catches that. It is the
    // part of the failure that can be caught without the PDFs to hand.
    const geometry = await load('geometry.json');
    const trespass = [];
    for (const [id, g] of Object.entries(geometry.shires)) {
      for (const [other, h] of Object.entries(geometry.shires)) {
        if (other === id || h.sheet !== g.sheet) continue;
        for (const at of h.settlements) {
          if (pointInPath(g.polygon, at)) trespass.push(`${id} covers ${other}'s pip at ${at}`);
        }
      }
    }
    expect(trespass).toEqual([]);
  });

  it('gives every shire an outline and one anchor per settlement', async () => {
    const { shires } = await load('shires.json');
    const geometry = await load('geometry.json');
    for (const [id, shire] of Object.entries(shires)) {
      const g = geometry.shires[id];
      expect(g, id).toBeDefined();
      expect(g.polygon, `${id} outline`).toMatch(/^M .* Z$/);
      // The overlay pairs settlements to anchors by index, so a mismatch here
      // would silently draw a pip in the wrong place.
      expect(g.settlements.length, `${id} anchors`).toBe(shire.settlements.length);
    }
  });
});
