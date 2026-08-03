/**
 * The static dataset, loaded once for the test run.
 *
 * The rules core never imports data — every function takes it as an argument,
 * so a test can hand it a fixture instead. This helper is just the convenience
 * of loading the real thing when the real thing is what you want to test
 * against.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

const FILES = ['shires', 'adjacency', 'roles', 'briefs', 'archetypes',
  'tactics', 'factions', 'meta', 'scaling'];

let cached = null;

export async function loadData() {
  if (cached) return cached;
  const entries = await Promise.all(FILES.map(async (name) => [
    name, JSON.parse(await readFile(join(DATA_DIR, `${name}.json`), 'utf8')),
  ]));
  cached = Object.fromEntries(entries);
  return cached;
}
