/**
 * gui/client/replay-app.js — the evening afterwards, from above.
 *
 * A save is a seed and a command log, which means the whole game is still in
 * it: not a highlight reel somebody chose to keep, but every action in the
 * order it was taken. This page walks that log and draws the board at whatever
 * point you stop.
 *
 * Three things follow from what it is for.
 *
 * **The whole of England at once.** During the game a player looks at one
 * sheet, because they are deciding something about one corner of the country.
 * Afterwards the question is the opposite one — where did the war go — so all
 * three sheets are up together and the map's own sheet row is off. The maps
 * are the same `<rb-map>` the consoles use, drawing the same "blank until it
 * differs" overlay, so watching the scrub is watching the printed board fill
 * in.
 *
 * **Nothing is redacted.** The projection is a facilitator's, because whoever
 * opened this file already holds every secret in the game — the save *is* the
 * secrets. Hiding one behind a page that could be given the file instead would
 * be theatre. The per-role sheets are the exception and are projected properly,
 * for a different reason: a panel that invented its own summary of a role could
 * disagree with the sheet that player was actually reading.
 *
 * **It hosts nothing.** No PeerJS, no clock, no commands. It reads a file and
 * some local storage, and the only state it holds is where the cursor is.
 */

import { Persistence, parseSave } from '../host/persistence.js';
import { ReplayCursor } from '../rules/replay-cursor.js';
import { projectView } from '../rules/views.js';
import { labelFor } from '../rules/commands.js';
import { loadData } from './load-data.js';
import '../components/rb-map.js';
import '../components/rb-aftermath.js';
import '../components/rb-private-sheet.js';

const $ = (id) => document.getElementById(id);

/** How far the skip buttons go. A phase of a turn is roughly this many acts. */
const SKIP = 10;

