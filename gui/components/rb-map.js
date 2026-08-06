/**
 * <rb-map> — the artist's three sheets, with the whole game drawn onto them.
 *
 * The art is geography and nothing else: terrain, coastline, borders, sea. It
 * carries no shire names, no steward frames, no castle glyphs and no
 * settlement letters, because everything a printed sheet says about the game
 * is a thing the game can change, and a drawing that states a fact cannot be
 * corrected when the fact moves. So the drawing states none of them and this
 * component states all of them, every shire, every turn.
 *
 * That is the whole of it: the art can never be wrong, and there is exactly
 * one place a player can read who holds Jorvik. An earlier version drew a cell
 * only where the live board had moved off the printed one, which was right
 * while the art still spoke — a quiet shire was quiet because the paper had
 * already said what was true of it. On art that says nothing, a quiet shire is
 * an unlabelled blank.
 *
 * What it draws is the paper form, redrawn: the Control/Steward frame, the
 * support strip ruled off underneath it, the castle stack up the frame's right
 * edge, the shire's name over it in small caps, and a letter at each
 * settlement — F, T or C, ringed when it is defended and struck through when
 * it has been burned. `assets/maps/cells.json` says where all of those belong.
 * Anyone who has played this on a table should recognise their own sheet.
 *
 * Art and overlay live inside one `<svg>` rather than an image with a second
 * SVG floating over it, so they share a coordinate system rather than merely
 * agreeing about `preserveAspectRatio`, and cannot come apart.
 *
 * Read-only in itself. It renders a projection, raises `rb-shire` when a shire
 * is chosen, and shows whatever the page around it parked in `slot="card"` —
 * the player's read-out, or the facilitator's editor. It never decides
 * anything.
 *
 * One exception, and it is opt-in: with `editable` set, a settlement letter
 * becomes clickable and opens a three-way state panel over it. That is a
 * facilitator's pencil and nobody else's, so it is an attribute the
 * facilitator's page sets rather than something inferred from what happens to
 * be parked in the card — a player's console and a facilitator's share this
 * component, and "whether anything is in the card slot" is not the question
 * being asked. Even then the map only raises the command; admission decides.
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

/** The letters the printed sheet's own legend explains. */
const SETTLEMENT_LETTER = { farm: 'F', town: 'T', church: 'C' };

/**
 * The three states a settlement is ever in, as the facilitator's panel offers
 * them.
 *
 * Radios rather than the two checkboxes this replaced, because the states are
 * exclusive in play and the pair of boxes could say otherwise: a settlement
 * somebody has burned is not also a settlement somebody is holding, and a form
 * that lets an umpire tick both is a form that will eventually be ticked both.
 */
const SETTLEMENT_STATES = [
  ['standing', 'standing'],
  ['defended', 'defended'],
  ['destroyed', 'destroyed'],
];

/** As far as a hit target grows before it starts reaching over a neighbour. */
const SETTLEMENT_REACH = 20;

/** Roughly how many characters of a steward's name fit across a frame. */
const NAME_WRAP = 14;

export class RbMap extends HTMLElement {
  static observedAttributes = ['sheet', 'editable'];

  /** The static dataset: shires, factions, roles, geometry, map cells. */
  set data(value) { this._data = value; this._render(); }

  /** The current projection. */
  set view(value) { this._view = value; this._render(); }

  /**
   * Shires worth pointing a player's eye at right now — the valid targets of
   * an action they have just picked. Presentation only: clicking one of these
   * still goes through the same `rb-shire` event as clicking any other.
   */
  set highlighted(ids) {
    this._highlighted = ids ? new Set(ids) : null;
    this._render();
  }

  get sheet() { return this.getAttribute('sheet') || 'northern'; }

  /**
   * Whether the settlement letters take a click and offer their state.
   *
   * A capability the page grants rather than one the component assumes: the
   * player's console mounts the same element and must not get it.
   */
  get editable() { return this.hasAttribute('editable'); }

  /** Which shire the card is open on, if any. */
  get selected() { return this._selected ?? null; }

