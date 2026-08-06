/**
 * <rb-map> — the three printed sheets as vector art, with the live game in the
 * cells the art no longer carries.
 *
 * The sheets are the exported SVGs from `tools/export_maps_svg.py`, which are
 * the printed artwork with the state-bearing cells cut out of it: the steward
 * frame, the support strip, the castle stack and every settlement letter are
 * blank parchment now. `assets/maps/cells.json` says where those cells were.
 * So the art and the overlay are not two pictures of the same fact any more —
 * the art is the geography and the overlay is the game, and neither can
 * contradict the other because neither draws what the other draws.
 *
 * Art and overlay live inside one `<svg>` rather than an image with a second
 * SVG floating over it. They shared a viewBox before and lined up because two
 * elements agreed about `preserveAspectRatio`; now they share a coordinate
 * system and cannot come apart at all.
 *
 * **Blank until it differs.** A shire the game has not moved draws nothing —
 * no tint, no name, no castles, no letters. Turn zero is a quiet board, which
 * is what makes the first burned farm impossible to miss. The predicate is in
 * `gui/rules/map-state.js` and is testable without any of this. The outline is
 * still there under the parchment, because a click needs a target whether or
 * not anything has happened yet, and because the chooser has to be able to
 * point at shires an action could reach.
 *
 * Read-only in itself. It renders a projection, raises `rb-shire` when a shire
 * is chosen, and shows whatever the page around it parked in `slot="card"` —
 * the player's read-out, or the facilitator's editor. It never decides
 * anything.
 */

import { shireDeviations } from '../rules/map-state.js';

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

/** The letters the printed sheet's own legend explains. */
const SETTLEMENT_LETTER = { farm: 'F', town: 'T', church: 'C' };

/** Roughly how many characters of a steward's name fit across a frame. */
const NAME_WRAP = 14;

export class RbMap extends HTMLElement {
  static observedAttributes = ['sheet'];

  /** The static dataset: shires, factions, roles, geometry, map cells. */
  set data(value) { this._data = value; this._render(); }

  /** The current projection. */
  set view(value) { this._view = value; this._render(); }

  /**
   * Shires worth pointing a player's eye at right now — the valid targets of
   * an action they have just picked. Presentation only: clicking one of these
   * still goes through the same `rb-shire` event as clicking any other, and it
   * works on a blank shire, which is the point of keeping the outlines.
   */
  set highlighted(ids) {
    this._highlighted = ids ? new Set(ids) : null;
    this._render();
  }

  get sheet() { return this.getAttribute('sheet') || 'northern'; }

  /** Which shire the card is open on, if any. */
  get selected() { return this._selected ?? null; }

  /**
   * Where the page puts what it wants said about the selected shire.
   *
   * There is no shadow DOM anywhere in this codebase, so `slot="card"` is
   * honoured by hand: anything parked inside `<rb-map>` with that attribute is
   * carried into the card when the component builds itself. The map positions
   * the card and decides when it is on screen; it has no opinion about what is
   * in it, which is how one renderer serves a player who may only read and a
   * facilitator who must be able to write.
   */
  get card() {
    if (!this._built) this._build();
    return this.querySelector('.rb-map-card-body');
  }

  connectedCallback() {
    if (!this._built) this._build();
    this._render();
  }

  attributeChangedCallback() { this._render(); }

