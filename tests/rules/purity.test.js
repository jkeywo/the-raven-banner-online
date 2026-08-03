import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RULES_DIR = join(ROOT, 'gui', 'rules');

/**
 * The rules core is imported by the host, which enforces it, and by both
 * clients, which use it to grey out controls they cannot afford. That only
 * works if it depends on nothing. These are the imports that would break it.
 */
const FORBIDDEN_IMPORT = /from\s+['"]([^'"]*\/(net|host|client|components)\/[^'"]*)['"]/g;

/**
 * A rules module that touches the DOM cannot be run in Node, and a rules module
 * that reads its data from a module-level global cannot be given a fixture.
 */
const FORBIDDEN_GLOBAL = /\b(document|window|localStorage|navigator|fetch)\b/g;

async function jsFilesUnder(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // gui/rules/ does not exist yet
  }
  const out = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await jsFilesUnder(full)));
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const RULES_FILES = await jsFilesUnder(RULES_DIR);

describe('gui/rules is pure', () => {
  it.runIf(RULES_FILES.length > 0)('imports nothing from the transport, host or UI layers', async () => {
    const offences = [];
    for (const file of RULES_FILES) {
      const src = await readFile(file, 'utf8');
      for (const m of src.matchAll(FORBIDDEN_IMPORT)) {
        offences.push(`${relative(ROOT, file)} imports ${m[1]}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it.runIf(RULES_FILES.length > 0)('touches no browser global', async () => {
    const offences = [];
    for (const file of RULES_FILES) {
      const src = await readFile(file, 'utf8')
        // Strip comments so prose about `document` is not an offence.
        .then((s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
      for (const m of src.matchAll(FORBIDDEN_GLOBAL)) {
        offences.push(`${relative(ROOT, file)} references ${m[1]}`);
      }
    }
    expect(offences).toEqual([]);
  });
});
