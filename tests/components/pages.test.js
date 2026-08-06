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
      'debrief-waiting', 'fac-map', 'shire-editor',
      'foreign-influence-note', 'foreign-influence-commit',
      'tab-fac-game', 'lobby-roles', 'role-grid',
      'test-seats', 'open-test-seats']) {
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

  it('loads the map geometry so the facilitator\'s own map can draw', async () => {
    await loadPage('host.html');
    const { startHostApp } = await import('../../gui/host/host-app.js');
    await startHostApp({ location: { hash: '', href: 'http://x/host.html' } });
    const fetched = globalThis.fetch.mock.calls.map(([url]) => String(url));
    expect(fetched).toContain('data/geometry.json');
  });

  it('switches control panels on the facilitator’s own tabs', async () => {
    await loadPage('host.html');
    const { startHostApp } = await import('../../gui/host/host-app.js');
    await startHostApp({ location: { hash: '', href: 'http://x/host.html' } });

    // The map is the default tab — a facilitator opens the console into the
    // board, not into whichever control happened to be built first.
    expect(document.getElementById('fac-map').closest('[data-pane-body]').hidden).toBe(false);
    expect(document.getElementById('battle-panel').closest('[data-pane-body]').hidden).toBe(true);

    document.getElementById('tab-fac-crowns').click();

    expect(document.getElementById('fac-map').closest('[data-pane-body]').hidden).toBe(true);
    expect(document.getElementById('consent-panel').closest('[data-pane-body]').hidden).toBe(false);
    expect(document.getElementById('tab-fac-crowns').getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('tab-fac-battle').getAttribute('aria-selected')).toBe('false');
  });

  it('keeps the game code and roster off screen until their own tab is picked', async () => {
    // The join code, PIN, save button and roster used to sit below every
    // pane as a permanent footer. They are their own tab now, same as
    // battle or crowns — hidden until picked, not a fixture at the bottom.
    await loadPage('host.html');
    const { startHostApp } = await import('../../gui/host/host-app.js');
    await startHostApp({ location: { hash: '', href: 'http://x/host.html' } });

    expect(document.getElementById('join-code').closest('[data-pane-body]').hidden).toBe(true);
    document.querySelector('[data-pane="game"]').click();
    expect(document.getElementById('join-code').closest('[data-pane-body]').hidden).toBe(false);
  });

  it('shows the same character grid every player sees, until the game begins', async () => {
    // The one test here that needs render() to actually run past session.start()
    // rather than stop at the markup — that needs a Peer that does not throw
    // the moment the host tries to claim an address.
    const { Peer, createBroker } = await import('../fakes/peerjs-shim.js');
    createBroker();
    globalThis.Peer = Peer;

    await loadPage('host.html');
    const { startHostApp } = await import('../../gui/host/host-app.js');
    await startHostApp({ location: { hash: '', href: 'http://x/host.html' } });
    document.getElementById('new-game').click();

    expect(document.getElementById('lobby-roles').hidden).toBe(false);
    expect(document.getElementById('tab-fac-game').dataset.live).toBe('true');
    const roles = document.querySelectorAll('#role-grid .rb-role');
    expect(roles.length).toBe(16);
    expect([...roles].every((r) => r.textContent.includes('open'))).toBe(true);

    document.getElementById('advance-phase').click();   // lobby -> team

    expect(document.getElementById('lobby-roles').hidden).toBe(true);
    expect(document.getElementById('tab-fac-game').dataset.live).toBe('false');
  });

  it('deletes a saved game from the resume list, once asked', async () => {
    // localStorage is per-origin and the only copy of a game that survives
    // this machine is a downloaded file, so the list fills up with abandoned
    // tests and there was no way to be rid of one but wiping storage by hand.
    const { Persistence } = await import('../../gui/host/persistence.js');
    const store = new Persistence({});
    store.write({ joinCode: 'AAAAAAA', seed: 1, log: [], savedAt: 1 });
    store.write({ joinCode: 'BBBBBBB', seed: 2, log: [], savedAt: 2 });

    await loadPage('host.html');
    const { startHostApp } = await import('../../gui/host/host-app.js');
    await startHostApp({ location: { hash: '', href: 'http://x/host.html' } });
    expect(document.querySelectorAll('#resume-list li').length).toBe(2);

    const original = globalThis.confirm;
    globalThis.confirm = () => false;
    document.querySelector('[data-forget="AAAAAAA"]').click();
    expect(document.querySelectorAll('#resume-list li').length).toBe(2);   // declined

    globalThis.confirm = () => true;
    document.querySelector('[data-forget="AAAAAAA"]').click();
    globalThis.confirm = original;

    // Gone from the list and from storage, and the other one is untouched.
    expect(document.querySelector('[data-forget="AAAAAAA"]')).toBeNull();
    expect(document.querySelector('[data-forget="BBBBBBB"]')).toBeTruthy();
    expect(store.list().map((s) => s.joinCode)).toEqual(['BBBBBBB']);
  });

  it('hides the resume panel once the last saved game is deleted', async () => {
    const { Persistence } = await import('../../gui/host/persistence.js');
    new Persistence({}).write({ joinCode: 'ZZZZZZZ', seed: 1, log: [], savedAt: 1 });

    await loadPage('host.html');
    const { startHostApp } = await import('../../gui/host/host-app.js');
    await startHostApp({ location: { hash: '', href: 'http://x/host.html' } });
    expect(document.getElementById('resume').hidden).toBe(false);

    const original = globalThis.confirm;
    globalThis.confirm = () => true;
    document.querySelector('[data-forget="ZZZZZZZ"]').click();
    globalThis.confirm = original;

    expect(document.getElementById('resume').hidden).toBe(true);
  });

  it('fills the debrief in as the game goes, marked as provisional', async () => {
    // It is derived from the board every render, so mid-game it is simply the
    // truth so far — and a facilitator who can watch the counters move has
    // something to steer by rather than meeting them for the first time with
    // sixteen people waiting.
    const { Peer, createBroker } = await import('../fakes/peerjs-shim.js');
    createBroker();
    globalThis.Peer = Peer;

    await loadPage('host.html');
    const { startHostApp } = await import('../../gui/host/host-app.js');
    await startHostApp({ location: { hash: '', href: 'http://x/host.html' } });
    document.getElementById('new-game').click();

    // The lobby has no board to report on yet.
    expect(document.getElementById('epilogue-panel').hidden).toBe(true);
    expect(document.getElementById('debrief-waiting').hidden).toBe(false);

    document.getElementById('advance-phase').click();   // lobby -> team

    expect(document.getElementById('epilogue-panel').hidden).toBe(false);
    expect(document.getElementById('debrief-waiting').hidden).toBe(true);
    expect(document.getElementById('epilogue-provisional').hidden).toBe(false);
    expect(document.getElementById('epilogue').textContent.length).toBeGreaterThan(0);
    // The real thing is what gets printed, so those wait for the real thing.
    expect(document.getElementById('print-epilogue').disabled).toBe(true);
    expect(document.getElementById('save-epilogue').disabled).toBe(true);
  });

  it('drops the provisional warning and opens print once time is called', async () => {
    const { Peer, createBroker } = await import('../fakes/peerjs-shim.js');
    createBroker();
    globalThis.Peer = Peer;

    await loadPage('host.html');
    const { startHostApp } = await import('../../gui/host/host-app.js');
    await startHostApp({ location: { hash: '', href: 'http://x/host.html' } });
    document.getElementById('new-game').click();
    document.getElementById('advance-phase').click();   // lobby -> team

    const original = globalThis.confirm;
    globalThis.confirm = () => true;
    document.getElementById('end-game').click();
    globalThis.confirm = original;

    expect(document.getElementById('epilogue-provisional').hidden).toBe(true);
    expect(document.getElementById('print-epilogue').disabled).toBe(false);
    expect(document.getElementById('save-epilogue').disabled).toBe(false);
  });

  it('does not call the primary host a co-facilitator', async () => {
    // A class on .rb-co-banner set its own `display`, which in CSS beats the
    // `hidden` attribute on specificity alone — so the banner announcing
    // "you are the co-facilitator" rendered even for whoever was actually
    // hosting. jsdom does not run the stylesheet, so this checks the
    // property the render loop actually sets rather than a computed style.
    await loadPage('host.html');
    const { startHostApp } = await import('../../gui/host/host-app.js');
    await startHostApp({ location: { hash: '', href: 'http://x/host.html' } });
    document.getElementById('new-game').click();
    expect(document.getElementById('co-banner').hidden).toBe(true);
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

  it('offers the three printed sheets as three buttons, not one board tab', async () => {
    await loadPage('index.html');
    const { startPlayerApp } = await import('../../gui/client/player-app.js');
    await startPlayerApp({ location: { hash: '' } });

    const labels = [...document.querySelectorAll('#map-buttons button')]
      .map((b) => b.textContent.trim());
    expect(labels).toEqual(['Northern', 'Western', 'Eastern']);
    // And the tab they replaced is gone.
    expect(document.querySelector('#game-tabs [data-pane="map"]')).toBeNull();
  });

  it('switches the map to the sheet clicked, and shows the board to do it', async () => {
    await loadPage('index.html');
    const { startPlayerApp } = await import('../../gui/client/player-app.js');
    await startPlayerApp({ location: { hash: '' } });

    // Away on another pane first, so this proves the button brings the board
    // back rather than only moving a map already in view.
    document.querySelector('#game-tabs [data-pane="aftermath"]').click();
    expect(document.getElementById('map').closest('[data-pane-body]').hidden).toBe(true);

    document.querySelector('#map-buttons [data-sheet="eastern"]').click();

    expect(document.getElementById('map').getAttribute('sheet')).toBe('eastern');
    expect(document.getElementById('map').closest('[data-pane-body]').hidden).toBe(false);
    expect(document.querySelector('#map-buttons [data-sheet="eastern"]')
      .getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('#map-buttons [data-sheet="northern"]')
      .getAttribute('aria-selected')).toBe('false');
  });

  it('does not draw the sheet row twice', async () => {
    // The map renders its own row for the facilitator, who has no tab bar to
    // put it in. The player's console provides one, so the map's is off.
    await loadPage('index.html');
    const { startPlayerApp } = await import('../../gui/client/player-app.js');
    await startPlayerApp({ location: { hash: '' } });
    expect(document.getElementById('map').getAttribute('tabs')).toBe('off');
  });

  it('starts on the code screen when there is no code in the link', async () => {
    await loadPage('index.html');
    const { startPlayerApp } = await import('../../gui/client/player-app.js');
    await startPlayerApp({ location: { hash: '' } });
    expect(document.getElementById('screen-code').hidden).toBe(false);
    expect(document.getElementById('screen-game').hidden).toBe(true);
  });
});