  _build() {
    this._built = true;
    // Taken out before the markup below replaces our children. The nodes
    // survive being detached; the references are what matters.
    const parked = [...this.children].filter((child) => child.getAttribute('slot') === 'card');

    this.innerHTML = `
      <div class="rb-map-tabs" role="tablist"></div>
      <div class="rb-map-stage">
        <svg class="rb-map-sheet" xmlns="${SVG_NS}" preserveAspectRatio="xMidYMid meet">
          <g class="rb-map-overlay"></g>
        </svg>
        <div class="rb-map-card" hidden>
          <button type="button" class="rb-map-card-close" aria-label="Close">×</button>
          <div class="rb-map-card-body"></div>
        </div>
      </div>`;

    // Built rather than written into the markup above: `<image>` inside an
    // HTML-parsed `<svg>` is a corner of the parser worth not relying on.
    const art = document.createElementNS(SVG_NS, 'image');
    art.setAttribute('class', 'rb-map-art');
    art.setAttribute('x', '0');
    art.setAttribute('y', '0');
    art.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.querySelector('.rb-map-sheet').prepend(art);

    this.querySelector('.rb-map-card-body').append(...parked);

    this.querySelector('.rb-map-tabs').addEventListener('click', (event) => {
      const button = event.target.closest('[data-sheet]');
      if (button) this.setAttribute('sheet', button.dataset.sheet);
    });

    // One listener for the whole sheet. A click that lands on nothing is a
    // click that closes the card, which is the gesture people already expect
    // from a map: tap a county, tap the sea to put it away.
    this.querySelector('.rb-map-sheet').addEventListener('click', (event) => {
      const hit = event.target.closest('[data-shire]');
      this._select(hit ? hit.dataset.shire : null);
    });

    this.querySelector('.rb-map-card-close').addEventListener('click', () => this._select(null));
  }

  /**
   * Announced before it is drawn, on purpose.
   *
   * The page fills the card in response to this event, and the card is placed
   * by measuring it — so a render that ran first would be measuring the
   * previous shire's card and would put a taller one off the bottom of the
   * sheet.
   */
  _select(shireId) {
    this._selected = shireId;
    this.dispatchEvent(new CustomEvent('rb-shire', {
      bubbles: true, detail: { shireId },
    }));
    this._render();
  }

  _render() {
    if (!this.isConnected || !this._built || !this._data || !this._view) return;
    const { geometry, cells } = this._data;
    if (!geometry) return;

    this._renderTabs();

    const [width, height] = geometry.viewBox;
    const svg = this.querySelector('.rb-map-sheet');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    // Width and height as attributes as well, so the element has an intrinsic
    // aspect ratio to be sized from rather than collapsing to nothing.
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);

    const art = this.querySelector('.rb-map-art');
    art.setAttribute('href', `assets/maps/${this.sheet}.svg`);
    art.setAttribute('width', width);
    art.setAttribute('height', height);

    const sheetCells = cells?.sheets?.[this.sheet] ?? {};
    const overlay = this.querySelector('.rb-map-overlay');
    overlay.replaceChildren();

    for (const [id, printed] of Object.entries(this._data.shires.shires)) {
      if (printed.map !== this.sheet) continue;
      const outline = geometry.shires[id];
      const live = this._view.shires?.[id];
      if (!outline?.polygon || !live) continue;

      const moved = shireDeviations(this._view, this._data, id);
      overlay.append(this._shirePath(id, printed, live, outline, moved));
      if (moved.length) {
        overlay.append(this._shireCells(id, printed, live, sheetCells[id], outline, moved));
      }
    }

    for (const ghost of sheetCells.ghosts ?? []) {
      const drawn = this._ghost(ghost);
      if (drawn) overlay.append(drawn);
    }

