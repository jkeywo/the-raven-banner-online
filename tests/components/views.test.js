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
// The map view wants both halves of the printed sheet: where things sit, and
// where the exporter blanked the state cells out of the art.
const cells = JSON.parse(await readFile(join(ROOT, 'assets', 'maps', 'cells.json'), 'utf8'));
const data = { ...core, geometry, cells };

/**
 * A game with someone seated, projected as they would see it.
 *
 * `move` runs against the state before it is projected, which is how a test
 * asks for a board the game has actually moved — every map assertion about
 * live cells needs one, since an untouched board deliberately draws nothing.
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

  it('draws nothing over a board still standing where the rules printed it', () => {
    // The headline behaviour. The artwork's steward frames, support strips,
    // castle stacks and settlement letters are blank parchment now, and on
    // turn zero the overlay leaves them that way — the outlines are there to
    // be clicked and nothing else. Anything the eye lands on has happened.
    const { view } = seatedView();
    const map = mount('rb-map');
    map.data = data;
    map.view = view;

    expect(map.querySelectorAll('.rb-shire-cells')).toHaveLength(0);
    expect(map.querySelectorAll('.rb-ghost')).toHaveLength(0);
    expect(map.querySelectorAll('path.rb-shire.is-live')).toHaveLength(0);
    for (const path of map.querySelectorAll('path.rb-shire')) {
      expect(path.dataset.moved).toBe('false');
      expect(path.hasAttribute('color')).toBe(false);
    }
  });

  it('draws a shire’s live cells the moment the game moves it', () => {
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

    const cellGroups = [...map.querySelectorAll('.rb-shire-cells')];
    expect(cellGroups.map((g) => g.dataset.shire)).toEqual(['wrekinsets']);
    const cell = cellGroups[0];
    expect(cell.querySelector('.rb-cell-steward').textContent).toContain('Halfdan');
    expect(cell.querySelectorAll('.rb-cell-castle')).toHaveLength(1);
    expect(cell.querySelectorAll('.rb-settlement')).toHaveLength(3);
    expect(cell.querySelectorAll('.rb-settlement.is-destroyed')).toHaveLength(1);
    expect(cell.querySelector('.rb-settlement-strike')).toBeTruthy();
  });

  it('marks a shire held without support, once losing it was something that happened', () => {
    // Rewritten from "three of them at turn zero". Halfdan and Guthrum start
    // unsupported everywhere they stand, so at turn zero that is a printed
    // fact rather than an event and the map keeps quiet about it. A Dane
    // taking a Mercian shire off Ceowulf is an event, and hatches.
    const { view } = seatedView({
      move: (state) => { state.shires.wrekinsets.stewardRoleId = 'halfdan_ragnarsson'; },
    });
    const map = mount('rb-map');
    map.setAttribute('sheet', 'northern');
    map.data = data;
    map.view = view;

    const unsupported = [...map.querySelectorAll('path.is-unsupported')].map((p) => p.dataset.shire);
    expect(unsupported).toEqual(['wrekinsets']);
    expect(map.querySelector('.rb-cell-support.is-lost')).toBeTruthy();
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

  it('repeats a shire onto its other sheet as a copy that cannot be clicked', () => {
    // Middle Anglia is played on the eastern sheet and printed again, greyed,
    // on the northern one — so a player looking north can see who holds the
    // shire over the border. It is the same data, read-only: there is exactly
    // one place to select a shire, and it is the sheet it lives on.
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
    expect(ghost.querySelector('title').textContent).toContain('read-only');
    // No shire to read off it, so a click cannot select one.
    expect(ghost.hasAttribute('data-shire')).toBe(false);
    let heard = 'unset';
    map.addEventListener('rb-shire', (event) => { heard = event.detail.shireId; });
    ghost.dispatchEvent(new Event('click', { bubbles: true }));
    expect(heard).toBe(null);
  });

  it('leaves a ghost blank while its shire is still where it was printed', () => {
    const { view } = seatedView();
    const map = mount('rb-map');
    map.setAttribute('sheet', 'northern');
    map.data = data;
    map.view = view;
    expect(map.querySelector('.rb-ghost')).toBe(null);
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

    // The shire is on another sheet now, so there is nothing to anchor to.
    map.setAttribute('sheet', 'eastern');
    expect(card.hidden).toBe(true);

    map.setAttribute('sheet', 'northern');
    expect(card.hidden).toBe(false);
    map.querySelector('.rb-map-card-close').click();
    expect(card.hidden).toBe(true);
    expect(map.selected).toBe(null);
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
