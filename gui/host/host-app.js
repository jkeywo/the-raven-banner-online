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
import { installSessionToken } from '../net/session-token.js';
import {
  mintJoinCode, mintFacilitatorPin, playerLink, normaliseJoinCode, isValidJoinCode,
} from '../net/join-code.js';
import { mintSeed } from '../rules/rng.js';
import { rosterFor } from '../rules/state.js';
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

const $ = (id) => document.getElementById(id);

export async function startHostApp({ location = window.location } = {}) {
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
  const saves = persistence.list();
  if (saves.length) {
    $('resume-list').innerHTML = saves.map((save) => `
      <li><button type="button" class="rb-resume" data-code="${save.joinCode}">
        <strong>${save.joinCode}</strong>
        <span>${save.log.length} action${save.log.length === 1 ? '' : 's'}${
      save.savedAt ? `, saved ${new Date(save.savedAt).toLocaleTimeString()}` : ''}</span>
      </button></li>`).join('');
    $('resume').hidden = false;
  }

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
    take(new CoFacilitatorSession({
      joinCode: code,
      pin: enteredPin,
      name: $('co-name').value.trim() || 'Co-facilitator',
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
    if (save) persistence.schedule(save);
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
    $('tab-fac-crowns').dataset.live = String(consentsPending);
    $('inspector').state = session.state;
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
    // says when it matters most.
    $('tab-fac-battle').dataset.live = String(phase.name === 'battle');

    // The debrief appears when the game ends and not before: a half-played
    // epilogue is a thing to be misread out loud.
    const ended = phase.name === 'epilogue';
    $('epilogue-panel').hidden = !ended;
    $('debrief-waiting').hidden = ended;
    $('tab-fac-debrief').dataset.live = String(ended);
    $('end-game').disabled = ended || phase.name === 'lobby';
    if (ended) {
      $('epilogue').data = data;
      $('epilogue').state = session.state;
    }
    $('advance-phase').textContent = phase.name === 'lobby' ? 'Begin the game'
      : phase.name === 'epilogue' ? 'The game is over' : 'Next phase';
    $('advance-phase').disabled = phase.name === 'epilogue';
    $('pause-clock').textContent = phase.paused ? 'Resume' : 'Pause';
    // Nothing to pause or stretch before the game starts, or after it ends.
    const running = phase.endsAt !== null || phase.paused;
    for (const id of ['pause-clock', 'extend-clock', 'shorten-clock']) $(id).disabled = !running;
  }

  /** The facilitator acts as themselves — a seat of their own on this tab. */
  function asFacilitator(verb, payload = {}) {
    const result = session.submit(verb, payload);
    if (result && !result.ok) appendLog(`[host] refused: ${result.reason}`);
  }

  document.addEventListener('rb-facilitate', (event) =>
    asFacilitator(event.detail.verb, event.detail.payload));

  // --- the facilitator's own tabs -------------------------------------------
  // One clock and one set of setup details stay on screen throughout; the
  // rest — battle, crowns, envoys, the debrief, the inspector — are each a
  // control panel in its own right, and only one needs to be in front at a
  // time.
  $('facilitator-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-pane]');
    if (button) selectFacilitatorPane(button.dataset.pane);
  });

  function selectFacilitatorPane(pane) {
    for (const button of $('facilitator-tabs').children) {
      button.setAttribute('aria-selected', String(button.dataset.pane === pane));
    }
    for (const section of document.querySelectorAll('[data-pane-body]')) {
      section.hidden = section.dataset.paneBody !== pane;
    }
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

  $('print-epilogue').addEventListener('click', () => globalThis.print?.());

  $('save-epilogue').addEventListener('click', () => {
    // A self-contained page, so a debrief can be sent round afterwards
    // without needing the app or the game still to exist.
    downloadPage(epiloguePage($('epilogue').innerHTML, session.joinCode),
      `raven-banner-${session.state.joinCode}-debrief.html`);
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
    'tactics', 'factions', 'meta', 'scaling'];
  const loaded = await Promise.all(
    names.map((name) => fetch(`data/${name}.json`).then((r) => r.json())));
  return Object.fromEntries(names.map((name, i) => [name, loaded[i]]));
}