    this._renderCard(sheetCells, width, height);
  }

  /**
   * The sheet row, unless the page around it provides its own.
   *
   * The player console promotes these three into its main tab bar, where they
   * replace what used to be a single "The board" tab — so the map must not
   * also draw them underneath. The facilitator's map has no such bar and keeps
   * them. `tabs="off"` is the seam.
   */
  _renderTabs() {
    const tabs = this.querySelector('.rb-map-tabs');
    if (this.getAttribute('tabs') === 'off') { tabs.hidden = true; return; }
    const sheets = this._data.shires.sheets ?? [];
    if (tabs.childElementCount === sheets.length) {
      for (const button of tabs.children) {
        button.setAttribute('aria-selected', String(button.dataset.sheet === this.sheet));
      }
      return;
    }
    tabs.innerHTML = sheets.map((sheet) => `
      <button type="button" role="tab" data-sheet="${sheet.id}"
              aria-selected="${sheet.id === this.sheet}">${sheetLabel(sheet.display_name)}</button>`).join('');
  }

  /**
   * The hit target, and the tint when there is something to tint.
   *
   * Always drawn, whether or not the shire has moved. A blank shire is
   * transparent rather than absent: the chooser still points at it, a click
   * still opens it, and the printed parchment shows through.
   */
  _shirePath(id, printed, live, outline, moved) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', outline.polygon);
    path.setAttribute('class', 'rb-shire');
    path.dataset.shire = id;
    path.dataset.moved = String(moved.length > 0);
    if (moved.length) path.classList.add('is-live');
    if (id === this._selected) path.classList.add('is-selected');
    if (this._highlighted?.has(id)) path.classList.add('is-highlighted');

    // Tinted by whoever holds it, and only once the game has moved it. An
    // unheld shire, or one whose holder has no faction, keeps the parchment.
    if (moved.length) {
      const tint = this._tintFor(live.stewardRoleId);
      if (tint) path.setAttribute('color', tint);
      // Without support, defended settlements pay nothing and the shire counts
      // toward Disorder — worth seeing on the board rather than only in a
      // table. Hatched only where losing it was something that happened.
      if (moved.includes('support') && this._supported(id) === false) {
        path.classList.add('is-unsupported');
      }
    }

    path.append(titleFor(`${printed.name} — ${this._describe(id, printed, live)}`));
    return path;
  }

  /** The cells the printed sheet used to fill in, filled in from state. */
  _shireCells(id, printed, live, cell, outline, moved) {
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'rb-shire-cells');
    group.dataset.shire = id;

    const frame = cell?.frame ?? frameOf(outline);
    if (frame) {
      group.append(...this._frameCell(id, printed, live, frame, moved));
      if (cell?.support) group.append(this._supportCell(id, printed, cell.support));
      if (cell?.castles) group.append(...castleStack(cell.castles, live.castles));
    }

    printed.settlements.forEach((was, index) => {
      const at = cell?.settlements?.[index] ?? anchorOf(outline, index);
      const now = live.settlements?.[was.id];
      if (!at || !now) return;
      group.append(settlementMark(at, now, was));
    });

    return group;
  }

  /** Who holds it, what they speak for, and anything printed that is now wrong. */
  _frameCell(id, printed, live, frame, moved) {
    const nodes = [];
    const midX = (frame.x0 + frame.x1) / 2;
    const steward = live.stewardRoleId;
    const name = steward
      ? this._data.roles.roles[steward]?.name ?? steward
      : 'unheld';

    const lines = wrapWords(name, NAME_WRAP);
    lines.forEach((line, index) => {
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('class', 'rb-cell-steward');
      text.setAttribute('x', midX);
      text.setAttribute('y', frame.y0 + 30 + index * 22 - (lines.length - 1) * 8);
      text.textContent = line;
      nodes.push(text);
    });

    // What they speak for, which is the other half of reading the support
    // strip below: the letters in the box only mean anything against these.
    const factions = this._factionsOf(steward);
    if (factions.length) {
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('class', 'rb-cell-factions');
      text.setAttribute('x', midX);
      text.setAttribute('y', frame.y1 - 9);
      text.textContent = factions.join(' ');
      nodes.push(text);
    }

    if (live.missionaryCross) {
      const cross = missionaryCross(frame.x1 - 15, frame.y0 + 16);
      cross.append(titleFor('Christian missionaries have planted a cross here'));
      nodes.push(cross);
    }

    // The printed ship number is still on the artwork — it was never a cell —
    // so when a contract or a defensive fleet moves it, the sheet is quietly
    // lying. Say the real one where the frame has room.
    if (moved.includes('shipCost')) {
      const cost = this._view.derived?.shires?.[id]?.shipCost;
      if (cost !== null && cost !== undefined) {
        const text = document.createElementNS(SVG_NS, 'text');
        text.setAttribute('class', 'rb-cell-sea');
        text.setAttribute('x', frame.x1 - 6);
        text.setAttribute('y', frame.y1 - 9);
        text.textContent = `sea ${cost}`;
        text.append(titleFor(`Reachable by sea for ${cost}, not the ${printed.shipCost} printed`));
        nodes.push(text);
      }
    }

    return nodes;
  }

  /** The support box, redrawn, and marked when it is doing nothing. */
  _supportCell(id, printed, support) {
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('class', 'rb-cell-support');
    text.setAttribute('x', (support.x0 + support.x1) / 2);
    text.setAttribute('y', support.y1 - 2);
    text.textContent = printed.support.join(' / ');
    if (this._supported(id) === false) {
      text.classList.add('is-lost');
      text.append(titleFor('Held without support: defended settlements pay nothing here'));
    }
    return text;
  }

  /**
   * A shire printed a second time on a sheet it is not played on.
   *
   * The printed sheets carry short grey frames for the neighbours just off the
   * edge, so a player looking at one corner of England can see who holds the
   * shire across the border without turning to another sheet. They are copies,
   * so they are drawn from the same live data and take no clicks at all —
   * there is exactly one place to select a shire, and it is the sheet it lives
   * on.
   */
  _ghost(ghost) {
    const id = ghost.shireId;
    const live = id ? this._view.shires?.[id] : null;
    const printed = id ? this._data.shires.shires[id] : null;
    if (!live || !printed) return null;
    if (!shireDeviations(this._view, this._data, id).length) return null;

    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'rb-ghost');
    group.dataset.ghostShire = id;

    const tint = this._tintFor(live.stewardRoleId);
    const box = document.createElementNS(SVG_NS, 'rect');
    box.setAttribute('class', 'rb-ghost-box');
    box.setAttribute('x', ghost.x0);
    box.setAttribute('y', ghost.y0);
    box.setAttribute('width', ghost.x1 - ghost.x0);
    box.setAttribute('height', ghost.y1 - ghost.y0);
    if (tint) box.setAttribute('color', tint);
    group.append(box);

    const midX = (ghost.x0 + ghost.x1) / 2;
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('class', 'rb-ghost-name');
    label.setAttribute('x', midX);
    label.setAttribute('y', ghost.y0 + 20);
    label.textContent = printed.name;
    group.append(label);

    const steward = live.stewardRoleId;
    const who = document.createElementNS(SVG_NS, 'text');
    who.setAttribute('class', 'rb-ghost-steward');
    who.setAttribute('x', midX);
    who.setAttribute('y', ghost.y1 - 13);
    who.textContent = steward
      ? this._data.roles.roles[steward]?.name ?? steward
      : 'unheld';
    group.append(who);

    group.append(titleFor(
      `${printed.name} — a read-only copy. It is played on the ${printed.map} sheet.`));
    return group;
  }

  /**
   * Put the card where the shire is, or take it away.
   *
   * Which side of the anchor it opens on is decided from its measured size
   * rather than from fixed thresholds, because the same card sits in a
   * facilitator's full-width map and in a player's middle column, and a rule
   * tuned for one hangs off the edge of the other. Measured, it simply takes
   * the first side it fits on.
   */
  _renderCard(sheetCells, width, height) {
    const card = this.querySelector('.rb-map-card');
    const id = this._selected;
    const printed = id ? this._data.shires.shires[id] : null;
    const frame = printed?.map === this.sheet
      ? sheetCells?.[id]?.frame ?? frameOf(this._data.geometry.shires[id])
      : null;
    if (!frame) { card.hidden = true; return; }

    card.hidden = false;

    // Both axes as a percentage of the sheet. Zero where there is no layout
    // engine — a test environment — in which case the defaults stand in for a
    // card about a third of the sheet across, which is what it is.
    const stage = this.querySelector('.rb-map-stage').getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const cardWidth = stage.width ? (box.width / stage.width) * 100 : 36;
    const cardHeight = stage.height ? (box.height / stage.height) * 100 : 30;

    const across = anchor(
      ((frame.x0 + frame.x1) / 2) / width * 100, cardWidth,
      [['centre', 0.5], ['left', 0], ['right', 1]]);
    const down = anchor(
      [(frame.y1 / height) * 100, (frame.y0 / height) * 100], cardHeight,
      [['below', 0], ['above', 1]]);

    card.dataset.x = across.side;
    card.dataset.y = down.side;
    card.style.left = `${across.at}%`;
    card.style.top = `${down.at}%`;
  }

  _supported(shireId) {
    return this._view.derived?.shires?.[shireId]?.supported;
  }

  _factionsOf(roleId) {
    return roleId ? this._view.derived?.roles?.[roleId]?.factions ?? [] : [];
  }

  _tintFor(roleId) {
    return this._factionsOf(roleId).map((f) => FACTION_TINT[f]).find(Boolean);
  }

  /** The one-line answer a hover gives, whether or not anything is drawn. */
  _describe(id, printed, live) {
    const steward = live.stewardRoleId
      ? this._data.roles.roles[live.stewardRoleId]?.name ?? live.stewardRoleId
      : 'nobody';
    return `${steward}, ${live.castles} castles, support ${printed.support.join('/')}`;
  }
}

