#!/usr/bin/env node
/**
 * tools/validate-data.mjs — structural and checksum gate over `data/`.
 *
 * `data/` is transcribed from vector artwork in the printed map PDFs and from
 * the printed reference sheets, so it is checked against numbers the published
 * game states independently: eighteen shires, six per sheet, and the turn-zero
 * values printed on the "England in the Aftermath" tracker.
 *
 * The strongest check here is not a count. The maps and the reference sheets
 * were transcribed separately and each says who stewards what, so the two must
 * agree exactly, in both directions. Two independent transcriptions agreeing is
 * evidence; one transcription agreeing with itself is not.
 *
 * Run directly (`npm run data:validate`) or via tests/data/checksums.test.js,
 * which imports `validateData` so a failure names the offending shire rather
 * than just returning a nonzero exit code.
 */

import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { KNOWN_GAPS } from '../gui/rules/gaps.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(HERE, '..', 'data');

/** Published values, transcribed by hand from the printed sheets. */
export const CHECKSUMS = {
  shires: 18,
  shiresPerMap: 6,
  roles: 16,
  landedRoles: 10,
  /** "England in the Aftermath", turn 0. */
  paganShires: 3,
  danishShires: 3,
  unsupportedShires: 3,
  settlements: 74,
};

/**
 * Where the artwork and the printed tracker disagree, recorded rather than
 * silently accommodated. Each entry must say what was checked and how.
 */
export const KNOWN_DISCREPANCIES = {
  settlements: {
    published: 74,
    extracted: 75,
    note:
      'The Aftermath tracker starts Prosperity at 74, but the three maps carry ' +
      '75 settlement letters. All three sheets were rendered and counted by eye ' +
      'against the extraction and every letter is really there, so this is one ' +
      'mark unaccounted for in the printed tracker rather than a transcription ' +
      'error. Needs the game author to settle.',
  },
  unsupportedShires: {
    published: 3,
    extracted: 7,
    note:
      'The Aftermath tracker starts Disorder at 3, but the support examples in '
      + 'the Players Guide say Abbess Wenyld has no support in South Mercia — '
      + 'and by the same reasoning neither would Uchtred in Middle Anglia or '
      + 'Lundenwic, nor Wenyld in Hwicce. Read strictly as "you or your liege '
      + 'must have a claim listed in the box", turn zero has seven unsupported '
      + 'shires rather than three. The app follows the tracker: while a kingdom '
      + 'has no king, everyone in it speaks for it, which gives exactly the '
      + 'printed three. Needs the game author to settle.',
  },
};

/** The archetypes whose holders are Danish, and pagan until baptised. */
const DANISH_ARCHETYPES = new Set(['danish_warrior', 'danish_trader']);

export async function dataExists() {
  try {
    await access(join(DATA_DIR, 'shires.json'));
    return true;
  } catch {
    return false;
  }
}

const load = async (name) => JSON.parse(await readFile(join(DATA_DIR, name), 'utf8'));

