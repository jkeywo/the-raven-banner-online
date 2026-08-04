// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The two entry points, started the way a browser starts them.
 *
 * Everything else in the suite imports modules and drives them directly, which
 * left the wiring — `host-app.js` and `player-app.js` — never once executed. A
 * blank page shipped past 485 green tests, and the cause was a stray
 * apostrophe.
 *
 * This is not a browser and does not pretend to be one: no PeerJS, no network,
 * no rendering. It answers one question, which is the question that was going
 * unasked — does the page come up, and does the script find every control it
 * reaches for?
 */

/** The real markup, so a renamed id fails here rather than at an event. */
async function loadPage(name) {
  const html = await readFile(join(ROOT, name), 'utf8');
  document.documentElement.innerHTML = html
    .replace(/<!doctype html>/i, '')
    .replace(/<\/?html[^>]*>/gi, '');
  // The module scripts in the page are not run by jsdom; the test calls the
  // entry point itself, which is what a browser would end up doing.
}

/** Serve data/ off the filesystem, since jsdom has no server to fetch from. */
function stubFetch() {
  globalThis.fetch = vi.fn(async (url) => {
    const path = join(ROOT, String(url).replace(/^\/+/, ''));
    return { ok: true, json: async () => JSON.parse(await readFile(path, 'utf8')) };
  });
}

beforeEach(() => {
  document.documentElement.innerHTML = '';
  stubFetch();
  // No broker and no WebRTC. Nothing here gets as far as starting a game.
  delete globalThis.Peer;
  globalThis.localStorage?.clear?.();
});

describe('the facilitator console', () => {
  it('comes up without throwing', async () => {
    await loadPage('host.html');
    const { startHostApp } = await import('../../gui/host/host-app.js');
    await expect(startHostApp({ location: { hash: '', href: 'http://x/host.html' } }))
      .resolves.not.toThrow();
  });

  it('finds every control it wires', async () => {
    // The failure this guards against is a control renamed in the markup and
    // not in the script: `$('take-over')` returning null, and the page dying
    // on the addEventListener that follows.
    await loadPage('host.html');
    const { startHostApp } = await import('../../gui/host/host-app.js');
    await startHostApp({ location: { hash: '', href: 'http://x/host.html' } });

    for (const id of ['new-game', 'player-count', 'join-as-co', 'co-code', 'co-pin',
      'co-name', 'take-over', 'end-game', 'print-epilogue', 'save-epilogue',
      'advance-phase', 'pause-clock', 'download-save', 'rules-gaps',
      'facilitator-tabs', 'tab-fac-battle', 'tab-fac-crowns', 'tab-fac-envoys',
      'tab-fac-debrief', 'battle-panel', 'consent-panel', 'epilogue-panel',
      'debrief-waiting']) {
      expect(document.getElementById(id), id).toBeTruthy();
    }
  });

  it('writes the rules gaps out where the umpire can read them', async () => {
    await loadPage('host.html');
    const { startHostApp } = await import('../../gui/host/host-app.js');
    await startHostApp({ location: { hash: '', href: 'http://x/host.html' } });
    expect(document.getElementById('rules-gaps').textContent).toContain('Baptise');
  });

  it('offers every head count the guide allows', async () => {
    await loadPage('host.html');
    const options = [...document.getElementById('player-count').options].map((o) => o.value);
    expect(options).toEqual(['16', '15', '14', '13', '12']);
  });

  it('loads the scaling table for itself, not just the player console', async () => {
    // host-app.js keeps its own private loadData rather than sharing
    // gui/client/load-data.js, and it fell out of sync with the player-count
    // work: scaling.json was added to the player's loader but not this one,
    // so a short-handed game silently skipped every top-up, mercenary card
    // and castle removal the guide's table calls for.
    await loadPage('host.html');
    const { startHostApp } = await import('../../gui/host/host-app.js');
    await startHostApp({ location: { hash: '', href: 'http://x/host.html' } });
    const fetched = globalThis.fetch.mock.calls.map(([url]) => String(url));
    expect(fetched).toContain('data/scaling.json');
  });

  it('switches control panels on the facilitator’s own tabs', async () => {
    await loadPage('host.html');
    const { startHostApp } = await import('../../gui/host/host-app.js');
    await startHostApp({ location: { hash: '', href: 'http://x/host.html' } });

    expect(document.getElementById('battle-panel').closest('[data-pane-body]').hidden).toBe(false);
    expect(document.getElementById('consent-panel').closest('[data-pane-body]').hidden).toBe(true);

    document.getElementById('tab-fac-crowns').click();

    expect(document.getElementById('battle-panel').closest('[data-pane-body]').hidden).toBe(true);
    expect(document.getElementById('consent-panel').closest('[data-pane-body]').hidden).toBe(false);
    expect(document.getElementById('tab-fac-crowns').getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('tab-fac-battle').getAttribute('aria-selected')).toBe('false');
  });
});

describe('the player console', () => {
  it('comes up without throwing', async () => {
    await loadPage('index.html');
    const { startPlayerApp } = await import('../../gui/client/player-app.js');
    await expect(startPlayerApp({ location: { hash: '' } })).resolves.not.toThrow();
  });

  it('finds every control it wires', async () => {
    await loadPage('index.html');
    const { startPlayerApp } = await import('../../gui/client/player-app.js');
    await startPlayerApp({ location: { hash: '' } });

    for (const id of ['code-form', 'join-code', 'name-form', 'player-name', 'role-picker',
      'game-tabs', 'tab-battle', 'action-rail', 'character-rail', 'sheet',
      'consents', 'ballot', 'chooser', 'actions']) {
      expect(document.getElementById(id), id).toBeTruthy();
    }
  });

  it('starts on the code screen when there is no code in the link', async () => {
    await loadPage('index.html');
    const { startPlayerApp } = await import('../../gui/client/player-app.js');
    await startPlayerApp({ location: { hash: '' } });
    expect(document.getElementById('screen-code').hidden).toBe(false);
    expect(document.getElementById('screen-game').hidden).toBe(true);
  });
});
