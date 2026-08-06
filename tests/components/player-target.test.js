// @vitest-environment jsdom
import {
  describe, it, expect, beforeEach, vi,
} from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { projectView } from '../../gui/rules/views.js';
import { reachableFrom } from '../../gui/rules/derive.js';
import { VIEW } from '../../gui/net/wire.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const data = await loadData();

/**
 * The real player console, driven the way a browser would, but fed a
 * projection directly through the client rather than over a real connection
 * — the same seam ClientState.receive() exists for.
 */
async function loadPage() {
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html
    .replace(/<!doctype html>/i, '')
    .replace(/<\/?html[^>]*>/gi, '');
}

function stubFetch() {
  globalThis.fetch = vi.fn(async (url) => {
    const path = join(ROOT, String(url).replace(/^\/+/, ''));
    return { ok: true, json: async () => JSON.parse(await readFile(path, 'utf8')) };
  });
}

/** A team-phase game with the given role seated, and an optional tweak. */
function stateFor(roleId, tweak = () => {}) {
  const state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
  state.phase.name = 'team';
  state.seats.s1 = {
    id: 's1', token: 't', name: 'A', roleId, kind: 'player', connected: true, lastSeen: 0,
  };
  tweak(state);
  return state;
}

/** A team-phase view for the given role, with an optional state tweak first. */
function viewFor(roleId, tweak = () => {}) {
  const state = stateFor(roleId, tweak);
  return projectView(state, data, {
    kind: 'player', seatId: 's1', roleId, teamId: state.roles[roleId].teamId,
  });
}

beforeEach(() => {
  document.documentElement.innerHTML = '';
  stubFetch();
  delete globalThis.Peer;
  globalThis.localStorage?.clear?.();
});

describe('targeting a shire straight off the map', () => {
  it('offers no Target button for a role holding no initiative token', async () => {
    await loadPage();
    const { startPlayerApp } = await import('../../gui/client/player-app.js');
    const { client } = await startPlayerApp({ location: { hash: '' } });

    client.receive({ type: VIEW, data: viewFor('king_alfred') });
    document.querySelector('#map path.rb-shire')
      .dispatchEvent(new Event('click', { bubbles: true }));

    expect(document.querySelector('[data-target-shire]')).toBeNull();
  });

  it('offers a Target button once the shire clicked belongs to someone holding a token', async () => {
    await loadPage();
    const { startPlayerApp } = await import('../../gui/client/player-app.js');
    const { client } = await startPlayerApp({ location: { hash: '' } });

    // Halfdan holds white at turn one, but it starts fixed to Lindsey — clear
    // that so the declaration is his to make, same as turn two onward.
    client.receive({
      type: VIEW,
      data: viewFor('halfdan_ragnarsson', (state) => { delete state.initiative.declared.white; }),
    });
    const shirePath = document.querySelector('#map path.rb-shire');
    const shireId = shirePath.dataset.shire;
    // The console opens on the northern sheet, and Halfdan's reach is exactly
    // its six shires — so whichever one is drawn first, he can attack it. That
    // is what makes the button appear, and asserting it here means a change to
    // the default sheet or to his starting holdings fails for a legible reason
    // rather than as a mysteriously absent button.
    expect(reachableFrom(stateFor('halfdan_ragnarsson'), data, 'halfdan_ragnarsson'))
      .toContain(shireId);
    shirePath.dispatchEvent(new Event('click', { bubbles: true }));

    const button = document.querySelector('[data-target-shire]');
    expect(button).toBeTruthy();
    expect(button.dataset.targetShire).toBe(shireId);
  });

  it('dispatches declare-initiative-target with the clicked shire on Target', async () => {
    await loadPage();
    const { startPlayerApp } = await import('../../gui/client/player-app.js');
    const { client } = await startPlayerApp({ location: { hash: '' } });

    client.receive({
      type: VIEW,
      data: viewFor('halfdan_ragnarsson', (state) => { delete state.initiative.declared.white; }),
    });
    const shirePath = document.querySelector('#map path.rb-shire');
    const shireId = shirePath.dataset.shire;
    shirePath.dispatchEvent(new Event('click', { bubbles: true }));

    const sent = [];
    window.connectionManager = { send: (message) => { sent.push(message); return true; } };
    document.querySelector('[data-target-shire]').click();

    // startPlayerApp is called once per test here, each adding its own
    // document-level click listener to a jsdom document these tests share —
    // a harness artifact rather than anything the real one-page-load app
    // does, so this checks every message the click raised agrees, rather
    // than assuming there was exactly one.
    expect(sent.length).toBeGreaterThan(0);
    for (const message of sent) {
      expect(message.data.verb).toBe('declare-initiative-target');
      expect(message.data.payload).toEqual({ shireId });
    }
  });

  it('offers no Target button on a shire the token holder cannot reach', async () => {
    await loadPage();
    const { startPlayerApp } = await import('../../gui/client/player-app.js');
    const { client } = await startPlayerApp({ location: { hash: '' } });

    // Guthrum holds black and can reach Essex and Middle Anglia, both on the
    // eastern sheet. The console opens on the northern one, where every shire
    // is beyond him — so the button has to stay away rather than be offered
    // and then refused by the host.
    client.receive({
      type: VIEW,
      data: viewFor('guthrum_the_old', (state) => { delete state.initiative.declared.black; }),
    });
    document.querySelector('#map path.rb-shire')
      .dispatchEvent(new Event('click', { bubbles: true }));

    expect(document.querySelector('[data-target-shire]')).toBeNull();
  });

  it('offers it again on a shire the same holder can reach', async () => {
    await loadPage();
    const { startPlayerApp } = await import('../../gui/client/player-app.js');
    const { client } = await startPlayerApp({ location: { hash: '' } });

    client.receive({
      type: VIEW,
      data: viewFor('guthrum_the_old', (state) => { delete state.initiative.declared.black; }),
    });
    document.querySelector('#map').setAttribute('sheet', 'eastern');
    document.querySelector('#map path[data-shire="essex"]')
      .dispatchEvent(new Event('click', { bubbles: true }));

    expect(document.querySelector('[data-target-shire]')?.dataset.targetShire).toBe('essex');
  });

  it('does not offer declare-initiative-target as a plain action-list item any more', async () => {
    await loadPage();
    const { startPlayerApp } = await import('../../gui/client/player-app.js');
    const { client } = await startPlayerApp({ location: { hash: '' } });

    client.receive({
      type: VIEW,
      data: viewFor('halfdan_ragnarsson', (state) => { delete state.initiative.declared.white; }),
    });

    expect(document.querySelector('#actions [data-verb="declare-initiative-target"]')).toBeNull();
  });
});
