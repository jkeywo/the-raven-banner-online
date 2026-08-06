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

describe('coming back to a seat you already had', () => {
  it('skips both join screens when the code and the name are already known', async () => {
    // The session token survives a reload and the host matches it back to the
    // seat that held it — so the two screens in front of the game exist to
    // collect exactly what this player has already given.
    window.localStorage.setItem('rbo:name', 'Alice');
    await loadPage();
    const { startPlayerApp } = await import('../../gui/client/player-app.js');
    await startPlayerApp({ location: { hash: '#RAVEN7Z' } });

    expect(document.getElementById('screen-code').hidden).toBe(true);
    expect(document.getElementById('screen-name').hidden).toBe(true);
    expect(document.getElementById('screen-lobby').hidden).toBe(false);
    expect(document.getElementById('lobby-message').textContent).toContain('as Alice');
  });

  it('still asks for a name when it has no idea who you are', async () => {
    await loadPage();
    const { startPlayerApp } = await import('../../gui/client/player-app.js');
    await startPlayerApp({ location: { hash: '#RAVEN7Z' } });

    expect(document.getElementById('screen-name').hidden).toBe(false);
    expect(document.getElementById('screen-lobby').hidden).toBe(true);
  });

  it('offers a way out of a game that is not answering, and only then', async () => {
    // A player who was put here rather than choosing it needs one; a player
    // who typed their way in does not.
    window.localStorage.setItem('rbo:name', 'Alice');
    await loadPage();
    const { startPlayerApp } = await import('../../gui/client/player-app.js');
    await startPlayerApp({ location: { hash: '#RAVEN7Z' } });
    expect(document.getElementById('start-over').hidden).toBe(false);

    document.getElementById('start-over').click();

    // Back at the front door, and the name is forgotten so the next load asks
    // properly rather than marching them into the same silent game again.
    expect(document.getElementById('screen-code').hidden).toBe(false);
    expect(document.getElementById('screen-lobby').hidden).toBe(true);
    expect(window.localStorage.getItem('rbo:name')).toBeNull();
  });
});

describe('several seats on one machine, for testing', () => {
  it('names itself and joins straight away, without touching the saved name', () => {
    // Tabs of one origin share storage, so four ordinary tabs are one seat
    // opened four times. `?seat=N` gives each its own token.
    window.localStorage.setItem('rbo:name', 'Alice');
    return (async () => {
      await loadPage();
      const { startPlayerApp } = await import('../../gui/client/player-app.js');
      await startPlayerApp({ location: { hash: '#RAVEN7Z', search: '?seat=3' } });

      expect(document.getElementById('screen-lobby').hidden).toBe(false);
      expect(document.getElementById('lobby-message').textContent).toContain('Seat 3');
      // The real player's name on this machine is left exactly as it was.
      expect(window.localStorage.getItem('rbo:name')).toBe('Alice');
    })();
  });

  it('gives each seat a token of its own, kept apart from the real ones', async () => {
    const { installSessionToken } = await import('../../gui/net/session-token.js');
    const one = installSessionToken('RAVEN7Z', window, { seat: 1 });
    const two = installSessionToken('RAVEN7Z', window, { seat: 2 });
    expect(one).not.toBe(two);
    // And each is stable, so a test tab reloading keeps its seat.
    expect(installSessionToken('RAVEN7Z', window, { seat: 1 })).toBe(one);
    // Namespaced away, so a test tab can never be mistaken for a real seat.
    expect(window.localStorage.getItem('rbo:tok:shared:RAVEN7Z')).toBeNull();
  });
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
