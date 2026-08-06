/**
 * gui/client/player-app.js — the player's whole console.
 *
 * Four screens: the code, your name, the lobby, and then the game. The game
 * itself is three columns that hold no matter which tab is open — what you
 * can do on the left, your own sheet on the right, and the board, a battle
 * or how England is doing in between. Envoys live in the left column too,
 * beneath the actions: sending the first one is an action like any other,
 * gated to the phase it belongs to, and a conversation already open stays
 * reachable whatever phase it is now.
 *
 * Nothing here decides anything. It sends what the player asked for and
 * renders whatever the host sends back, including the reason a request was
 * refused. No local truth, no prediction, no patching of a projection: the
 * next one that arrives is simply what is true now, which is what makes a
 * reconnect free.
 */

import { ConnectionManager } from '../net/connection-manager.js';
import {
  peerIdForCode, codeFromLocation, seatFromLocation, normaliseJoinCode, isValidJoinCode,
} from '../net/join-code.js';
import { installSessionToken } from '../net/session-token.js';
import { loadSavedName, saveName, forgetName } from '../net/name-storage.js';
import { identify } from '../net/wire.js';
import { sendCommand } from '../net/command-gateway.js';
import { ClientState } from './client-state.js';
import { loadData } from './load-data.js';
import { renderChooser, valuesFrom, payloadFrom, shireTargetsFor } from './action-chooser.js';
import { admit } from '../rules/admission.js';
import '../components/rb-connection-dot.js';
import '../components/rb-seat-roster.js';
import '../components/rb-map.js';
import '../components/rb-private-sheet.js';
import '../components/rb-aftermath.js';
import '../components/rb-phase-clock.js';
import '../components/rb-action-list.js';
import '../components/rb-clash-panel.js';
import '../components/rb-envoy-channel.js';
import '../components/rb-consent-panel.js';
import '../components/rb-ballot.js';

const $ = (id) => document.getElementById(id);