  /** Which settlement the state panel is open on, if any. */
  get selectedSettlement() { return this._settlement ?? null; }

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
        <div class="rb-map-settlement" role="group" hidden></div>
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
    //
    // A settlement is tested for first and answered on its own, because its
    // hit target sits inside its shire's and would otherwise only ever be read
    // as a click on the ground underneath it.
    this.querySelector('.rb-map-sheet').addEventListener('click', (event) => {
      const glyph = this.editable ? event.target.closest('[data-settlement]') : null;
      if (glyph) {
        this._selectSettlement(glyph.closest('[data-shire]').dataset.shire,
          glyph.dataset.settlement);
        return;
      }
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
   *
   * Clicking the shire that is already open closes it. The card has a × and
   * the sea closes it too, but the thing people actually try first is the
   * county they just tapped, and a map that does nothing when they do reads as
   * a map that has stopped responding.
   */
  _select(shireId) {
    this._selected = shireId === this._selected ? null : shireId;
    // Only one thing on the sheet is being looked at at a time. Both panels
    // are pinned to points a few millimetres apart — a settlement sits inside
    // its own shire — so leaving both open would mean one covering the other.
    this._settlement = null;
    this.dispatchEvent(new CustomEvent('rb-shire', {
      bubbles: true, detail: { shireId: this._selected },
    }));
    this._render();
  }

  /** The same gesture on a settlement: click it to open, click it to close. */
  _selectSettlement(shireId, settlementId) {
    const open = this._settlement;
    const same = open?.shireId === shireId && open?.settlementId === settlementId;
    if (same) { this._settlement = null; this._render(); return; }
    // Through _select so the page hears the card go away and empties it,
    // rather than being left holding a shire nothing is pointing at.
    if (this.selected !== null) this._select(null);
    this._settlement = { shireId, settlementId };
    this._render();
  }

  /**
   * A settlement's state, changed one field at a time because that is what the
   * command takes.
   *
   * Reaching two of the three states means two commands, so the order matters:
   * whatever is being left is cleared before whatever is being gone to is set.
   * Done the other way round, a settlement on its way from defended to
   * destroyed would spend the gap between the two commands ringed *and* struck
   * through — the one reading the radios exist to rule out — and would stay
   * that way if the second were refused. Cleared first, the half-applied state
   * is always one of the three legal ones (standing), which is a state a
   * facilitator can see is not what they asked for and fix with one more
   * click.
   */
  _setSettlementState({ shireId, settlementId }, want) {
    const live = this._view?.shires?.[shireId]?.settlements?.[settlementId];
    if (!live) return;
    const fields = ['defended', 'destroyed'];
    const wanted = { defended: want === 'defended', destroyed: want === 'destroyed' };
    const changes = [
      ...fields.filter((field) => live[field] && !wanted[field]).map((field) => [field, false]),
      ...fields.filter((field) => !live[field] && wanted[field]).map((field) => [field, true]),
    ];
    for (const [field, value] of changes) {
      this.dispatchEvent(new CustomEvent('rb-facilitate', {
        bubbles: true,
        detail: {
          verb: 'facilitator:set-settlement',
          payload: { shireId, settlementId, field, value },
        },
      }));
    }
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

    // Every outline first, then every cell, rather than one shire at a time.
    // The tints are washes and the cells are ink: drawn shire by shire, a
    // neighbour's wash would land on top of the frame drawn just before it.
    const here = Object.entries(this._data.shires.shires)
      .filter(([id, printed]) => printed.map === this.sheet
        && geometry.shires[id]?.polygon && this._view.shires?.[id]);

    for (const [id, printed] of here) {
      overlay.append(this._shirePath(id, printed, this._view.shires[id], geometry.shires[id]));
    }
    for (const [id, printed] of here) {
      overlay.append(this._shireCells(
        id, printed, this._view.shires[id], sheetCells[id], geometry.shires[id]));
    }

    for (const ghost of sheetCells.ghosts ?? []) {
      const drawn = this._ghost(ghost);
      if (drawn) overlay.append(drawn);
    }

    this._renderCard(sheetCells, width, height);
    this._renderSettlementPanel(sheetCells, width, height);
  }

  /**
   * The sheet row, unless the page around it provides its own.
   *
   * Both consoles promote these three into their main tab bar, where they
   * replace what used to be a single board tab — so the map must not also draw
   * them underneath. The replay, which shows all three sheets at once and has
   * nothing to pick between, keeps them off for the opposite reason. What is
   * left needing them is a map mounted on its own, which is what the default
   * serves. `tabs="off"` is the seam.
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

  /** The hit target, and the wash of whoever holds the ground. */
  _shirePath(id, printed, live, outline) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', outline.polygon);
    path.setAttribute('class', 'rb-shire');
    path.dataset.shire = id;
    if (id === this._selected) path.classList.add('is-selected');
    if (this._highlighted?.has(id)) path.classList.add('is-highlighted');

    // Tinted by whoever holds it. A shire nobody holds, or whose holder speaks
    // for no faction, keeps the plain wash — there is no colour to give it.
    //
    // Set as a style rather than as the `color` presentation attribute: the
    // stylesheet gives .rb-shire a default colour, and any rule with a
    // selector beats a presentation attribute, so an attribute here would be
    // silently ignored and every shire would come out the same grey.
    const tint = this._tintFor(live.stewardRoleId);
    if (tint) path.style.color = tint;

    // Without support, defended settlements pay nothing and the shire counts
    // toward Disorder. That is worth seeing on the board rather than only in a
    // table, so it is hatched rather than merely tinted.
    if (this._supported(id) === false) path.classList.add('is-unsupported');

    path.append(titleFor(`${printed.name} — ${this._describe(id, printed, live)}`));
    return path;
  }

  /** The sheet the shire had on paper, drawn from what is true now. */
  _shireCells(id, printed, live, cell, outline) {
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'rb-shire-cells');
    group.dataset.shire = id;

    const frame = cell?.frame ?? frameOf(outline);
    const support = cell?.support ?? stripUnder(frame);
    if (frame) {
      group.append(box(frame, 'rb-cell-frame'), box(support, 'rb-cell-strip'));
      group.append(this._shireName(printed, frame));
      group.append(...this._frameCell(id, printed, live, frame));
      group.append(...this._supportCell(id, printed, support));
      if (cell?.castles) group.append(...castleStack(cell.castles, live.castles));
    }

    const anchors = printed.settlements.map((was, index) =>
      cell?.settlements?.[index] ?? anchorOf(outline, index));
    printed.settlements.forEach((was, index) => {
      const at = anchors[index];
      const now = live.settlements?.[was.id];
      if (!at || !now) return;
      const open = this._settlement;
      group.append(settlementMark(at, now, was, {
        reach: this.editable ? reachOf(anchors, index) : 0,
        selected: open?.shireId === id && open?.settlementId === was.id,
      }));
    });

    return group;
  }

