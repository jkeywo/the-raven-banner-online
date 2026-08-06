// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply } from '../../gui/rules/reducer.js';
import '../../gui/components/rb-facilitator-grid.js';

const data = await loadData();
const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };

function run(state, verb, payload = {}) {
  const result = apply(state, data, { verb, payload }, FACILITATOR, { ts: 0 });
  if (!result.ok) throw new Error(`${verb} refused: ${result.reason}`);
  return result.state;
}

/** A state parked in the battle phase, with turn one's fixed targets declared. */
function atBattle() {
  let state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
  state = run(state, 'facilitator:advance-phase');   // lobby -> team
  state = run(state, 'facilitator:advance-phase');   // team -> battle
  return state;
}

const mount = () => {
  const element = document.createElement('rb-facilitator-grid');
  document.body.append(element);
  return element;
};

beforeEach(() => { document.body.innerHTML = ''; });

describe('<rb-facilitator-grid> before the targets are announced', () => {
  it('lists each declared target with a way to change it', () => {
    const grid = mount();
    grid.data = data;
    grid.state = atBattle();

    const rows = grid.querySelectorAll('[data-retarget]');
    expect(rows.length).toBe(2);   // white and black both hold a token at turn one
    expect(grid.querySelector('[data-retarget="white"]').value).toBe('lindsey');
    expect(grid.querySelector('[data-retarget="black"]').value).toBe('essex');
  });

  it('sends a correction that overrides even a fixed target', () => {
    const grid = mount();
    grid.data = data;
    grid.state = atBattle();

    let raised = null;
    grid.addEventListener('rb-facilitate', (event) => { raised = event.detail; });
    grid.querySelector('[data-retarget="white"]').value = 'wiltshire';
    grid.querySelector('[data-commit-retarget="white"]').click();

    expect(raised).toEqual({
      verb: 'facilitator:set-initiative-target', payload: { token: 'white', shireId: 'wiltshire' },
    });
  });

  it('drops the whole panel once targets are announced', () => {
    const grid = mount();
    grid.data = data;
    grid.state = run(atBattle(), 'facilitator:announce-targets');

    expect(grid.querySelector('[data-retarget]')).toBeNull();
    expect(grid.querySelector('[data-announce]')).toBeNull();
  });
});
