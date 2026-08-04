// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply } from '../../gui/rules/reducer.js';
import '../../gui/components/rb-state-inspector.js';
import '../../gui/components/rb-envoy-channel.js';

const data = await loadData();
const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };

const fresh = () => createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });

const mount = (tag) => {
  const element = document.createElement(tag);
  document.body.append(element);
  return element;
};

beforeEach(() => { document.body.innerHTML = ''; });

describe('one card per role', () => {
  it('does nothing without the static dataset', () => {
    const inspector = mount('rb-state-inspector');
    inspector.state = fresh();
    expect(inspector.querySelector('.rb-inspector-card')).toBeNull();
  });

  it('shows a card per role, named for a human rather than by id', () => {
    const inspector = mount('rb-state-inspector');
    inspector.data = data;
    inspector.state = fresh();
    const cards = inspector.querySelectorAll('.rb-inspector-card');
    expect(cards.length).toBe(16);
    expect(inspector.textContent).toContain('King Alfred');
  });

  it('shows which shires a role stewards', () => {
    const inspector = mount('rb-state-inspector');
    inspector.data = data;
    const state = fresh();
    inspector.state = state;

    const stewarded = Object.entries(state.shires)
      .filter(([, s]) => s.stewardRoleId === 'king_alfred')
      .map(([id]) => data.shires.shires[id].name);
    expect(stewarded.length).toBeGreaterThan(0);

    const cards = [...inspector.querySelectorAll('.rb-inspector-card')];
    const card = cards.find((c) => c.textContent.includes('King Alfred'));
    const list = card.querySelector('.rb-inspector-steward-list').textContent;
    for (const name of stewarded) expect(list).toContain(name);
  });

  it('says nothing to steward when a role holds no shires', () => {
    const inspector = mount('rb-state-inspector');
    inspector.data = data;
    inspector.state = fresh();

    const cards = [...inspector.querySelectorAll('.rb-inspector-card')];
    const card = cards.find((c) => c.textContent.includes('Frida'));
    expect(card.querySelector('.rb-inspector-steward-list').textContent).toContain('no shires');
  });

  it('commits an adjustment as a delta, not a replacement', () => {
    const state = fresh();
    const inspector = mount('rb-state-inspector');
    inspector.data = data;
    inspector.state = state;

    let raised = null;
    inspector.addEventListener('rb-facilitate', (event) => { raised = event.detail; });
    const input = inspector.querySelector('[data-adjust="roles.king_alfred.silver"]');
    input.value = '5';
    inspector.querySelector('[data-commit-adjust="roles.king_alfred.silver"]').click();

    expect(raised).toEqual({
      verb: 'facilitator:adjust',
      payload: { path: ['roles', 'king_alfred', 'silver'], delta: 5 },
    });
    const result = apply(state, data, raised, FACILITATOR, { ts: 0 });
    expect(result.state.roles.king_alfred.silver).toBe(state.roles.king_alfred.silver + 5);
  });

  it('refuses to commit an empty or zero adjustment, without sending anything', () => {
    const inspector = mount('rb-state-inspector');
    inspector.data = data;
    inspector.state = fresh();

    const sent = [];
    inspector.addEventListener('rb-facilitate', (event) => sent.push(event.detail));
    inspector.querySelector('[data-commit-adjust="roles.king_alfred.silver"]').click();
    expect(sent).toEqual([]);
    expect(inspector.querySelector('[data-error-for="roles.king_alfred.silver"]').textContent)
      .toContain('nonzero');
  });

  it('lets the server have the last word on going negative', () => {
    // The card cannot know whether "-999" is safe without asking — a player
    // might have spent the silver a second ago — so it sends the delta and
    // leaves the actual refusal to the admission check, same as any command.
    const state = fresh();
    const result = apply(state, data, {
      verb: 'facilitator:adjust', payload: { path: ['roles', 'king_alfred', 'silver'], delta: -999 },
    }, FACILITATOR, { ts: 0 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('would go negative');
  });

  it('adds and removes a claim', () => {
    const inspector = mount('rb-state-inspector');
    inspector.data = data;
    inspector.state = fresh();

    const sent = [];
    inspector.addEventListener('rb-facilitate', (event) => sent.push(event.detail));
    const form = inspector.querySelector('[data-add-claim="abbess_wenyld"]');
    form.elements.crown.value = 'mercia';
    form.dispatchEvent(new Event('submit'));
    expect(sent).toEqual([{
      verb: 'facilitator:add-claim', payload: { roleId: 'abbess_wenyld', crown: 'mercia' },
    }]);

    inspector.querySelector('[data-remove-claim="king_alfred|kent"]').click();
    expect(sent[1]).toEqual({
      verb: 'facilitator:remove-claim', payload: { roleId: 'king_alfred', crown: 'kent' },
    });
  });

  it('toggles a mercenary card', () => {
    const inspector = mount('rb-state-inspector');
    inspector.data = data;
    inspector.state = fresh();

    let raised = null;
    inspector.addEventListener('rb-facilitate', (event) => { raised = event.detail; });
    const checkbox = inspector.querySelector('[data-mercenary="king_alfred"]');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    expect(raised).toEqual({
      verb: 'facilitator:set',
      payload: { path: ['roles', 'king_alfred', 'mercenary'], value: true },
    });
  });

  it('assigns an initiative token from the card', () => {
    const inspector = mount('rb-state-inspector');
    inspector.data = data;
    inspector.state = fresh();

    let raised = null;
    inspector.addEventListener('rb-facilitate', (event) => { raised = event.detail; });
    const checkbox = inspector.querySelector('[data-token="bonus|cenred"]');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    expect(raised).toEqual({
      verb: 'facilitator:assign-initiative', payload: { token: 'bonus', roleId: 'cenred' },
    });
  });

  it('offers to remove a role, with a confirmation', () => {
    const inspector = mount('rb-state-inspector');
    inspector.data = data;
    inspector.state = fresh();

    const original = globalThis.confirm;
    globalThis.confirm = () => false;
    const sent = [];
    inspector.addEventListener('rb-facilitate', (event) => sent.push(event.detail));
    inspector.querySelector('[data-remove-role="king_alfred"]').click();
    expect(sent).toEqual([]);   // declined

    globalThis.confirm = () => true;
    inspector.querySelector('[data-remove-role="king_alfred"]').click();
    expect(sent).toEqual([{ verb: 'facilitator:remove-role', payload: { roleId: 'king_alfred' } }]);
    globalThis.confirm = original;
  });
});

describe('adding a role from the inspector', () => {
  it('prefills from the printed sheet', () => {
    const state = createInitialState({
      joinCode: 'RAVEN7Z', seed: 1, data,
      roleIds: Object.keys(data.roles.roles).filter((id) => id !== 'king_ecgberht'),
    });
    const inspector = mount('rb-state-inspector');
    inspector.data = data;
    inspector.state = state;

    const form = inspector.querySelector('[data-add-role]');
    expect(form).toBeTruthy();
    expect(form.elements.silver.value).toBe(String(data.roles.roles.king_ecgberht.start.silver));
    expect(form.querySelectorAll('input[name="claim"]:checked').length)
      .toBe(data.roles.roles.king_ecgberht.claims.length);
  });

  it('commits whatever the facilitator finished editing, not just the prefill', () => {
    const state = createInitialState({
      joinCode: 'RAVEN7Z', seed: 1, data,
      roleIds: Object.keys(data.roles.roles).filter((id) => id !== 'king_ecgberht'),
    });
    const inspector = mount('rb-state-inspector');
    inspector.data = data;
    inspector.state = state;

    const form = inspector.querySelector('[data-add-role]');
    form.elements.silver.value = '99';
    let raised = null;
    inspector.addEventListener('rb-facilitate', (event) => { raised = event.detail; });
    form.dispatchEvent(new Event('submit'));

    expect(raised.verb).toBe('facilitator:add-role');
    expect(raised.payload.roleId).toBe('king_ecgberht');
    expect(raised.payload.resources.silver).toBe(99);

    const result = apply(state, data, raised, FACILITATOR, { ts: 0 });
    expect(result.ok).toBe(true);
    expect(result.state.roles.king_ecgberht.silver).toBe(99);
  });

  it('says there is nobody left to add once everyone printed is in the game', () => {
    const inspector = mount('rb-state-inspector');
    inspector.data = data;
    inspector.state = fresh();
    expect(inspector.textContent).toContain('Everyone printed is already in the game');
  });
});

describe('<rb-envoy-channel>', () => {
  // Opening a thread is now solely rb-action-list's send-envoy action, gated
  // to the Encounter Phase; this component only continues a conversation
  // that is already open, whatever phase it now is.

  /** A projection for a seated player, with whatever envoys we hand it. */
  const viewFor = (roleId, envoys = {}) => ({
    viewer: { roleId, kind: 'player' },
    roles: { [roleId]: { id: roleId } },
    envoys,
  });

  it('takes up nothing when there is no conversation open', () => {
    const channel = mount('rb-envoy-channel');
    channel.data = data;
    channel.view = viewFor('king_alfred');
    expect(channel.innerHTML).toBe('');
  });

  it('shows a thread once one exists, named for who it is with', () => {
    const channel = mount('rb-envoy-channel');
    channel.data = data;
    channel.view = viewFor('king_alfred', {
      t1: { id: 't1', roleId: 'king_alfred', npcFaction: 'franks', open: true, messages: [] },
    });
    expect(channel.querySelector('[data-thread="t1"]')).toBeTruthy();
    expect(channel.textContent).toContain(data.factions.npc.franks.name);
  });

  it('sends a reply into the open thread', () => {
    const channel = mount('rb-envoy-channel');
    channel.data = data;
    channel.view = viewFor('king_alfred', {
      t1: { id: 't1', roleId: 'king_alfred', npcFaction: 'franks', open: true, messages: [] },
    });
    let raised = null;
    channel.addEventListener('rb-command', (event) => { raised = event.detail; });
    const form = channel.querySelector('[data-say="t1"]');
    form.elements.text.value = 'A fleet, for silver.';
    form.dispatchEvent(new Event('submit'));
    expect(raised).toEqual({
      verb: 'envoy-message', payload: { threadId: 't1', text: 'A fleet, for silver.' },
    });
  });

  it('escapes what somebody typed', () => {
    // The only free text in the game that another party renders.
    const channel = mount('rb-envoy-channel');
    channel.data = data;
    channel.view = viewFor('king_alfred', {
      t1: {
        id: 't1',
        roleId: 'king_alfred',
        npcFaction: 'franks',
        open: true,
        messages: [{ from: 'king_alfred', text: '<img src=x onerror=alert(1)>', at: 0 }],
      },
    });
    expect(channel.querySelector('img')).toBe(null);
    expect(channel.textContent).toContain('<img src=x');
  });
});
