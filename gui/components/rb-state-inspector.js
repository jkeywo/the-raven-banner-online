/**
 * <rb-state-inspector> — the umpire's hand, reaching into the game.
 *
 * It exists because the app will get something wrong during a game, and the
 * alternative to fixing it is a room of sixteen people watching a facilitator
 * apologise. A paper megagame has never had this problem: the umpire simply
 * crosses out a number. This is that pencil.
 *
 * One card per role for the things that actually come up — resources, wounds,
 * claims, a mercenary card, an initiative token, and which shires they steward
 * — each with a human-readable name rather than a dotted path. A number is
 * adjusted rather than replaced: type how much to change it by and commit,
 * and the change lands against whatever the value actually is at that
 * moment, not whatever it was when the facilitator opened the panel. That is
 * what keeps an edit from quietly undoing something a player did in between
 * — an absolute "set it to 40" cannot tell the difference between "was 12,
 * should be 40" and "was 12, a player just spent 8 of it, should now be 32";
 * an adjustment of "+28" can, because it does not need to know which one it
 * started from.
 *
 * Every edit goes out through the ordinary command pipeline, so it lands in
 * the log tagged as an override and a replay reproduces it. That is what
 * stops "the facilitator can change anything" from meaning "the history is a
 * polite fiction".
 */

/** The numbers a role card offers to adjust, in the order a sheet lists them. */
const STATS = [
  ['momentum', 'Momentum'], ['silver', 'Silver'], ['food', 'Food'],
  ['soldiers', 'Soldiers'], ['ships', 'Ships'], ['wounds', 'Wounds'],
];

import { TOKENS } from '../rules/state.js';

export class RbStateInspector extends HTMLElement {
  set state(value) {
    this._state = value;
    this._render();
  }

  /** The static dataset. Only the per-role cards and the add-role form need it. */
  set data(value) {
    this._data = value;
    this._render();
  }

  connectedCallback() {
    if (!this._built) {
      this._built = true;
      this.innerHTML = `
        <div class="rb-inspector-cards"></div>
        <div class="rb-inspector-addrole"></div>`;
    }
    this._render();
  }

  _emit(verb, payload) {
    this.dispatchEvent(new CustomEvent('rb-facilitate', { bubbles: true, detail: { verb, payload } }));
  }

  _render() {
    if (!this.isConnected || !this._built || !this._state) return;
    this._renderCards();
    this._renderAddRole();
  }

  // --- one card per role ----------------------------------------------------

  _renderCards() {
    const host = this.querySelector('.rb-inspector-cards');
    if (!this._data) { host.innerHTML = ''; return; }

    const roles = Object.values(this._state.roles ?? {})
      .sort((a, b) => (this._data.roles.roles[a.id]?.name ?? a.id)
        .localeCompare(this._data.roles.roles[b.id]?.name ?? b.id));

    host.innerHTML = `<h4>One card per role</h4>
      <div class="rb-inspector-cardgrid">${roles.map((role) => this._card(role)).join('')}</div>`;

    for (const button of host.querySelectorAll('[data-commit-adjust]')) {
      button.onclick = () => this._commitAdjust(button);
    }
    for (const button of host.querySelectorAll('[data-remove-role]')) {
      button.onclick = () => {
        // eslint-disable-next-line no-alert
        if (globalThis.confirm?.(
          `Take ${button.dataset.name} out of the game? Their lands go unheld.`) === false) return;
        this._emit('facilitator:remove-role', { roleId: button.dataset.removeRole });
      };
    }
    for (const button of host.querySelectorAll('[data-remove-claim]')) {
      button.onclick = () => {
        const [roleId, crown] = button.dataset.removeClaim.split('|');
        this._emit('facilitator:remove-claim', { roleId, crown });
      };
    }
    for (const form of host.querySelectorAll('[data-add-claim]')) {
      form.onsubmit = (event) => {
        event.preventDefault();
        this._emit('facilitator:add-claim',
          { roleId: form.dataset.addClaim, crown: form.elements.crown.value });
      };
    }
    for (const input of host.querySelectorAll('[data-mercenary]')) {
      input.onchange = () => this._emit('facilitator:set',
        { path: ['roles', input.dataset.mercenary, 'mercenary'], value: input.checked });
    }
    for (const input of host.querySelectorAll('[data-token]')) {
      input.onchange = () => {
        const [token, roleId] = input.dataset.token.split('|');
        this._emit('facilitator:assign-initiative', { token, roleId: input.checked ? roleId : null });
      };
    }
  }

