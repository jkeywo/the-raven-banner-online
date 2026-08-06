import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState, rosterFor } from '../../gui/rules/state.js';
import { projectView } from '../../gui/rules/views.js';
import {
  shireDeviations, hasDeviated, deviatedShires, printedBoard,
} from '../../gui/rules/map-state.js';

const data = await loadData();

const fresh = (roleIds) =>
  createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data, roleIds });

/** The same board as a player sees it, which is the state the map actually gets. */
const asPlayer = (state, roleId = 'king_alfred') => projectView(state, data, {
  kind: 'player', seatId: 's1', roleId, teamId: state.roles[roleId].teamId,
});

describe('blank until it differs', () => {
  it('finds nothing to draw on a board still at its printed position', () => {
    expect(deviatedShires(fresh(), data)).toEqual([]);
  });

  it('opens blank at every head count the guide allows', () => {
    // A twelve-player game hands Oscatel's shires on and takes a castle off a
    // four-castle shire — but it does that because a printed table says to, so
    // it is still the opening position and still draws nothing.
    for (const players of [16, 15, 14, 13, 12]) {
      const state = fresh(rosterFor(data, players));
      expect(deviatedShires(state, data), `${players} players`).toEqual([]);
    }
  });

  it('lights only the shire that moved', () => {
    const state = fresh();
    state.shires.wiltshire.stewardRoleId = 'halfdan_ragnarsson';
    expect(deviatedShires(state, data)).toEqual(['wiltshire']);
    expect(shireDeviations(state, data, 'wiltshire')).toContain('steward');
  });

  it('reads the same off a projection as off the whole state', () => {
    // The player console runs this predicate against a redacted view. Every
    // field it reads is public, so both sides have to reach the same verdict.
    const state = fresh();
    state.shires.kent.castles += 1;
    expect(deviatedShires(asPlayer(state), data)).toEqual(['kent']);
    expect(shireDeviations(asPlayer(state), data, 'kent')).toEqual(['castles']);
  });

  it('notices a settlement burned and one newly defended', () => {
    const state = fresh();
    const [first, second] = Object.keys(state.shires.sussex.settlements);
    state.shires.sussex.settlements[first].destroyed = true;
    expect(shireDeviations(state, data, 'sussex')).toEqual(['settlements']);

    const other = fresh();
    other.shires.sussex.settlements[second].defended =
      !other.shires.sussex.settlements[second].defended;
    expect(shireDeviations(other, data, 'sussex')).toEqual(['settlements']);
  });

  it('notices a missionary cross', () => {
    const state = fresh();
    state.shires.jorvik.missionaryCross = true;
    expect(shireDeviations(state, data, 'jorvik')).toEqual(['cross']);
  });

  it('notices a ship value a contract has moved', () => {
    const state = fresh();
    state.shires.wiltshire.shipCostDelta = -2;
    expect(shireDeviations(state, data, 'wiltshire')).toEqual(['shipCost']);
  });

  it('leaves the three shires that open unsupported alone', () => {
    // Halfdan and Guthrum have settled nowhere, so their shires pay nothing
    // and count toward Disorder from the first minute. That is a printed fact
    // about the opening position, not something the game did, so the map says
    // nothing about it — the tracker and the private sheet do.
    const state = fresh();
    for (const id of ['jorvik', 'ribble', 'east_anglia']) {
      expect(hasDeviated(state, data, id), id).toBe(false);
    }
  });

  it('lights a shire whose support fell away without it being touched', () => {
    // Nothing about Gainbeald's shires changes when Ceowulf is crowned. What
    // changes is that Mercia now answers to somebody else, and Gainbeald is a
    // lord with land he cannot tax — which is exactly the thing a player needs
    // to see on the board rather than work out.
    const state = fresh();
    state.crownHolders = { ...state.crownHolders, mercia: 'ceowulf' };
    const lit = deviatedShires(state, data);
    expect(lit).toContain('north_mercia');
    expect(shireDeviations(state, data, 'north_mercia')).toEqual(['support']);
    // Ceowulf's own shires still support him, so they stay quiet.
    expect(lit).not.toContain('wrekinsets');
    expect(lit).not.toContain('magonsets');
  });

  it('lights a Danish shire the moment it is settled', () => {
    const state = fresh();
    state.shires.jorvik.danishSupport = true;
    expect(shireDeviations(state, data, 'jorvik')).toEqual(['support']);
  });

  it('builds the printed board from the same function that starts a game', () => {
    // If these ever disagree, the map is comparing against a fiction.
    const opening = printedBoard(fresh(), data);
    expect(opening.shires).toEqual(fresh().shires);
  });

  it('survives a role the printed guide never had', () => {
    // The facilitator's inspector can add one. An opening position cannot be
    // built for somebody the rules have never heard of, so it is left out
    // rather than throwing and taking the whole map down with it.
    const state = fresh();
    state.roles.a_stranger = { ...state.roles.cenred, id: 'a_stranger' };
    expect(() => deviatedShires(state, data)).not.toThrow();
    expect(deviatedShires(state, data)).toEqual([]);
  });
});
