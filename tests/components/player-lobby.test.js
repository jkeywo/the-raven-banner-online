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
import { VIEW } from '../../gui/net/wire.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const data = await loadData();

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

/** A view of the lobby, seated or not, for the given role. */
function lobbyView(roleId) {
  const state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
  if (roleId) {
    state.seats.s1 = {
      id: 's1', token: 't', name: 'A', roleId, kind: 'player', connected: true, lastSeen: 0,
    };
  }
  return projectView(state, data, roleId
    ? { kind: 'player', seatId: 's1', roleId, teamId: state.roles[roleId].teamId }
    : { kind: 'player', seatId: 's0', roleId: null, teamId: null });
}

beforeEach(() => {
  document.documentElement.innerHTML = '';
  stubFetch();
  delete globalThis.Peer;
  globalThis.localStorage?.clear?.();
});

describe('choosing a character and waiting for the facilitator', () => {
  it('offers the character grid before anybody has picked', async () => {
    await loadPage();
    const { startPlayerApp } = await import('../../gui/client/player-app.js');
    const { client } = await startPlayerApp({ location: { hash: '' } });

    client.receive({ type: VIEW, data: lobbyView(null) });

    expect(document.getElementById('screen-lobby').hidden).toBe(false);
    expect(document.getElementById('screen-game').hidden).toBe(true);
    expect(document.getElementById('role-picker').hidden).toBe(false);
    expect(document.getElementById('lobby-message').textContent).toBe('Choose a character.');
  });

  it('stays on the lobby screen once seated, if the game has not begun', async () => {
    await loadPage();
    const { startPlayerApp } = await import('../../gui/client/player-app.js');
    const { client } = await startPlayerApp({ location: { hash: '' } });

    client.receive({ type: VIEW, data: lobbyView('king_alfred') });

    expect(document.getElementById('screen-lobby').hidden).toBe(false);
    expect(document.getElementById('screen-game').hidden).toBe(true);
    expect(document.getElementById('role-picker').hidden).toBe(true);
    expect(document.getElementById('lobby-message').textContent)
      .toBe('Playing King Alfred. Waiting for the facilitator to start the game.');
  });

  it('moves to the game screen once the facilitator begins it', async () => {
    await loadPage();
    const { startPlayerApp } = await import('../../gui/client/player-app.js');
    const { client } = await startPlayerApp({ location: { hash: '' } });

    client.receive({ type: VIEW, data: lobbyView('king_alfred') });
    expect(document.getElementById('screen-game').hidden).toBe(true);

    const state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
    state.phase.name = 'team';
    state.seats.s1 = {
      id: 's1', token: 't', name: 'A', roleId: 'king_alfred', kind: 'player', connected: true, lastSeen: 0,
    };
    client.receive({
      type: VIEW,
      data: projectView(state, data, {
        kind: 'player', seatId: 's1', roleId: 'king_alfred', teamId: state.roles.king_alfred.teamId,
      }),
    });

    expect(document.getElementById('screen-lobby').hidden).toBe(true);
    expect(document.getElementById('screen-game').hidden).toBe(false);
    expect(document.getElementById('game-role').textContent).toBe('King Alfred');
  });
});
