// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply } from '../../gui/rules/reducer.js';
import { projectView } from '../../gui/rules/views.js';
import { fieldsFor } from '../../gui/client/action-chooser.js';
import '../../gui/components/rb-ballot.js';
import '../../gui/components/rb-crown-panel.js';

const data = await loadData();
const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };

/** The Mercian election, called by Ceowulf, in the team phase. */
function election() {
  let state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
  state.seats.s9 = { id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
  while (state.phase.name !== 'team') {
    state = apply(state, data, { verb: 'facilitator:advance-phase', payload: {} },
      FACILITATOR, { ts: 0 }).state;
  }
  state = apply(state, data, { verb: 'claim-crown', payload: { crown: 'mercia' } },
    { seatId: 's1', kind: 'player', roleId: 'ceowulf' }, { ts: 0 }).state;
  return { state, id: Object.keys(state.votes)[0] };
}

const viewFor = (state, roleId) => projectView(state, data, {
  kind: 'player', seatId: 's1', roleId, teamId: state.roles[roleId].teamId,
});

const shiresOf = (state, roleId) =>
  Object.keys(state.shires).filter((id) => state.shires[id].stewardRoleId === roleId);

const mount = (tag) => {
  const element = document.createElement(tag);
  document.body.append(element);
  return element;
};

beforeEach(() => { document.body.innerHTML = ''; });

describe('<rb-ballot>', () => {
  it('gives an elector a button for each candidate', () => {
    const { state } = election();
    const ballot = mount('rb-ballot');
    ballot.data = data;
    ballot.view = viewFor(state, 'cenred');

    const buttons = [...ballot.querySelectorAll('[data-for]')];
    expect(buttons.map((b) => b.textContent.trim()))
      .toEqual(['Ceowulf', 'Gainbeald']);
    expect(ballot.textContent).toContain('Mercia');
    expect(ballot.pending).toHaveLength(1);
  });

  it('says how heavy your voice is', () => {
    const { state, id } = election();
    const ballot = mount('rb-ballot');
    ballot.data = data;
    ballot.view = viewFor(state, 'cenred');
    expect(ballot.textContent).toContain(`${state.votes[id].electorate.cenred} votes`);
  });

  it('sends the vote as a command', () => {
    const { state, id } = election();
    const ballot = mount('rb-ballot');
    ballot.data = data;
    ballot.view = viewFor(state, 'cenred');

    const sent = [];
    document.addEventListener('rb-command', (event) => sent.push(event.detail));
    ballot.querySelector('[data-for]').click();
    expect(sent).toEqual([{ verb: 'cast-vote', payload: { voteId: id, forRoleId: 'ceowulf' } }]);
  });

  it('gives a compelled vassal one button and says why', () => {
    const { state } = election();
    state.roles.abbess_wenyld.liegeId = 'gainbeald';
    const ballot = mount('rb-ballot');
    ballot.data = data;
    ballot.view = viewFor(state, 'abbess_wenyld');

    const buttons = [...ballot.querySelectorAll('[data-for]')];
    expect(buttons.map((b) => b.textContent.trim())).toEqual(['Gainbeald']);
    expect(ballot.textContent).toContain('sworn to vote for them');
  });

  it('tells a bystander they have no vote, rather than hiding it', () => {
    const { state } = election();
    const ballot = mount('rb-ballot');
    ballot.data = data;
    ballot.view = viewFor(state, 'king_alfred');
    expect(ballot.textContent).toContain('no vote in this');
    expect(ballot.querySelector('[data-for]')).toBeNull();
    expect(ballot.pending).toHaveLength(0);
  });

  it('says who won when it is over', () => {
    let { state, id } = election();
    for (const who of Object.keys(state.votes[id].electorate)) {
      state = apply(state, data, { verb: 'cast-vote', payload: { voteId: id, forRoleId: 'ceowulf' } },
        { seatId: 's1', kind: 'player', roleId: who }, { ts: 0 }).state;
    }
    const ballot = mount('rb-ballot');
    ballot.data = data;
    ballot.view = viewFor(state, 'king_alfred');
    expect(ballot.textContent).toContain('Ceowulf is king');
  });

  it('is empty before anybody stands', () => {
    let state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
    const ballot = mount('rb-ballot');
    ballot.data = data;
    ballot.view = viewFor(state, 'king_alfred');
    expect(ballot.innerHTML).toBe('');
  });
});

describe('<rb-crown-panel>', () => {
  it('lets the facilitator call a count, naming who is missing', () => {
    const { state, id } = election();
    const panel = mount('rb-crown-panel');
    panel.data = data;
    panel.state = state;

    expect(panel.textContent).toContain('waiting on');
    const sent = [];
    document.addEventListener('rb-facilitate', (event) => sent.push(event.detail));
    panel.querySelector('[data-close]').click();
    expect(sent).toEqual([{ verb: 'facilitator:close-vote', payload: { voteId: id } }]);
  });

  it('shows the crowns already worn at the start, and Mercia as still a claim', () => {
    // Wessex and Northumbria are already somebody's; Mercia genuinely starts
    // the game without a king, so the election fixture's crown has not been
    // decided yet.
    const { state } = election();
    const panel = mount('rb-crown-panel');
    panel.data = data;
    panel.state = state;
    expect(panel.textContent).toContain('Wessex');
    expect(panel.textContent).toContain('Northumbria');
    expect(panel.textContent).not.toContain('Mercia:');
  });

  it('says nobody has asked to rebel when nobody has', () => {
    const { state } = election();
    const panel = mount('rb-crown-panel');
    panel.data = data;
    panel.state = state;
    expect(panel.textContent).toContain('Nobody has asked to rebel');
  });

  it('prices a waiting petition and commits it as one choice', () => {
    let { state } = election();
    state = apply(state, data, { verb: 'request-rebel', payload: { shireId: shiresOf(state, 'cenred')[0] } },
      { seatId: 's1', kind: 'player', roleId: 'cenred' }, { ts: 0 }).state;

    const panel = mount('rb-crown-panel');
    panel.data = data;
    panel.state = state;
    expect(panel.textContent).toContain('Cenred');

    const sent = [];
    document.addEventListener('rb-facilitate', (event) => sent.push(event.detail));
    const form = panel.querySelector('[data-price="cenred"]');
    form.elements.price.value = '0|0';
    form.dispatchEvent(new Event('submit'));
    expect(sent).toEqual([{
      verb: 'facilitator:price-rebellion',
      payload: { roleId: 'cenred', shires: 0, soldiers: 0 },
    }]);
  });

  it('says once priced that it is waiting on the vassal now', () => {
    let { state } = election();
    state = apply(state, data, { verb: 'request-rebel', payload: { shireId: shiresOf(state, 'cenred')[0] } },
      { seatId: 's1', kind: 'player', roleId: 'cenred' }, { ts: 0 }).state;
    state = apply(state, data, {
      verb: 'facilitator:price-rebellion', payload: { roleId: 'cenred', shires: 1, soldiers: 2 },
    }, { seatId: 's9', kind: 'facilitator', roleId: null }, { ts: 0 }).state;

    const panel = mount('rb-crown-panel');
    panel.data = data;
    panel.state = state;
    expect(panel.textContent).toContain('Waiting on them now');
  });
});

describe('the chooser', () => {
  it('offers only crowns you claim and nobody wears', () => {
    const { state } = election();
    state.crownHolders.lindsey = 'gainbeald';
    const [field] = fieldsFor('claim-crown', viewFor(state, 'gainbeald'), data);
    expect(field.options.map((o) => o.value)).toEqual(['mercia']);
  });

  it('offers homage only to a crowned Saxon or a Dane', () => {
    const { state } = election();
    const before = fieldsFor('request-allegiance', viewFor(state, 'abbess_wenyld'), data);
    // Nobody wears Mercia's crown yet, so only the Danes and the two who
    // already have a throne — Alfred in Wessex, Ecgberht in Northumbria —
    // can take a vassal.
    expect(before[0].options.every(({ value }) => state.roles[value]
      && (['danish_warrior', 'danish_trader'].includes(data.roles.roles[value].archetype)
        || Object.values(state.crownHolders).includes(value)))).toBe(true);
    expect(before[0].options.map((o) => o.value)).toContain('king_alfred');
    expect(before[0].options.map((o) => o.value)).not.toContain('ceowulf');

    state.crownHolders.mercia = 'ceowulf';
    const after = fieldsFor('request-allegiance', viewFor(state, 'abbess_wenyld'), data);
    expect(after[0].options.map((o) => o.value)).toContain('ceowulf');
  });

  it('asks a landed vassal which shire he would offer', () => {
    // The price is not known yet — the facilitator has not been asked — so
    // this is what he would put up if a shire turns out to be part of it.
    const { state } = election();
    const [field] = fieldsFor('request-rebel', viewFor(state, 'cenred'), data);
    expect(field.name).toBe('shireId');
    expect(field.options.length).toBeGreaterThan(0);
  });

  it('asks a landless vassal nothing at all', () => {
    const { state } = election();
    for (const id of shiresOf(state, 'cenred')) state.shires[id].stewardRoleId = 'king_alfred';
    expect(fieldsFor('request-rebel', viewFor(state, 'cenred'), data)).toEqual([]);
  });
});
