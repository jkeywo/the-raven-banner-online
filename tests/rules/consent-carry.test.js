/**
 * What carrying means, asked one kind at a time.
 *
 * `resolveConsent` answers "did this round carry?" — everybody answered and
 * nobody refused — and hands the consequence to the kind that was being asked
 * about. These tests take the two halves apart: each kind's `carry` is called
 * on a hand-made request with no round and no commands around it, so what it
 * actually does to the board is visible without a settle negotiation or a
 * homage in the way; and the delegation itself is checked, because a round that
 * failed must reach no carry at all.
 *
 * The end-to-end paths are still covered where they were — settle-shire and
 * feudal — and stay there. This is about the seam, which is the thing a third
 * agreement type will be added through.
 */
import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { CONSENT_KINDS, resolveConsent } from '../../gui/rules/commands/consent.js';

const data = await loadData();

const board = () => createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });

const settleRequest = (overrides = {}) => ({
  id: 'settle:jorvik:1',
  kind: 'settle',
  roleId: 'halfdan_ragnarsson',
  shireId: 'jorvik',
  asked: ['gainbeald', 'king_ecgberht'],
  granted: {},
  resolved: false,
  outcome: null,
  ...overrides,
});

const allegianceRequest = (overrides = {}) => ({
  id: 'allegiance:gainbeald:1',
  kind: 'allegiance',
  roleId: 'gainbeald',
  liegeId: 'guthrum_the_old',
  asked: ['guthrum_the_old'],
  granted: {},
  resolved: false,
  outcome: null,
  ...overrides,
});

describe('settling, as a carry on its own', () => {
  it('charges the asker and supports the shire', () => {
    const state = board();
    state.roles.halfdan_ragnarsson.momentum = 2;
    const { silver, soldiers } = state.roles.halfdan_ragnarsson;

    CONSENT_KINDS.settle.carry(state, data, settleRequest());

    expect(state.roles.halfdan_ragnarsson).toMatchObject(
      { momentum: 1, soldiers: soldiers - 3, silver: silver - 5 });
    expect(state.shires.jorvik.danishSupport).toBe(true);
    // Two of Jorvik's three, and the third left as it was printed.
    expect(Object.values(state.shires.jorvik.settlements)
      .filter((s) => s.defended)).toHaveLength(2);
  });

  it('circles only the settlements there is any point circling', () => {
    // "Add defenders to two settlements of your choice" — a settlement already
    // circled gains nothing from being circled again, and a burnt one has
    // nothing left to defend, so neither is one of the two.
    const state = board();
    state.roles.halfdan_ragnarsson.momentum = 2;
    const [already, burnt, open] = Object.values(state.shires.jorvik.settlements);
    already.defended = true;
    burnt.destroyed = true;

    CONSENT_KINDS.settle.carry(state, data, settleRequest());

    expect(open.defended).toBe(true);
    expect(burnt.defended).toBe(false);
  });
});

describe('homage, as a carry on its own', () => {
  it('takes the liege, the faction, and the shires that follow it', () => {
    const state = board();
    const faction = state.roles.guthrum_the_old.factionId;
    expect(state.roles.gainbeald.factionId).not.toBe(faction);

    CONSENT_KINDS.allegiance.carry(state, data, allegianceRequest());

    expect(state.roles.gainbeald).toMatchObject({ liegeId: 'guthrum_the_old', factionId: faction });
    // A vassal's lands answer to their liege's faction, which is what moves
    // them on the Danelaw and Disorder counters.
    expect(state.shires.lindsey.factionId).toBe(faction);
    expect(state.shires.north_mercia.factionId).toBe(faction);
  });
});

describe('resolveConsent decides only whether it carried', () => {
  it('reaches the carry once everybody has said yes', () => {
    const state = board();
    state.roles.halfdan_ragnarsson.momentum = 2;
    const request = settleRequest({ granted: { gainbeald: true, king_ecgberht: true } });

    resolveConsent(state, data, request);

    expect(request).toMatchObject({ resolved: true, outcome: 'granted' });
    expect(state.shires.jorvik.danishSupport).toBe(true);
  });

  it('reaches no carry at all on a refusal', () => {
    const state = board();
    state.roles.halfdan_ragnarsson.momentum = 2;
    const before = { ...state.roles.halfdan_ragnarsson };
    const request = settleRequest({ granted: { gainbeald: false } });

    resolveConsent(state, data, request);

    expect(request).toMatchObject({ resolved: true, outcome: 'refused' });
    expect(state.shires.jorvik.danishSupport).toBe(false);
    expect(state.roles.halfdan_ragnarsson).toEqual(before);
  });

  it('leaves a round still waiting on somebody alone', () => {
    const state = board();
    const request = settleRequest({ granted: { gainbeald: true } });

    resolveConsent(state, data, request);

    expect(request.resolved).toBe(false);
    expect(state.shires.jorvik.danishSupport).toBe(false);
  });

  it('resolves a kind nothing has been taught about, and changes nothing', () => {
    // A round with no consequence is a legitimate thing to hold — the answer
    // is the record — so an unknown kind must close rather than throw.
    const state = board();
    const roles = structuredClone(state.roles);
    const request = settleRequest({ kind: 'a-thing-nobody-has-written-yet', granted: { gainbeald: true, king_ecgberht: true } });

    resolveConsent(state, data, request);

    expect(request).toMatchObject({ resolved: true, outcome: 'granted' });
    expect(state.roles).toEqual(roles);
    expect(state.shires.jorvik.danishSupport).toBe(false);
  });
});