  /**
   * The shire's name, above its frame in letterspaced small caps.
   *
   * The printed sheets set it wherever the coastline left room — under
   * Bernicia's frame, over North Mercia's. There is no transcription of where
   * each one sat, and inventing one per shire would be eighteen numbers nobody
   * could check, so they all go above: the strip below the frame is spoken
   * for, and above it is the one side that is free on every sheet.
   */
  _shireName(printed, frame) {
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('class', 'rb-cell-shire');
    text.setAttribute('x', (frame.x0 + frame.x1) / 2);
    text.setAttribute('y', frame.y0 - 7);
    text.textContent = printed.name;
    return text;
  }

  /** Who holds it, and what they speak for. */
  _frameCell(id, printed, live, frame) {
    const nodes = [label(frame.x0 + 7, frame.y0 + 13, 'Control / Steward')];
    const midX = (frame.x0 + frame.x1) / 2;
    const steward = live.stewardRoleId;
    const name = steward
      ? this._data.roles.roles[steward]?.name ?? steward
      : 'unheld';

    // The faction letters lead the name on one line, as they do in print,
    // because the letters in the support strip below only mean anything read
    // against them: "support M" is support from the man's own side or from a
    // rival depending entirely on this. They eat into the width the name has,
    // so they come out of its wrapping budget — otherwise the two shires whose
    // steward speaks for two factions push their names into the castles.
    const factions = this._factionsOf(steward);
    const lines = wrapWords(name, NAME_WRAP - factions.join(' ').length);
    lines.forEach((line, index) => {
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('class', 'rb-cell-steward');
      text.setAttribute('x', midX);
      text.setAttribute('y', frame.y0 + 45 + index * 23 - (lines.length - 1) * 11);
      if (index === 0 && factions.length) {
        const mark = document.createElementNS(SVG_NS, 'tspan');
        mark.setAttribute('class', 'rb-cell-faction');
        mark.textContent = `${factions.join(' ')} `;
        text.append(mark);
      }
      text.append(document.createTextNode(line));
      nodes.push(text);
    });

    if (live.missionaryCross) {
      const cross = missionaryCross(frame.x1 - 15, frame.y0 + 15);
      cross.append(titleFor('Christian missionaries have planted a cross here'));
      nodes.push(cross);
    }

    return nodes;
  }

