// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState, rosterFor } from '../../gui/rules/state.js';
import { projectView } from '../../gui/rules/views.js';
import { fieldsFor } from '../../gui/rules/commands.js';
import '../../gui/components/rb-crown-panel.js';

const data = await loadData();

const mount = (state) => {
  const panel = document.createElement('rb-crown-panel');
  document.body.append(panel);
  panel.data = data;
  panel.state = state;
  return panel;
};

beforeEach(() => { document.body.innerHTML = ''; });

describe('<rb-crown-panel> and the fallen', () => {
  it('says nothing while everybody is alive', () => {
    const panel = mount(createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data }));
    expect(panel.textContent).not.toContain('The fallen');
  });

  it('offers the heir with the umpire’s three levers', () => {
    const state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
    state.roles.ceowulf.dead = true;
    const panel = mount(state);

    expect(panel.textContent).toContain('The fallen');
    const form = panel.querySelector('[data-heir="ceowulf"]');
    expect(form.elements.note).toBeTruthy();
    expect(form.elements.addClaim).toBeTruthy();
    expect(form.elements.dropClaim).toBeTruthy();
  });

  it('sends what the umpire actually filled in, and nothing else', () => {
    const state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
    state.roles.ceowulf.dead = true;
    const panel = mount(state);

    const sent = [];
    document.addEventListener('rb-facilitate', (event) => sent.push(event.detail));
    const form = panel.querySelector('[data-heir="ceowulf"]');
    form.elements.note.value = 'His son wants peace.';
    form.elements.addClaim.value = 'wessex';
    form.dispatchEvent(new Event('submit'));

    expect(sent).toEqual([{
      verb: 'facilitator:heir-arrives',
      payload: {
        roleId: 'ceowulf',
        note: 'His son wants peace.',
        addClaim: 'wessex',
        dropClaim: undefined,
      },
    }]);
  });
});

describe('the mercenary chooser', () => {
  it('offers the battles actually being fought', () => {
    const state = createInitialState({
      joinCode: 'RAVEN7Z', seed: 1, data, roleIds: rosterFor(data, 13),
    });
    state.battle.targets = ['lindsey', 'essex'];
    const view = projectView(state, data, {
      kind: 'player',
      seatId: 's1',
      roleId: 'halfdan_ragnarsson',
      teamId: state.roles.halfdan_ragnarsson.teamId,
    });
    const [field] = fieldsFor('use-mercenary', view, data);
    expect(field.options.map((o) => o.value)).toEqual(['lindsey', 'essex']);
  });
});
