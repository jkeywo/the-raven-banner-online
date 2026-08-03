/**
 * gui/client/player-app.js — the player's whole console.
 *
 * Four screens: the code, your name, the lobby, and then the game. The game is
 * three panes — the board, your own sheet, and how England is doing.
 *
 * Nothing here decides anything. It sends what the player asked for and
 * renders whatever the host sends back, including the reason a request was
 * refused. No local truth, no prediction, no patching of a projection: the
 * next one that arrives is simply what is true now, which is what makes a
 * reconnect free.
 */

import { ConnectionManager } from '../net/connection-manager.js';
import { peerIdForCode, codeFromLocation, normaliseJoinCode, isValidJoinCode } from '../net/join-code.js';
import { installSessionToken } from '../net/session-token.js';
import { identify } from '../net/wire.js';
import { sendCommand } from '../net/command-gateway.js';
import { ClientState } from './client-state.js';
import { loadData } from './load-data.js';
import { renderChooser, valuesFrom, payloadFrom } from './action-chooser.js';
import '../components/rb-connection-dot.js';
import '../components/rb-seat-roster.js';
import '../components/rb-map.js';
import '../components/rb-private-sheet.js';
import '../components/rb-aftermath.js';
import '../components/rb-phase-clock.js';
import '../components/rb-action-list.js';
import '../components/rb-clash-panel.js';
import '../components/rb-envoy-channel.js';

const $ = (id) => document.getElementById(id);