  /**
   * The support strip: who is behind the steward, and what it costs to arrive
   * by sea.
   *
   * The ship number sat on a little boat out in the water on the printed
   * sheet, and there is no transcription of where those boats were, so it
   * moves to the free end of this strip. It is drawn from the derived value
   * rather than the printed one, which is the same number until a contract or
   * a defensive fleet moves it.
   */
  _supportCell(id, printed, support) {
    const nodes = [label(support.x0 + 7, support.y1 - 3, 'Support')];
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('class', 'rb-cell-support');
    text.setAttribute('x', support.x0 + 56);
    text.setAttribute('y', support.y1 - 3);
    // Not upper-cased: the printed legend distinguishes N (Northumbria) from
    // Be (Bernicia) and Ea (East Anglia) by that second lower-case letter.
    text.textContent = printed.support.join(', ');
    if (this._supported(id) === false) {
      text.classList.add('is-lost');
      text.append(titleFor('Held without support: defended settlements pay nothing here'));
    }
    nodes.push(text);

    const derived = this._view.derived?.shires?.[id];
    const cost = derived && 'shipCost' in derived ? derived.shipCost : printed.shipCost;
    if (cost !== null && cost !== undefined) {
      const sea = document.createElementNS(SVG_NS, 'text');
      sea.setAttribute('class', 'rb-cell-sea');
      sea.setAttribute('x', support.x1 - 7);
      sea.setAttribute('y', support.y1 - 3);
      sea.textContent = `sea ${cost}`;
      if (cost !== printed.shipCost) {
        sea.classList.add('is-moved');
        sea.append(titleFor(
          `Reachable by sea for ${cost}, not the ${printed.shipCost} the sheet was printed with`));
      }
      nodes.push(sea);
    }
    return nodes;
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

    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'rb-ghost');
    group.dataset.ghostShire = id;

    const tint = this._tintFor(live.stewardRoleId);
    const frame = { x0: ghost.x0, y0: ghost.y0, x1: ghost.x1, y1: ghost.y1 };
    const outline = box(frame, 'rb-ghost-box');
    if (tint) outline.style.color = tint;
    group.append(outline);

    const midX = (ghost.x0 + ghost.x1) / 2;
    const name = document.createElementNS(SVG_NS, 'text');
    name.setAttribute('class', 'rb-ghost-name');
    name.setAttribute('x', midX);
    name.setAttribute('y', ghost.y0 - 6);
    name.textContent = printed.name;
    group.append(name);

    group.append(label(ghost.x0 + 7, ghost.y0 + 13, 'Control'));

    const steward = live.stewardRoleId;
    const who = document.createElementNS(SVG_NS, 'text');
    who.setAttribute('class', 'rb-ghost-steward');
    who.setAttribute('x', midX);
    who.setAttribute('y', ghost.y1 - 14);
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