/** @returns {Promise<string[]>} findings; empty means the dataset is sound. */
export async function validateData() {
  const findings = [];
  const fail = (msg) => findings.push(msg);

  const { shires } = await load('shires.json');
  const { roles } = await load('roles.json');
  const { edges } = await load('adjacency.json');
  const { tactics } = await load('tactics.json');
  const meta = await load('meta.json');
  const ids = Object.keys(shires);

  // --- shape ---------------------------------------------------------------
  if (ids.length !== CHECKSUMS.shires) fail(`expected ${CHECKSUMS.shires} shires, found ${ids.length}`);
  if (Object.keys(roles).length !== CHECKSUMS.roles) {
    fail(`expected ${CHECKSUMS.roles} roles, found ${Object.keys(roles).length}`);
  }

  const perMap = {};
  let settlements = 0;
  for (const id of ids) {
    const s = shires[id];
    perMap[s.map] = (perMap[s.map] || 0) + 1;
    settlements += s.settlements.length;
    if (s.castles < 2 || s.castles > 4) fail(`${id}: castle count ${s.castles} outside 2-4`);
    if (s.shipCost !== null && (s.shipCost < 1 || s.shipCost > 4)) {
      fail(`${id}: ship cost ${s.shipCost} outside 1-4`);
    }
    for (const x of s.settlements) {
      if (!['farm', 'town', 'church'].includes(x.type)) fail(`${id}: unknown settlement ${x.type}`);
    }
  }
  for (const [map, n] of Object.entries(perMap)) {
    if (n !== CHECKSUMS.shiresPerMap) fail(`sheet ${map}: expected ${CHECKSUMS.shiresPerMap} shires, found ${n}`);
  }

  const known = KNOWN_DISCREPANCIES.settlements;
  if (settlements !== known.extracted) {
    fail(`expected ${known.extracted} settlements from the artwork, found ${settlements}`);
  }
  if (meta.aftermath.prosperity.start !== known.published) {
    fail(`meta prosperity start is ${meta.aftermath.prosperity.start}, tracker prints ${known.published}`);
  }

  // --- the two transcriptions must agree ------------------------------------
  // The maps say who stewards each shire; the reference sheets say which shires
  // each role stewards. Neither was derived from the other.
  const fromMap = new Map(ids.map((id) => [id, shires[id].initialSteward]));
  const fromSheets = new Map();
  for (const r of Object.values(roles)) {
    for (const shire of r.stewardship) {
      if (fromSheets.has(shire)) fail(`${shire} is stewarded by both ${fromSheets.get(shire)} and ${r.id}`);
      fromSheets.set(shire, r.id);
    }
  }
  for (const [shire, steward] of fromMap) {
    if (!roles[steward]) fail(`${shire}: map names steward '${steward}', which is not a role`);
    else if (fromSheets.get(shire) !== steward) {
      fail(`${shire}: map says ${steward}, reference sheet says ${fromSheets.get(shire) ?? 'nobody'}`);
    }
  }
  for (const shire of fromSheets.keys()) {
    if (!shires[shire]) fail(`reference sheets steward '${shire}', which is not a shire`);
  }

  const landed = Object.values(roles).filter((r) => r.stewardship.length > 0).length;
  if (landed !== CHECKSUMS.landedRoles) {
    fail(`expected ${CHECKSUMS.landedRoles} roles holding land, found ${landed}`);
  }

  // --- liege chains ---------------------------------------------------------
  for (const r of Object.values(roles)) {
    if (r.liege && !roles[r.liege]) fail(`${r.id}: liege '${r.liege}' is not a role`);
    let hop = r.liege;
    for (let i = 0; hop && i <= Object.keys(roles).length; i++) {
      if (hop === r.id) { fail(`${r.id}: liege chain is a cycle`); break; }
      hop = roles[hop]?.liege;
    }
  }

  // --- adjacency ------------------------------------------------------------
  const seen = new Set();
  for (const [a, b] of edges) {
    if (a === b) fail(`adjacency: ${a} borders itself`);
    if (!shires[a] || !shires[b]) fail(`adjacency: unknown shire in ${a}-${b}`);
    const key = [a, b].sort().join('|');
    if (seen.has(key)) fail(`adjacency: ${a}-${b} listed twice`);
    seen.add(key);
  }
  // Every shire must be reachable, or somewhere on the board is unplayable.
  const graph = new Map(ids.map((id) => [id, []]));
  for (const [a, b] of edges) { graph.get(a)?.push(b); graph.get(b)?.push(a); }
  const reached = new Set([ids[0]]);
  for (const stack = [ids[0]]; stack.length; ) {
    for (const next of graph.get(stack.pop()) ?? []) {
      if (!reached.has(next)) { reached.add(next); stack.push(next); }
    }
  }
  if (reached.size !== ids.length) {
    fail(`adjacency: ${ids.length - reached.size} shire(s) unreachable: ` +
         ids.filter((i) => !reached.has(i)).join(', '));
  }

  // --- turn-zero tracker values --------------------------------------------
  // Danish and pagan are read from the steward's archetype, not from the map's
  // faction letter. Bernicia is lettered D because it belongs to the Danish
  // invasion, but King Ecgberht is a Saxon puppet, so it is neither a Danish
  // shire nor a pagan one.
  const danish = ids.filter((id) => DANISH_ARCHETYPES.has(roles[shires[id].initialSteward]?.archetype));
  if (danish.length !== CHECKSUMS.danishShires) {
    fail(`expected ${CHECKSUMS.danishShires} Danish shires at turn 0, found ${danish.length}: ${danish.join(', ')}`);
  }
  const pagan = danish.filter((id) => !shires[id].missionaryCross);
  if (pagan.length !== CHECKSUMS.paganShires) {
    fail(`expected ${CHECKSUMS.paganShires} pagan shires at turn 0, found ${pagan.length}`);
  }
  // The third turn-zero number, the unsupported count, is asserted in
  // tests/rules/derive.test.js instead of here. It cannot be read off the data
  // the way the two above can: it needs the support rule itself -- you have
  // support where you or your liege hold a crown named in the shire's support
  // box -- and that lives in gui/rules/derive.js, which this validator does
  // not load. The check is the same one, and it is the check that pinned the
  // rule down: the published answer is 3, and the three Danish shires are
  // exactly the three that can have no support when the game opens.

  // --- tactic table ---------------------------------------------------------
  if (Object.keys(tactics).length !== 5) fail(`expected 5 tactic cards, found ${Object.keys(tactics).length}`);
  for (const [card, t] of Object.entries(tactics)) {
    if (t.score < 1 || t.score > 5) fail(`tactic ${card}: score ${t.score} outside 1-5`);
  }
  const phaseMinutes = meta.phases.reduce((n, p) => n + p.minutes, 0);
  if (phaseMinutes !== 25) fail(`phases total ${phaseMinutes} minutes, expected 25`);

  return findings;
}

async function main() {
  if (!(await dataExists())) {
    console.log('data/ has not been generated yet — nothing to validate.');
    console.log('It is exported from the gamespec project; see AGENTS.md.');
    return 0;
  }
  const findings = await validateData();
  for (const [what, d] of Object.entries(KNOWN_DISCREPANCIES)) {
    console.log(`known discrepancy — ${what}: ${d.extracted} by the sources, ${d.published} on the printed tracker`);
  }
  // Not findings. Places the printed rules say nothing and the app had to
  // decide, listed so a facilitator can see what was decided for them.
  for (const gap of KNOWN_GAPS) console.log(`rules gap — ${gap.about}: ${gap.ruling}`);
  if (findings.length === 0) {
    console.log('data/ is sound.');
    return 0;
  }
  for (const f of findings) console.error(`  ${f}`);
  console.error(`\n${findings.length} finding(s) in data/.`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main());
}
