// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply } from '../../gui/rules/reducer.js';
import { projectView } from '../../gui/rules/views.js';
import { fieldsFor } from '../../gui/rules/commands.js';
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

describe('the homage web on the crowns panel', () => {
  const mountPanel = (state) => {
    const panel = document.createElement('rb-crown-panel');
    document.body.append(panel);
    panel.data = data;
    panel.state = state;
    return panel;
  };

  const fresh = () => createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });

  /** The role a node sits under, or null when it is a root of the tree. */
  const parentOf = (panel, roleId) => panel
    .querySelector(`[data-role="${roleId}"]`)
    ?.parentElement?.closest('[data-role]')?.dataset.role ?? null;

  it('nests each man under the lord he answers to', () => {
    // The printed game opens with a full web already: Alfred holds three
    // Saxons, and Halfdan holds Ecgberht, Ubba and Frida. A flat list said
    // this in pairs; the tree says it in one shape.
    const panel = mountPanel(fresh());

    for (const man of ['cenred', 'godric', 'archbishop_aethelred']) {
      expect(parentOf(panel, man), man).toBe('king_alfred');
    }
    for (const man of ['king_ecgberht', 'ubba_ragnarsson', 'frida_anundottir']) {
      expect(parentOf(panel, man), man).toBe('halfdan_ragnarsson');
    }
    // And the men at the top of their own chains hang off nothing.
    for (const lord of ['king_alfred', 'halfdan_ragnarsson', 'ceowulf']) {
      expect(parentOf(panel, lord), lord).toBe(null);
    }
    // Everybody is on it exactly once, which a tree can get wrong in a way a
    // list cannot: a node drawn under two lords, or dropped entirely.
    for (const id of Object.keys(fresh().roles)) {
      expect(panel.querySelectorAll(`[data-role="${id}"]`), id).toHaveLength(1);
    }
  });

  it('carries the whole chain, not just the pairs', () => {
    // Ecgberht answers to Halfdan and is answered to by nobody at the start,
    // so give him a man: he should appear once, under Halfdan, with Uchtred
    // under him. That "grandchild" is the question the flat list could not
    // answer without the reader joining two rows by hand.
    const state = fresh();
    expect(state.roles.king_ecgberht.liegeId).toBe('halfdan_ragnarsson');
    state.roles.uchtred.liegeId = 'king_ecgberht';
    const panel = mountPanel(state);

    expect(parentOf(panel, 'king_ecgberht')).toBe('halfdan_ragnarsson');
    expect(parentOf(panel, 'uchtred')).toBe('king_ecgberht');
  });

  it('puts a crown on whoever wears one, and says which', () => {
    const state = fresh();
    state.crownHolders = { mercia: 'ceowulf' };
    const panel = mountPanel(state);

    const node = panel.querySelector('[data-role="ceowulf"]');
    expect(node.dataset.crowned).toBe('true');
    expect(node.querySelector('.rb-tree-crowns').textContent).toContain('Mercia');
    // Eleven crowns in this game, so the glyph alone cannot say which.
    expect(node.querySelector('.rb-tree-crown')).toBeTruthy();
    expect(panel.textContent).toContain('Crowns worn');

    // And nobody else is wearing anything.
    expect(panel.querySelectorAll('[data-crowned="true"]')).toHaveLength(1);
  });

  it('opens with the two crowns the guide seats, and no others', () => {
    // Alfred wears Wessex and Ecgberht wears Northumbria from the first
    // minute; Mercia is the one that starts without a king. Anything else
    // crowned here means startingCrowns and this panel have drifted apart.
    const panel = mountPanel(fresh());
    const crowned = [...panel.querySelectorAll('[data-crowned="true"]')]
      .map((node) => node.dataset.role).sort();
    expect(crowned).toEqual(['king_alfred', 'king_ecgberht']);
    expect(panel.querySelector('[data-role="king_alfred"] .rb-tree-crowns').textContent)
      .toContain('Wessex');
    expect(panel.textContent).toContain('Crowns worn');
  });

  it('says plainly when no crown is worn at all', () => {
    const state = fresh();
    state.crownHolders = {};
    const panel = mountPanel(state);
    expect(panel.textContent).toContain('still a claim');
    expect(panel.querySelector('[data-crowned="true"]')).toBeNull();
  });

  it('draws every role as a root when nobody has sworn to anybody', () => {
    const state = fresh();
    for (const role of Object.values(state.roles)) role.liegeId = null;
    const panel = mountPanel(state);

    const roots = [...panel.querySelectorAll('.rb-tree-root > [data-role]')];
    expect(roots).toHaveLength(Object.keys(state.roles).length);
  });

  it('survives a homage loop rather than recursing forever', () => {
    // Nothing should be able to make one — swearing checks for it — but this
    // draws whatever the state says, and a save that has been hand-edited into
    // a cycle should not take the facilitator's console down with it.
    const state = fresh();
    state.roles.ceowulf.liegeId = 'uchtred';
    state.roles.uchtred.liegeId = 'ceowulf';
    const panel = mountPanel(state);
    expect(panel.textContent).toContain('homage loops here');
  });

  it('follows fealty as it is sworn, without being told', () => {
    // Derived from liegeId every render, so it cannot drift out of step with
    // the rebellion in the column beside it that is about to change it.
    const state = fresh();
    const panel = mountPanel(state);
    expect(parentOf(panel, 'uchtred')).toBe(null);

    const sworn = apply(state, data, {
      verb: 'facilitator:set', payload: { path: ['roles', 'uchtred', 'liegeId'], value: 'ceowulf' },
    }, FACILITATOR, { ts: 0 }).state;
    panel.state = sworn;

    expect(parentOf(panel, 'uchtred')).toBe('ceowulf');
  });

  it('keeps what is waiting on the facilitator out of the tree', () => {
    // The split the two columns exist for: the standing arrangement on the
    // left, the queue wanting a decision on the right. Mixed together, the
    // queue sat below a tree that grows down the page and got missed.
    const panel = mountPanel(fresh());
    expect(panel.querySelector('.rb-feudal-main .rb-tree-root')).toBeTruthy();
    expect(panel.querySelector('.rb-feudal-main .rb-ballots')).toBeNull();
    const side = panel.querySelector('.rb-feudal-side');
    expect(side.textContent).toContain('Elections');
    expect(side.textContent).toContain('Rebellions');
    expect(side.querySelector('.rb-tree')).toBeNull();
  });
});