  /**
   * The chosen settlement's state, as three radios over the letter itself.
   *
   * Pinned the same way the card is and by the same `anchor()`, so it takes
   * whichever side of the letter it fits on rather than hanging off the sheet
   * for the settlements down the bottom edge. The anchor is a point rather
   * than a box, so the two vertical pins are simply a little above and a
   * little below it — far enough that the panel never lands on the glyph it is
   * about.
   */
  _renderSettlementPanel(sheetCells, width, height) {
    const panel = this.querySelector('.rb-map-settlement');
    const chosen = this.editable ? this._settlement : null;
    const printed = chosen ? this._data.shires.shires[chosen.shireId] : null;
    const index = printed?.settlements.findIndex((s) => s.id === chosen.settlementId) ?? -1;
    const live = chosen
      ? this._view.shires?.[chosen.shireId]?.settlements?.[chosen.settlementId] : null;
    const at = printed?.map === this.sheet && index >= 0
      ? sheetCells?.[chosen.shireId]?.settlements?.[index]
        ?? anchorOf(this._data.geometry.shires[chosen.shireId], index)
      : null;
    if (!live || !at) { panel.hidden = true; panel.dataset.key = ''; return; }
    panel.hidden = false;

    // Rebuilt only when it is about a different settlement. A render lands on
    // every change anywhere in the game, and one that replaced these controls
    // each time would take the keyboard focus out of the group a facilitator
    // was part way through arrowing along.
    const key = `${chosen.shireId}|${chosen.settlementId}`;
    if (panel.dataset.key !== key) {
      panel.dataset.key = key;
      panel.innerHTML = `<p class="rb-map-settlement-name"></p>${SETTLEMENT_STATES
        .map(([value, text]) => `<label><input type="radio" name="rb-state-${key}"
          value="${value}"> ${text}</label>`).join('')}`;
      const named = title(printed.settlements[index].type);
      panel.querySelector('.rb-map-settlement-name').textContent = named;
      // Three radios reading "standing/defended/destroyed" say nothing on
      // their own about which of a shire's five churches they are for.
      panel.setAttribute('aria-label', `${named} in ${printed.name}`);
      for (const input of panel.querySelectorAll('input')) {
        input.onchange = () => this._setSettlementState(chosen, input.value);
      }
    }

    // Read off the board every time rather than left where the last click put
    // it: the radio says what is true, not what was asked for, so a refused
    // command shows as the state snapping back.
    const state = settlementState(live);
    for (const input of panel.querySelectorAll('input')) input.checked = input.value === state;

    const stage = this.querySelector('.rb-map-stage').getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    const panelWidth = stage.width ? (box.width / stage.width) * 100 : 12;
    const panelHeight = stage.height ? (box.height / stage.height) * 100 : 10;
    const clear = SETTLEMENT_REACH;

    const across = anchor(
      (at.x / width) * 100, panelWidth,
      [['centre', 0.5], ['left', 0], ['right', 1]]);
    const down = anchor(
      [((at.y + clear) / height) * 100, ((at.y - clear) / height) * 100], panelHeight,
      [['below', 0], ['above', 1]]);

    panel.dataset.x = across.side;
    panel.dataset.y = down.side;
    panel.style.left = `${across.at}%`;
    panel.style.top = `${down.at}%`;
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

/**
 * The stack up a frame's right edge, one tower per castle still standing.
 *
 * A column growing upward off the frame's bottom corner, which is where the
 * printed sheet put it: a shire that throws a castle down loses the top of its
 * own stack rather than having the whole thing shuffle.
 */
function castleStack(cell, castles) {
  const towers = [];
  const count = Math.max(0, castles);
  const size = 22;
  const gap = 2;
  const x = cell.x0 + 3;
  for (let i = 0; i < count; i += 1) {
    const tower = document.createElementNS(SVG_NS, 'path');
    tower.setAttribute('class', 'rb-cell-castle');
    tower.setAttribute('d', castlePath(x + size / 2, cell.y1 - 1 - (i + 0.5) * (size + gap), size));
    tower.append(titleFor(`${count} ${count === 1 ? 'castle' : 'castles'}`));
    towers.push(tower);
  }
  if (count === 0) {
    const none = document.createElementNS(SVG_NS, 'text');
    none.setAttribute('class', 'rb-cell-nocastle');
    none.setAttribute('x', x + size / 2);
    none.setAttribute('y', cell.y1 - 6);
    none.textContent = '—';
    none.append(titleFor('No castles left standing'));
    towers.push(none);
  }
  return towers;
}

/** A ruled box, as the printed sheet ruled its frames. */
function box(rect, className) {
  const node = document.createElementNS(SVG_NS, 'rect');
  node.setAttribute('class', className);
  node.setAttribute('x', rect.x0);
  node.setAttribute('y', rect.y0);
  node.setAttribute('width', rect.x1 - rect.x0);
  node.setAttribute('height', rect.y1 - rect.y0);
  return node;
}

/** The tiny small-caps heading a printed cell carries in its top-left corner. */
function label(x, y, text) {
  const node = document.createElementNS(SVG_NS, 'text');
  node.setAttribute('class', 'rb-cell-label');
  node.setAttribute('x', x);
  node.setAttribute('y', y);
  node.textContent = text;
  return node;
}

/** The support strip's rectangle, when the manifest has not already said. */
function stripUnder(frame) {
  return frame ? { x0: frame.x0, y0: frame.y1, x1: frame.x1, y1: frame.y1 + 14 } : null;
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
 * How far a settlement's hit target may spread before it starts taking clicks
 * meant for the letter next to it.
 *
 * A single comfortable disc will not do. Some shires set their letters
 * seventeen units apart — closer together than the letters themselves are wide
 * — and a fixed disc big enough to click on an empty coastline would cover its
 * neighbour's centre there, so aiming straight at one letter would select the
 * other. Half the distance to the nearest neighbour is the line the two of them
 * would agree on, which is the most either can have.
 */
function reachOf(anchors, index) {
  const here = anchors[index];
  if (!here) return 0;
  const nearest = anchors.reduce((closest, other, at) => (
    !other || at === index ? closest
      : Math.min(closest, Math.hypot(other.x - here.x, other.y - here.y))), Infinity);
  return Math.min(SETTLEMENT_REACH, nearest / 2);
}

/**
 * A settlement, as the printed legend draws one: a letter for what it is, a
 * ring when it is defended, and a cross through it when it has been burned.
 *
 * Struck rather than removed. The letter is what the sheet said was there, and
 * its absence is the point — a blank space would read as a farm nobody ever
 * built rather than as one somebody came and burned.
 */
function settlementMark(at, live, printed, { reach = 0, selected = false } = {}) {
  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'rb-settlement');
  group.dataset.settlement = printed.id;
  if (live.defended) group.classList.add('is-defended');
  if (live.destroyed) group.classList.add('is-destroyed');
  if (selected) group.classList.add('is-selected');

  // An invisible disc under the glyph, because the glyph is a single letter
  // and a letter is not something anyone can reliably hit. Drawn only where
  // there is something to hit it for: on a player's map nothing here takes a
  // click at all.
  if (reach > 0) {
    const hit = document.createElementNS(SVG_NS, 'circle');
    hit.setAttribute('class', 'rb-settlement-hit');
    hit.setAttribute('cx', at.x);
    hit.setAttribute('cy', at.y);
    hit.setAttribute('r', reach);
    group.append(hit);
  }

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

  group.append(titleFor(`${title(printed.type)} — ${settlementState(live)}`));
  return group;
}

/**
 * Which of the three the two stored flags add up to.
 *
 * Destroyed wins over defended, matching the glyph — a struck-through letter
 * reads as burned whatever ring is drawn round it — so a pair of flags that
 * has somehow come out of step still lights the radio the map is showing.
 */
function settlementState(live) {
  return live.destroyed ? 'destroyed' : live.defended ? 'defended' : 'standing';
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
 * A name on one line if it fits, and on two balanced ones if it does not.
 *
 * No text metrics: this runs in a test environment with no layout engine, and
 * a name that breaks one word early is a far smaller problem than a renderer
 * that cannot be tested at all. Two lines is all a frame has room for, so the
 * question is only where to break, and the answer is wherever leaves the two
 * halves closest in length — greedy filling gave "Guthrum the / Old", which
 * looks like a mistake even though it fits.
 */
function wrapWords(text, max) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  if (words.join(' ').length <= max || words.length === 1) return [words.join(' ')];

  let best = null;
  for (let i = 1; i < words.length; i += 1) {
    const lines = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
    const evenness = Math.abs(lines[0].length - lines[1].length);
    if (!best || evenness < best.evenness) best = { evenness, lines };
  }
  return best.lines;
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