export async function startPlayerApp({ location = window.location } = {}) {
  const client = new ClientState();
  const manager = new ConnectionManager();
  window.connectionManager = manager;      // what command-gateway resolves to

  const data = await loadData({ geometry: true });
  let joinCode = codeFromLocation(location);
  let name = '';

  const screens = {
    code: $('screen-code'),
    name: $('screen-name'),
    lobby: $('screen-lobby'),
    game: $('screen-game'),
  };
  const show = (which) => {
    for (const [key, element] of Object.entries(screens)) element.hidden = key !== which;
  };

  // --- the code -------------------------------------------------------------
  $('code-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const typed = normaliseJoinCode($('join-code').value);
    if (!isValidJoinCode(typed)) {
      // Deliberately not guessed at: see join-code.js. A misheard letter that
      // was silently corrected could be a different, valid game.
      $('code-error').textContent = 'That code is not right. Ask your facilitator to read it again.';
      $('join-code').focus();
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

  // --- the game -------------------------------------------------------------
  $('game-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-pane]');
    if (button) selectPane(button.dataset.pane);
  });

  function selectPane(pane) {
    for (const button of $('game-tabs').children) {
      button.setAttribute('aria-selected', String(button.dataset.pane === pane));
    }
    for (const section of document.querySelectorAll('[data-pane-body]')) {
      section.hidden = section.dataset.paneBody !== pane;
    }
  }

  document.addEventListener('rb-shire', (event) => showShire(event.detail.shireId));
  document.addEventListener('rb-command', (event) => dispatch(event.detail.verb, event.detail.payload));

  function showShire(shireId) {
    const printed = data.shires.shires[shireId];
    const live = client.view?.shires?.[shireId];
    const derived = client.view?.derived?.shires?.[shireId];
    if (!printed || !live) return;

    const steward = live.stewardRoleId
      ? data.roles.roles[live.stewardRoleId]?.name ?? live.stewardRoleId
      : 'nobody';
    const standing = Object.values(live.settlements ?? {}).filter((s) => !s.destroyed);
    const tally = ['farm', 'town', 'church'].map((kind) => {
      const of = standing.filter((s) => s.type === kind);
      const defended = of.filter((s) => s.defended).length;
      return of.length ? `${of.length} ${kind}${of.length === 1 ? '' : 's'}`
        + (defended ? ` (${defended} defended)` : '') : null;
    }).filter(Boolean);

    $('shire-detail').innerHTML = `
      <h3>${printed.name}</h3>
      <p class="rb-meta">${printed.map} England</p>
      <dl class="rb-detail">
        <dt>Steward</dt><dd>${steward}</dd>
        <dt>Support box</dt><dd>${printed.support.join(', ')}
          ${derived?.supported === false ? '<span class="rb-warn">unsupported</span>' : ''}</dd>
        <dt>Castles</dt><dd>${live.castles}</dd>
        <dt>By sea</dt><dd>${derived?.shipCost === null || derived?.shipCost === undefined
    ? 'landlocked' : `${derived.shipCost} ships`}</dd>
        <dt>Settlements</dt><dd>${tally.join(', ') || 'none left'}</dd>
        ${live.missionaryCross ? '<dt>Missionaries</dt><dd>a cross stands here</dd>' : ''}
      </dl>`;
  }

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

    const seats = Object.values(view.seats ?? {});
    $('roster').roles = view.roles ?? {};
    $('roster').seats = seats;

    const mine = client.roleId;
    if (!mine) {
      show('lobby');
      $('lobby-message').textContent = 'Choose a character.';
      renderRolePicker(view);
      if (client.lastRefusal) $('claim-error').textContent = client.lastRefusal.reason;
      return;
    }

    // Seated: the board, the sheet and the tracker take over.
    if (screens.game.hidden) {
      show('game');
      selectPane('map');
    }
    $('game-role').textContent = data.roles.roles[mine]?.name ?? mine;
    $('clock').phase = view.phase;
    $('actions').data = data;
    $('actions').view = view;
    $('action-error').textContent = client.lastRefusal?.reason ?? '';

    $('clash').data = data;
    $('clash').view = view;
    $('envoys').data = data;
    $('envoys').view = view;
    // The battle tab announces itself, because a phase you can miss is a
    // phase you will miss.
    $('tab-battle').dataset.live = String(view.phase.name === 'battle');

    $('map').data = data;
    $('map').view = view;
    $('sheet').data = data;
    $('sheet').view = view;
    $('aftermath').view = view;
    $('game-roster').roles = view.roles ?? {};
    $('game-roster').seats = seats;
  }

  function renderRolePicker(view) {
    const taken = new Set(Object.values(view.seats ?? {})
      .filter((s) => s.connected && s.roleId).map((s) => s.roleId));

    $('role-picker').hidden = false;
    $('role-picker').innerHTML = Object.values(view.roles ?? {}).map((role) => {
      const printed = data.roles.roles[role.id] ?? {};
      const held = taken.has(role.id);
      return `<button type="button" class="rb-role" data-role="${role.id}" ${held ? 'disabled' : ''}>
          <span class="rb-role-name">${printed.name ?? role.id}</span>
          <span class="rb-role-team">${title(printed.team)} · ${title(printed.archetype)}</span>
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

  // An action is a request like any other: sent, and then whatever the host
  // says is what happened. Some need a question answered first.
  document.addEventListener('click', (event) => {
    const button = event.target.closest('#actions [data-verb]');
    if (!button) return;
    const verb = button.dataset.verb;
    const chooser = renderChooser(verb, client.view, data);
    if (chooser) { openChooser(chooser); return; }
    dispatch(verb, {});
  });

  function openChooser(form) {
    const panel = $('chooser');
    panel.replaceChildren(form);
    panel.hidden = false;
    form.querySelector('select, input')?.focus();
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      dispatch(form.dataset.verb, payloadFrom(form.dataset.verb, valuesFrom(form)));
      closeChooser();
    });
    form.querySelector('[data-cancel]').addEventListener('click', closeChooser);
  }

  function closeChooser() {
    $('chooser').hidden = true;
    $('chooser').replaceChildren();
  }

  function dispatch(verb, payload) {
    $('action-error').textContent = '';
    const { envelope, sent } = sendCommand(verb, payload);
    if (sent) client.awaiting(envelope.data.seq, verb);
    else $('action-error').textContent = 'Not connected — try again in a moment.';
  }

  // A link with the code already in it skips the first screen.
  if (joinCode) {
    $('lobby-code').textContent = joinCode;
    show('name');
  } else {
    show('code');
  }

  return { client, manager, data };
}

const title = (text) => String(text ?? '').replace(/_/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());
