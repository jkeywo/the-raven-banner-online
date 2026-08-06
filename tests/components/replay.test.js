// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply } from '../../gui/rules/reducer.js';
import { toSave } from '../../gui/rules/command-log.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const data = await loadData();

const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };
const ALFRED = { seatId: 's1', kind: 'player', roleId: null };

/** The first settlement on the first shire, whichever the dataset says that is. */
const BURNED = (() => {
  const [shireId, shire] = Object.entries(data.shires.shires)
    .find(([, s]) => s.settlements.length > 0);
  return { shireId, settlementId: shire.settlements[0].id };
})();

/**
 * A short game with one of everything the screen has to tell apart: a player's
 * own action, three facilitator overrides, and a settlement struck out so an
 * Aftermath counter actually moves while the cursor does.
 */
function fixtureSave() {
  let state = createInitialState({ joinCode: 'RPLAY01', seed: 7, data });
  state.seats.s9 = { id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
  state.seats.s1 = { id: 's1', token: 't1', name: 'A', roleId: null, kind: 'player', connected: true, lastSeen: 0 };

  const step = (verb, payload, actor = FACILITATOR) => {
    const result = apply(state, data, { verb, payload }, actor, { ts: 0 });
    if (!result.ok) throw new Error(`${verb} refused: ${result.reason}`);
    state = result.state;
  };

  step('claim-role', { roleId: 'king_alfred' }, ALFRED);
  step('facilitator:advance-phase', {});
  step('facilitator:set-settlement', { shireId: BURNED.shireId, settlementId: BURNED.settlementId, field: 'destroyed', value: true });
  step('facilitator:set-steward', { shireId: 'wiltshire', roleId: 'guthrum_the_old' });

  const save = toSave(state);
  save.savedAt = 1;
  return save;
}

const SAVE = fixtureSave();

/** The change handler reads the file asynchronously; let it. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/** The real markup, so a renamed id fails here rather than in front of people. */
async function loadPage(name) {
  const html = await readFile(join(ROOT, name), 'utf8');
  document.documentElement.innerHTML = html
    .replace(/<!doctype html>/i, '')
    .replace(/<\/?html[^>]*>/gi, '');
}

/** Serve data/ and assets/ off the filesystem, since jsdom has no server. */
function stubFetch() {
  globalThis.fetch = vi.fn(async (url) => {
    const path = join(ROOT, String(url).replace(/^\/+/, ''));
    return { ok: true, json: async () => JSON.parse(await readFile(path, 'utf8')) };
  });
}

/** The page, opened on the fixture save the way a click opens it. */
async function opened() {
  const { Persistence } = await import('../../gui/host/persistence.js');
  new Persistence({}).write(SAVE);
  await loadPage('replay.html');
  const { startReplayApp } = await import('../../gui/client/replay-app.js');
  await startReplayApp();
  document.querySelector(`[data-code="${SAVE.joinCode}"]`).click();
}

/** The four counters, by their printed names. */
function counters() {
  return Object.fromEntries([...document.querySelectorAll('#aftermath .rb-counter')]
    .map((li) => [li.querySelector('.rb-counter-label').textContent,
      li.querySelector('.rb-counter-value').textContent]));
}

const historyLabels = () => [...document.querySelectorAll('#history .rb-replay-label')]
  .map((span) => span.textContent.trim());

beforeEach(() => {
  document.documentElement.innerHTML = '';
  stubFetch();
  globalThis.localStorage?.clear?.();
});

describe('the replay screen', () => {
  it('comes up on the opening screen without throwing', async () => {
    await loadPage('replay.html');
    const { startReplayApp } = await import('../../gui/client/replay-app.js');
    await expect(startReplayApp()).resolves.not.toThrow();
    expect(document.getElementById('screen-open').hidden).toBe(false);
    expect(document.getElementById('screen-replay').hidden).toBe(true);
  });

  it('finds every control it wires', async () => {
    await loadPage('replay.html');
    const { startReplayApp } = await import('../../gui/client/replay-app.js');
    await startReplayApp();

    for (const id of ['screen-open', 'screen-replay', 'resume', 'resume-list', 'import-file',
      'open-error', 'open-another', 'replay-code', 'replay-position', 'replay-warning',
      'to-start', 'skip-back', 'step-back', 'scrub', 'step-forward', 'skip-forward',
      'to-end', 'england', 'history', 'aftermath']) {
      expect(document.getElementById(id), id).toBeTruthy();
    }
  });

  it('offers the saved games on this machine, and opens one', async () => {
    await opened();
    expect(document.getElementById('screen-replay').hidden).toBe(false);
    expect(document.getElementById('replay-code').textContent).toBe(SAVE.joinCode);
    expect(document.getElementById('scrub').max).toBe(String(SAVE.log.length));
    // A screen for looking at a finished game is not a screen for deleting it.
    expect(document.querySelector('[data-forget]')).toBeNull();
  });

  it('opens on the board before anything happened', async () => {
    await opened();
    expect(document.getElementById('scrub').value).toBe('0');
    expect(document.getElementById('to-start').disabled).toBe(true);
    expect(document.getElementById('step-back').disabled).toBe(true);
    expect(document.getElementById('to-end').disabled).toBe(false);
  });

  it('shows the whole of England at once, on the shared renderer', async () => {
    await opened();
    const maps = [...document.querySelectorAll('#england rb-map')];
    expect(maps.map((m) => m.getAttribute('sheet')))
      .toEqual(data.shires.sheets.map((s) => s.id));
    // Each draws the same vector sheet the consoles do, with its own sheet row
    // off — three maps side by side have nothing left to pick between.
    for (const map of maps) {
      expect(map.getAttribute('tabs')).toBe('off');
      expect(map.querySelector('.rb-map-sheet')).toBeTruthy();
    }
  });

  it('keeps the map in lockstep with the state at the cursor', async () => {
    await opened();
    const wiltshire = () => document.querySelector('#england [data-shire="wiltshire"]');

    // Turn zero is a quiet board: nothing has moved off the printed sheet.
    expect(wiltshire().dataset.moved).toBe('false');

    document.getElementById('to-end').click();

    // The last action handed Wiltshire to a Dane, so now it has.
    expect(wiltshire().dataset.moved).toBe('true');

    document.getElementById('to-start').click();
    expect(wiltshire().dataset.moved).toBe('false');
  });

  it('moves the Aftermath counters as the cursor moves', async () => {
    await opened();
    const before = counters();

    document.getElementById('to-end').click();
    const after = counters();

    // A settlement was struck out along the way, so fewer are standing.
    expect(Number(after.Prosperity)).toBe(Number(before.Prosperity) - 1);
    expect(Number(after.Danelaw)).toBeGreaterThan(Number(before.Danelaw));
  });

  it('writes the history out under the command labels, not the verbs', async () => {
    await opened();
    const { labelFor } = await import('../../gui/rules/commands.js');
    expect(historyLabels()).toEqual(SAVE.log.map((entry) => labelFor(entry.verb)));
    expect(historyLabels()[0]).toBe('Take a character');
    expect(historyLabels()[0]).not.toContain('claim-role');
  });

  it('marks a facilitator’s hand apart from a player’s', async () => {
    await opened();
    const items = [...document.querySelectorAll('#history li')];
    expect(items.map((li) => li.dataset.override))
      .toEqual(SAVE.log.map((entry) => String(entry.override === true)));
    // The first entry is a player's and the rest are overrides, so the badge
    // count is the honest check that it is written where it belongs.
    expect(document.querySelectorAll('#history .rb-replay-override').length)
      .toBe(SAVE.log.filter((e) => e.override).length);
    expect(items[0].querySelector('.rb-replay-override')).toBeNull();
  });

  it('steps, skips and jumps, and says where it is', async () => {
    await opened();
    const scrub = document.getElementById('scrub');

    document.getElementById('step-forward').click();
    expect(scrub.value).toBe('1');
    expect(document.getElementById('replay-position').textContent)
      .toContain(`1 of ${SAVE.log.length}`);

    document.getElementById('skip-forward').click();       // ten, clamped to the end
    expect(scrub.value).toBe(String(SAVE.log.length));
    expect(document.getElementById('step-forward').disabled).toBe(true);

    document.getElementById('step-back').click();
    expect(scrub.value).toBe(String(SAVE.log.length - 1));

    document.getElementById('to-start').click();
    expect(scrub.value).toBe('0');
  });

  it('jumps to the action clicked in the history', async () => {
    await opened();
    document.querySelector('#history li:nth-child(3) button').click();
    expect(document.getElementById('scrub').value).toBe('3');
    // Everything up to and including the clicked action has happened; the
    // rest has not, and the clicked one is where the reader is standing.
    const items = [...document.querySelectorAll('#history li')];
    expect(items.map((li) => li.dataset.applied))
      .toEqual(['true', 'true', 'true', ...items.slice(3).map(() => 'false')]);
    expect(items[2].getAttribute('aria-current')).toBe('step');
    expect(items[3].hasAttribute('aria-current')).toBe(false);
  });

  it('scrubs to the same board whether it walked there or jumped', async () => {
    // The checkpointed cursor is unit-tested next door; this is that the page
    // is actually driving it and not re-reading a stale render.
    await opened();
    document.getElementById('to-end').click();
    const jumped = document.getElementById('england').innerHTML;

    document.getElementById('to-start').click();
    for (let i = 0; i < SAVE.log.length; i += 1) document.getElementById('step-forward').click();

    expect(document.getElementById('england').innerHTML).toBe(jumped);
  });

  it('says so when a recorded action no longer replays', async () => {
    const { Persistence } = await import('../../gui/host/persistence.js');
    new Persistence({}).write({
      ...SAVE,
      joinCode: 'BROKEN1',
      log: [{
        seq: 1, ts: 0, seatId: 's1', roleId: 'king_alfred',
        verb: 'recruit-soldiers', payload: {}, rngCursorBefore: 0, override: false,
      }],
    });
    await loadPage('replay.html');
    const { startReplayApp } = await import('../../gui/client/replay-app.js');
    await startReplayApp();
    document.querySelector('[data-code="BROKEN1"]').click();

    expect(document.getElementById('replay-warning').hidden).toBe(false);
    expect(document.getElementById('replay-warning').textContent).toContain('recruit-soldiers');
    expect(document.querySelector('#history li').dataset.refused).toBe('true');
  });

  it('reads a downloaded save as well as a stored one', async () => {
    await loadPage('replay.html');
    const { startReplayApp } = await import('../../gui/client/replay-app.js');
    await startReplayApp();

    // No FileList to fake: the change handler reads `files[0].text()`, so a
    // stand-in with that one method is the whole of what it touches.
    const input = document.getElementById('import-file');
    Object.defineProperty(input, 'files', {
      value: [{ text: async () => JSON.stringify(SAVE) }], configurable: true,
    });
    input.dispatchEvent(new Event('change'));
    await settle();

    expect(document.getElementById('screen-replay').hidden).toBe(false);
    expect(document.getElementById('replay-code').textContent).toBe(SAVE.joinCode);
  });

  it('refuses a file that is not a save, and says why', async () => {
    await loadPage('replay.html');
    const { startReplayApp } = await import('../../gui/client/replay-app.js');
    await startReplayApp();

    const input = document.getElementById('import-file');
    Object.defineProperty(input, 'files', {
      value: [{ text: async () => 'not json' }], configurable: true,
    });
    input.dispatchEvent(new Event('change'));
    await settle();

    expect(document.getElementById('open-error').textContent).toContain('not readable');
    expect(document.getElementById('screen-replay').hidden).toBe(true);
  });
});

describe('the replay’s role panels', () => {
  const GUTHRUM = 'guthrum_the_old';
  const nameOf = (roleId) => data.roles.roles[roleId].name;
  const wiltshire = data.shires.shires.wiltshire.name;

  const railed = () => [...document.querySelectorAll('#role-rail [data-role]')];
  const openSheets = () => [...document.querySelectorAll('rb-private-sheet')];

  it('lists every role in play', async () => {
    await opened();
    // The roster the game was dealt, in the order the save records it — not
    // every role that was ever printed, which is a different list at any head
    // count but sixteen.
    expect(railed().map((button) => button.dataset.role)).toEqual(SAVE.roleIds);
    expect(railed()[0].textContent).toContain(nameOf(SAVE.roleIds[0]));
  });

  it('mounts nothing until somebody is clicked', async () => {
    await opened();
    expect(openSheets()).toHaveLength(0);
    expect(document.getElementById('role-panel').hidden).toBe(true);
    expect(railed().every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true);
  });

  it('renders the clicked role’s own private sheet', async () => {
    await opened();
    document.querySelector(`[data-role="${GUTHRUM}"]`).click();

    const sheet = document.querySelector('#role-panel rb-private-sheet');
    expect(sheet).toBeTruthy();
    expect(document.getElementById('role-panel').hidden).toBe(false);
    expect(sheet.textContent).toContain(nameOf(GUTHRUM));
    expect(document.querySelector(`[data-role="${GUTHRUM}"]`).getAttribute('aria-pressed'))
      .toBe('true');
  });

  it('keeps exactly one sheet on screen', async () => {
    // Two sheets at once would be two people's private business side by side,
    // which is the one thing a sheet called private should never be.
    await opened();
    document.querySelector(`[data-role="${GUTHRUM}"]`).click();
    document.querySelector('[data-role="king_alfred"]').click();

    expect(openSheets()).toHaveLength(1);
    expect(openSheets()[0].textContent).toContain(nameOf('king_alfred'));
    expect(openSheets()[0].textContent).not.toContain(nameOf(GUTHRUM));
    expect(railed().filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
  });

  it('puts the open one away when it is clicked again', async () => {
    await opened();
    document.querySelector(`[data-role="${GUTHRUM}"]`).click();
    document.querySelector(`[data-role="${GUTHRUM}"]`).click();

    expect(openSheets()).toHaveLength(0);
    expect(document.getElementById('role-panel').hidden).toBe(true);
  });

  it('redraws the open sheet for the state at the cursor', async () => {
    // The last recorded action hands Wiltshire to Guthrum, so his own sheet
    // says he stewards it on one side of that action and not on the other.
    await opened();
    document.querySelector(`[data-role="${GUTHRUM}"]`).click();
    expect(document.querySelector('#role-panel').textContent).not.toContain(wiltshire);

    document.getElementById('to-end').click();
    expect(document.querySelector('#role-panel').textContent).toContain(wiltshire);

    document.getElementById('to-start').click();
    expect(document.querySelector('#role-panel').textContent).not.toContain(wiltshire);
    // Still exactly one, after all that scrubbing.
    expect(openSheets()).toHaveLength(1);
  });

  it('draws it through that player’s own projection, not the umpire’s', async () => {
    // The whole reason for reusing rb-private-sheet is that the panel shows
    // what that player saw. A brief is the plainest proof: it is theirs, the
    // projector attaches it per viewer, and nobody else's is in the view.
    await opened();
    document.querySelector(`[data-role="${GUTHRUM}"]`).click();

    const sheet = document.querySelector('#role-panel rb-private-sheet');
    expect(sheet.textContent).toContain(data.briefs.briefs[GUTHRUM].goals[0]);
    expect(sheet.textContent).not.toContain(data.briefs.briefs.king_alfred.goals[0]);
  });
});
