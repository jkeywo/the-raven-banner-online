// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { projectView } from '../../gui/rules/views.js';
import '../../gui/components/rb-map.js';
import '../../gui/components/rb-shire-editor.js';
import '../../gui/components/rb-private-sheet.js';
import '../../gui/components/rb-aftermath.js';
import '../../gui/components/rb-seat-roster.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const core = await loadData();
const geometry = JSON.parse(await readFile(join(ROOT, 'data', 'geometry.json'), 'utf8'));
// The map view wants both halves of the sheet: the shire outlines, and where
// on the artwork each shire's frame, support strip, castles and settlements
// belong, since the artwork itself draws none of them.
const cells = JSON.parse(await readFile(join(ROOT, 'assets', 'maps', 'cells.json'), 'utf8'));
const data = { ...core, geometry, cells };

/**
 * A game with someone seated, projected as they would see it.
 *
 * `move` runs against the state before it is projected, which is how a test
 * asks for a board something has happened on.
 */
function seatedView({ roleId = 'king_alfred', move } = {}) {
  const state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
  state.seats.s1 = {
    id: 's1', token: 't', name: 'Alice', roleId, kind: 'player',
    connected: true, lastSeen: 0,
  };
  move?.(state);
  return {
    state,
    view: projectView(state, data, {
      kind: 'player', seatId: 's1', roleId, teamId: state.roles[roleId].teamId,
    }),
  };
}

const mount = (tag) => {
  const element = document.createElement(tag);
  document.body.append(element);
  return element;
};

/** Whoever holds this shire, however many lines their name took. */
const steward = (cell) => [...cell.querySelectorAll('.rb-cell-steward')]
  .map((line) => line.textContent).join(' ');

beforeEach(() => { document.body.innerHTML = ''; });