  _card(role) {
    const printed = this._data.roles.roles[role.id] ?? {};
    const crowns = Object.keys(this._data.factions.crownLetter ?? {});
    const available = crowns.filter((c) => !role.claims.includes(c));
    const steward = Object.entries(this._state.shires)
      .filter(([, s]) => s.stewardRoleId === role.id)
      .map(([id]) => this._data.shires.shires[id]?.name ?? id)
      .sort((a, b) => a.localeCompare(b));
    // One role, one token, so the other boxes are disabled rather than left
    // clickable-and-then-refused: the panel says the rule instead of the log
    // saying it afterwards, the same greying the player's action list does.
    //
    // But it reads every token rather than asking which one they hold, because
    // this panel is the pencil the rest of the design defers to. `settleBattle`
    // stands aside for "the facilitator moves it by hand", `seizeInitiative`
    // does the same, and `facilitator:set-initiative-target` refuses a double
    // hold with "clear one first" — all three are pointing here. A panel that
    // showed only the first of two counters would be pointing at a stray it
    // had itself made invisible, and unclearable from any card on the grid.
    const holds = TOKENS.filter((token) => this._state.initiative?.[token] === role.id);

    return `
      <article class="rb-inspector-card">
        <header>
          <h5>${escape(printed.name ?? role.id)}${role.dead ? ' <span class="rb-warn">dead</span>' : ''}</h5>
          <span class="rb-meta">${title(printed.archetype)} · ${title(printed.team)}</span>
        </header>

        <div class="rb-inspector-stats">${STATS.map(([key, label]) => `
          <div class="rb-inspector-stat">
            <span class="rb-inspector-stat-label">${label}</span>
            <span class="rb-inspector-stat-value">${role[key] ?? 0}</span>
            <input type="number" step="1" placeholder="+/-" data-adjust="roles.${role.id}.${key}">
            <button type="button" data-commit-adjust="roles.${role.id}.${key}">Commit</button>
            <span class="rb-inspector-error" data-error-for="roles.${role.id}.${key}"></span>
          </div>`).join('')}
        </div>

        <div class="rb-inspector-stewardship">
          <span class="rb-inspector-stat-label">Stewards</span>
          <ul class="rb-inspector-steward-list">${steward.map((name) => `
            <li>${escape(name)}</li>`).join('') || '<li class="rb-empty">no shires</li>'}
          </ul>
        </div>

        <div class="rb-inspector-claims">
          <span class="rb-inspector-stat-label">Claims</span>
          <ul class="rb-inspector-claim-list">${role.claims.map((c) => `
            <li>${title(c)}
              <button type="button" data-remove-claim="${role.id}|${c}" aria-label="Remove ${title(c)}">×</button>
            </li>`).join('') || '<li class="rb-empty">none</li>'}
          </ul>
          ${available.length ? `
            <form data-add-claim="${role.id}">
              <select name="crown">${available.map((c) => `<option value="${c}">${title(c)}</option>`).join('')}</select>
              <button type="submit">Add claim</button>
            </form>` : ''}
        </div>

        <label class="rb-inspector-toggle">
          <input type="checkbox" data-mercenary="${role.id}" ${role.mercenary ? 'checked' : ''}>
          Holds a mercenary card
        </label>

        <fieldset class="rb-inspector-tokens">
          <legend>Initiative token</legend>
          ${TOKENS.map((token) => `
            <label><input type="checkbox" data-token="${token}|${role.id}"
              ${holds.includes(token) ? 'checked' : ''}
              ${holds.length && !holds.includes(token) ? 'disabled' : ''}> ${title(token)}</label>`).join('')}
        </fieldset>
        ${holds.length > 1 ? `<p class="rb-meta rb-warn">Holding the ${holds.join(' and ')}
          tokens — one of those is a stray. Uncheck it.</p>`
    : holds.length ? `<p class="rb-meta">Holding the ${holds[0]} token — uncheck it before
          moving them onto another.</p>` : ''}

        <button type="button" class="rb-inspector-remove"
          data-remove-role="${role.id}" data-name="${escape(printed.name ?? role.id)}">
          Remove from game
        </button>
      </article>`;
  }

