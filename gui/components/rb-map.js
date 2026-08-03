/**
 * <rb-map> — the three printed sheets, with the live game laid over them.
 *
 * The artwork is the product's face, so it stays: each sheet is the exported
 * PNG with an SVG overlay on top, sharing one 1191x1684 viewBox so they line
 * up at any size. The overlay carries the only things that change — who holds
 * a shire, whether they have support, how many castles are left, which
 * settlements are still standing — and nothing else.
 *
 * Redrawing eighteen shires as vectors would have cost days and looked worse.
 * The outlines exist because a click needs a hit target and a faction needs a
 * tint, not because anyone wanted to replace the map.
 *
 * Read-only. It renders a projection and raises an event when a shire is
 * chosen; it never decides anything.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Faction tints, keyed by the initials printed in a support box. */
const FACTION_TINT = {
  W: '#2f6fa8',      // Wessex
  M: '#8a6d1f',      // Mercia
  D: '#8f2d2d',      // the Danish invasion
  N: '#5b4a86',      // Northumbria
  Be: '#5b4a86',
  Ea: '#8f2d2d',
  Ex: '#2f6fa8',
  K: '#2f6fa8',
  L: '#8a6d1f',
  Sx: '#2f6fa8',
};

const SETTLEMENT_MARK = { farm: 'F', town: 'T', church: 'C' };

export class RbMap extends HTMLElement {
  static observedAttributes = ['sheet'];

  /** The static dataset: shires, factions, roles, geometry. */
  set data(value) { this._data = value; this._render(); }

  /** The current projection. */
  set view(value) { this._view = value; this._render(); }

  get sheet() { return this.getAttribute('sheet') || 'northern'; }

  connectedCallback() {
    if (!this._built) this._build();
    this._render();
  }

  attributeChangedCallback() { this._render(); }

  _build() {
    this._built = true;
    this.innerHTML = `
      <div class="rb-map-tabs" role="tablist"></div>
      <div class="rb-map-stage">
        <img class="rb-map-art" alt="" decoding="async">
        <svg class="rb-map-overlay" xmlns="${SVG_NS}" preserveAspectRatio="xMidYMid meet"></svg>
      </div>`;

    this.querySelector('.rb-map-tabs').addEventListener('click', (event) => {
      const button = event.target.closest('[data-sheet]');
      if (button) this.setAttribute('sheet', button.dataset.sheet);
    });

    this.querySelector('.rb-map-overlay').addEventListener('click', (event) => {
      const shire = event.target.closest('[data-shire]');
      if (!shire) return;
      this._selected = shire.dataset.shire;
      this._render();
      this.dispatchEvent(new CustomEvent('rb-shire', {
        bubbles: true, detail: { shireId: this._selected },
      }));
    });
  }

  _render() {
    if (!this.isConnected || !this._built || !this._data || !this._view) return;
    const { shires: statics, geometry } = this._data;
    if (!geometry) return;

    this._renderTabs();

    const [width, height] = geometry.viewBox;
    const art = this.querySelector('.rb-map-art');
    art.src = `assets/maps/${this.sheet}.png`;
    art.alt = `${this.sheet} England`;

    const svg = this.querySelector('.rb-map-overlay');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.replaceChildren();

    for (const [id, printed] of Object.entries(statics.shires)) {
      if (printed.map !== this.sheet) continue;
      const outline = geometry.shires[id];
      const live = this._view.shires?.[id];
      if (!outline?.polygon || !live) continue;

      svg.append(this._shirePath(id, printed, live, outline));
      svg.append(this._shireTokens(id, printed, live, outline));
    }
  }

  _renderTabs() {
    const tabs = this.querySelector('.rb-map-tabs');
    const sheets = this._data.shires.sheets ?? [];
    if (tabs.childElementCount === sheets.length) {
      for (const button of tabs.children) {
        button.setAttribute('aria-selected', String(button.dataset.sheet === this.sheet));
      }
      return;
    }
    tabs.innerHTML = sheets.map((sheet) => `
      <button type="button" role="tab" data-sheet="${sheet.id}"
              aria-selected="${sheet.id === this.sheet}">${sheet.display_name}</button>`).join('');
  }

  _shirePath(id, printed, live, outline) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', outline.polygon);
    path.setAttribute('class', 'rb-shire');
    path.dataset.shire = id;
    if (id === this._selected) path.classList.add('is-selected');

    // Tinted by whoever holds it. An unheld shire, or one whose holder has no
    // faction, is left as the printed parchment.
    const steward = live.stewardRoleId;
    const factions = this._view.derived?.roles?.[steward]?.factions ?? [];
    const tint = factions.map((f) => FACTION_TINT[f]).find(Boolean);
    if (tint) path.setAttribute('color', tint);

    // Without support, defended settlements pay nothing and the shire counts
    // toward Disorder — worth seeing on the board rather than only in a table.
    if (steward && this._view.derived?.shires?.[id]?.supported === false) {
      path.classList.add('is-unsupported');
    }

    const stewardName = steward
      ? this._data.roles.roles[steward]?.name ?? steward
      : 'nobody';
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = `${printed.name} — ${stewardName}, ${live.castles} castles, `
      + `support ${printed.support.join('/')}`;
    path.append(title);
    return path;
  }

  _shireTokens(id, printed, live, outline) {
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'rb-shire-tokens');
    const [x0, , x1, y1] = outline.frame;

    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('class', 'rb-shire-label');
    label.setAttribute('x', (x0 + x1) / 2);
    label.setAttribute('y', y1 + 64);
    const castles = '⌂'.repeat(Math.max(0, live.castles));
    label.textContent = `${castles}${live.missionaryCross ? '  †' : ''}`;
    group.append(label);

    // A destroyed settlement is struck through rather than removed: the
    // printed letter is still on the paper, and its absence is the point.
    const settlements = Object.values(live.settlements ?? {});
    settlements.forEach((settlement, index) => {
      const at = outline.settlements?.[index];
      if (!at || !settlement.destroyed) return;
      const mark = document.createElementNS(SVG_NS, 'text');
      mark.setAttribute('class', 'rb-settlement-gone');
      mark.setAttribute('x', at[0]);
      mark.setAttribute('y', at[1]);
      mark.textContent = '×';
      mark.append(titleFor(`${SETTLEMENT_MARK[settlement.type]} destroyed`));
      group.append(mark);
    });

    return group;
  }
}

function titleFor(text) {
  const title = document.createElementNS(SVG_NS, 'title');
  title.textContent = text;
  return title;
}

customElements.define('rb-map', RbMap);