describe('<rb-map>', () => {
  it('draws one clickable outline per shire on the chosen sheet', () => {
    const { view } = seatedView();
    const map = mount('rb-map');
    map.setAttribute('sheet', 'northern');
    map.data = data;
    map.view = view;

    const paths = map.querySelectorAll('path.rb-shire');
    expect(paths).toHaveLength(6);
    // Every one carries the shire it stands for, which is what a click reads.
    for (const path of paths) expect(data.shires.shires[path.dataset.shire].map).toBe('northern');
  });

  it('draws the vector sheet and the overlay in one coordinate system', () => {
    // They used to be an <img> and an <svg> that lined up because both agreed
    // about preserveAspectRatio. Now the art is an <image> inside the same
    // <svg> as the overlay, so there is nothing left for them to disagree on.
    const { view } = seatedView();
    const map = mount('rb-map');
    map.data = data;
    map.view = view;

    const svg = map.querySelector('svg');
    const [width, height] = geometry.viewBox;
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${width} ${height}`);

    const art = svg.querySelector('image.rb-map-art');
    expect(art.getAttribute('href')).toBe('assets/maps/northern.svg');
    expect(art.getAttribute('width')).toBe(String(width));
    expect(art.getAttribute('height')).toBe(String(height));
    expect(svg.querySelector('.rb-map-overlay')).toBeTruthy();
  });

  it('renders all three sheets from the exported vector art', () => {
    const { view } = seatedView();
    const map = mount('rb-map');
    map.data = data;
    map.view = view;
    for (const sheet of ['northern', 'western', 'eastern']) {
      map.setAttribute('sheet', sheet);
      expect(map.querySelector('image.rb-map-art').getAttribute('href'), sheet)
        .toBe(`assets/maps/${sheet}.svg`);
      const drawn = [...map.querySelectorAll('path.rb-shire')].map((p) => p.dataset.shire);
      expect(drawn, sheet).toEqual(Object.keys(data.shires.shires)
        .filter((id) => data.shires.shires[id].map === sheet));
    }
  });

  it('draws the whole board on a game nobody has touched yet', () => {
    // The headline behaviour, and the opposite of what it used to be. The art
    // says nothing about the game — no names, no frames, no letters — so a
    // shire the overlay left alone would be a blank patch of countryside
    // rather than a quiet one. Every shire on the sheet gets its paper form.
    const { view } = seatedView();
    const map = mount('rb-map');
    map.setAttribute('sheet', 'northern');
    map.data = data;
    map.view = view;

    const cells = [...map.querySelectorAll('.rb-shire-cells')];
    expect(cells.map((g) => g.dataset.shire).sort()).toEqual(
      Object.keys(data.shires.shires).filter((id) => data.shires.shires[id].map === 'northern').sort());

    // Bernicia as the printed sheet has it: its name, the Danish steward the
    // guide seats there, what supports him, and two castles.
    const bernicia = map.querySelector('.rb-shire-cells[data-shire="bernicia"]');
    expect(bernicia.querySelector('.rb-cell-shire').textContent).toBe('Bernicia');
    // A long name is two lines in the frame, so read them together.
    expect(steward(bernicia)).toContain('King Ecgberht');
    // One letter, and it is his liege's. Ecgberht claims Northumbria, and the
    // frame used to read "D N" because of it — but a claim is an ambition, and
    // the ground is held for the man he kneels to.
    expect(steward(bernicia).trim().startsWith('D ')).toBe(true);
    expect(steward(bernicia)).not.toContain('N');
    expect(bernicia.querySelector('.rb-cell-support').textContent).toContain('N, Be');
    expect(bernicia.querySelectorAll('.rb-cell-castle')).toHaveLength(2);
    expect(bernicia.querySelectorAll('.rb-settlement')).toHaveLength(4);
    // The frame and the strip ruled under it, so the cell reads as a form.
    expect(bernicia.querySelector('rect.rb-cell-frame')).toBeTruthy();
    expect(bernicia.querySelector('rect.rb-cell-strip')).toBeTruthy();

    // And every shire is tinted by whoever holds it, from the first minute.
    // As a style rather than a `color` attribute, which the stylesheet's own
    // default for .rb-shire would quietly beat.
    for (const path of map.querySelectorAll('path.rb-shire')) {
      expect(path.style.color, path.dataset.shire).toBeTruthy();
    }
  });

  it('follows a shire the game moves', () => {
    const { view } = seatedView({
      move: (state) => {
        state.shires.wrekinsets.stewardRoleId = 'halfdan_ragnarsson';
        state.shires.wrekinsets.factionId = 'great_heathen_army';
        state.shires.wrekinsets.castles = 1;
        const [first] = Object.keys(state.shires.wrekinsets.settlements);
        state.shires.wrekinsets.settlements[first].destroyed = true;
      },
    });
    const map = mount('rb-map');
    map.setAttribute('sheet', 'northern');
    map.data = data;
    map.view = view;

    const cell = map.querySelector('.rb-shire-cells[data-shire="wrekinsets"]');
    expect(steward(cell)).toContain('Halfdan Ragnarsson');
    // Ceolwulf held it with three; the Dane who took it has thrown two down.
    expect(cell.querySelectorAll('.rb-cell-castle')).toHaveLength(1);
    expect(cell.querySelectorAll('.rb-settlement')).toHaveLength(3);
    expect(cell.querySelectorAll('.rb-settlement.is-destroyed')).toHaveLength(1);
    expect(cell.querySelector('.rb-settlement-strike')).toBeTruthy();

    // The shires beside it are untouched and still fully drawn.
    const jorvik = map.querySelector('.rb-shire-cells[data-shire="jorvik"]');
    expect(steward(jorvik)).toContain('Halfdan Ragnarsson');
  });

  it('hatches a shire held without support, from the first minute', () => {
    // Halfdan and Guthrum have settled nowhere, so the shires they hold pay
    // nothing and count toward Disorder before anyone has done anything. The
    // board says so, because the board is the only thing that can.
    const { view } = seatedView();
    const map = mount('rb-map');
    map.setAttribute('sheet', 'northern');
    map.data = data;
    map.view = view;

    const unsupported = [...map.querySelectorAll('path.is-unsupported')]
      .map((p) => p.dataset.shire).sort();
    expect(unsupported).toEqual(['jorvik', 'ribble']);   // east_anglia is eastern

    // Said in words on the strip rather than by ruling a line through the
    // crowns above it, and said either way round — a strip that only spoke up
    // for bad news would leave "nothing printed" meaning both "supported" and
    // "not worked out yet".
    const verdicts = [...map.querySelectorAll('.rb-cell-verdict')];
    expect(verdicts).toHaveLength(6);
    const lost = verdicts.filter((t) => t.classList.contains('is-lost'));
    expect(lost.map((t) => t.closest('[data-shire]').dataset.shire).sort())
      .toEqual(['jorvik', 'ribble']);
    // childNodes[0], not textContent: the unsupported one carries a <title>
    // explaining itself, and textContent would read the tooltip in too.
    expect(lost[0].childNodes[0].textContent).toBe('Not Supported');
    expect(verdicts.find((t) => !t.classList.contains('is-lost')).textContent)
      .toBe('Supported');
    // And the crowns themselves are left legible.
    expect(map.querySelector('.rb-cell-support.is-lost')).toBeNull();
  });

  it('raises the shire that was clicked, rather than deciding anything', () => {
    const { view } = seatedView();
    const map = mount('rb-map');
    map.data = data;
    map.view = view;
    let heard = null;
    map.addEventListener('rb-shire', (event) => { heard = event.detail.shireId; });
    map.querySelector('path.rb-shire').dispatchEvent(new Event('click', { bubbles: true }));
    expect(heard).toBeTruthy();
  });

  it('switches sheets without losing the overlay', () => {
    const { view } = seatedView();
    const map = mount('rb-map');
    map.data = data;
    map.view = view;
    map.setAttribute('sheet', 'eastern');
    expect(map.querySelectorAll('path.rb-shire')).toHaveLength(6);
    expect(map.querySelector('image.rb-map-art').getAttribute('href'))
      .toBe('assets/maps/eastern.svg');
  });

  it('repeats a shire onto its other sheet, and clicking it goes there', () => {
    // Middle Anglia is played on the eastern sheet and printed again, greyed,
    // on the northern one — so a player looking north can see who holds the
    // shire over the border. It used to take no click at all, on the grounds
    // that there is one place to select a shire; but a signpost you cannot
    // follow is a worse answer than one you can, so it turns the page instead.
    const { view } = seatedView({
      move: (state) => { state.shires.middle_anglia.stewardRoleId = 'guthrum_the_old'; },
    });
    const map = mount('rb-map');
    map.setAttribute('sheet', 'northern');
    map.data = data;
    map.view = view;

    const ghost = map.querySelector('.rb-ghost[data-ghost-shire="middle_anglia"]');
    expect(ghost).toBeTruthy();
    expect(ghost.textContent).toContain('Middle Anglia');
    expect(ghost.textContent).toContain('Guthrum');
    // The letter leads the name here too, and it is Guthrum's own — he kneels
    // to nobody, so the top of his chain is himself.
    expect(ghost.querySelector('.rb-cell-faction').textContent.trim()).toBe('D');
    // Still not a shire in its own right: no outline, nothing to select here.
    expect(ghost.hasAttribute('data-shire')).toBe(false);

    const sheets = [];
    map.addEventListener('rb-sheet', (event) => sheets.push(event.detail.sheetId));
    ghost.dispatchEvent(new Event('click', { bubbles: true }));

    // It turns the page and stops there. Selecting the shire as well would be
    // deciding what somebody wants to do next on a sheet they have not seen
    // yet — and would leave a card open over ground they had not chosen.
    expect(sheets).toEqual(['eastern']);
    expect(map.getAttribute('sheet')).toBe('eastern');
    expect(map.selected).toBe(null);
  });

  it('arrives at a sheet holding nothing, however it got there', () => {
    // Whatever was open on the old sheet is put down on the way: through a
    // repeated neighbour, or a tab, or a page setting the attribute itself.
    const { view } = seatedView();
    const map = mount('rb-map');
    map.setAttribute('sheet', 'eastern');
    map.data = data;
    map.view = view;
    map.querySelector('path.rb-shire[data-shire="middle_anglia"]')
      .dispatchEvent(new Event('click', { bubbles: true }));
    expect(map.selected).toBe('middle_anglia');

    map.setAttribute('sheet', 'northern');
    expect(map.selected).toBe(null);
    map.querySelector('.rb-ghost[data-ghost-shire="middle_anglia"]')
      .dispatchEvent(new Event('click', { bubbles: true }));
    expect(map.getAttribute('sheet')).toBe('eastern');
    expect(map.selected).toBe(null);
  });

  it('fills every ghost in before anything has happened', () => {
    // Rewritten from "leaves a ghost blank until its shire moves". A ghost is
    // a frame the art does not draw either, so an empty one would be a grey
    // rectangle in the sea rather than a neighbour worth glancing at.
    const { view } = seatedView();
    const map = mount('rb-map');
    map.setAttribute('sheet', 'northern');
    map.data = data;
    map.view = view;

    const ghosts = [...map.querySelectorAll('.rb-ghost')];
    expect(ghosts.map((g) => g.dataset.ghostShire).sort())
      .toEqual(['magonsets', 'middle_anglia', 'south_mercia']);
    for (const ghost of ghosts) {
      expect(ghost.querySelector('.rb-ghost-name').textContent).toBeTruthy();
      expect(ghost.querySelector('.rb-ghost-steward').textContent).toBeTruthy();
    }
  });

  it('opens a card on the shire chosen, and puts it away again', () => {
    const { view } = seatedView();
    const map = mount('rb-map');
    map.setAttribute('sheet', 'northern');
    map.data = data;
    map.view = view;
    map.card.textContent = 'whatever the page wants said';

    const card = map.querySelector('.rb-map-card');
    expect(card.hidden).toBe(true);

    map.querySelector('path[data-shire="jorvik"]')
      .dispatchEvent(new Event('click', { bubbles: true }));
    expect(map.selected).toBe('jorvik');
    expect(card.hidden).toBe(false);
    // Anchored to the shire rather than parked in a column beside the map.
    expect(card.style.left).toMatch(/%$/);
    expect(card.style.top).toMatch(/%$/);

    // Turning the page puts it down — and leaves it down on the way back.
    // A selection is about a shire on the sheet in front of you, and one
    // carried across a change is a highlight on ground nobody is looking at.
    map.setAttribute('sheet', 'eastern');
    expect(card.hidden).toBe(true);
    expect(map.selected).toBe(null);

    map.setAttribute('sheet', 'northern');
    expect(card.hidden).toBe(true);

    map.querySelector('path[data-shire="jorvik"]')
      .dispatchEvent(new Event('click', { bubbles: true }));
    expect(card.hidden).toBe(false);
    map.querySelector('.rb-map-card-close').click();
    expect(card.hidden).toBe(true);
    expect(map.selected).toBe(null);
  });

  it('tells the page it has put the selection down, rather than just forgetting', () => {
    // The page owns the card's contents. If the map cleared quietly, the
    // facilitator's editor would be left pointing at a shire on a sheet that
    // is no longer showing, and the next edit would land on it.
    const { view } = seatedView();
    const map = mount('rb-map');
    map.setAttribute('sheet', 'northern');
    map.data = data;
    map.view = view;

    const heard = [];
    map.addEventListener('rb-shire', (event) => heard.push(event.detail.shireId));
    map.querySelector('path[data-shire="jorvik"]')
      .dispatchEvent(new Event('click', { bubbles: true }));
    map.setAttribute('sheet', 'eastern');
    expect(heard).toEqual(['jorvik', null]);

    // And a sheet change with nothing held says nothing at all.
    map.setAttribute('sheet', 'western');
    expect(heard).toEqual(['jorvik', null]);
  });

  it('carries the facilitator’s editor into the card and edits through it', () => {
    // The round trip the side panel used to do: click a shire, get the pencil,
    // change something, and have it leave as an ordinary command.
    const { state, view } = seatedView();
    const map = document.createElement('rb-map');
    map.setAttribute('sheet', 'western');
    map.innerHTML = '<rb-shire-editor slot="card"></rb-shire-editor>';
    document.body.append(map);

    const editor = map.querySelector('rb-shire-editor');
    expect(editor.closest('.rb-map-card-body')).toBeTruthy();

    map.addEventListener('rb-shire', (event) => { editor.shireId = event.detail.shireId; });
    map.data = data;
    map.view = view;
    editor.data = data;
    editor.state = state;

    map.querySelector('path[data-shire="wiltshire"]')
      .dispatchEvent(new Event('click', { bubbles: true }));
    expect(map.querySelector('.rb-map-card').hidden).toBe(false);
    expect(editor.textContent).toContain('Wiltshire');

    const sent = [];
    map.addEventListener('rb-facilitate', (event) => sent.push(event.detail));
    const select = editor.querySelector('[data-steward]');
    select.value = 'cenred';
    select.dispatchEvent(new Event('change'));
    expect(sent).toEqual([{
      verb: 'facilitator:set-steward', payload: { shireId: 'wiltshire', roleId: 'cenred' },
    }]);
  });

  it('closes a shire when the same one is clicked again', () => {
    // The × and the sea both close the card, but the thing people try first is
    // the county they just tapped, and a map that does nothing when they do
    // reads as one that has stopped responding.
    const { view } = seatedView();
    const map = mount('rb-map');
    map.setAttribute('sheet', 'northern');
    map.data = data;
    map.view = view;

    const heard = [];
    map.addEventListener('rb-shire', (event) => heard.push(event.detail.shireId));
    const jorvik = () => map.querySelector('path[data-shire="jorvik"]');

    jorvik().dispatchEvent(new Event('click', { bubbles: true }));
    expect(map.selected).toBe('jorvik');
    jorvik().dispatchEvent(new Event('click', { bubbles: true }));
    expect(map.selected).toBe(null);
    expect(map.querySelector('.rb-map-card').hidden).toBe(true);
    // The page hears the close as an ordinary deselection, so whatever it put
    // in the card is emptied rather than left pointing at a shut card.
    expect(heard).toEqual(['jorvik', null]);

    // And a different shire still simply moves the card.
    jorvik().dispatchEvent(new Event('click', { bubbles: true }));
    map.querySelector('path[data-shire="ribble"]').dispatchEvent(new Event('click', { bubbles: true }));
    expect(map.selected).toBe('ribble');
  });

  it('moors a ship value off every coast, and nowhere inland', () => {
    // The number sat on a boat out in the water on the printed sheets, and it
    // belongs there: it is a fact about the water, not about the steward, and
    // it used to be crammed into the end of the support strip instead.
    const { view } = seatedView();
    const map = mount('rb-map');
    map.setAttribute('sheet', 'western');
    map.data = data;
    map.view = view;

    for (const [id, printed] of Object.entries(data.shires.shires)) {
      if (printed.map !== 'western') continue;
      const boat = map.querySelector(`.rb-sea[data-sea="${id}"]`);
      const coastal = printed.shipCost !== null && printed.shipCost !== undefined;
      expect(Boolean(boat), id).toBe(coastal);
      if (coastal) {
        const cost = boat.querySelector('.rb-sea-cost');
        expect(cost.textContent, id).toBe(String(printed.shipCost));
        // On the sail of the ship the printed map moored there, which is a
        // transcribed position and not one this app chose.
        expect(Number(cost.getAttribute('x')), id).toBe(cells.sheets.western[id].sea.x);
        // And no second boat drawn over the artist's.
        expect(boat.querySelector('.rb-sea-hull'), id).toBeNull();
      }
    }
    // The strip it used to live in has let it go.
    expect(map.querySelector('.rb-cell-sea')).toBeNull();
    // The ships and the arrows are artwork, laid over the sheet.
    expect(map.querySelector('.rb-map-marks').getAttribute('href'))
      .toBe('assets/maps/marks-western.svg');
  });

  it('shows the ship value a contract or a fleet has moved, and says it moved', () => {
    const { view } = seatedView({
      move: (state) => { state.shires.wiltshire.shipCostDelta = -1; },
    });
    const map = mount('rb-map');
    map.setAttribute('sheet', 'western');
    map.data = data;
    map.view = view;

    const boat = map.querySelector('.rb-sea[data-sea="wiltshire"]');
    expect(boat.querySelector('.rb-sea-cost').textContent)
      .toBe(String(data.shires.shires.wiltshire.shipCost - 1));
    expect(boat.classList.contains('is-moved')).toBe(true);
  });

  it('lets only a facilitator touch the ship value, one step at a time', () => {
    const { view } = seatedView();
    const player = mount('rb-map');
    player.setAttribute('sheet', 'western');
    player.data = data;
    player.view = view;
    expect(player.querySelector('.rb-sea-hit')).toBeNull();

    const map = mount('rb-map');
    map.setAttribute('sheet', 'western');
    map.setAttribute('editable', '');
    map.data = data;
    map.view = view;

    const sent = [];
    map.addEventListener('rb-facilitate', (event) => sent.push(event.detail));
    map.querySelector('.rb-sea[data-sea="wiltshire"] .rb-sea-hit')
      .dispatchEvent(new Event('click', { bubbles: true }));

    const panel = map.querySelector('.rb-map-sea');
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain('Wiltshire');
    expect(panel.querySelector('.rb-map-sea-value').textContent)
      .toBe(String(data.shires.shires.wiltshire.shipCost));

    // A delta, like every other facilitator number — a contract and a fleet
    // both write this field, and an absolute would clobber whichever landed
    // in between.
    panel.querySelector('[data-step="1"]').click();
    expect(sent).toEqual([{
      verb: 'facilitator:adjust',
      payload: { path: ['shires', 'wiltshire', 'shipCostDelta'], delta: 1 },
    }]);

    // Clicking the boat again puts the panel away, same as everything else.
    map.querySelector('.rb-sea[data-sea="wiltshire"] .rb-sea-hit')
      .dispatchEvent(new Event('click', { bubbles: true }));
    expect(map.querySelector('.rb-map-sea').hidden).toBe(true);
  });

  it('takes a click on the steward box as a click on that shire', () => {
    // The frames are drawn wherever they fit, which for a narrow shire is out
    // over a neighbour or over the sea. With the cells transparent to clicks,
    // aiming at a steward's name either selected the shire underneath the box
    // or nothing at all — which is why so many of them appeared dead.
    const { view } = seatedView();
    const map = mount('rb-map');
    map.setAttribute('sheet', 'western');
    map.data = data;
    map.view = view;

    for (const id of ['wiltshire', 'hwicce', 'redding', 'magonsets']) {
      const heard = [];
      map.addEventListener('rb-shire', (event) => heard.push(event.detail.shireId));
      map.querySelector(`.rb-shire-cells[data-shire="${id}"] rect.rb-cell-frame`)
        .dispatchEvent(new Event('click', { bubbles: true }));
      expect(heard, id).toEqual([id]);
      map.querySelector(`.rb-shire-cells[data-shire="${id}"] rect.rb-cell-frame`)
        .dispatchEvent(new Event('click', { bubbles: true }));   // and shut again
    }
  });

  it('gives a player no way to touch a settlement', () => {
    // The gate on the whole of the editing below. Both consoles mount this
    // element; only the facilitator's page says `editable`.
    const { view } = seatedView();
    const map = mount('rb-map');
    map.setAttribute('sheet', 'western');
    map.data = data;
    map.view = view;

    expect(map.editable).toBe(false);
    expect(map.querySelector('.rb-settlement-hit')).toBeNull();

    // Even a click aimed straight at the letter is a click on the shire.
    const heard = [];
    map.addEventListener('rb-facilitate', (event) => heard.push(event.detail));
    map.querySelector('.rb-shire-cells[data-shire="wiltshire"] .rb-settlement')
      .dispatchEvent(new Event('click', { bubbles: true }));
    expect(heard).toEqual([]);
    expect(map.selectedSettlement).toBe(null);
    expect(map.selected).toBe('wiltshire');
    expect(map.querySelector('.rb-map-settlement').hidden).toBe(true);
  });

  it('gives every settlement a hit target once the map is editable', () => {
    // Moved from shire-editor.test.js, where this was a list of two checkboxes
    // per settlement. The letter is a single character, so it needs a disc
    // under it to be clickable at all — and one that never reaches past the
    // halfway line to the letter beside it, because some shires set theirs
    // closer together than the letters are wide.
    const { view } = seatedView();
    const map = mount('rb-map');
    map.setAttribute('sheet', 'western');
    map.setAttribute('editable', '');
    map.data = data;
    map.view = view;

    const cell = map.querySelector('.rb-shire-cells[data-shire="wiltshire"]');
    const printedCount = data.shires.shires.wiltshire.settlements.length;
    expect(cell.querySelectorAll('.rb-settlement')).toHaveLength(printedCount);
    expect(cell.querySelectorAll('.rb-settlement-hit')).toHaveLength(printedCount);

    const anchors = cells.sheets.western.wiltshire.settlements;
    for (const [index, hit] of [...cell.querySelectorAll('.rb-settlement-hit')].entries()) {
      const radius = Number(hit.getAttribute('r'));
      expect(radius).toBeGreaterThan(0);
      for (const [other, at] of anchors.entries()) {
        if (other === index) continue;
        const gap = Math.hypot(at.x - anchors[index].x, at.y - anchors[index].y);
        expect(radius).toBeLessThanOrEqual(gap / 2 + 1e-9);
      }
    }
  });

  it('offers the three states a settlement can be in, on the settlement', () => {
    const { view } = seatedView();
    const map = mount('rb-map');
    map.setAttribute('sheet', 'western');
    map.setAttribute('editable', '');
    map.data = data;
    map.view = view;

    const panel = map.querySelector('.rb-map-settlement');
    expect(panel.hidden).toBe(true);

    const [settlementId] = data.shires.shires.wiltshire.settlements.map((s) => s.id);
    map.querySelector(`.rb-settlement[data-settlement="${settlementId}"]`)
      .dispatchEvent(new Event('click', { bubbles: true }));

    expect(map.selectedSettlement).toEqual({ shireId: 'wiltshire', settlementId });
    expect(panel.hidden).toBe(false);
    // Radios, not two checkboxes: the states are exclusive in play, and a pair
    // of boxes could say a burned settlement was also being held.
    expect([...panel.querySelectorAll('input')].map((i) => i.value))
      .toEqual(['standing', 'defended', 'destroyed']);
    expect([...panel.querySelectorAll('input')].every((i) => i.type === 'radio')).toBe(true);
    expect(panel.querySelector('input[value="standing"]').checked).toBe(true);
    // Anchored to the settlement, the same way the card is to its shire.
    expect(panel.style.left).toMatch(/%$/);
    expect(panel.style.top).toMatch(/%$/);
    // And the letter it is about is marked, since the panel opens beside it.
    expect(map.querySelector(`.rb-settlement[data-settlement="${settlementId}"]`)
      .classList.contains('is-selected')).toBe(true);
  });

  it('circles or strikes a settlement directly', () => {
    // Moved from shire-editor.test.js. Same command, raised from the map.
    const { view } = seatedView();
    const map = mount('rb-map');
    map.setAttribute('sheet', 'western');
    map.setAttribute('editable', '');
    map.data = data;
    map.view = view;

    const [settlementId] = data.shires.shires.wiltshire.settlements.map((s) => s.id);
    map.querySelector(`.rb-settlement[data-settlement="${settlementId}"]`)
      .dispatchEvent(new Event('click', { bubbles: true }));

    const sent = [];
    map.addEventListener('rb-facilitate', (event) => sent.push(event.detail));
    const panel = map.querySelector('.rb-map-settlement');
    panel.querySelector('input[value="defended"]').dispatchEvent(new Event('change'));

    expect(sent).toEqual([{
      verb: 'facilitator:set-settlement',
      payload: { shireId: 'wiltshire', settlementId, field: 'defended', value: true },
    }]);
  });

  it('clears what it is leaving before setting what it is going to', () => {
    // The command takes one field at a time, so defended -> destroyed is two
    // of them, and the order is the whole point: set-then-clear would leave
    // the settlement ringed *and* struck through in between, and leave it
    // there for good if the second command were refused. Cleared first, a
    // half-applied change is always one of the three legal states.
    const { view } = seatedView({
      move: (state) => {
        const [first] = Object.keys(state.shires.wiltshire.settlements);
        state.shires.wiltshire.settlements[first].defended = true;
      },
    });
    const map = mount('rb-map');
    map.setAttribute('sheet', 'western');
    map.setAttribute('editable', '');
    map.data = data;
    map.view = view;

    const [settlementId] = data.shires.shires.wiltshire.settlements.map((s) => s.id);
    map.querySelector(`.rb-settlement[data-settlement="${settlementId}"]`)
      .dispatchEvent(new Event('click', { bubbles: true }));
    const panel = map.querySelector('.rb-map-settlement');
    expect(panel.querySelector('input[value="defended"]').checked).toBe(true);

    const sent = [];
    map.addEventListener('rb-facilitate', (event) => sent.push(event.detail.payload));
    panel.querySelector('input[value="destroyed"]').dispatchEvent(new Event('change'));

    expect(sent).toEqual([
      { shireId: 'wiltshire', settlementId, field: 'defended', value: false },
      { shireId: 'wiltshire', settlementId, field: 'destroyed', value: true },
    ]);
  });

  it('asks for nothing it already has', () => {
    // The state the radios are showing is the state on the board, so choosing
    // it again is not a change and must not become a log entry.
    const { view } = seatedView();
    const map = mount('rb-map');
    map.setAttribute('sheet', 'western');
    map.setAttribute('editable', '');
    map.data = data;
    map.view = view;

    const [settlementId] = data.shires.shires.wiltshire.settlements.map((s) => s.id);
    map.querySelector(`.rb-settlement[data-settlement="${settlementId}"]`)
      .dispatchEvent(new Event('click', { bubbles: true }));

    const sent = [];
    map.addEventListener('rb-facilitate', (event) => sent.push(event.detail));
    map.querySelector('.rb-map-settlement input[value="standing"]')
      .dispatchEvent(new Event('change'));
    expect(sent).toEqual([]);
  });

  it('closes a settlement when the same one is clicked again', () => {
    const { view } = seatedView();
    const map = mount('rb-map');
    map.setAttribute('sheet', 'western');
    map.setAttribute('editable', '');
    map.data = data;
    map.view = view;

    const [settlementId] = data.shires.shires.wiltshire.settlements.map((s) => s.id);
    const glyph = () => map.querySelector(`.rb-settlement[data-settlement="${settlementId}"]`);

    glyph().dispatchEvent(new Event('click', { bubbles: true }));
    expect(map.selectedSettlement).toBeTruthy();
    glyph().dispatchEvent(new Event('click', { bubbles: true }));
    expect(map.selectedSettlement).toBe(null);
    expect(map.querySelector('.rb-map-settlement').hidden).toBe(true);
  });

  it('keeps one panel on the sheet at a time', () => {
    // Both are pinned to points a few millimetres apart — a settlement sits
    // inside its own shire — so two open at once means one covering the other.
    const { view } = seatedView();
    // Built before it is mounted: the card's contents are carried in when the
    // component builds itself, so setting them afterwards would wipe it.
    const map = document.createElement('rb-map');
    map.setAttribute('sheet', 'western');
    map.setAttribute('editable', '');
    map.innerHTML = '<div slot="card">the card</div>';
    document.body.append(map);
    map.data = data;
    map.view = view;

    const heard = [];
    map.addEventListener('rb-shire', (event) => heard.push(event.detail.shireId));
    const [settlementId] = data.shires.shires.wiltshire.settlements.map((s) => s.id);

    map.querySelector('path[data-shire="wiltshire"]').dispatchEvent(new Event('click', { bubbles: true }));
    expect(map.querySelector('.rb-map-card').hidden).toBe(false);

    map.querySelector(`.rb-settlement[data-settlement="${settlementId}"]`)
      .dispatchEvent(new Event('click', { bubbles: true }));
    expect(map.querySelector('.rb-map-card').hidden).toBe(true);
    expect(map.querySelector('.rb-map-settlement').hidden).toBe(false);
    // The page is told the card went away rather than left holding a shire
    // nothing is pointing at any more.
    expect(heard).toEqual(['wiltshire', null]);

    map.querySelector('path[data-shire="redding"]').dispatchEvent(new Event('click', { bubbles: true }));
    expect(map.querySelector('.rb-map-settlement').hidden).toBe(true);
    expect(map.querySelector('.rb-map-card').hidden).toBe(false);
  });

  it('puts the settlement panel away when its sheet is not the one shown', () => {
    const { view } = seatedView();
    const map = mount('rb-map');
    map.setAttribute('sheet', 'western');
    map.setAttribute('editable', '');
    map.data = data;
    map.view = view;

    const [settlementId] = data.shires.shires.wiltshire.settlements.map((s) => s.id);
    map.querySelector(`.rb-settlement[data-settlement="${settlementId}"]`)
      .dispatchEvent(new Event('click', { bubbles: true }));
    expect(map.querySelector('.rb-map-settlement').hidden).toBe(false);

    // And leaving the sheet puts it down for good, like everything else the
    // map holds — coming back does not re-open it.
    map.setAttribute('sheet', 'eastern');
    expect(map.querySelector('.rb-map-settlement').hidden).toBe(true);
    expect(map.selectedSettlement).toBe(null);
    map.setAttribute('sheet', 'western');
    expect(map.querySelector('.rb-map-settlement').hidden).toBe(true);
  });

  it('trims "England" off its own sheet tabs, being already inside the board', () => {
    // A player who has already opened the board should not read "Northern
    // England" beside a sibling top-level tab that is also just "England"
    // but shows something else entirely (the Aftermath tracker).
    const { view } = seatedView();
    const map = mount('rb-map');
    map.data = data;
    map.view = view;
    const labels = [...map.querySelectorAll('.rb-map-tabs button')].map((b) => b.textContent);
    expect(labels).toEqual(['Northern', 'Western', 'Eastern']);
  });

  it('points at the shires an action was given to target, and nowhere else', () => {
    const { view } = seatedView();
    const map = mount('rb-map');
    map.setAttribute('sheet', 'northern');
    map.data = data;
    map.view = view;
    map.highlighted = ['jorvik', 'ribble'];

    const lit = [...map.querySelectorAll('path.is-highlighted')].map((p) => p.dataset.shire);
    expect(lit.sort()).toEqual(['jorvik', 'ribble']);
  });

  it('clears the highlight once the chooser it was for is gone', () => {
    const { view } = seatedView();
    const map = mount('rb-map');
    map.setAttribute('sheet', 'northern');
    map.data = data;
    map.view = view;
    map.highlighted = ['jorvik'];
    map.highlighted = null;
    expect(map.querySelectorAll('path.is-highlighted')).toHaveLength(0);
  });
});

describe('<rb-private-sheet>', () => {
  it('shows what is yours and cannot show what is not', () => {
    // The redaction already happened on the host. Another player's silver is
    // simply not in the projection, so no amount of rendering can leak it.
    const { view } = seatedView();
    const sheet = mount('rb-private-sheet');
    sheet.data = data;
    sheet.view = view;

    expect(sheet.textContent).toContain('King Alfred');
    const tracks = [...sheet.querySelectorAll('.rb-track')]
      .map((t) => [t.querySelector('dt').textContent, t.querySelector('dd').textContent]);
    expect(tracks).toEqual([['Silver', '4'], ['Food', '4'], ['Soldiers', '4'], ['Ships', '0']]);

    // Guthrum's silver is not in the projection at all, so nothing rendered
    // from it could show his. (His *name* is fair game — Alfred's own brief
    // calls him out as the immediate threat, and Alfred is allowed to read
    // his own brief.)
    expect(view.roles.guthrum_the_old.silver).toBeUndefined();
    expect(sheet.textContent).toMatch(/Guthrum and his Great Summer Army/);
    expect(sheet.textContent).not.toMatch(/\b8\b/);
  });

  it('shows the brief, and says why it is private', () => {
    const { view } = seatedView();
    const sheet = mount('rb-private-sheet');
    sheet.data = data;
    sheet.view = view;
    expect(sheet.querySelectorAll('.rb-goals li').length).toBeGreaterThan(0);
    expect(sheet.textContent).toContain('keep them to yourself');
  });

  it('lists lands and flags one held without support', () => {
    const { view } = seatedView({ roleId: 'halfdan_ragnarsson' });
    const sheet = mount('rb-private-sheet');
    sheet.data = data;
    sheet.view = view;
    expect(sheet.textContent).toContain('Jorvik');
    expect(sheet.querySelectorAll('.rb-warn').length).toBe(2);   // Jorvik and Ribble
  });

  it('marks a landless player’s stat cards with what they collect instead', () => {
    // The modifier sits on the card it changes rather than in a separate
    // paragraph, so it reads as "this number, because of that" at a glance.
    const { view } = seatedView({ roleId: 'godric' });
    const sheet = mount('rb-private-sheet');
    sheet.data = data;
    sheet.view = view;
    expect(sheet.textContent).toContain('+2 landless');   // food
    expect(sheet.textContent).toContain('+1 landless');   // soldiers
    expect(sheet.textContent).toContain('You steward nothing');
  });

  it('shows what a landed player’s stat cards will pay next turn', () => {
    const { view } = seatedView();
    const sheet = mount('rb-private-sheet');
    sheet.data = data;
    sheet.view = view;
    expect(sheet.textContent).toMatch(/\+\d+\/turn/);
  });

  it('warns before a third wound rather than after', () => {
    const { state } = seatedView();
    state.roles.king_alfred.wounds = 2;
    const view = projectView(state, data, {
      kind: 'player', seatId: 's1', roleId: 'king_alfred', teamId: 'wessex',
    });
    const sheet = mount('rb-private-sheet');
    sheet.data = data;
    sheet.view = view;
    expect(sheet.querySelector('.rb-wounds.is-grave').textContent).toContain('One more would kill you');
  });
});

describe('<rb-aftermath>', () => {
  it('shows the opening position in the bands the sheet prints', () => {
    const { view } = seatedView();
    const tracker = mount('rb-aftermath');
    tracker.view = view;

    const values = [...tracker.querySelectorAll('.rb-counter-value')].map((e) => e.textContent);
    expect(values).toEqual(['3', '3', '3', '75']);   // paganism, danelaw, disorder, prosperity
    // Every counter lands in a real band, so every one has a sentence.
    expect(tracker.querySelectorAll('.rb-band.is-here')).toHaveLength(4);
    expect(tracker.textContent).not.toContain('Outside the printed bands');
  });

  it('says nothing has been promised yet rather than showing an empty line', () => {
    const { view } = seatedView();
    const tracker = mount('rb-aftermath');
    tracker.view = view;
    expect(tracker.textContent).toContain('Nothing has been promised');
  });
});

describe('<rb-seat-roster>', () => {
  it('escapes a name someone typed', () => {
    // The only free text a player controls that everyone else renders.
    const roster = mount('rb-seat-roster');
    roster.seats = [{ id: 's1', name: '<img src=x onerror=alert(1)>', roleId: null, kind: 'player', connected: true }];
    expect(roster.querySelector('img')).toBe(null);
    expect(roster.textContent).toContain('<img src=x');
  });

  it('dims a seat that has dropped without forgetting it', () => {
    const roster = mount('rb-seat-roster');
    roster.seats = [{ id: 's1', name: 'Alice', roleId: 'cenred', kind: 'player', connected: false }];
    expect(roster.querySelector('.rb-seat').dataset.connected).toBe('false');
    expect(roster.textContent).toContain('cenred');
  });
});
