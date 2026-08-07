// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
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

/**
 * A storage object of this test's own, rather than one shared and wiped.
 *
 * Starting a game queues a debounced autosave, and 250ms later it writes — by
 * which time the test that started it has finished and a later one has put its
 * own saves in storage and is asserting about them. Clearing a shared
 * localStorage cannot help, because the stale timer fires after the clear; a
 * fresh object can, because the write then lands in the storage of the test
 * that asked for it, where nobody is looking any more. The failure this
 * prevents is a resume panel that refuses to hide, in one run out of a few,
 * depending on how long the tests before it happened to take.
 */
function ownStorage() {
  const entries = new Map();
  return {
    get length() { return entries.size; },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => { entries.set(key, String(value)); },
    removeItem: (key) => { entries.delete(key); },
    clear: () => entries.clear(),
  };
}

beforeEach(() => {
  document.documentElement.innerHTML = '';
  stubFetch();
  // No broker and no WebRTC. Nothing here gets as far as starting a game.
  delete globalThis.Peer;
  Object.defineProperty(globalThis, 'localStorage', {
    value: ownStorage(), configurable: true, writable: true,
  });
});

describe('the facilitator console', () => {
  it('comes up without throwing', async () => {
    await loadPage('host.html');
    const { startHostApp } = await import('../../gui/host/host-app.js');
    await expect(startHostApp({ location: { hash: '', href: 'http://x/host.html' } }))
      .resolves.not.toThrow();
  });

  it('beeps three times when a phase runs out, then once every ten seconds', async () => {
    // A facilitator running a room is listening to the table, not watching
    // this screen. The clock has to say it, not only show it.
    await loadPage('host.html');
    const beeps = [];
    const beeper = { beep: (count, hz) => beeps.push(`${count}@${hz}`) };
    const { startHostApp } = await import('../../gui/host/host-app.js');
    await startHostApp({ location: { hash: '', href: 'http://x/host.html' }, beeper });
    document.getElementById('new-game').click();
    document.getElementById('advance-phase').click();     // lobby -> team

    const clock = document.getElementById('clock');
    const { endsAt } = clock._phase;
    expect(endsAt).toBeTruthy();
    const tick = (at) => { clock.now = () => at; clock.phase = clock._phase; };

    tick(endsAt - 1_000);
    expect(beeps).toEqual([]);

    tick(endsAt + 500);
    expect(beeps).toEqual(['3@880']);

    tick(endsAt + 5_000);                                 // still the first ten
    expect(beeps).toEqual(['3@880']);

    tick(endsAt + 11_000);
    tick(endsAt + 22_000);
    expect(beeps).toEqual(['3@880', '1@660', '1@660']);
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
    // And the cell manifest, without which the vector sheets are blank fields
    // the overlay has nowhere to write into.
    expect(fetched).toContain('assets/maps/cells.json');
  });

  it('puts the shire editor inside the map rather than beside it', async () => {
    // The editor is the map's card now. If it is left outside, clicking a
    // shire still fills it in and nobody ever sees it.
    await loadPage('host.html');
    const { startHostApp } = await import('../../gui/host/host-app.js');
    await startHostApp({ location: { hash: '', href: 'http://x/host.html' } });
    expect(document.getElementById('shire-editor').closest('rb-map'))
      .toBe(document.getElementById('fac-map'));
    expect(document.getElementById('shire-editor').closest('.rb-map-card-body')).toBeTruthy();
  });

  it('offers the three printed sheets as three buttons, not one map tab', async () => {
    // The same row the player's console already carries. A single "Map" tab
    // meant picking the board and then picking a sheet inside it, twice, for
    // the one thing a facilitator looks at most.
    await loadPage('host.html');
    const { startHostApp } = await import('../../gui/host/host-app.js');
    await startHostApp({ location: { hash: '', href: 'http://x/host.html' } });

    const labels = [...document.querySelectorAll('#fac-map-buttons button')]
      .map((b) => b.textContent.trim());
    expect(labels).toEqual(['Northern', 'Western', 'Eastern']);
    expect(document.querySelector('#facilitator-tabs [data-pane="map"]')).toBeNull();
    // The map is still the pane the console opens into, so the row starts lit.
    expect(document.getElementById('fac-map-buttons').dataset.active).toBe('true');
    // And the map does not draw a second row of its own underneath.
    expect(document.getElementById('fac-map').getAttribute('tabs')).toBe('off');
  });

  it('switches the facilitator’s map to the sheet clicked, and shows the board', async () => {
    await loadPage('host.html');
    const { startHostApp } = await import('../../gui/host/host-app.js');
    await startHostApp({ location: { hash: '', href: 'http://x/host.html' } });

    // Away on another pane first, so this proves the button brings the board
    // back rather than only moving a map already in view.
    document.getElementById('tab-fac-battle').click();
    expect(document.getElementById('fac-map').closest('[data-pane-body]').hidden).toBe(true);
    expect(document.getElementById('fac-map-buttons').dataset.active).toBe('false');

    document.querySelector('#fac-map-buttons [data-sheet="eastern"]').click();

    expect(document.getElementById('fac-map').getAttribute('sheet')).toBe('eastern');
    expect(document.getElementById('fac-map').closest('[data-pane-body]').hidden).toBe(false);
    expect(document.getElementById('fac-map-buttons').dataset.active).toBe('true');
    expect(document.querySelector('#fac-map-buttons [data-sheet="eastern"]')
      .getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('#fac-map-buttons [data-sheet="northern"]')
      .getAttribute('aria-selected')).toBe('false');
    // The panes' own tabs are untouched by a sheet click — they answer a
    // different question and keep their own selected state.
    expect(document.getElementById('tab-fac-battle').getAttribute('aria-selected')).toBe('false');
  });

  it('lets the facilitator edit settlements on the map, and nobody else', async () => {
    // `editable` is the whole gate. It is granted by the facilitator's page,
    // not inferred by the component from what is parked in its card slot.
    await loadPage('host.html');
    const { startHostApp } = await import('../../gui/host/host-app.js');
    await startHostApp({ location: { hash: '', href: 'http://x/host.html' } });
    expect(document.getElementById('fac-map').editable).toBe(true);

    await loadPage('index.html');
    const { startPlayerApp } = await import('../../gui/client/player-app.js');
    await startPlayerApp({ location: { hash: '' } });
    expect(document.getElementById('map').editable).toBe(false);
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

    // Dealt a team to a row: four teams, four seats each. Every question a
    // facilitator asks this grid is about a team — is Wessex all seated, has
    // anybody from the Summer Army turned up — and one that reflowed to fit
    // the window answered none of them.
    const rows = [...document.querySelectorAll('#role-grid .rb-roles-team')];
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.querySelectorAll('.rb-role').length)).toEqual([4, 4, 4, 4]);
    expect(rows.map((row) => row.dataset.team).sort()).toEqual(
      ['great_heathen_army', 'great_summer_army', 'mercia', 'wessex']);

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
    // Asserted by code rather than by count: a debounced autosave from an
    // earlier test can still land here — the real app wants that write, and
    // nothing cancels it — so a total is not this test's business.
    expect(document.querySelector('[data-forget="AAAAAAA"]')).toBeTruthy();
    expect(document.querySelector('[data-forget="BBBBBBB"]')).toBeTruthy();

    const original = globalThis.confirm;
    globalThis.confirm = () => false;
    document.querySelector('[data-forget="AAAAAAA"]').click();
    expect(document.querySelector('[data-forget="AAAAAAA"]')).toBeTruthy();   // declined

    globalThis.confirm = () => true;
    document.querySelector('[data-forget="AAAAAAA"]').click();
    globalThis.confirm = original;

    // Gone from the list and from storage, and the other one is untouched.
    expect(document.querySelector('[data-forget="AAAAAAA"]')).toBeNull();
    expect(document.querySelector('[data-forget="BBBBBBB"]')).toBeTruthy();
    expect(store.list().map((entry) => entry.joinCode)).toContain('BBBBBBB');
    expect(store.list().map((entry) => entry.joinCode)).not.toContain('AAAAAAA');
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
      'consents', 'ballot', 'chooser', 'actions', 'shire-card']) {
      expect(document.getElementById(id), id).toBeTruthy();
    }
  });

  it('writes the shire read-out into the card on the map', async () => {
    // The side panel beside the map is gone. Everything it said — steward,
    // support, castles, ship cost, settlements — is in the card the map opens
    // on the shire, so this is the one place it can still be read.
    await loadPage('index.html');
    const { startPlayerApp } = await import('../../gui/client/player-app.js');
    await startPlayerApp({ location: { hash: '' } });

    expect(document.getElementById('shire-detail')).toBeNull();
    expect(document.getElementById('shire-card').closest('rb-map'))
      .toBe(document.getElementById('map'));
    expect(document.getElementById('shire-card').closest('.rb-map-card-body')).toBeTruthy();
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
    // The map renders its own row for whoever has no tab bar to put it in —
    // the replay's three sheets, side by side. Both consoles provide one now,
    // so on both of them the map's own row is off.
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

describe('what actually reaches the live site', () => {
  it('copies every page at the repo root into the published site', async () => {
    // gh-pages is assembled from an explicit copy list rather than the whole
    // repository, which is the point of publishing from a branch — but it
    // means a page added here and not there is a 404 on the live site and
    // nowhere else. Nothing else in the suite can see that, because every
    // other test reads the files off disk.
    const workflow = await readFile(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const pages = (await readdir(ROOT)).filter((name) => name.endsWith('.html'));

    expect(pages.sort()).toEqual(['host.html', 'index.html', 'replay.html']);
    for (const page of pages) expect(workflow, page).toContain(page);
  });
});
