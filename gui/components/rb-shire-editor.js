/**
 * <rb-shire-editor> — the facilitator's pencil over the map.
 *
 * The map is read-only in a player's hands and has to stop being read-only in
 * a facilitator's. This is the panel that appears beside it once a shire is
 * clicked: who stewards it, how many castles are left, what it costs to reach
 * by sea, and which settlements are circled or struck through — the things a
 * paper umpire would simply write on the map in pencil.
 *
 * Reads the whole state directly rather than a projection, because a
 * facilitator's own view already is the whole state. Every change still goes
 * out as an ordinary command through `rb-facilitate`, so it lands in the log
 * and replays like anything a player did.
 */

export class RbShireEditor extends HTMLElement {
  set data(value) { this._data = value; this._render(); }

  set state(value) { this._state = value; this._render(); }

  /** Which shire is open, chosen by clicking the map beside this panel. */
  set shireId(value) { this._shireId = value; this._render(); }

  connectedCallback() { this._render(); }

  _emit(verb, payload) {
    this.dispatchEvent(new CustomEvent('rb-facilitate', { bubbles: true, detail: { verb, payload } }));
  }

  _render() {
    if (!this.isConnected || !this._data || !this._state) return;
    if (!this._shireId) {
      this.innerHTML = '<p class="rb-empty">Choose a shire on the map to edit it.</p>';
      return;
    }

    const shireId = this._shireId;
    const shire = this._state.shires[shireId];
    const printed = this._data.shires.shires[shireId];
    if (!shire || !printed) {
      this.innerHTML = '<p class="rb-empty">Choose a shire on the map to edit it.</p>';
      return;
    }

    const nameOf = (id) => this._data.roles.roles[id]?.name ?? id;
    const roles = Object.keys(this._state.roles).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));

    this.innerHTML = `
      <h3>${escape(printed.name)}</h3>

      <label class="rb-editor-row">Steward
        <select data-steward="${shireId}">
          <option value="">nobody</option>
          ${roles.map((id) => `<option value="${id}"
            ${shire.stewardRoleId === id ? 'selected' : ''}>${escape(nameOf(id))}</option>`).join('')}
        </select>
      </label>

      <div class="rb-inspector-stat">
        <span class="rb-inspector-stat-label">Castles</span>
        <span class="rb-inspector-stat-value">${shire.castles}</span>
        <input type="number" step="1" placeholder="+/-" data-adjust="shires.${shireId}.castles">
        <button type="button" data-commit-adjust="shires.${shireId}.castles">Commit</button>
        <span class="rb-inspector-error" data-error-for="shires.${shireId}.castles"></span>
      </div>

      ${printed.shipCost === null ? '' : `
        <div class="rb-inspector-stat">
          <span class="rb-inspector-stat-label">Ship value</span>
          <span class="rb-inspector-stat-value">${printed.shipCost + (shire.shipCostDelta ?? 0)}</span>
          <input type="number" step="1" placeholder="+/-" data-adjust="shires.${shireId}.shipCostDelta">
          <button type="button" data-commit-adjust="shires.${shireId}.shipCostDelta">Commit</button>
          <span class="rb-inspector-error" data-error-for="shires.${shireId}.shipCostDelta"></span>
        </div>
        <p class="rb-meta">Printed at ${printed.shipCost}. A contract or a defensive
          fleet already moves this — this adjusts it further, on top of either.</p>`}

      <h4>Settlements</h4>
      <ul class="rb-editor-settlements">
        ${Object.values(shire.settlements).map((settlement) => `
          <li data-destroyed="${settlement.destroyed}">
            <span>${title(settlement.type)}</span>
            <label><input type="checkbox" data-settlement="${shireId}|${settlement.id}|defended"
              ${settlement.defended ? 'checked' : ''}> defended</label>
            <label><input type="checkbox" data-settlement="${shireId}|${settlement.id}|destroyed"
              ${settlement.destroyed ? 'checked' : ''}> destroyed</label>
          </li>`).join('')}
      </ul>`;

    this.querySelector('[data-steward]').onchange = (event) => {
      this._emit('facilitator:set-steward', { shireId, roleId: event.target.value || null });
    };
    for (const button of this.querySelectorAll('[data-commit-adjust]')) {
      button.onclick = () => this._commitAdjust(button);
    }
    for (const input of this.querySelectorAll('[data-settlement]')) {
      input.onchange = () => {
        const [sid, settlementId, field] = input.dataset.settlement.split('|');
        this._emit('facilitator:set-settlement',
          { shireId: sid, settlementId, field, value: input.checked });
      };
    }
  }

  _commitAdjust(button) {
    const path = button.dataset.commitAdjust;
    const input = this.querySelector(`[data-adjust="${cssEscape(path)}"]`);
    const error = this.querySelector(`[data-error-for="${cssEscape(path)}"]`);
    const delta = Number(input.value);
    if (!input.value.trim() || !Number.isFinite(delta) || delta === 0) {
      if (error) error.textContent = 'enter a nonzero amount, positive or negative';
      return;
    }
    if (error) error.textContent = '';
    input.value = '';
    this._emit('facilitator:adjust', { path: path.split('.'), delta });
  }
}

const title = (text) => String(text ?? '').replace(/_/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());

function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cssEscape(text) {
  return String(text).replace(/["\\]/g, '\\$&');
}

customElements.define('rb-shire-editor', RbShireEditor);
