// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply } from '../../gui/rules/reducer.js';
import '../../gui/components/rb-envoy-queue.js';

const data = await loadData();
const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };

/** Alfred has an envoy waiting on the Pope's answer. */
function waiting() {
  let state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
  state.seats.s9 = { id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
  while (state.phase.name !== 'encounter') {
    state = apply(state, data, { verb: 'facilitator:advance-phase', payload: {} },
      FACILITATOR, { ts: 0 }).state;
  }
  state.roles.archbishop_aethelred.momentum = 2;
  const sent = apply(state, data, { verb: 'send-envoy', payload: { npcFaction: 'pope' } },
    { seatId: 's1', kind: 'player', roleId: 'archbishop_aethelred' }, { ts: 0 });
  if (!sent.ok) throw new Error(`send-envoy refused: ${sent.reason}`);
  return sent.state;
}

const mount = (state) => {
  const queue = document.createElement('rb-envoy-queue');
  document.body.append(queue);
  queue.data = data;
  queue.state = state;
  return queue;
};

beforeEach(() => { document.body.innerHTML = ''; });

describe('<rb-envoy-queue> briefings', () => {
  it('says who the court is, not only what they want', () => {
    const queue = mount(waiting());
    expect(queue.textContent).toContain('Rome, the most powerful institution');
    expect(queue.textContent).toContain('episcopal freedom');
    expect(queue.textContent).toContain('Press for:');
  });

  it('warns where a concession buys nothing on the board', () => {
    const queue = mount(waiting());
    expect(queue.textContent).toContain('game effect');
  });

  it('drops an opening into the reply box rather than sending it', () => {
    // The umpire gets the last word on what a king actually says.
    const queue = mount(waiting());
    const opening = queue.querySelector('[data-opening]');
    const sent = [];
    document.addEventListener('rb-facilitate', (event) => sent.push(event.detail));

    opening.click();
    expect(queue.querySelector('textarea').value).toBe(opening.dataset.opening);
    expect(sent).toEqual([]);
  });
});

describe('<rb-envoy-queue> ledger', () => {
  it('records what was promised, against the right court and player', () => {
    const queue = mount(waiting());
    const sent = [];
    document.addEventListener('rb-facilitate', (event) => sent.push(event.detail));

    const form = queue.querySelector('[data-concede]');
    form.elements.text.value = 'The bishops freed';
    form.dispatchEvent(new Event('submit'));

    expect(sent).toEqual([{
      verb: 'facilitator:record-concession',
      payload: {
        npcFaction: 'pope', roleId: 'archbishop_aethelred', text: 'The bishops freed',
      },
    }]);
  });

  it('will not record an empty promise', () => {
    const queue = mount(waiting());
    const sent = [];
    document.addEventListener('rb-facilitate', (event) => sent.push(event.detail));
    const form = queue.querySelector('[data-concede]');
    form.elements.text.value = '   ';
    form.dispatchEvent(new Event('submit'));
    expect(sent).toEqual([]);
  });

  it('shows what this player has already promised this court', () => {
    let state = waiting();
    state = apply(state, data, {
      verb: 'facilitator:record-concession',
      payload: { npcFaction: 'pope', roleId: 'archbishop_aethelred', text: 'The monasteries reformed' },
    }, FACILITATOR, { ts: 0 }).state;

    const queue = mount(state);
    expect(queue.querySelector('.rb-ledger').textContent).toContain('The monasteries reformed');
  });

  it('keeps a broken promise on the page, struck through', () => {
    let state = waiting();
    state = apply(state, data, {
      verb: 'facilitator:record-concession',
      payload: { npcFaction: 'pope', roleId: 'archbishop_aethelred', text: 'A pagan baptised' },
    }, FACILITATOR, { ts: 0 }).state;
    const [{ id }] = Object.values(state.concessions);

    const queue = mount(state);
    const sent = [];
    document.addEventListener('rb-facilitate', (event) => sent.push(event.detail));
    queue.querySelector('[data-strike]').click();
    expect(sent).toEqual([{
      verb: 'facilitator:strike-concession', payload: { concessionId: id },
    }]);

    state = apply(state, data, { verb: 'facilitator:strike-concession', payload: { concessionId: id } },
      FACILITATOR, { ts: 0 }).state;
    const after = mount(state);
    expect(after.querySelector('.rb-ledger s').textContent).toBe('A pagan baptised');
    expect(after.querySelector('[data-strike]')).toBeNull();
  });

  it('does not show one player’s promises beside another’s conversation', () => {
    let state = waiting();
    state = apply(state, data, {
      verb: 'facilitator:record-concession',
      payload: { npcFaction: 'pope', roleId: 'king_alfred', text: 'Kent to Rome' },
    }, FACILITATOR, { ts: 0 }).state;
    const queue = mount(state);
    expect(queue.textContent).not.toContain('Kent to Rome');
  });
});
