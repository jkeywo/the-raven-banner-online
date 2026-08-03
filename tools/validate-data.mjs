#!/usr/bin/env node
/**
 * tools/validate-data.mjs — structural and checksum gate over `data/`.
 *
 * The dataset is transcribed by hand from vector art in the printed map PDFs,
 * so it gets checked against numbers the published game states independently:
 * 18 shires, 74 settlements, and three each of pagan, Danish and unsupported
 * shires at turn zero. Those four are the Aftermath tracker's starting values,
 * printed on the sheet, and they are the only external evidence that the
 * transcription is right.
 *
 * Run directly (`npm run data:validate`) or via tests/data/checksums.test.js,
 * which imports `validateData` so a failure names the offending shire rather
 * than just a nonzero exit code.
 */

import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(HERE, '..', 'data');

/** Published turn-zero values from the "England in the Aftermath" sheet. */
export const CHECKSUMS = {
  shires: 18,
  shiresPerMap: 6,
  settlements: 74,
  paganShires: 3,
  danishShires: 3,
  unsupportedShires: 3,
};

export async function dataExists() {
  try {
    await access(join(DATA_DIR, 'shires.json'));
    return true;
  } catch {
    return false;
  }
}

async function loadJson(name) {
  return JSON.parse(await readFile(join(DATA_DIR, name), 'utf8'));
}

/**
 * @returns {Promise<string[]>} findings; empty means the dataset is sound.
 */
export async function validateData() {
  const findings = [];
  const shireFile = await loadJson('shires.json');
  const shires = shireFile.shires;
  const ids = Object.keys(shires);

  if (ids.length !== CHECKSUMS.shires) {
    findings.push(`expected ${CHECKSUMS.shires} shires, found ${ids.length}`);
  }

  const byMap = {};
  let settlements = 0;
  for (const id of ids) {
    const s = shires[id];
    byMap[s.map] = (byMap[s.map] || 0) + 1;
    settlements += s.settlements.length;
    if (s.castles < 2 || s.castles > 4) {
      findings.push(`${id}: castle count ${s.castles} outside the 2-4 range`);
    }
  }

  for (const [map, count] of Object.entries(byMap)) {
    if (count !== CHECKSUMS.shiresPerMap) {
      findings.push(`map ${map}: expected ${CHECKSUMS.shiresPerMap} shires, found ${count}`);
    }
  }

  if (settlements !== CHECKSUMS.settlements) {
    findings.push(`expected ${CHECKSUMS.settlements} settlements, found ${settlements}`);
  }

  // TODO(M1): adjacency symmetry and connectivity, steward bijection against
  // roles.json, crown/support-letter coverage, and the three derived turn-zero
  // counts computed through gui/rules/derive.js rather than counted here.

  return findings;
}

async function main() {
  if (!(await dataExists())) {
    console.log('data/ has not been generated yet — nothing to validate.');
    console.log('It is exported from the gamespec project; see AGENTS.md.');
    return 0;
  }
  const findings = await validateData();
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
