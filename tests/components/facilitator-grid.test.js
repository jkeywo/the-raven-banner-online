// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply } from '../../gui/rules/reducer.js';
import { createClash } from '../../gui/rules/clash.js';
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

describe('<rb-facilitator-grid> says what the rules could not do for themselves', () => {
  /** Lindsey attacked and held: two clashes, both won by the defending steward. */
  function heldAtLindsey() {
    const state = run(atBattle(), 'facilitator:announce-targets');
    state.battle.sides = {
      lindsey: { attackers: ['ubba_ragnarsson'], defenders: ['gainbeald'] },
    };
    for (let i = 1; i <= 2; i += 1) {
      const clash = createClash({
        id: `lindsey:${i}`, shireId: 'lindsey',
        attacker: 'ubba_ragnarsson', defender: 'gainbeald',
      });
      clash.stage = 'resolved';
      clash.result = { winner: 'gainbeald' };
      state.battle.clashes[clash.id] = clash;
    }
    return state;
  }

  it('renders the line about a token the settling had to hold back', () => {
    // settleBattle runs inside effects and cannot refuse, so it leaves the
    // token where it was — and facilitator:settle-battle throws its return
    // away. Without this line the token the rules say moves simply does not,
    // and nothing on the grid would ever mention it. Rewritten from a version
    // that asserted a note settleBattle had written into state: the condition
    // is derived here now, from the same board settleBattle read.
    const state = heldAtLindsey();
    state.initiative.black = 'gainbeald';   // already holding one
    const grid = mount();
    grid.data = data;
    grid.state = run(state, 'facilitator:settle-battle', { shireId: 'lindsey' });

    const note = grid.querySelector('[data-token-held-back="lindsey"]');
    expect(note?.textContent).toContain('already holds the black token');
    expect(note?.textContent).toContain('white token stays with Halfdan Ragnarsson');
    expect(grid.querySelector('.rb-settle').contains(note)).toBe(true);
  });

  it('draws it before the settling as well, next to the button that will not move it', () => {
    const grid = mount();
    grid.data = data;
    const state = heldAtLindsey();
    state.initiative.black = 'gainbeald';
    grid.state = state;

    expect(grid.querySelector('[data-token-held-back="lindsey"]')?.textContent)
      .toContain('already holds the black token');
  });

  it('drops it again once the facilitator has moved the counters', () => {
    // The dismissal a stored note never had: the line is a reading of the
    // board, so doing what it asks is what makes it go.
    const grid = mount();
    grid.data = data;
    const state = heldAtLindsey();
    state.initiative.black = 'gainbeald';
    let after = run(state, 'facilitator:settle-battle', { shireId: 'lindsey' });
    after = run(after, 'facilitator:assign-initiative', { token: 'black', roleId: null });
    after = run(after, 'facilitator:assign-initiative', { token: 'white', roleId: 'gainbeald' });
    grid.state = after;

    expect(grid.querySelector('[data-token-held-back="lindsey"]')).toBeNull();
  });

  it('names nobody, never null, when the held-back token is on the table', () => {
    // facilitator:remove-role nulls a token and leaves the declaration made
    // with it standing, so the line has to have a word for an unheld token.
    const grid = mount();
    grid.data = data;
    const state = heldAtLindsey();
    state.initiative.black = 'gainbeald';
    let after = run(state, 'facilitator:settle-battle', { shireId: 'lindsey' });
    after = run(after, 'facilitator:remove-role', { roleId: 'halfdan_ragnarsson' });
    grid.state = after;

    const note = grid.querySelector('[data-token-held-back="lindsey"]');
    expect(note?.textContent).toContain('white token stays with nobody');
    expect(note?.textContent).not.toContain('null');
  });

  it('says nothing when the token simply changed hands', () => {
    const grid = mount();
    grid.data = data;
    grid.state = run(heldAtLindsey(), 'facilitator:settle-battle', { shireId: 'lindsey' });

    expect(grid.querySelector('[data-token-held-back="lindsey"]')).toBeNull();
  });

  it('says when ending the battles handed no spare token out', () => {
    // The button promises to hand one out, so a phase that could not has to
    // look different from a phase that did.
    const grid = mount();
    grid.data = data;
    grid.state = run(atBattle(), 'facilitator:end-battles');

    expect(grid.querySelector('[data-initiative-note="spare"]')?.textContent)
      .toContain('No spare initiative token was handed out');
  });
});