/**
 * Which side of an anchor point a card of a given size opens on, and where to
 * pin it so that it stays on the sheet.
 *
 * Each side is a name and how far back from the pin the card's leading edge
 * sits, as a fraction of its own size — the same numbers the stylesheet
 * translates by. The first side that fits wins; if none does, because the card
 * is larger than the sheet, the first is used and simply clamped. A shire
 * near an edge therefore gets a card beside it rather than one hanging into
 * the rail next door.
 *
 * @param {number|number[]} at  the pin, or one pin per side
 * @param {number} size  the card's size on this axis, as a percentage
 * @param {Array<[string, number]>} sides  name and shift, in order of preference
 */
function anchor(at, size, sides) {
  const pinFor = (index) => (Array.isArray(at) ? at[Math.min(index, at.length - 1)] : at);
  const room = Math.max(0, 100 - size);
  const leading = (index) => pinFor(index) - size * sides[index][1];

  let chosen = 0;
  for (let i = 0; i < sides.length; i += 1) {
    if (leading(i) >= 0 && leading(i) <= room) { chosen = i; break; }
  }
  const lead = clamp(leading(chosen), 0, room);
  return { side: sides[chosen][0], at: lead + size * sides[chosen][1] };
}

/** The crenellated stack beside a frame, one tower per castle still standing. */
function castleStack(cell, castles) {
  const towers = [];
  const count = Math.max(0, castles);
  const size = 26;
  const perRow = 2;
  const midX = (cell.x0 + cell.x1) / 2;
  const midY = (cell.y0 + cell.y1) / 2;
  const rows = Math.ceil(count / perRow) || 1;
  for (let i = 0; i < count; i += 1) {
    const row = Math.floor(i / perRow);
    const inRow = Math.min(perRow, count - row * perRow);
    const column = i % perRow;
    const tower = document.createElementNS(SVG_NS, 'path');
    tower.setAttribute('class', 'rb-cell-castle');
    tower.setAttribute('d', castlePath(
      midX + (column - (inRow - 1) / 2) * (size + 6),
      midY + (row - (rows - 1) / 2) * (size + 6),
      size));
    towers.push(tower);
  }
  if (count === 0) {
    const none = document.createElementNS(SVG_NS, 'text');
    none.setAttribute('class', 'rb-cell-nocastle');
    none.setAttribute('x', midX);
    none.setAttribute('y', midY + 6);
    none.textContent = '—';
    none.append(titleFor('No castles left standing'));
    towers.push(none);
  }
  return towers;
}

