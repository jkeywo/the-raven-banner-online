/**
 * gui/host/host-app.js — the facilitator's tab, which must not be closed.
 *
 * Starts or resumes a game, holds it, and shows the three things a facilitator
 * needs in the lobby: the code to read out, the link to paste, and who has
 * turned up. The PIN is here and nowhere else — the code gets shouted over
 * voice, and without a second secret anyone holding it could claim to be an
 * umpire and edit the game.
 *
 * Everything else on this page exists because the tab can die. Autosave on
 * every change, an unconditional write when the page is hidden, and a download
 * button that is always in reach.
 */

import { GameHost } from './game-host.js';
import {
  Persistence, saveFilename, downloadSave, downloadPage, epiloguePage, parseSave,
} from './persistence.js';
import { PrimarySession, CoFacilitatorSession } from './session.js';
import { eventPumpFor } from './event-pump.js';
import { createBeeper } from '../sound.js';
import { installSessionToken } from '../net/session-token.js';
import { loadSavedName, saveName } from '../net/name-storage.js';
import {
  mintJoinCode, mintFacilitatorPin, playerLink, normaliseJoinCode, isValidJoinCode,
} from '../net/join-code.js';
import { mintSeed } from '../rules/rng.js';
import { rosterFor, PHASES, OUT_OF_PLAY } from '../rules/state.js';
import { projectView } from '../rules/views.js';
import { KNOWN_GAPS } from '../rules/gaps.js';
import '../components/rb-connection-dot.js';
import '../components/rb-seat-roster.js';
import '../components/rb-phase-clock.js';
import '../components/rb-facilitator-grid.js';
import '../components/rb-envoy-queue.js';
import '../components/rb-consent-queue.js';
import '../components/rb-crown-panel.js';
import '../components/rb-epilogue.js';
import '../components/rb-state-inspector.js';
import '../components/rb-map.js';
import '../components/rb-shire-editor.js';

const $ = (id) => document.getElementById(id);