export async function startReplayApp() {
  const data = await loadData({ geometry: true });
  const persistence = new Persistence({});

  let save = null;
  let cursor = null;
  let maps = [];
  let historyItems = [];
  // How far the history list is currently painted, so a step repaints two
  // entries rather than a thousand. See `markHistory`.
  let painted = 0;
  let current = null;
  // Whose sheet is open, and the roster the rail was last built from.
  let openRoleId = null;
  let roster = '';

  const screens = { open: $('screen-open'), replay: $('screen-replay') };
  const show = (which) => {
    for (const [key, element] of Object.entries(screens)) element.hidden = key !== which;
  };

  // --- opening a game -------------------------------------------------------
  renderSaves();

  /**
   * The games this browser has a save for.
   *
   * Deliberately without the facilitator console's Delete button: this page
   * exists to look at a game that is over, and a screen for looking at
   * something should not be a screen for throwing it away.
   */
  function renderSaves() {
    const saves = persistence.list();
    $('resume').hidden = saves.length === 0;
    $('resume-list').innerHTML = saves.map((entry) => `
      <li>
        <button type="button" class="rb-resume" data-code="${escape(entry.joinCode)}">
          <strong>${escape(entry.joinCode)}</strong>
          <span>${entry.log.length} action${entry.log.length === 1 ? '' : 's'}${
  entry.savedAt ? `, saved ${new Date(entry.savedAt).toLocaleTimeString()}` : ''}</span>
        </button>
      </li>`).join('');
  }

  $('resume-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-code]');
    if (button) open(persistence.read(button.dataset.code));
  });

  $('import-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const parsed = parseSave(await file.text());
    if (!parsed.ok) { $('open-error').textContent = parsed.reason; return; }
    $('open-error').textContent = '';
    open(parsed.save);
  });

  $('open-another').addEventListener('click', () => {
    renderSaves();
    show('open');
  });

  function open(loaded) {
    if (!loaded) return;
    save = loaded;
    // Warmed on the way in. One pass over the log is what restoring a save
    // already costs, and paying it here means no drag of the bar ever pays it
    // — and that the refusals below are the whole truth rather than whatever
    // has been scrubbed past so far.
    cursor = new ReplayCursor(save, data).warm();
    openRoleId = null;
    roster = '';

    $('replay-code').textContent = save.joinCode;
    $('scrub').max = String(cursor.length);
    buildEngland();
    buildHistory();

    const refused = cursor.refusals;
    $('replay-warning').hidden = refused.length === 0;
    $('replay-warning').textContent = refused.length
      ? `${refused.length} recorded action${refused.length === 1 ? '' : 's'} could not be `
        + `replayed and had no effect: ${refused.map((r) => r.verb).join(', ')}.`
      : '';

    show('replay');
    render();
  }

  // --- the board ------------------------------------------------------------

  /**
   * Three maps rather than one with a sheet picker.
   *
   * Built from `shires.json` so the row cannot name a sheet that does not
   * exist, and each map is told `tabs="off"` because the picker it would
   * otherwise draw has nothing left to pick.
   */
  function buildEngland() {
    const stage = $('england');
    stage.replaceChildren();
    maps = (data.shires.sheets ?? []).map((sheet) => {
      const map = document.createElement('rb-map');
      map.setAttribute('sheet', sheet.id);
      map.setAttribute('tabs', 'off');
      // Parked before the map is connected, because that is when it collects
      // whatever the page wants shown on a clicked shire.
      const card = document.createElement('div');
      card.setAttribute('slot', 'card');
      card.className = 'rb-replay-shire';
      map.append(card);

      const figure = document.createElement('figure');
      figure.className = 'rb-england-sheet';
      const caption = document.createElement('figcaption');
      caption.textContent = sheet.display_name;
      figure.append(caption, map);
      stage.append(figure);
      return map;
    });
  }

  // A clicked shire is answered on the sheet it was clicked on. The map raises
  // this from itself, so the event's target is the map whose card to fill.
  $('england').addEventListener('rb-shire', (event) => fillCard(event.target));

  function fillCard(map, view = viewNow()) {
    const card = map.querySelector?.('.rb-replay-shire');
    if (card) card.innerHTML = map.selected ? shireCard(map.selected, view) : '';
  }

  /** What a shire was, at the cursor. The board is quiet, so this is the read. */
  function shireCard(shireId, view) {
    const printed = data.shires.shires[shireId];
    const live = view.shires?.[shireId];
    if (!printed || !live) return '';
    const derived = view.derived?.shires?.[shireId];
    const standing = Object.values(live.settlements ?? {}).filter((s) => !s.destroyed).length;
    return `
      <h3>${escape(printed.name)}</h3>
      <dl class="rb-detail">
        <dt>Steward</dt>
        <dd>${escape(live.stewardRoleId ? nameOf(live.stewardRoleId) : 'nobody')}</dd>
        <dt>Support box</dt>
        <dd>${escape(printed.support.join(', '))}
          ${derived?.supported === false ? '<span class="rb-warn">unsupported</span>' : ''}</dd>
        <dt>Castles</dt><dd>${live.castles}</dd>
        <dt>Settlements</dt>
        <dd>${standing} of ${printed.settlements.length} standing</dd>
      </dl>`;
  }

  // --- the history ----------------------------------------------------------

  /**
   * Every action, written once.
   *
   * A five-turn game is a few thousand entries and the list does not change as
   * the cursor moves — only which of it has happened yet does. So it is built
   * once and thereafter only has attributes flipped on it; rebuilding the
   * markup on every step is exactly the stutter the checkpointed cursor exists
   * to avoid, and it would be a shame to hand it back here.
   *
   * `data-at` is the cursor position *after* the entry, which is what clicking
   * one should jump to: "show me the board once this had happened".
   */
  function buildHistory() {
    $('history').innerHTML = cursor.log.map((entry, index) => {
      const refusal = cursor.refusalAt(index);
      return `<li data-at="${index + 1}" data-applied="false"
                  data-override="${entry.override === true}"
                  ${refusal ? 'data-refused="true"' : ''}>
        <button type="button" data-at="${index + 1}">
          <span class="rb-replay-seq">${entry.seq}</span>
          <span class="rb-replay-label">${escape(labelFor(entry.verb))}</span>
          <span class="rb-replay-who">${escape(whoDid(entry))}</span>
          ${entry.override
    ? '<span class="rb-replay-override">facilitator override</span>' : ''}
          ${refusal ? `<span class="rb-replay-refused">${escape(refusal.reason)}</span>` : ''}
        </button>
      </li>`;
    }).join('');
    historyItems = [...$('history').children];
    painted = 0;
    current = null;
  }

  /** Whose action it was, in the words the roster uses. */
  function whoDid(entry) {
    if (entry.roleId) return nameOf(entry.roleId);
    return entry.override ? 'a facilitator' : entry.seatId;
  }

  /**
   * Repaint only the stretch the cursor moved across.
   *
   * A step flips one entry; a jump flips as many as it skipped. Either way it
   * is attribute writes on nodes that already exist rather than a parse of the
   * whole list.
   */
  function markHistory() {
    const to = cursor.position;
    for (let i = Math.min(painted, to); i < Math.max(painted, to); i += 1) {
      historyItems[i].dataset.applied = String(i < to);
    }
    painted = to;

    current?.removeAttribute('aria-current');
    current = to > 0 ? historyItems[to - 1] : null;
    current?.setAttribute('aria-current', 'step');
    // Absent in a test environment, which has no layout to scroll.
    current?.scrollIntoView?.({ block: 'nearest' });
  }

  // --- the people who were playing ------------------------------------------

  /**
   * The roster, as a rail of things to open.
   *
   * Rebuilt only when the roster itself changes, which it can mid-game: a
   * facilitator can seat a late arrival or take a dead character out, and a
   * rail that ignored that would offer a sheet for somebody who was not in the
   * game at the point being looked at.
   */
  function renderRoles() {
    const state = cursor.state;
    const roleIds = Object.keys(state.roles);
    const key = roleIds.join(',');

    if (key !== roster) {
      roster = key;
      $('role-rail').innerHTML = roleIds.map((roleId) => {
        const printed = data.roles.roles[roleId] ?? {};
        return `<button type="button" class="rb-role" data-role="${escape(roleId)}"
                        aria-pressed="false">
            <span class="rb-role-name">${escape(printed.name ?? roleId)}</span>
            <span class="rb-role-team">${title(printed.team)} · ${title(printed.archetype)}</span>
          </button>`;
      }).join('');
      // Scrubbing back past the moment somebody was added closes their sheet
      // rather than leaving a panel about a character who is not there yet.
      if (openRoleId && !roleIds.includes(openRoleId)) openRoleId = null;
    }

    for (const button of $('role-rail').children) {
      button.setAttribute('aria-pressed', String(button.dataset.role === openRoleId));
    }
    renderRoleSheet(state);
  }

  /**
   * One sheet, or none.
   *
   * Mounted on demand and rebuilt on every move, so "only the role you clicked
   * is on screen" is a thing the code does rather than a thing it has to
   * remember to keep doing. It is the same `<rb-private-sheet>` that player
   * had open at the table, given a real player projection — a panel that
   * summarised a role its own way could quietly disagree with the sheet they
   * were reading, which is exactly the argument a replay exists to settle.
   */
  function renderRoleSheet(state) {
    const panel = $('role-panel');
    if (!openRoleId) {
      panel.replaceChildren();
      panel.hidden = true;
      return;
    }
    const sheet = document.createElement('rb-private-sheet');
    sheet.data = data;
    sheet.view = projectView(state, data, viewerFor(state, openRoleId));
    panel.replaceChildren(sheet);
    panel.hidden = false;
  }

  /**
   * Whose eyes the sheet is drawn through.
   *
   * The seat is looked up in the replayed state first and in the save's own
   * roster second. Seats are not commanded and so are not in the log — they
   * ride alongside it — and the log's version is only whoever the reducer had
   * to invent to admit a command.
   */
  function viewerFor(state, roleId) {
    const seat = Object.values(state.seats ?? {}).find((s) => s.roleId === roleId)
      ?? Object.values(save.seats ?? {}).find((s) => s.roleId === roleId);
    return {
      kind: 'player',
      seatId: seat?.id ?? null,
      roleId,
      teamId: state.roles[roleId]?.teamId ?? null,
    };
  }

  $('role-rail').addEventListener('click', (event) => {
    const button = event.target.closest('[data-role]');
    if (!button) return;
    // Clicking the open one shuts it. The rail is a row of toggles rather than
    // a choice there is no way back out of.
    openRoleId = openRoleId === button.dataset.role ? null : button.dataset.role;
    renderRoles();
  });

  // --- the controls ---------------------------------------------------------

  const goTo = (position) => { cursor.seek(position); render(); };

  $('to-start').addEventListener('click', () => goTo(0));
  $('to-end').addEventListener('click', () => goTo(cursor.length));
  for (const [id, by] of [['step-back', -1], ['step-forward', 1],
    ['skip-back', -SKIP], ['skip-forward', SKIP]]) {
    $(id).addEventListener('click', () => goTo(cursor.position + by));
  }
  $('scrub').addEventListener('input', (event) => goTo(Number(event.target.value)));
  $('history').addEventListener('click', (event) => {
    const button = event.target.closest('[data-at]');
    if (button) goTo(Number(button.dataset.at));
  });

  // --- drawing whatever the cursor is on ------------------------------------

  function viewNow() {
    // A facilitator's projection: unredacted, and carrying the derived values
    // the map tints itself from and the tracker counts. See the header — the
    // file this page was handed holds every secret in it already.
    return projectView(cursor.state, data, { kind: 'facilitator' });
  }

  function render() {
    const view = viewNow();
    for (const map of maps) {
      map.data = data;
      map.view = view;
      fillCard(map, view);
    }
    $('aftermath').view = view;

    $('scrub').value = String(cursor.position);
    $('replay-position').textContent = cursor.position === 0
      ? `Before anything happened — ${cursor.length} action${cursor.length === 1 ? '' : 's'} to come`
      : `After ${cursor.position} of ${cursor.length} actions`;

    const atStart = cursor.position === 0;
    const atEnd = cursor.position === cursor.length;
    for (const id of ['to-start', 'skip-back', 'step-back']) $(id).disabled = atStart;
    for (const id of ['to-end', 'skip-forward', 'step-forward']) $(id).disabled = atEnd;

    markHistory();
    renderRoles();
  }

  const nameOf = (roleId) => data.roles.roles[roleId]?.name ?? roleId;

  show('open');
}

const title = (text) => String(text ?? '').replace(/_/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());

/** Join codes are minted, but names and refusal reasons are prose. */
function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
