// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply } from '../../gui/rules/reducer.js';
import { collectLeaves, matchesPattern, coerce } from '../../gui/components/rb-state-inspector.js';
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

describe('what the inspector will show', () => {
  const leaves = collectLeaves(fresh());
  const paths = leaves.map((l) => l.path);

  it('reaches every leaf of the board', () => {
    expect(paths).toContain('roles.king_alfred.silver');
    expect(paths).toContain('shires.wiltshire.castles');
    expect(paths).toContain('shires.wiltshire.settlements.wiltshire_town_1.defended');
  });

  it('refuses to offer the things that would break replay', () => {
    // Editing the seed or the history would make the record disagree with the
    // game it describes, which is worse than any bug it could paper over.
    for (const forbidden of ['seed', 'rngCursor', 'schemaVersion', 'joinCode']) {
      expect(paths, forbidden).not.toContain(forbidden);
    }
    expect(paths.some((p) => p.startsWith('log'))).toBe(false);
    expect(paths.some((p) => p.startsWith('seatByToken'))).toBe(false);
  });

  it('matches a suggestion pattern against a real path', () => {
    expect(matchesPattern('roles.*.silver', 'roles.king_alfred.silver')).toBe(true);
    expect(matchesPattern('roles.*.silver', 'roles.king_alfred.food')).toBe(false);
    expect(matchesPattern('roles.*.silver', 'roles.king_alfred.perTurn.silver')).toBe(false);
  });
});

describe('values keep their type', () => {
  it('reads a number back as a number', () => {
    // A castles that quietly became the string "3" would compare wrong
    // everywhere afterwards and nobody would know why.
    expect(coerce('3', 'number')).toBe(3);
    expect(coerce('', 'number')).toBe(0);
    expect(coerce('nonsense', 'number')).toBe(0);
  });

  it('reads a boolean back as a boolean, and a blank as null', () => {
    expect(coerce(true, 'boolean')).toBe(true);
    expect(coerce(false, 'boolean')).toBe(false);
    expect(coerce('', 'null')).toBe(null);
    expect(coerce('cenred', 'null')).toBe('cenred');
  });
});

describe('the inspector in the page', () => {
  it('shows the fields a facilitator actually reaches for', () => {
    const inspector = mount('rb-state-inspector');
    inspector.state = fresh();
    const paths = [...inspector.querySelectorAll('.rb-inspector-path')].map((e) => e.textContent);
    expect(paths).toContain('roles.king_alfred.silver');
    expect(paths.some((p) => p.endsWith('.wounds'))).toBe(true);
  });

  it('finds anything by name', () => {
    const inspector = mount('rb-state-inspector');
    inspector.state = fresh();
    inspector.querySelector('#rb-inspector-find').value = 'wiltshire';
    inspector.querySelector('#rb-inspector-find')
      .dispatchEvent(new Event('input', { bubbles: true }));
    const paths = [...inspector.querySelectorAll('.rb-inspector-path')].map((e) => e.textContent);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => p.includes('wiltshire'))).toBe(true);
  });

  it('raises an override that the reducer actually accepts', () => {
    // The end-to-end claim: what the control emits is a command the rules
    // admit, so the pencil really does write on the board.
    const state = fresh();
    const inspector = mount('rb-state-inspector');
    inspector.state = state;

    let raised = null;
    inspector.addEventListener('rb-facilitate', (event) => { raised = event.detail; });

    const field = inspector.querySelector('[data-path="roles.king_alfred.silver"]');
    field.value = '40';
    field.dispatchEvent(new Event('change', { bubbles: true }));

    expect(raised.verb).toBe('facilitator:set');
    expect(raised.payload).toEqual({ path: ['roles', 'king_alfred', 'silver'], value: 40 });

    const result = apply(state, data, raised, FACILITATOR, { ts: 0 });
    expect(result.ok).toBe(true);
    expect(result.state.roles.king_alfred.silver).toBe(40);
  });
});

describe('<rb-envoy-channel>', () => {
  /** A projection for a seated player, with whatever envoys we hand it. */
  const viewFor = (roleId, envoys = {}) => ({
    viewer: { roleId, kind: 'player' },
    roles: { [roleId]: { id: roleId } },
    envoys,
  });

  it('offers a warrior the secular courts and says what they want', () => {
    const channel = mount('rb-envoy-channel');
    channel.data = data;
    channel.view = viewFor('king_alfred');
    const courts = [...channel.querySelectorAll('[data-send]')].map((b) => b.dataset.send);
    expect(courts).toEqual(['britons', 'franks', 'danish_kings']);
    expect(channel.textContent).toContain('English territory');
  });

  it('offers a priest only Rome', () => {
    const channel = mount('rb-envoy-channel');
    channel.data = data;
    channel.view = viewFor('archbishop_aethelred');
    expect([...channel.querySelectorAll('[data-send]')].map((b) => b.dataset.send))
      .toEqual(['pope']);
  });

  it('shuts a court you are already talking to', () => {
    const channel = mount('rb-envoy-channel');
    channel.data = data;
    channel.view = viewFor('king_alfred', {
      t1: { id: 't1', roleId: 'king_alfred', npcFaction: 'franks', open: true, messages: [] },
    });
    expect(channel.querySelector('[data-send="franks"]').disabled).toBe(true);
    expect(channel.querySelector('[data-send="britons"]').disabled).toBe(false);
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