  _commitAdjust(button) {
    const path = button.dataset.commitAdjust;
    const card = button.closest('.rb-inspector-card, .rb-inspector-addrole-form') ?? this;
    const input = card.querySelector(`[data-adjust="${cssEscape(path)}"]`);
    const error = card.querySelector(`[data-error-for="${cssEscape(path)}"]`);
    const delta = Number(input.value);
    if (!input.value.trim() || !Number.isFinite(delta) || delta === 0) {
      if (error) error.textContent = 'enter a nonzero amount, positive or negative';
      return;
    }
    if (error) error.textContent = '';
    input.value = '';
    this._emit('facilitator:adjust', { path: path.split('.'), delta });
  }

  // --- bringing somebody into a game already running ------------------------

  _renderAddRole() {
    const host = this.querySelector('.rb-inspector-addrole');
    if (!this._data) { host.innerHTML = ''; return; }

    const missing = Object.keys(this._data.roles.roles).filter((id) => !this._state.roles[id]);
    if (!missing.length) {
      host.innerHTML = '<h4>Add a role</h4><p class="rb-empty">Everyone printed is already in the game.</p>';
      return;
    }

    const selected = missing.includes(this._addRoleId) ? this._addRoleId : missing[0];
    const printed = this._data.roles.roles[selected];
    const stewardship = Object.entries(this._data.shires.shires)
      .filter(([, s]) => s.initialSteward === selected)
      .map(([id, s]) => {
        const holder = this._state.shires[id]?.stewardRoleId;
        return {
          id,
          name: s.name,
          note: holder ? ` — currently ${this._data.roles.roles[holder]?.name ?? holder}` : '',
        };
      });

    host.innerHTML = `
      <h4>Add a role</h4>
      <label>Bring back
        <select id="rb-inspector-addrole-pick">${missing.map((id) => `
          <option value="${id}" ${id === selected ? 'selected' : ''}>${this._data.roles.roles[id].name}</option>`).join('')}
        </select>
      </label>
      <form class="rb-inspector-addrole-form" data-add-role="${selected}">
        <p class="rb-meta">Prefilled from the printed sheet. Change anything before committing.</p>
        <div class="rb-inspector-stats">${['momentum', 'silver', 'food', 'soldiers', 'ships']
    .map((key) => `
          <label class="rb-inspector-stat">
            <span class="rb-inspector-stat-label">${title(key)}</span>
            <input type="number" min="0" name="${key}" value="${printed.start[key] ?? 0}">
          </label>`).join('')}
        </div>
        <fieldset>
          <legend>Claims</legend>
          ${printed.claims.length ? printed.claims.map((c) => `
            <label><input type="checkbox" name="claim" value="${c}" checked> ${title(c)}</label>`).join('')
    : '<p class="rb-empty">none printed</p>'}
        </fieldset>
        <fieldset>
          <legend>Stewardship</legend>
          ${stewardship.length ? stewardship.map((s) => `
            <label><input type="checkbox" name="steward" value="${s.id}" checked>
              ${escape(s.name)}${escape(s.note)}</label>`).join('')
    : '<p class="rb-empty">no printed lands</p>'}
        </fieldset>
        <button type="submit" class="rb-primary">Add to the game</button>
      </form>`;

    host.querySelector('#rb-inspector-addrole-pick').onchange = (event) => {
      this._addRoleId = event.target.value;
      this._renderAddRole();
    };
    host.querySelector('[data-add-role]').onsubmit = (event) => {
      event.preventDefault();
      const form = event.target;
      const resources = {};
      for (const key of ['momentum', 'silver', 'food', 'soldiers', 'ships']) {
        resources[key] = Math.max(0, Number(form.elements[key].value) || 0);
      }
      const claims = [...form.querySelectorAll('input[name="claim"]:checked')].map((i) => i.value);
      const stewards = [...form.querySelectorAll('input[name="steward"]:checked')].map((i) => i.value);
      this._emit('facilitator:add-role',
        { roleId: form.dataset.addRole, resources, claims, stewardship: stewards });
      this._addRoleId = null;
    };
  }
}

const title = (text) => String(text ?? '').replace(/_/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());

function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** A dotted path used verbatim in a CSS attribute selector needs its own escaping. */
function cssEscape(text) {
  return String(text).replace(/["\\]/g, '\\$&');
}

customElements.define('rb-state-inspector', RbStateInspector);
