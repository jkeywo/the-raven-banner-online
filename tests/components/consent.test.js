// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply } from '../../gui/rules/reducer.js';
import { projectView } from '../../gui/rules/views.js';
import { fieldsFor } from '../../gui/client/action-chooser.js';
import '../../gui/components/rb-consent-panel.js';
import '../../gui/components/rb-consent-queue.js';

const data = await loadData();
const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };

/** A maintenance phase in which Halfdan has asked to settle Jorvik. */
function asked() {
  let state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
  state.seats.s9 = { id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
  while (state.phase.name !== 'maintenance') {
    state = apply(state, data, { verb: 'facilitator:advance-phase', payload: {} },
      FACILITATOR, { ts: 0 }).state;
  }
  state.roles.halfdan_ragnarsson.momentum = 2;
  state = apply(state, data, { verb: 'request-settle', payload: { shireId: 'jorvik' } },
    { seatId: 's1', kind: 'player', roleId: 'halfdan_ragnarsson' }, { ts: 0 }).state;
  return { state, id: Object.keys(state.consents)[0] };
}

function viewFor(state, roleId) {
  return projectView(state, data, {
    kind: 'player', seatId: 's1', roleId, teamId: state.roles[roleId].teamId,
  });
}

const mount = (tag) => {
  const element = document.createElement(tag);
  document.body.append(element);
  return element;
};

beforeEach(() => { document.body.innerHTML = ''; });

describe('<rb-consent-panel>', () => {
  it('gives a neighbour who was asked two buttons', () => {
    const { state } = asked();
    const panel = mount('rb-consent-panel');
    panel.data = data;
    panel.view = viewFor(state, 'gainbeald');

    expect(panel.textContent).toContain('Halfdan Ragnarsson');
    expect(panel.textContent).toContain('Jorvik');
    expect(panel.querySelector('[data-yes]')).toBeTruthy();
    expect(panel.querySelector('[data-no]')).toBeTruthy();
  });

  it('sends the answer as a command like any other', () => {
    const { state, id } = asked();
    const panel = mount('rb-consent-panel');
    panel.data = data;
    panel.view = viewFor(state, 'gainbeald');

    const sent = [];
    document.addEventListener('rb-command', (event) => sent.push(event.detail));
    panel.querySelector('[data-no]').click();
    expect(sent).toEqual([{ verb: 'answer-consent', payload: { consentId: id, granted: false } }]);
  });

  it('shows the asker who has answered and who has not', () => {
    const { state } = asked();
    const panel = mount('rb-consent-panel');
    panel.data = data;
    panel.view = viewFor(state, 'halfdan_ragnarsson');

    // His own request, so no buttons — he is the one waiting.
    expect(panel.querySelector('[data-yes]')).toBeNull();
    expect(panel.textContent).toContain('You');
    const silent = [...panel.querySelectorAll('[data-answer="silent"]')];
    expect(silent).toHaveLength(2);
    expect(panel.textContent).toContain('has not said');
  });

  it('tells a bystander what is being negotiated', () => {
    // A settlement is public business, and worth knowing about next door.
    const { state } = asked();
    const panel = mount('rb-consent-panel');
    panel.data = data;
    panel.view = viewFor(state, 'king_alfred');
    expect(panel.textContent).toContain('Jorvik');
    expect(panel.querySelector('[data-yes]')).toBeNull();
    expect(panel.pending).toHaveLength(0);
  });

  it('flags only the viewer who still owes an answer', () => {
    const { state } = asked();
    const panel = mount('rb-consent-panel');
    panel.data = data;
    panel.view = viewFor(state, 'gainbeald');
    expect(panel.pending).toHaveLength(1);
  });

  it('says how it ended rather than disappearing', () => {
    let { state, id } = asked();
    state = apply(state, data, { verb: 'answer-consent', payload: { consentId: id, granted: false } },
      { seatId: 's2', kind: 'player', roleId: 'gainbeald' }, { ts: 0 }).state;

    const panel = mount('rb-consent-panel');
    panel.data = data;
    panel.view = viewFor(state, 'halfdan_ragnarsson');
    expect(panel.textContent).toContain('Somebody refused');
    expect(panel.querySelector('[data-resolved="true"]')).toBeTruthy();
  });

  it('stays empty when nobody is asking anything', () => {
    const state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
    const panel = mount('rb-consent-panel');
    panel.data = data;
    panel.view = viewFor(state, 'king_alfred');
    expect(panel.innerHTML).toBe('');
  });
});

describe('<rb-consent-queue>', () => {
  it('offers the facilitator a way past whoever is not at their screen', () => {
    const { state, id } = asked();
    const queue = mount('rb-consent-queue');
    queue.data = data;
    queue.state = state;

    const sent = [];
    document.addEventListener('rb-facilitate', (event) => sent.push(event.detail));

    // One pair of buttons per silent neighbour, plus the sweep.
    expect(queue.querySelectorAll('[data-for]')).toHaveLength(4);
    queue.querySelector('[data-all]').click();
    expect(sent).toEqual([{
      verb: 'facilitator:answer-consent',
      payload: { consentId: id, granted: true },
    }]);
  });

  it('answers for one named neighbour', () => {
    const { state, id } = asked();
    const queue = mount('rb-consent-queue');
    queue.data = data;
    queue.state = state;

    const sent = [];
    document.addEventListener('rb-facilitate', (event) => sent.push(event.detail));
    queue.querySelector('[data-for$="|yes"]').click();
    expect(sent[0].payload).toMatchObject({ consentId: id, granted: true });
    expect(['gainbeald', 'king_ecgberht']).toContain(sent[0].payload.onBehalfOf);
  });

  it('drops a request once it is settled', () => {
    let { state, id } = asked();
    for (const who of ['gainbeald', 'king_ecgberht']) {
      state = apply(state, data, { verb: 'answer-consent', payload: { consentId: id, granted: true } },
        { seatId: 's2', kind: 'player', roleId: who }, { ts: 0 }).state;
    }
    const queue = mount('rb-consent-queue');
    queue.data = data;
    queue.state = state;
    expect(queue.textContent).toContain('Nobody is waiting');
  });
});

describe('the chooser', () => {
  it('offers a Dane only the shires he holds and has not settled', () => {
    const { state } = asked();
    state.shires.ribble.danishSupport = true;
    const view = viewFor(state, 'halfdan_ragnarsson');
    const [field] = fieldsFor('request-settle', view, data);
    expect(field.options.map((o) => o.value)).toEqual(['jorvik']);
  });

  it('offers only shires where a cross actually stands', () => {
    const { state } = asked();
    state.shires.jorvik.missionaryCross = true;
    const view = viewFor(state, 'halfdan_ragnarsson');
    const [field] = fieldsFor('drive-out-missionaries', view, data);
    expect(field.options.map((o) => o.value)).toEqual(['jorvik']);
  });
});
