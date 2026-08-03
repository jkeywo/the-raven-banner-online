// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { projectView } from '../../gui/rules/views.js';
import { apply } from '../../gui/rules/reducer.js';
import { admit } from '../../gui/rules/admission.js';
import { fieldsFor, payloadFrom, renderChooser, valuesFrom } from '../../gui/client/action-chooser.js';

const data = await loadData();
const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };

/** A seated player's view of the game, at a chosen phase. */
function view(roleId, phaseName = 'maintenance') {
  let state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
  state.seats.s1 = { id: 's1', token: 't', name: 'A', roleId, kind: 'player', connected: true, lastSeen: 0 };
  state.seats.s9 = { id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
  while (state.phase.name !== phaseName) {
    state = apply(state, data, { verb: 'facilitator:advance-phase', payload: {} },
      FACILITATOR, { ts: 0 }).state;
  }
  return {
    state,
    view: projectView(state, data, {
      kind: 'player', seatId: 's1', roleId, teamId: state.roles[roleId].teamId,
    }),
  };
}

describe('what an action still needs asking', () => {
  it('asks nothing for a plain action', () => {
    expect(fieldsFor('recruit-soldiers', view('king_alfred').view, data)).toEqual([]);
    expect(fieldsFor('build-ship', view('king_alfred').view, data)).toEqual([]);
  });

  it('asks a pagan Dane about their followers, and nobody else', () => {
    const pagan = fieldsFor('collect-income', view('halfdan_ragnarsson').view, data);
    expect(pagan.map((f) => f.name)).toEqual(['upkeep']);
    expect(pagan[0].options.map((o) => o.value)).toEqual(['pay', 'lose']);
    expect(fieldsFor('collect-income', view('king_alfred').view, data)).toEqual([]);
  });

  it('offers only what you actually hold when giving', () => {
    // Being invited to give away ships you do not have is a slow way to find
    // out you have none.
    const { view: seen } = view('king_alfred', 'encounter');
    const what = fieldsFor('give', seen, data).find((f) => f.name === 'what');
    expect(what.options.map((o) => o.value)).toEqual(['silver', 'food']);   // no ships
    expect(what.options[0].label).toContain('you have 4');
  });

  it('never offers you yourself as a recipient', () => {
    const { view: seen } = view('king_alfred', 'encounter');
    for (const verb of ['give', 'transfer-stewardship', 'swear-allegiance']) {
      const to = fieldsFor(verb, seen, data).find((f) => f.name.endsWith('RoleId') || f.name === 'liegeId');
      expect(to.options.map((o) => o.value), verb).not.toContain('king_alfred');
    }
  });

  it('offers only shires you steward when handing one over', () => {
    const { view: seen } = view('king_alfred', 'team');
    const which = fieldsFor('transfer-stewardship', seen, data)[0];
    expect(which.options.map((o) => o.value).sort()).toEqual(['west_country', 'wiltshire']);
  });

  it('offers only settlements you could actually circle', () => {
    const { view: seen } = view('king_alfred');
    const options = fieldsFor('reinforce', seen, data)[0].options;
    expect(options.length).toBeGreaterThan(0);
    // Every one of Alfred's, and none of anybody else's.
    for (const option of options) {
      const [shireId] = option.value.split('|');
      expect(['wiltshire', 'west_country']).toContain(shireId);
    }
  });

  it('lets a player stand alone as well as follow someone', () => {
    const { view: seen } = view('ubba_ragnarsson', 'team');
    const options = fieldsFor('swear-allegiance', seen, data)[0].options;
    expect(options[0]).toMatchObject({ value: '' });
    expect(payloadFrom('swear-allegiance', { liegeId: '' })).toEqual({ liegeId: null });
  });
});

describe('what the chooser sends', () => {
  it('splits a settlement choice back into a shire and a settlement', () => {
    expect(payloadFrom('reinforce', { target: 'wiltshire|wiltshire_town_1' }))
      .toEqual({ shireId: 'wiltshire', settlementId: 'wiltshire_town_1' });
  });

  it('sends an amount as a number, because the rules count with it', () => {
    const payload = payloadFrom('give', { toRoleId: 'cenred', what: 'silver', amount: '3' });
    expect(payload.amount).toBe(3);
  });

  it('produces a payload the rules actually admit', () => {
    // The point of the whole exercise: the form offers choices, and every one
    // of them survives the same admission the host will run.
    const { state, view: seen } = view('king_alfred');
    const actor = { seatId: 's1', kind: 'player', roleId: 'king_alfred' };
    const target = fieldsFor('reinforce', seen, data)[0].options[0].value;
    state.roles.king_alfred.momentum = 2;
    const payload = payloadFrom('reinforce', { target });
    expect(admit(state, data, { verb: 'reinforce', payload }, actor)).toEqual({ ok: true });
  });
});

describe('the form', () => {
  it('builds nothing for an action that needs nothing', () => {
    expect(renderChooser('recruit-soldiers', view('king_alfred').view, data)).toBe(null);
  });

  it('round-trips through the DOM', () => {
    const { view: seen } = view('king_alfred', 'encounter');
    const form = renderChooser('give', seen, data);
    document.body.append(form);
    form.elements.toRoleId.value = 'cenred';
    form.elements.what.value = 'food';
    form.elements.amount.value = '2';
    expect(payloadFrom('give', valuesFrom(form)))
      .toEqual({ toRoleId: 'cenred', what: 'food', amount: 2 });
  });

  it('disables a chooser with nothing to choose from', () => {
    // A landless player has no shire to hand over, and should be told so by
    // the control rather than by a refusal after the fact.
    const { view: seen } = view('godric', 'team');
    const form = renderChooser('transfer-stewardship', seen, data);
    expect(form.querySelector('select[name="shireId"]').disabled).toBe(true);
  });
});
