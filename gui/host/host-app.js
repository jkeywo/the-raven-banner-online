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
import { Persistence, saveFilename, downloadSave, parseSave } from './persistence.js';
import { HostPeer } from '../net/host-peer.js';
import { mintJoinCode, mintFacilitatorPin, playerLink } from '../net/join-code.js';
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
import '../components/rb-state-inspector.js';

const $ = (id) => document.getElementById(id);

export async function startHostApp({ location = window.location } = {}) {
  const data = await loadData();
  const persistence = new Persistence({
    onError: () => {
      $('save-warning').hidden = false;
    },
  });

  let host = null;
  let peer = null;
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
    host = started;
    // A save from before PINs were kept, or one hand-made: mint one rather
    // than leaving the co-facilitator with no way in at all.
    host.facilitatorPin ??= mintFacilitatorPin();
    pin = host.facilitatorPin;
    host._onChange = onChange;

    peer = new HostPeer({
      joinCode: host.state.joinCode,
      facilitatorPin: pin,
      onIdentify: (args) => host.identify(args),
      onCommand: (seat, cmd) => host.submit(seat, cmd),
      viewFor: (seat) => host.viewFor(seat),
      onStatus: (status) => $('connection').setAttribute('status', status),
      onLog: (line) => appendLog(line),
    });
    peer.start();

    $('join-code').textContent = host.state.joinCode;
    $('facilitator-pin').textContent = pin;
    $('player-link').value = playerLink(location, host.state.joinCode);
    show('running');
    render();

    // The tab may be closed, put to sleep, or crash. Write unconditionally on
    // the way out — there may be no next tick to debounce into.
    const flush = () => persistence.write(host.save());
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    flush();
  }

  function onChange() {
    persistence.schedule(host.save());
    peer.broadcast();
    render();
  }

  function render() {
    const roster = $('roster');
    roster.roles = data.roles.roles;
    roster.seats = host.roster();
    const claimed = host.roster().filter((s) => s.roleId).length;
    $('seated-count').textContent = `${claimed} of ${Object.keys(host.state.roles).length} roles claimed`;

    const phase = host.state.phase;
    $('clock').phase = phase;
    $('battle-grid').data = data;
    $('battle-grid').state = host.state;
    $('envoy-queue').data = data;
    $('envoy-queue').state = host.state;
    $('consent-queue').data = data;
    $('consent-queue').state = host.state;
    $('crowns').data = data;
    $('crowns').state = host.state;
    // Hidden until somebody asks: an empty panel above the envoys is a panel
    // the facilitator learns to scroll past.
    $('consent-panel').hidden = !Object.values(host.state.consents ?? {})
      .some((r) => !r.resolved);
    $('inspector').state = host.state;
    const waiting = Object.values(host.state.envoys).filter((t) => t.open
      && t.messages.at(-1)?.from === t.roleId).length;
    $('envoy-count').textContent = waiting
      ? `${waiting} waiting on you` : 'nothing waiting';
    $('battle-panel').hidden = phase.name !== 'battle';
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
    const seat = { id: 'host', kind: 'facilitator', roleId: null };
    const result = host.submit(seat, { verb, payload });
    if (!result.ok) appendLog(`[host] refused: ${result.reason}`);
  }

  document.addEventListener('rb-facilitate', (event) =>
    asFacilitator(event.detail.verb, event.detail.payload));

  $('advance-phase').addEventListener('click', () => asFacilitator('facilitator:advance-phase'));
  $('pause-clock').addEventListener('click', () => asFacilitator('facilitator:pause-clock'));
  for (const id of ['extend-clock', 'shorten-clock']) {
    $(id).addEventListener('click', (event) => asFacilitator('facilitator:extend-clock', {
      minutes: Number(event.currentTarget.dataset.minutes),
    }));
  }

  $('copy-link').addEventListener('click', async () => {
    await navigator.clipboard?.writeText($('player-link').value);
    $('copy-link').textContent = 'Copied';
    setTimeout(() => { $('copy-link').textContent = 'Copy'; }, 1500);
  });

  $('download-save').addEventListener('click', () => {
    downloadSave(host.save(), saveFilename(host.state));
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
    'tactics', 'factions', 'meta'];
  const loaded = await Promise.all(
    names.map((name) => fetch(`data/${name}.json`).then((r) => r.json())));
  return Object.fromEntries(names.map((name, i) => [name, loaded[i]]));
}
