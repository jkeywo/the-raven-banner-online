/**
 * gui/client/player-app.js — the player's side of the lobby.
 *
 * Three screens, in order: what is the code, what is your name, which
 * character. Then the game, which is M5 onward.
 *
 * Nothing here decides anything. It sends what the player asked for and
 * renders whatever the host sends back, including the reason a request was
 * refused. That is the whole client contract: no local truth, no prediction,
 * no patching of a projection.
 */

import { ConnectionManager } from '../net/connection-manager.js';
import { peerIdForCode, codeFromLocation, normaliseJoinCode, isValidJoinCode } from '../net/join-code.js';
import { installSessionToken } from '../net/session-token.js';
import { identify } from '../net/wire.js';
import { sendCommand } from '../net/command-gateway.js';
import { ClientState } from './client-state.js';
import '../components/rb-connection-dot.js';
import '../components/rb-seat-roster.js';

const $ = (id) => document.getElementById(id);

export function startPlayerApp({ location = window.location } = {}) {
  const client = new ClientState();
  const manager = new ConnectionManager();
  window.connectionManager = manager;      // what command-gateway resolves to

  let joinCode = codeFromLocation(location);
  let name = '';

  const screens = {
    code: $('screen-code'),
    name: $('screen-name'),
    lobby: $('screen-lobby'),
  };
  const show = (which) => {
    for (const [key, element] of Object.entries(screens)) element.hidden = key !== which;
  };

  // --- the code -------------------------------------------------------------
  const codeInput = $('join-code');
  const codeError = $('code-error');

  $('code-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const typed = normaliseJoinCode(codeInput.value);
    if (!isValidJoinCode(typed)) {
      // Deliberately not guessed at: see join-code.js. A misheard letter that
      // was silently corrected could be a different, valid game.
      codeError.textContent = 'That code is not right. Ask your facilitator to read it again.';
      codeInput.focus();
      return;
    }
    joinCode = typed;
    location.hash = `#${typed}`;
    show('name');
    $('player-name').focus();
  });

  // --- the name -------------------------------------------------------------
  $('name-form').addEventListener('submit', (event) => {
    event.preventDefault();
    name = $('player-name').value.trim() || 'Someone';
    connect();
    show('lobby');
  });

  // --- the game -------------------------------------------------------------
  function connect() {
    const token = installSessionToken(joinCode);
    $('lobby-code').textContent = joinCode;
    manager.connect(peerIdForCode(joinCode), {
      onData: (message) => client.receive(message),
      onStatus: (status) => client.setStatus(status),
      getIdent: () => identify({ token, name }),
    });
  }

  document.addEventListener('rb-retry', () => manager.retryNow());

  client.subscribe(render);

  function render() {
    $('connection').setAttribute('status', client.status);

    if (client.rejection) {
      $('lobby-message').textContent = client.rejection;
      $('role-picker').hidden = true;
      return;
    }

    const view = client.view;
    if (!view) {
      $('lobby-message').textContent = 'Waiting for the facilitator…';
      return;
    }

    $('roster').roles = view.roles ?? {};
    $('roster').seats = Object.values(view.seats ?? {});

    const mine = client.roleId;
    $('lobby-message').textContent = mine
      ? 'You are seated. The facilitator will start the game.'
      : 'Choose a character.';
    renderRolePicker(view, mine);

    if (client.lastRefusal) $('claim-error').textContent = client.lastRefusal.reason;
  }

  function renderRolePicker(view, mine) {
    const picker = $('role-picker');
    picker.hidden = Boolean(mine);
    if (mine) return;

    const taken = new Set(Object.values(view.seats ?? {})
      .filter((s) => s.connected && s.roleId).map((s) => s.roleId));

    picker.innerHTML = Object.values(view.roles ?? {})
      .map((role) => {
        const held = taken.has(role.id);
        return `<button type="button" class="rb-role" data-role="${role.id}" ${held ? 'disabled' : ''}>
            <span class="rb-role-name">${role.id.replace(/_/g, ' ')}</span>
            <span class="rb-role-team">${(role.teamId ?? '').replace(/_/g, ' ')}</span>
            ${held ? '<span class="rb-role-taken">taken</span>' : ''}
          </button>`;
      }).join('');
  }

  $('role-picker').addEventListener('click', (event) => {
    const button = event.target.closest('[data-role]');
    if (!button) return;
    $('claim-error').textContent = '';
    const { envelope, sent } = sendCommand('claim-role', { roleId: button.dataset.role });
    if (sent) client.awaiting(envelope.data.seq, 'claim-role');
    else $('claim-error').textContent = 'Not connected yet — try again in a moment.';
  });

  // A link with the code already in it skips the first screen.
  if (joinCode) {
    $('lobby-code').textContent = joinCode;
    show('name');
  } else {
    show('code');
  }

  return { client, manager };
}
