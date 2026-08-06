// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import '../../gui/components/rb-shire-editor.js';

const data = await loadData();

const mount = () => {
  const element = document.createElement('rb-shire-editor');
  document.body.append(element);
  return element;
};

const fresh = () => createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });

beforeEach(() => { document.body.innerHTML = ''; });

describe('<rb-shire-editor>', () => {
  it('asks for a shire before showing anything to edit', () => {
    const editor = mount();
    editor.data = data;
    editor.state = fresh();
    expect(editor.textContent).toContain('Choose a shire');
    expect(editor.querySelector('[data-steward]')).toBeNull();
  });

  it('offers every role as a possible steward, including nobody', () => {
    const editor = mount();
    editor.data = data;
    editor.state = fresh();
    editor.shireId = 'wiltshire';

    const select = editor.querySelector('[data-steward]');
    expect([...select.options].map((o) => o.value)).toContain('king_alfred');
    expect(select.value).toBe('king_alfred');
  });

  it('reassigns the steward directly', () => {
    const editor = mount();
    editor.data = data;
    editor.state = fresh();
    editor.shireId = 'wiltshire';

    const sent = [];
    document.addEventListener('rb-facilitate', (event) => sent.push(event.detail));
    const select = editor.querySelector('[data-steward]');
    select.value = 'cenred';
    select.dispatchEvent(new Event('change'));
    expect(sent).toEqual([{
      verb: 'facilitator:set-steward', payload: { shireId: 'wiltshire', roleId: 'cenred' },
    }]);
  });

  it('can hand a shire to nobody', () => {
    const editor = mount();
    editor.data = data;
    editor.state = fresh();
    editor.shireId = 'wiltshire';

    const sent = [];
    document.addEventListener('rb-facilitate', (event) => sent.push(event.detail));
    const select = editor.querySelector('[data-steward]');
    select.value = '';
    select.dispatchEvent(new Event('change'));
    expect(sent).toEqual([{
      verb: 'facilitator:set-steward', payload: { shireId: 'wiltshire', roleId: null },
    }]);
  });

  it('commits a castle adjustment as a delta', () => {
    const editor = mount();
    editor.data = data;
    editor.state = fresh();
    editor.shireId = 'wiltshire';

    let raised = null;
    document.addEventListener('rb-facilitate', (event) => { raised = event.detail; });
    const input = editor.querySelector('[data-adjust="shires.wiltshire.castles"]');
    input.value = '1';
    editor.querySelector('[data-commit-adjust="shires.wiltshire.castles"]').click();
    expect(raised).toEqual({
      verb: 'facilitator:adjust', payload: { path: ['shires', 'wiltshire', 'castles'], delta: 1 },
    });
  });

  it('offers a ship value only for a coastal shire', () => {
    const editor = mount();
    editor.data = data;
    editor.state = fresh();

    editor.shireId = 'wiltshire';   // coastal, ship cost 2 in the printed data
    expect(editor.querySelector('[data-adjust="shires.wiltshire.shipCostDelta"]')).toBeTruthy();

    editor.shireId = 'south_mercia';   // landlocked
    expect(editor.querySelector('[data-adjust="shires.south_mercia.shipCostDelta"]')).toBeNull();
  });

  it('adjusts the ship value on top of whatever a contract or fleet already did', () => {
    const editor = mount();
    editor.data = data;
    const state = fresh();
    state.shires.wiltshire.shipCostDelta = -2;
    editor.state = state;
    editor.shireId = 'wiltshire';

    const printed = data.shires.shires.wiltshire.shipCost;
    expect(editor.querySelector('.rb-inspector-stat-value').textContent.trim())
      .not.toBe(String(printed));

    let raised = null;
    document.addEventListener('rb-facilitate', (event) => { raised = event.detail; });
    const input = editor.querySelector('[data-adjust="shires.wiltshire.shipCostDelta"]');
    input.value = '-1';
    editor.querySelector('[data-commit-adjust="shires.wiltshire.shipCostDelta"]').click();
    expect(raised.payload).toEqual({ path: ['shires', 'wiltshire', 'shipCostDelta'], delta: -1 });
  });

  it('refuses to send an empty or zero adjustment', () => {
    const editor = mount();
    editor.data = data;
    editor.state = fresh();
    editor.shireId = 'wiltshire';

    const sent = [];
    document.addEventListener('rb-facilitate', (event) => sent.push(event.detail));
    editor.querySelector('[data-commit-adjust="shires.wiltshire.castles"]').click();
    expect(sent).toEqual([]);
    expect(editor.querySelector('[data-error-for="shires.wiltshire.castles"]').textContent)
      .toContain('nonzero');
  });

  it('leaves the settlements to the map, and says so', () => {
    // They were a list of checkboxes here, two per settlement. A shire with
    // five churches gave five identical rows reading "Church", none of which
    // said which church on the ground it meant — so the control moved onto the
    // letter itself. The tests for it went with it, to views.test.js.
    const editor = mount();
    editor.data = data;
    editor.state = fresh();
    editor.shireId = 'wiltshire';

    expect(editor.querySelector('.rb-editor-settlements')).toBeNull();
    expect(editor.querySelector('[data-settlement]')).toBeNull();
    expect(editor.textContent).toContain('Click a settlement letter on the map');
  });

  it('switches cleanly between shires', () => {
    const editor = mount();
    editor.data = data;
    editor.state = fresh();
    editor.shireId = 'wiltshire';
    expect(editor.textContent).toContain('Wiltshire');
    editor.shireId = 'kent';
    expect(editor.textContent).toContain('Kent');
    expect(editor.textContent).not.toContain('Wiltshire');
  });
});
