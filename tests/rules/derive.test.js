import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import {
  aftermath, hasSupport, incomeFor, factionsOf, reachableFrom, settlementsStanding,
} from '../../gui/rules/derive.js';

const data = await loadData();
const fresh = () => createInitialState({ joinCode: 'TESTING', seed: 1, data });

describe('the opening position reproduces the printed tracker', () => {
  // The Aftermath sheet prints turn-zero values for three of its four
  // counters. Those numbers are the only external check on the support rule,
  // because support is the one thing on the board that is inferred rather
  // than drawn — and Disorder counts exactly the shires held without it.
  const counters = aftermath(fresh(), data);

  it('has three Danish shires', () => {
    expect(counters.danelaw.value).toBe(3);
    expect(counters.danelaw.shires).toEqual(['east_anglia', 'jorvik', 'ribble']);
  });

  it('has three pagan shires', () => {
    // The same three: no missionary has been anywhere yet.
    expect(counters.paganism.value).toBe(3);
  });

  it('has three unsupported shires, and they are the Danish ones', () => {
    // This is the assertion the whole support rule exists to satisfy. Get the
    // rule wrong in either direction and this moves: too strict and Abbess
    // Wenyld's Mercian shires fall out with it, too loose and Bernicia joins
    // the Danish three.
    expect(counters.disorder.value).toBe(3);
    expect(counters.disorder.shires).toEqual(['east_anglia', 'jorvik', 'ribble']);
  });

  it('has seventy-five settlements standing', () => {
    // The artwork's count, not the tracker's 74 — see KNOWN_DISCREPANCIES.
    expect(settlementsStanding(fresh())).toBe(75);
    expect(counters.prosperity.value).toBe(75);
  });
});

describe('support', () => {
  const state = fresh();

  it('follows a liege chain', () => {
    // Cenred holds no crown that Essex's box lists, but his liege Alfred holds
    // Wessex, and that is enough.
    expect(factionsOf(state, data, 'cenred')).not.toContain('Ex');
    expect(state.roles.cenred.liegeId).toBe('king_alfred');
    expect(hasSupport(state, data, 'essex')).toBe(true);
  });

  it('reads a crown as a faction', () => {
    // Ecgberht sits on the Danish side of the board, so his shire is lettered
    // for the invasion, but he holds Northumbria and Bernicia's box lists it.
    expect(factionsOf(state, data, 'king_ecgberht')).toContain('N');
    expect(hasSupport(state, data, 'bernicia')).toBe(true);
  });

  it('gives a Dane support only where they have settled', () => {
    expect(hasSupport(state, data, 'jorvik')).toBe(false);
    const settled = fresh();
    settled.shires.jorvik.danishSupport = true;
    expect(hasSupport(settled, data, 'jorvik')).toBe(true);
  });

  it('covers a role holding no crown at all, through their team', () => {
    // Abbess Wenyld claims nothing and answers to nobody, but she is Mercian
    // and both her shires list Mercia.
    expect(state.roles.abbess_wenyld.claims).toEqual([]);
    expect(state.roles.abbess_wenyld.liegeId).toBe(null);
    expect(hasSupport(state, data, 'hwicce')).toBe(true);
    expect(hasSupport(state, data, 'south_mercia')).toBe(true);
  });
});

describe('income', () => {
  it('pays a farm one food and a town two silver', () => {
    const state = fresh();
    const wiltshire = state.shires.wiltshire.settlements;
    const towns = Object.values(wiltshire).filter((s) => s.type === 'town').length;
    const farms = Object.values(wiltshire).filter((s) => s.type === 'farm').length;
    const westCountry = state.shires.west_country.settlements;
    const income = incomeFor(state, data, 'king_alfred');
    expect(income.silver).toBe(2 * (towns
      + Object.values(westCountry).filter((s) => s.type === 'town').length));
    expect(income.food).toBe(farms
      + Object.values(westCountry).filter((s) => s.type === 'farm').length);
  });

  it('pays nothing for a defended settlement without support', () => {
    // None of Alfred's towns start defended, so defend one first — otherwise
    // this passes for the wrong reason and would keep passing if the support
    // gate were deleted entirely.
    const state = fresh();
    const town = Object.values(state.shires.wiltshire.settlements).find((s) => s.type === 'town');
    town.defended = true;
    const supported = incomeFor(state, data, 'king_alfred').silver;

    // Strip Alfred of Wessex — claim and crown both, since he wears it
    // outright at the start rather than merely claiming it — and put him on
    // the wrong side of the war. The defended town now pays him nothing; the
    // undefended ones still pay.
    state.roles.king_alfred.claims = [];
    delete state.crownHolders.wessex;
    state.roles.king_alfred.teamId = 'great_summer_army';
    expect(hasSupport(state, data, 'wiltshire')).toBe(false);
    expect(incomeFor(state, data, 'king_alfred').silver).toBe(supported - 2);
  });

  it('gives a landless role two food and a soldier', () => {
    expect(incomeFor(fresh(), data, 'godric')).toMatchObject({
      silver: 0, food: 2, soldiers: 1, landless: true,
    });
  });

  it('stops paying for a destroyed settlement', () => {
    const state = fresh();
    const before = incomeFor(state, data, 'king_alfred');
    const town = Object.values(state.shires.wiltshire.settlements).find((s) => s.type === 'town');
    town.destroyed = true;
    expect(incomeFor(state, data, 'king_alfred').silver).toBe(before.silver - 2);
  });
});

describe('reach', () => {
  it('includes bordering shires and excludes the far side of the board', () => {
    const state = fresh();
    const reach = reachableFrom(state, data, 'king_alfred');
    expect(reach).toContain('hwicce');        // borders Wiltshire
    expect(reach).not.toContain('bernicia');  // the other end of England
  });

  it('opens a coastal shire for the turn once its ship cost is paid', () => {
    const state = fresh();
    expect(reachableFrom(state, data, 'guthrum_the_old')).not.toContain('kent');
    state.shires.kent.adjacencyBought.guthrum_the_old = state.phase.turn;
    expect(reachableFrom(state, data, 'guthrum_the_old')).toContain('kent');
    // Bought access lasts the turn and no longer.
    state.phase.turn += 1;
    expect(reachableFrom(state, data, 'guthrum_the_old')).not.toContain('kent');
  });
});