/** A tower with three merlons, drawn rather than typed — no font to trust. */
function castlePath(cx, cy, size) {
  const m = size / 5;
  const x = cx - size / 2;
  const y = cy - size / 2;
  const h = size;
  return `M${x} ${y + h} L${x} ${y} L${x + m} ${y} L${x + m} ${y + m} `
    + `L${x + 2 * m} ${y + m} L${x + 2 * m} ${y} L${x + 3 * m} ${y} `
    + `L${x + 3 * m} ${y + m} L${x + 4 * m} ${y + m} L${x + 4 * m} ${y} `
    + `L${x + 5 * m} ${y} L${x + 5 * m} ${y + h} Z`;
}

/**
 * A settlement, as the printed legend draws one: a letter for what it is, a
 * ring when it is defended, and a cross through it when it has been burned.
 *
 * Struck rather than removed. The letter is what the sheet said was there, and
 * its absence is the point — a blank space would read as a farm nobody ever
 * built rather than as one somebody came and burned.
 */
function settlementMark(at, live, printed) {
  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'rb-settlement');
  group.dataset.settlement = printed.id;
  if (live.defended) group.classList.add('is-defended');
  if (live.destroyed) group.classList.add('is-destroyed');

  if (live.defended) {
    const ring = document.createElementNS(SVG_NS, 'circle');
    ring.setAttribute('class', 'rb-settlement-ring');
    ring.setAttribute('cx', at.x);
    ring.setAttribute('cy', at.y);
    ring.setAttribute('r', 15);
    group.append(ring);
  }

  const letter = document.createElementNS(SVG_NS, 'text');
  letter.setAttribute('class', 'rb-settlement-letter');
  letter.setAttribute('x', at.x);
  letter.setAttribute('y', at.y);
  letter.textContent = SETTLEMENT_LETTER[printed.type] ?? '?';
  group.append(letter);

  if (live.destroyed) {
    const strike = document.createElementNS(SVG_NS, 'path');
    strike.setAttribute('class', 'rb-settlement-strike');
    strike.setAttribute('d', `M${at.x - 14} ${at.y - 14} L${at.x + 14} ${at.y + 14} `
      + `M${at.x + 14} ${at.y - 14} L${at.x - 14} ${at.y + 14}`);
    group.append(strike);
  }

  const state = live.destroyed ? 'destroyed' : live.defended ? 'defended' : 'standing';
  group.append(titleFor(`${title(printed.type)} — ${state}`));
  return group;
}

