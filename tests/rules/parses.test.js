// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUI = join(ROOT, 'gui');

/**
 * Every runtime module is imported by something a test exercises — except the
 * two entry points. `host-app.js` and `player-app.js` are wiring: they touch
 * `document` at call time and are driven by a browser, so nothing in the suite
 * had ever loaded them. A stray apostrophe in a string shipped a blank page,
 * and 485 green tests said nothing at all.
 *
 * So: load every file under gui/ and let the parser have an opinion. This is
 * not a substitute for testing the wiring; it is the floor beneath it.
 */
async function jsFilesUnder(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await jsFilesUnder(full)));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const FILES = await jsFilesUnder(GUI);

describe('every module the browser loads', () => {
  it('is there to be found', () => {
    // A guard on the guard: if the walk breaks, the parse check below would
    // pass by testing nothing.
    expect(FILES.length).toBeGreaterThan(25);
  });

  it.each(FILES.map((file) => relative(ROOT, file)))('%s parses', async (name) => {
    // Under jsdom, because a custom element extends HTMLElement at module
    // scope. The two apps only touch the document when they are called, so
    // importing them is safe — and importing is what makes the parser read
    // the whole file rather than just the top of it.
    await expect(import(pathToFileURL(join(ROOT, name)).href)).resolves.toBeTruthy();
  });
});
