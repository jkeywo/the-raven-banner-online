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

  it('shows every crown as still a claim before an election', () => {
    const { state } = election();
    const panel = mount('rb-crown-panel');
    panel.data = data;
    panel.state = state;
    expect(panel.textContent).toContain('still a claim');
  });

  it('sets what a rebellion costs a named vassal', () => {
    const { state } = election();
    const panel = mount('rb-crown-panel');
    panel.data = data;
    panel.state = state;

    const sent = [];
    document.addEventListener('rb-facilitate', (event) => sent.push(event.detail));
    const select = panel.querySelector('[data-relief="cenred"]');
    select.value = '0|0';
    select.dispatchEvent(new Event('change'));
    expect(sent).toEqual([{
      verb: 'facilitator:set-rebellion-relief',
      payload: { roleId: 'cenred', shires: 0, soldiers: 0 },
    }]);
  });

  it('starts every vassal at the full printed price', () => {
    const { state } = election();
    const panel = mount('rb-crown-panel');
    panel.data = data;
    panel.state = state;
    expect(panel.querySelector('[data-relief="cenred"]').value).toBe('1|2');
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
    // No kings yet, so only the Danes can take a vassal.
    expect(before[0].options.every(({ value }) => state.roles[value]
      && ['danish_warrior', 'danish_trader'].includes(data.roles.roles[value].archetype))).toBe(true);

    state.crownHolders.mercia = 'ceowulf';
    const after = fieldsFor('request-allegiance', viewFor(state, 'abbess_wenyld'), data);
    expect(after[0].options.map((o) => o.value)).toContain('ceowulf');
  });

  it('stops asking which shire when the rebellion is free', () => {
    const { state } = election();
    expect(fieldsFor('rebel', viewFor(state, 'cenred'), data)).toHaveLength(1);
    state.rebellionRelief.cenred = { shires: 0, soldiers: 0, note: '' };
    expect(fieldsFor('rebel', viewFor(state, 'cenred'), data)).toEqual([]);
  });
});