export async function startPlayerApp({ location = window.location } = {}) {
  const client = new ClientState();
  const manager = new ConnectionManager();
  window.connectionManager = manager;      // what command-gateway resolves to

  const data = await loadData({ geometry: true });
  let joinCode = codeFromLocation(location);
  let name = '';
  /** Whether this tab let itself in rather than being walked in. */
  let remembering = false;
  // `?seat=N`: a testing affordance, so one person can drive several seats
  // from one machine. It forces a token of its own rather than adopting the
  // shared one, which is what stops four tabs becoming one seat four times.
  const seat = seatFromLocation(location);

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
  // Prefilled from whoever last typed one on this machine, so a returning
  // player is not retyping their name every game.
  $('player-name').value = loadSavedName();
  $('name-form').addEventListener('submit', (event) => {
    event.preventDefault();
    name = $('player-name').value.trim() || 'Someone';
    saveName(name);
    connect();
    show('lobby');
  });

  function connect() {
    const token = installSessionToken(joinCode, window, { seat });
    $('lobby-code').textContent = joinCode;
    manager.connect(peerIdForCode(joinCode), {
      onData: (message) => client.receive(message),
      onStatus: (status) => client.setStatus(status),
      getIdent: () => identify({ token, name }),
    });
  }

  document.addEventListener('rb-retry', () => manager.retryNow());

  // The way out of a remembered seat: back to the code screen, with the
  // remembered name cleared so the next load asks properly rather than
  // marching the player into the same silent game again.
  $('start-over').addEventListener('click', () => {
    remembering = false;
    manager.disconnect?.();
    forgetName();
    location.hash = '';
    joinCode = '';
    $('join-code').value = '';
    show('code');
    $('join-code').focus();
  });

  // --- the game -------------------------------------------------------------
  buildMapButtons();
  $('game-tabs').addEventListener('click', (event) => {
    const sheet = event.target.closest('[data-sheet]');
    if (sheet) { selectSheet(sheet.dataset.sheet); return; }
    const button = event.target.closest('[data-pane]');
    if (button) selectPane(button.dataset.pane);
  });

  function selectPane(pane) {
    // The sheet buttons live in the same bar and answer a different question —
    // "which corner of England?" rather than "which of these three screens?" —
    // so they carry their own selected state, set in selectSheet.
    for (const button of $('game-tabs').querySelectorAll('[data-pane]')) {
      button.setAttribute('aria-selected', String(button.dataset.pane === pane));
    }
    for (const section of document.querySelectorAll('[data-pane-body]')) {
      section.hidden = section.dataset.paneBody !== pane;
    }
    // Only one of the three is the board, so the sheet row is lit only there.
    $('map-buttons').dataset.active = String(pane === 'map');
  }

  /**
   * The three printed sheets, as three buttons rather than one "The board" tab.
   *
   * England is the thing being looked at; which corner of it you want is the
   * question actually being asked. Built from `shires.json` so the row cannot
   * name a sheet that does not exist, and clicking one both opens the board
   * and moves the map to it — a player choosing "Eastern" from the battle tab
   * means "show me the east", not "show me the east once I have found my way
   * back".
   */
  function buildMapButtons() {
    $('map-buttons').innerHTML = (data.shires.sheets ?? []).map((sheet) => `
      <button type="button" role="tab" data-sheet="${sheet.id}"
              aria-selected="${sheet.id === $('map').getAttribute('sheet')}">${
  sheet.display_name.replace(/\s+England$/, '')}</button>`).join('');
  }

  function selectSheet(sheetId) {
    $('map').setAttribute('sheet', sheetId);
    for (const button of $('map-buttons').children) {
      button.setAttribute('aria-selected', String(button.dataset.sheet === sheetId));
    }
    selectPane('map');
  }

  document.addEventListener('rb-shire', (event) => onShireClicked(event.detail.shireId));
  document.addEventListener('rb-command', (event) => dispatch(event.detail.verb, event.detail.payload));

  /**
   * A shire was clicked, either on its own or while an action's chooser is
   * open.
   *
   * With a chooser open, the click finishes the field the dropdown would
   * otherwise have set — the map becomes the input, not just an illustration
   * of the dropdown's options. Without one open, the click instead asks the
   * action list which of the currently-available actions could use this
   * shire, and promotes those to the top so the answer to "what can I do
   * here?" is the first thing the player sees.
   */
  function onShireClicked(shireId) {
    showShire(shireId);

    const form = $('chooser').hidden ? null : $('chooser').querySelector('form');
    const field = form?.querySelector('select[name="shireId"], select[name="target"]');
    const match = field && [...field.options]
      .find((o) => o.value === shireId || o.value.startsWith(`${shireId}|`));
    if (field && match) {
      field.value = match.value;
      $('actions').focusShireId = null;
    } else {
      $('actions').focusShireId = shireId;
    }
  }

  function showShire(shireId) {
    const printed = data.shires.shires[shireId];
    const live = client.view?.shires?.[shireId];
    const derived = client.view?.derived?.shires?.[shireId];
    if (!printed || !live) return;

    const steward = live.stewardRoleId
      ? data.roles.roles[live.stewardRoleId]?.name ?? live.stewardRoleId
      : 'nobody';
    const standing = Object.values(live.settlements ?? {}).filter((s) => !s.destroyed);
    // Why the port is two cheaper to reach than the map says.
    const contract = Object.values(client.view?.contracts ?? {})
      .find((c) => c.shireId === shireId && c.status === 'active');
    const tally = ['farm', 'town', 'church'].map((kind) => {
      const of = standing.filter((s) => s.type === kind);
      const defended = of.filter((s) => s.defended).length;
      return of.length ? `${of.length} ${kind}${of.length === 1 ? '' : 's'}`
        + (defended ? ` (${defended} defended)` : '') : null;
    }).filter(Boolean);

    // Holding an initiative token turns the shire just clicked into
    // something that can be targeted directly, rather than picked a second
    // time from a dropdown listing every shire in England. Asked of the same
    // admission function the host will use, and asked about this shire rather
    // than about the verb in general — a token holder can only name somewhere
    // they can reach, so "can I target?" has no answer that is not about a
    // particular shire. That is what keeps the button from being offered and
    // then refused.
    //
    // Wrapped because this is a client asking a host's rule about a redacted
    // projection: a rule that reaches into a hole in it throws rather than
    // returning a verdict, which is exactly why `availableTo` wraps its own
    // probes. Nothing the reach gate reads is private today, so this catches
    // the next rule added to that admit rather than a live fault — and a
    // missing button is a far better failure than a console that stopped
    // rendering shires.
    const me = client.view?.viewer;
    let canTarget = false;
    try {
      canTarget = Boolean(me) && admit(client.view, data,
        { verb: 'declare-initiative-target', payload: { shireId } },
        { seatId: me.seatId, kind: 'player', roleId: me.roleId }).ok;
    } catch {
      canTarget = false;
    }

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
        ${contract ? `<dt>Trade contract</dt><dd>with ${
  data.roles.roles[contract.traderRoleId]?.name ?? 'the Danish Trader'}</dd>` : ''}
      </dl>
      ${canTarget ? `
        <button type="button" class="rb-primary" data-target-shire="${shireId}">Target</button>` : ''}`;
  }

  client.subscribe(render);

  function render() {
    $('connection').setAttribute('status', client.status);

    if (client.rejection) {
      $('lobby-message').textContent = client.rejection;
      $('role-picker').hidden = true;
      return;
    }

    // A seat let itself back in on a remembered name, and the game it
    // remembered is not answering — a host whose tab died, a code that has
    // moved on, a token the host no longer knows. Say so and offer the way
    // back to the front door, rather than sitting on "waiting" forever.
    $('start-over').hidden = !remembering;

    const view = client.view;
    if (!view) {
      $('lobby-message').textContent = remembering
        ? `Looking for game ${joinCode}, as ${name}…`
        : 'Waiting for the facilitator…';
      return;
    }

    const seats = Object.values(view.seats ?? {});
    $('roster').roles = view.roles ?? {};
    $('roster').seats = seats;

    const mine = client.roleId;
    if (!mine) {
      show('lobby');
      $('lobby-message').textContent = 'Choose a character.';
      $('role-picker').hidden = false;
      renderRolePicker(view);
      if (client.lastRefusal) $('claim-error').textContent = client.lastRefusal.reason;
      return;
    }

    // Seated, but the facilitator has not begun the game — stay on the
    // lobby screen with a character chosen rather than open the board on a
    // turn that has not started. There is no going back to lobby once left,
    // so this can never re-trigger mid-game.
    if (view.phase.name === 'lobby') {
      show('lobby');
      $('lobby-message').textContent =
        `Playing ${data.roles.roles[mine]?.name ?? mine}. Waiting for the facilitator to start the game.`;
      $('role-picker').hidden = true;
      return;
    }

    // Seated and under way: the board, the sheet and the tracker take over.
    if (screens.game.hidden) {
      show('game');
      selectPane('map');
    }
    // Name, turn, phase and timer live on the global bar now — the one strip
    // that is on screen whichever tab is open, and which no longer competes
    // with the tabs for the top of the game panel.
    $('bar-status').hidden = false;
    $('bar-role').textContent = data.roles.roles[mine]?.name ?? mine;
    $('clock').phase = view.phase;
    $('actions').data = data;
    $('actions').view = view;
    $('action-error').textContent = client.lastRefusal?.reason ?? '';

    $('consents').data = data;
    $('consents').view = view;
    $('ballot').data = data;
    $('ballot').view = view;
    // The action rail is always in view now, whichever tab is open, so an
    // answer somebody is waiting on can mark the rail itself rather than a
    // tab a player might not be looking at.
    $('action-rail').dataset.waiting = String(
      $('consents').pending.length > 0 || $('ballot').pending.length > 0);

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

  // The Target button on a clicked shire's own detail panel — the whole of
  // declaring an initiative target, now that the click already said which
  // shire is meant.
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-target-shire]');
    if (!button) return;
    dispatch('declare-initiative-target', { shireId: button.dataset.targetShire });
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

    // Point at the shires this action could land on, so a player can finish
    // it by clicking the map instead of hunting through the dropdown. Once a
    // choice is being made, a shire clicked for its own sake is answered
    // already — the action list is not also trying to say what else it could
    // be relevant to.
    const targets = shireTargetsFor(form.dataset.verb, client.view, data);
    $('map').highlighted = targets.length ? targets : null;
    $('actions').focusShireId = null;
  }

  function closeChooser() {
    $('chooser').hidden = true;
    $('chooser').replaceChildren();
    $('map').highlighted = null;
  }

  function dispatch(verb, payload) {
    $('action-error').textContent = '';
    const { envelope, sent } = sendCommand(verb, payload);
    if (sent) client.awaiting(envelope.data.seq, verb);
    else $('action-error').textContent = 'Not connected — try again in a moment.';
  }

  // A code in the link and a name already given: the two screens in front of
  // the game exist to collect exactly those, so there is nothing left to ask.
  // The session token survives a reload and the host matches it back to the
  // seat that held it, so this lands the player back in their own chair rather
  // than making them walk through the door again to reach it.
  //
  // `remembered` is what tells the lobby to offer a way out: a player who was
  // put here rather than choosing it needs one, and a player who typed their
  // way in does not.
  // A test seat names itself, so it never waits on the name screen and never
  // takes the name a real player left on this machine.
  const remembered = seat !== null ? `Seat ${seat}` : loadSavedName();
  if (joinCode && remembered) {
    remembering = true;
    name = remembered;
    connect();
    show('lobby');
    // Nothing has arrived to subscribe on yet, so the lobby would sit blank
    // until the first projection — which for a game that is not answering is
    // never. One render now says who we are looking for, and offers the way
    // back out.
    render();
  } else if (joinCode) {
    $('lobby-code').textContent = joinCode;
    show('name');
  } else {
    show('code');
  }

  return { client, manager, data };
}

const title = (text) => String(text ?? '').replace(/_/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());
