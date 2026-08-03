// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply } from '../../gui/rules/reducer.js';
import { epiloguePage } from '../../gui/host/persistence.js';
import '../../gui/components/rb-epilogue.js';

const data = await loadData();
const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };

function ended() {
  let state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
  state.seats.s9 = { id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
  const step = (verb, payload = {}) => {
    state = apply(state, data, { verb, payload }, FACILITATOR, { ts: 1000 }).state;
  };
  step('facilitator:advance-phase');
  step('facilitator:record-concession',
    { npcFaction: 'pope', roleId: 'king_alfred', text: 'The bishops freed' });
  step('facilitator:end-game');
  return state;
}

const mount = (state) => {
  const panel = document.createElement('rb-epilogue');
  document.body.append(panel);
  panel.data = data;
  panel.state = state;
  return panel;
};

beforeEach(() => { document.body.innerHTML = ''; });

describe('<rb-epilogue>', () => {
  it('reads out the four verdicts, not just the four numbers', () => {
    const panel = mount(ended());
    expect(panel.textContent).toContain('The church takes on some pagan influence.');
    expect(panel.textContent).toContain('Some Danish enclaves.');
    expect(panel.textContent).toContain('War is inevitable');
    expect(panel.textContent).toContain('All of England prospers.');
  });

  it('gives every player a line', () => {
    const panel = mount(ended());
    expect(panel.querySelectorAll('.rb-final tbody tr')).toHaveLength(16);
    expect(panel.textContent).toContain('King Alfred');
    expect(panel.textContent).toContain('Wiltshire');
  });

  it('names the factions as they ended', () => {
    const state = ended();
    state.roles.cenred.factionId = 'cenred';
    const panel = mount(state);
    expect(panel.querySelectorAll('.rb-factions li').length).toBeGreaterThan(4);
  });

  it('reads the ledger of what was promised abroad', () => {
    const panel = mount(ended());
    expect(panel.textContent).toContain('The bishops freed');
    expect(panel.textContent).toContain('the Pope');
    expect(panel.textContent).toContain('King Alfred');
  });

  it('says plainly when nothing was promised', () => {
    const state = ended();
    state.concessions = {};
    const panel = mount(state);
    expect(panel.textContent).toContain('Nobody promised anybody anything.');
  });

  it('hands back the report it drew, for saving', () => {
    const panel = mount(ended());
    expect(panel.report.counters.paganism.value).toBe(3);
    expect(panel.report.players).toHaveLength(16);
  });
});

describe('the saved page', () => {
  it('stands on its own, with nothing to fetch', () => {
    const panel = mount(ended());
    const page = epiloguePage(panel.innerHTML, 'RAVEN7Z');
    expect(page).toContain('<!doctype html>');
    expect(page).toContain('RAVEN7Z');
    expect(page).toContain('The church takes on some pagan influence.');
    // Nothing external: a debrief mailed round next week still renders.
    expect(page).not.toMatch(/<(script|link)\b/);
    expect(page).not.toMatch(/https?:\/\//);
  });
});