export async function startHostApp({ location = window.location, beeper = createBeeper() } = {}) {
  const data = await loadData();
  const persistence = new Persistence({
    onError: () => {
      $('save-warning').hidden = false;
    },
  });

  // The one seam between hosting the game and watching somebody else host it.
  // Everything below this line reads `session` and never asks which it has.
  let session = null;
  let pin = null;

  // Null unless this tab was opened with `?events=<url>`, which is the whole
  // of the Discord integration's off-switch. Built once per tab rather than
  // per game, because it is a property of how this console was launched and
  // not of the game it happens to be running — see docs/discord-integration.md.
  const pump = eventPumpFor({ location, onLog: (line) => appendLog(line) });

  // Fixed for the whole game, so it is written once rather than on every
  // projection.
  $('rules-gaps').innerHTML = KNOWN_GAPS.map((gap) => `
    <dt>${gap.about} — ${gap.ruling}</dt>
    <dd><em>${gap.silent}</em> ${gap.because}</dd>`).join('');

  const screens = { start: $('screen-start'), running: $('screen-running') };
  const show = (which) => {
    for (const [key, element] of Object.entries(screens)) element.hidden = key !== which;
  };

  // --- resuming -------------------------------------------------------------
  renderResumes();

  /**
   * The saved games on this machine, each with a way to be rid of it.
   *
   * Re-rendered rather than reloaded when one is deleted, because a
   * facilitator clearing out three abandoned test games should not have to
   * refresh between each — and because the whole panel disappears once the
   * last one is gone, which a stale list would not show.
   */
  function renderResumes() {
    const saves = persistence.list();
    $('resume').hidden = saves.length === 0;
    $('resume-list').innerHTML = saves.map((save) => `
      <li>
        <button type="button" class="rb-resume" data-code="${save.joinCode}">
          <strong>${save.joinCode}</strong>
          <span>${save.log.length} action${save.log.length === 1 ? '' : 's'}${
  save.savedAt ? `, saved ${new Date(save.savedAt).toLocaleTimeString()}` : ''}</span>
        </button>
        <button type="button" class="rb-resume-forget" data-forget="${save.joinCode}"
                aria-label="Delete game ${save.joinCode}">Delete</button>
        ${turnsFor(save.joinCode)}
      </li>`).join('');
  }

  /**
   * The turns kept for a game, as a row of ways back into it.
   *
   * Offered rather than merely stored. A checkpoint nobody can reach is a
   * checkpoint that is not there, and the reason for keeping these is a
   * facilitator saying "that went wrong, put us back to the start of turn
   * three" — which has to be one press, in front of a room that is waiting.
   */
  function turnsFor(joinCode) {
    const kept = persistence.checkpoints(joinCode);
    if (!kept.length) return '';
    return `<span class="rb-resume-turns">Back to the start of:${kept.map((save) => `
      <button type="button" data-turn="${joinCode}|${save.turn}"
              aria-label="Resume game ${joinCode} from the start of turn ${save.turn}"
              >turn ${save.turn}</button>`).join('')}</span>`;
  }

  // Prefilled from whoever last typed one on this machine.
  $('co-name').value = loadSavedName();

  $('join-as-co').addEventListener('submit', (event) => {
    event.preventDefault();
    const code = normaliseJoinCode($('co-code').value);
    if (!isValidJoinCode(code)) {
      // Not guessed at: a misheard letter that was silently corrected could be
      // a different, valid game.
      $('start-error').textContent = 'That code is not right. Ask them to read it again.';
      return;
    }
    const enteredPin = $('co-pin').value.trim();
    if (!enteredPin) {
      $('start-error').textContent = 'The PIN is on the other facilitator’s screen.';
      return;
    }
    $('start-error').textContent = '';
    const coName = $('co-name').value.trim() || 'Co-facilitator';
    saveName(coName);
    take(new CoFacilitatorSession({
      joinCode: code,
      pin: enteredPin,
      name: coName,
      token: installSessionToken(code),
      data,
      onChange,
      onStatus: (status) => $('connection').setAttribute('status', status),
      onLog: (line) => appendLog(line),
    }));
  });

  $('take-over').addEventListener('click', () => {
    // eslint-disable-next-line no-alert
    const sure = globalThis.confirm?.(
      'Take over hosting? Do this only when the other facilitator has stopped.');
    if (sure === false) return;

    const result = session.takeOver({
      onChange,
      onStatus: (status) => $('connection').setAttribute('status', status),
      onLog: (line) => appendLog(line),
      pump,
    });
    if (!result.ok) { appendLog(`[co] ${result.reason}`); return; }
    if (result.refused?.length) {
      $('replay-warning').hidden = false;
      $('replay-warning').textContent =
        `${result.refused.length} recorded action${result.refused.length === 1 ? '' : 's'} `
        + 'could not be replayed and had no effect.';
    }
    appendLog('[co] taking the game over — claiming the code');
    take(result.session);
  });

  $('resume-list').addEventListener('click', (event) => {
    // Deleting first: the delete button sits inside the same <li> as the
    // resume button, and closest() would otherwise walk past it and open the
    // game the facilitator was trying to throw away.
    const forget = event.target.closest('[data-forget]');
    if (forget) {
      const code = forget.dataset.forget;
      // The only copy that survives this machine is a downloaded save, so a
      // deletion is as final as deletions get. Asked once, out loud.
      // eslint-disable-next-line no-alert
      if (globalThis.confirm?.(
        `Delete the saved game ${code}? This cannot be undone.`) === false) return;
      persistence.forget(code);
      renderResumes();
      return;
    }
    // Going back to a turn before going back to the game, for the same reason
    // deleting is tested for first: both sit inside the resume button's <li>.
    const back = event.target.closest('[data-turn]');
    if (back) {
      const [code, turn] = back.dataset.turn.split('|');
      // Everything after that turn began is about to stop having happened.
      // eslint-disable-next-line no-alert
      if (globalThis.confirm?.(`Put game ${code} back to the start of turn ${turn}? `
        + 'Everything played since then is undone.') === false) return;
      const kept = persistence.checkpoints(code).find((s) => String(s.turn) === turn);
      if (kept) resume(kept);
      return;
    }
    const button = event.target.closest('[data-code]');
    if (button) resume(persistence.read(button.dataset.code));
  });

  $('import-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const parsed = parseSave(await file.text());
    if (!parsed.ok) {
      $('start-error').textContent = parsed.reason;
      return;
    }
    resume(parsed.save);
  });

  $('new-game').addEventListener('click', () => {
    begin(GameHost.create({
      joinCode: mintJoinCode(),
      seed: mintSeed(Math.random),
      facilitatorPin: mintFacilitatorPin(),
      // Chosen before anybody joins, because the guide's table changes the
      // opening position rather than anything that happens later.
      roleIds: rosterFor(data, Number($('player-count').value)),
      data,
    }));
  });

  function resume(save) {
    if (!save) return;
    const { host: restored, refused } = GameHost.restore({ save, data });
    if (refused.length) {
      // A log that no longer replays means the rules moved under this save.
      // Said plainly now, rather than discovered mid-game.
      $('replay-warning').hidden = false;
      $('replay-warning').textContent =
        `${refused.length} recorded action${refused.length === 1 ? '' : 's'} could not be `
        + `replayed and had no effect: ${refused.map((r) => r.verb).join(', ')}.`;
    }
    begin(restored);
  }

  function begin(started) {
    // A save from before PINs were kept, or one hand-made: mint one rather
    // than leaving the co-facilitator with no way in at all.
    started.facilitatorPin ??= mintFacilitatorPin();
    take(new PrimarySession({
      host: started,
      onChange,
      onStatus: (status) => $('connection').setAttribute('status', status),
      onLog: (line) => appendLog(line),
      pump,
    }));
  }

  /** Adopt a session, whichever kind it is, and show the running console. */
  function take(started) {
    session = started;
    pin = session.facilitatorPin;
    session.start();

    $('join-code').textContent = session.joinCode;
    $('facilitator-pin').textContent = pin ?? '—';
    $('player-link').value = playerLink(location, session.joinCode);
    document.body.dataset.role = session.kind;
    show('running');
    render();

    // The tab may be closed, put to sleep, or crash. Write unconditionally on
    // the way out — there may be no next tick to debounce into.
    const flush = () => { const save = session.save(); if (save) persistence.write(save); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    flush();
  }

  function onChange() {
    // The co-facilitator writes the same save the primary does, which is the
    // whole of the takeover: by the time it is needed, the game is already on
    // this machine.
    const save = session.save();
    if (save) {
      persistence.schedule(save);
      // And a copy of the moment each turn began, kept for good. The rolling
      // save above follows the game and so has any mistake in it by the time
      // anybody notices; a turn boundary is somewhere a facilitator can
      // actually ask to go back to. Written from a playing phase only, so the
      // lobby does not claim to be the start of turn one before anything has
      // happened in it.
      const { turn, name } = session.state.phase;
      if (name === PHASES[0] && persistence.checkpoint(save, turn)) renderResumes();
    }
    render();
  }

  function render() {
    const roster = $('roster');
    roster.roles = data.roles.roles;
    roster.seats = session.roster();
    const claimed = session.roster().filter((s) => s.roleId).length;
    $('seated-count').textContent = `${claimed} of ${Object.keys(session.state.roles).length} roles claimed`;

    const phase = session.state.phase;
    $('clock').phase = phase;
    // The same picker every player has open, mirrored here so the
    // facilitator can watch the table fill in without needing a second
    // screen — gone once the game leaves the lobby, since there is no
    // going back to it.
    $('tab-fac-game').dataset.live = String(phase.name === 'lobby');
    $('lobby-roles').hidden = phase.name !== 'lobby';
    if (phase.name === 'lobby') renderRoleGrid(session.state, session.roster());
    // The map wants a projection rather than raw state, purely for the
    // `.derived` tints and support hatching it already knows how to draw — a
    // facilitator's own projection is the whole board anyway, so nothing is
    // hidden by asking for one.
    const facilitatorView = projectView(session.state, data, { kind: 'facilitator' });
    $('fac-map').data = data;
    $('fac-map').view = facilitatorView;
    $('shire-editor').data = data;
    $('shire-editor').state = session.state;
    $('battle-grid').data = data;
    $('battle-grid').state = session.state;
    $('envoy-queue').data = data;
    $('envoy-queue').state = session.state;
    $('consent-queue').data = data;
    $('consent-queue').state = session.state;
    $('crowns').data = data;
    $('crowns').state = session.state;
    // Hidden until somebody asks: an empty panel above the envoys is a panel
    // the facilitator learns to scroll past.
    const consentsPending = Object.values(session.state.consents ?? {})
      .some((r) => !r.resolved);
    $('consent-panel').hidden = !consentsPending;
    const rebellionsPending = Object.values(session.state.rebellions ?? {})
      .some((r) => r.status === 'pending' || r.status === 'priced');
    $('tab-fac-crowns').dataset.live = String(consentsPending || rebellionsPending);
    $('inspector').data = data;
    $('inspector').state = session.state;
    // Left alone while the facilitator is mid-sentence: a render landing
    // between keystrokes must not overwrite what they are typing.
    if (document.activeElement !== $('foreign-influence-note')) {
      $('foreign-influence-note').value = session.state.aftermath.foreignInfluence;
    }
    const waiting = Object.values(session.state.envoys).filter((t) => t.open
      && t.messages.at(-1)?.from === t.roleId).length;
    $('envoy-count').textContent = waiting
      ? `${waiting} waiting on you` : 'nothing waiting';
    $('tab-fac-envoys').dataset.live = String(waiting > 0);
    // The co-facilitator's banner, and whether there is enough mirrored to
    // take the game over with.
    $('co-banner').hidden = session.kind !== 'co';
    if (session.kind === 'co') {
      const ready = session.canTakeOver;
      $('take-over').disabled = !ready;
      $('co-mirror').textContent = ready
        ? `${session.state.log.length} action${session.state.log.length === 1 ? '' : 's'} mirrored`
        : 'nothing has arrived yet';
    }

    // The tab flags itself live rather than the panel disappearing — a
    // control the facilitator needs stays reachable on every phase, it just
    // says when it matters most. The Team Phase counts: that is when the
    // targets are being declared, and watching them arrive is the whole
    // reason to have the panel open before a battle exists.
    $('tab-fac-battle').dataset.live = String(phase.name === 'battle' || phase.name === 'team');

    // The debrief fills in as the game goes, rather than appearing whole at
    // the end. It is derived from the board every time it renders, so mid-game
    // it is simply the truth so far — and a facilitator who can watch the four
    // counters move has something to steer by, instead of meeting them for the
    // first time with sixteen people waiting.
    //
    // It is labelled while the game is still on, because the one danger here is
    // reading a half-played epilogue out as though it were the ending.
    const ended = phase.name === 'epilogue';
    const started = phase.name !== 'lobby';
    $('epilogue-panel').hidden = !started;
    $('debrief-waiting').hidden = started;
    $('epilogue-provisional').hidden = ended;
    $('tab-fac-debrief').dataset.live = String(ended);
    $('end-game').disabled = ended || phase.name === 'lobby';
    // Print and save produce the real thing, so they wait for the real thing.
    for (const id of ['print-epilogue', 'save-epilogue']) $(id).disabled = !ended;
    if (started) {
      $('epilogue').data = data;
      $('epilogue').state = session.state;
    }
    $('advance-phase').textContent = phase.name === 'lobby' ? 'Begin the game'
      : phase.name === 'epilogue' ? 'The game is over' : 'Next phase';
    $('advance-phase').disabled = phase.name === 'epilogue';
    $('pause-clock').textContent = phase.paused ? 'Resume' : 'Pause';
    // Nothing to pause or stretch before the game starts, or after it ends.
    // The pregame is held at zero rather than having no clock at all, so
    // "is it paused" no longer answers this on its own.
    const running = !OUT_OF_PLAY.includes(phase.name) && (phase.endsAt !== null || phase.paused);
    for (const id of ['pause-clock', 'extend-clock', 'shorten-clock']) $(id).disabled = !running;
  }

  /**
   * The same roster a player's lobby shows, read rather than clicked — but
   * dealt out a team to a row.
   *
   * The game is four teams of four, and every question a facilitator asks this
   * grid is about a team: is Wessex all seated, has anybody from the Summer
   * Army turned up. Flowed to fit the window it answered none of them, because
   * where a row broke depended on how wide the browser happened to be. Four to
   * a row puts each team on its own line and makes a gap in one of them
   * visible without reading a single name.
   *
   * Ordered by the printed roster rather than alphabetically, so the seat a
   * player is looking for is where it was last time.
   */
  function renderRoleGrid(state, seats) {
    const holderOf = new Map(seats.filter((s) => s.roleId).map((s) => [s.roleId, s]));
    const teams = new Map();
    for (const roleId of Object.keys(state.roles)) {
      const team = data.roles.roles[roleId]?.team ?? 'unaligned';
      if (!teams.has(team)) teams.set(team, []);
      teams.get(team).push(roleId);
    }

    $('role-grid').innerHTML = [...teams].map(([team, roleIds]) => `
      <div class="rb-roles-team" data-team="${escape(team)}">
        <h3 class="rb-roles-team-name">${escape(title(team))}</h3>
        <div class="rb-roles-row">${roleIds.map((roleId) => {
    const printed = data.roles.roles[roleId] ?? {};
    const seat = holderOf.get(roleId);
    return `<div class="rb-role">
            <span class="rb-role-name">${escape(printed.name ?? roleId)}</span>
            <span class="rb-role-team">${title(printed.archetype)}</span>
            ${seat
    ? `<span class="rb-role-taken">${escape(seat.name)}${seat.connected ? '' : ' — away'}</span>`
    : '<span class="rb-meta">open</span>'}
          </div>`;
  }).join('')}</div>
      </div>`).join('');
  }

  /** The facilitator acts as themselves — a seat of their own on this tab. */
  function asFacilitator(verb, payload = {}) {
    const result = session.submit(verb, payload);
    if (result && !result.ok) appendLog(`[host] refused: ${result.reason}`);
  }

  document.addEventListener('rb-facilitate', (event) =>
    asFacilitator(event.detail.verb, event.detail.payload));

  document.addEventListener('rb-shire', (event) => {
    // Reached for rather than assumed: this listener is on the document and
    // outlives any particular page, so a late event from a map that is on its
    // way out must not take the console with it.
    if ($('shire-editor')) $('shire-editor').shireId = event.detail.shireId;
  });

  // --- the clock, out loud ----------------------------------------------------
  // A facilitator running a room is not looking at this screen. They are
  // listening to a negotiation across the table, and the one thing they must
  // not miss is a phase running out — so the clock says it rather than only
  // showing it. Three at the deadline because three is unmistakably a signal
  // and not a notification; one every ten seconds after, because past the
  // deadline the question has changed from "how long" to "are you going to
  // call it", and that wants nagging rather than announcing.
  document.addEventListener('rb-time-up', () => beeper.beep(3, 880));
  document.addEventListener('rb-overtime', () => beeper.beep(1, 660));

  // The map turns its own page when a repeated neighbour is clicked, and this
  // row has to follow it. Only the buttons are set here, not the sheet: the
  // map has already changed that, and setting it again would be a second
  // opinion about which page is showing.
  document.addEventListener('rb-sheet', (event) => {
    for (const button of $('fac-map-buttons').children) {
      button.setAttribute('aria-selected',
        String(button.dataset.sheet === event.detail.sheetId));
    }
    selectFacilitatorPane('map');
  });

  // --- the facilitator's own tabs -------------------------------------------
  // One clock and one set of setup details stay on screen throughout; the
  // rest — battle, crowns, envoys, the debrief, the inspector — are each a
  // control panel in its own right, and only one needs to be in front at a
  // time.
  buildMapButtons();
  $('facilitator-tabs').addEventListener('click', (event) => {
    const sheet = event.target.closest('[data-sheet]');
    if (sheet) { selectSheet(sheet.dataset.sheet); return; }
    const button = event.target.closest('[data-pane]');
    if (button) selectFacilitatorPane(button.dataset.pane);
  });

  function selectFacilitatorPane(pane) {
    // The sheet buttons share this bar and answer a different question —
    // "which corner of England?" rather than "which of these panels?" — so
    // they are skipped here and carry their own selected state, set in
    // selectSheet. Asking for [data-pane] rather than every child is what
    // keeps them out of it.
    for (const button of $('facilitator-tabs').querySelectorAll('[data-pane]')) {
      button.setAttribute('aria-selected', String(button.dataset.pane === pane));
    }
    for (const section of document.querySelectorAll('[data-pane-body]')) {
      section.hidden = section.dataset.paneBody !== pane;
    }
    // Only one of the panes is the board, so the sheet row is lit only there.
    $('fac-map-buttons').dataset.active = String(pane === 'map');
  }

  /**
   * The three printed sheets, as three buttons rather than one "Map" tab.
   *
   * The same row the player's console carries, for the same reason: England is
   * what is being looked at, and which corner of it is the question actually
   * being asked. Built from `shires.json` so the row cannot name a sheet that
   * does not exist, and clicking one both opens the board and moves the map to
   * it — a facilitator choosing "Eastern" from the battle tab means "show me
   * the east", not "show me the east once I have found my way back".
   */
  function buildMapButtons() {
    $('fac-map-buttons').innerHTML = (data.shires.sheets ?? []).map((sheet) => `
      <button type="button" role="tab" data-sheet="${sheet.id}"
              aria-selected="${sheet.id === $('fac-map').getAttribute('sheet')}">${
  sheet.display_name.replace(/\s+England$/, '')}</button>`).join('');
    // The board is the pane the console opens into, so the row starts lit.
    $('fac-map-buttons').dataset.active = 'true';
  }

  function selectSheet(sheetId) {
    $('fac-map').setAttribute('sheet', sheetId);
    for (const button of $('fac-map-buttons').children) {
      button.setAttribute('aria-selected', String(button.dataset.sheet === sheetId));
    }
    selectFacilitatorPane('map');
  }

  $('advance-phase').addEventListener('click', () => asFacilitator('facilitator:advance-phase'));
  $('pause-clock').addEventListener('click', () => asFacilitator('facilitator:pause-clock'));
  for (const id of ['extend-clock', 'shorten-clock']) {
    $(id).addEventListener('click', (event) => asFacilitator('facilitator:extend-clock', {
      minutes: Number(event.currentTarget.dataset.minutes),
    }));
  }

  $('end-game').addEventListener('click', () => {
    // Irreversible in the fiction and awkward to undo in the room, so it is
    // asked for rather than assumed. The inspector can still put the phase
    // back if somebody hits it by accident.
    // eslint-disable-next-line no-alert
    if (globalThis.confirm?.('End the game and freeze the board for the debrief?') !== false) {
      asFacilitator('facilitator:end-game');
    }
  });

  $('foreign-influence-commit').addEventListener('click', () => {
    asFacilitator('facilitator:set',
      { path: ['aftermath', 'foreignInfluence'], value: $('foreign-influence-note').value });
  });

  $('print-epilogue').addEventListener('click', () => globalThis.print?.());

  $('save-epilogue').addEventListener('click', () => {
    // A self-contained page, so a debrief can be sent round afterwards
    // without needing the app or the game still to exist.
    downloadPage(epiloguePage($('epilogue').innerHTML, session.joinCode),
      `raven-banner-${session.state.joinCode}-debrief.html`);
  });

  // A testing affordance, and deliberately behind a fold. Each tab carries a
  // `?seat=N` that makes it take a token of its own rather than adopting this
  // machine's shared one — otherwise four tabs are one seat opened four times.
  $('open-test-seats').addEventListener('click', () => {
    const wanted = Math.min(8, Math.max(1, Number($('test-seats').value) || 1));
    const link = $('player-link').value;
    for (let seat = 1; seat <= wanted; seat += 1) {
      const [base, hash = ''] = link.split('#');
      const url = `${base}${base.includes('?') ? '&' : '?'}seat=${seat}${hash ? `#${hash}` : ''}`;
      globalThis.open?.(url, `rb-seat-${seat}`);
    }
  });

  $('copy-link').addEventListener('click', async () => {
    await navigator.clipboard?.writeText($('player-link').value);
    $('copy-link').textContent = 'Copied';
    setTimeout(() => { $('copy-link').textContent = 'Copy'; }, 1500);
  });

  $('download-save').addEventListener('click', () => {
    downloadSave(session.save(), saveFilename(session.state));
  });

  function appendLog(line) {
    const log = $('host-log');
    log.textContent = `${line}\n${log.textContent}`.split('\n').slice(0, 40).join('\n');
  }

  show('start');
}

/**
 * The static dataset. Fetched rather than imported so the JSON stays JSON —
 * no build step means no import assertions to worry about.
 */
async function loadData() {
  const names = ['shires', 'adjacency', 'roles', 'briefs', 'archetypes',
    'tactics', 'factions', 'meta', 'scaling', 'geometry'];
  const loaded = await Promise.all(
    names.map((name) => fetch(`data/${name}.json`).then((r) => r.json())));
  const data = Object.fromEntries(names.map((name, i) => [name, loaded[i]]));
  // Where the exporter blanked the state-bearing cells out of the map art, and
  // so where <rb-map> has to put them back. Beside the pictures rather than
  // under data/, because it is regenerated with them.
  data.cells = await fetch('assets/maps/cells.json').then((r) => r.json());
  return data;
}

const title = (text) => String(text ?? '').replace(/_/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());

function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