/** Two bars rather than a glyph, for the same reason the castles are drawn. */
function missionaryCross(cx, cy) {
  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'rb-cell-cross');
  const bar = (x, y, width, height) => {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', width);
    rect.setAttribute('height', height);
    return rect;
  };
  group.append(bar(cx - 2.5, cy - 11, 5, 24));
  group.append(bar(cx - 9, cy - 4, 18, 5));
  return group;
}

/** `geometry.json` keeps a frame as a flat array; `cells.json` as a record. */
function frameOf(outline) {
  const frame = outline?.frame;
  if (!frame) return null;
  const [x0, y0, x1, y1] = frame;
  return { x0, y0, x1, y1 };
}

function anchorOf(outline, index) {
  const at = outline?.settlements?.[index];
  return at ? { x: at[0], y: at[1] } : null;
}

/**
 * Greedy word wrap by character count.
 *
 * No text metrics: this runs in a test environment with no layout engine, and
 * a name that wraps one word early is a far smaller problem than a renderer
 * that cannot be tested at all. Two lines is the most a frame has room for, so
 * anything longer is simply allowed to be a little wide.
 */
function wrapWords(text, max) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  for (const word of words) {
    const last = lines[lines.length - 1];
    if (last && last.length + 1 + word.length <= max) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  if (lines.length <= 2) return lines.length ? lines : [''];
  return [lines[0], lines.slice(1).join(' ')];
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

const title = (text) => String(text ?? '').replace(/_/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());

function titleFor(text) {
  const node = document.createElementNS(SVG_NS, 'title');
  node.textContent = text;
  return node;
}

/**
 * "Northern England" trimmed to "Northern" for the sheet tab itself.
 *
 * These tabs live inside a pane the player already opened to see the map —
 * saying "England" a second and third time only made them read as the same
 * tab as the top-level one that actually shows the Aftermath tracker.
 */
function sheetLabel(displayName) {
  return displayName.replace(/\s+England$/, '');
}

customElements.define('rb-map', RbMap);
