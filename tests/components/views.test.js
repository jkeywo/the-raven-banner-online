// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { projectView } from '../../gui/rules/views.js';
import '../../gui/components/rb-map.js';
import '../../gui/components/rb-private-sheet.js';
import '../../gui/components/rb-aftermath.js';
import '../../gui/components/rb-seat-roster.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const core = await loadData();
const geometry = JSON.parse(await readFile(join(DATA_DIR, 'geometry.json'), 'utf8'));
const data = { ...core, geometry };

/** A game with someone seated, projected as they would see it. */
function seatedView({ roleId = 'king_alfred' } = {}) {
  const state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
  state.seats.s1 = {
    id: 's1', token: 't', name: 'Alice', roleId, kind: 'player',
    connected: true, lastSeen: 0,
  };
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

  it('shares one viewBox with the printed art so the overlay lines up', () => {
    const { view } = seatedView();
    const map = mount('rb-map');
    map.data = data;
    map.view = view;
    const svg = map.querySelector('svg');
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${geometry.viewBox[0]} ${geometry.viewBox[1]}`);
    expect(map.querySelector('img').getAttribute('src')).toBe('assets/maps/northern.png');
  });

  it('marks a shire held without support', () => {
    // Three of them at turn zero, all Danish: without support their defended
    // settlements pay nothing, which is worth seeing on the board.
    const { view } = seatedView();
    const map = mount('rb-map');
    map.data = data;
    map.view = view;
    const unsupported = [...map.querySelectorAll('path.is-unsupported')].map((p) => p.dataset.shire);
    expect(unsupported.sort()).toEqual(['jorvik', 'ribble']);   // the northern two
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
    expect(map.querySelector('img').getAttribute('src')).toBe('assets/maps/eastern.png');
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

  it('tells a landless player what they collect instead', () => {
    const { view } = seatedView({ roleId: 'godric' });
    const sheet = mount('rb-private-sheet');
    sheet.data = data;
    sheet.view = view;
    expect(sheet.textContent).toContain('Holding no land');
    expect(sheet.textContent).toContain('You steward nothing');
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
