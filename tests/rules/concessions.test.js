import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply, replay } from '../../gui/rules/reducer.js';
import { admit } from '../../gui/rules/admission.js';
import { toSave } from '../../gui/rules/command-log.js';
import { projectView } from '../../gui/rules/views.js';

const data = await loadData();
const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };

function playing() {
  let state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
  state.seats.s9 = { id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
  while (state.phase.name !== 'encounter') {
    state = apply(state, data, { verb: 'facilitator:advance-phase', payload: {} },
      FACILITATOR, { ts: 0 }).state;
  }
  return state;
}

function run(state, actor, verb, payload = {}) {
  const result = apply(state, data, { verb, payload }, actor, { ts: 0 });
  if (!result.ok) throw new Error(`${verb} refused: ${result.reason}`);
  return result.state;
}

const refusal = (state, verb, payload = {}) =>
  admit(state, data, { verb, payload }, FACILITATOR).reason;

const promise = (state, payload) =>
  run(state, FACILITATOR, 'facilitator:record-concession', payload);

describe('every court is playable cold', () => {
  it('carries who they are, what they want, and something to open with', () => {
    // A facilitator is four foreign powers at once while also running a
    // clock. "Play them shrewdly" is not a line you can say to a player.
    for (const [id, npc] of Object.entries(data.factions.npc)) {
      expect(npc.who?.length, id).toBeGreaterThan(40);
      expect(npc.wants?.length, id).toBeGreaterThan(10);
      expect(npc.offers?.length, id).toBeGreaterThan(10);
      expect(npc.openings?.length, id).toBeGreaterThan(1);
      expect(npc.asks?.length, id).toBeGreaterThan(1);
    }
  });

  it('warns that Rome pays in nothing you can spend', () => {
    expect(data.factions.npc.pope.note).toContain('game effect');
  });

  it('reaches every court somebody may send to', () => {
    const reachable = new Set(Object.values(data.factions.envoy).flatMap((e) => e.to));
    expect([...reachable].sort()).toEqual(Object.keys(data.factions.npc).sort());
  });
});

describe('the concessions ledger', () => {
  it('writes down what was promised, by whom, and when', () => {
    const state = promise(playing(), {
      npcFaction: 'franks', roleId: 'king_alfred', text: 'Sussex, held of the Franks',
    });
    expect(Object.values(state.concessions)).toHaveLength(1);
    expect(Object.values(state.concessions)[0]).toMatchObject({
      npcFaction: 'franks',
      roleId: 'king_alfred',
      text: 'Sussex, held of the Franks',
      turn: 1,
      kept: true,
    });
  });

  it('takes a promise nobody in particular made', () => {
    // Some deals are struck by a faction rather than a person, and the
    // epilogue still wants them.
    const state = promise(playing(), { npcFaction: 'pope', text: 'The Mercian church reformed' });
    expect(Object.values(state.concessions)[0].roleId).toBe(null);
  });

  it('wants a court and something actually promised', () => {
    const state = playing();
    expect(refusal(state, 'facilitator:record-concession',
      { npcFaction: 'burgundy', text: 'anything' })).toBe('no such court');
    expect(refusal(state, 'facilitator:record-concession',
      { npcFaction: 'pope', text: '   ' })).toBe('what was promised?');
    expect(refusal(state, 'facilitator:record-concession',
      { npcFaction: 'pope', roleId: 'nobody', text: 'x' })).toBe('no such character');
  });

  it('strikes a broken promise through rather than deleting it', () => {
    // The epilogue is about what England did, not about what is still true.
    let state = promise(playing(), {
      npcFaction: 'danish_kings', roleId: 'halfdan_ragnarsson', text: 'Tribute every turn',
    });
    const { id } = Object.values(state.concessions)[0];
    state = run(state, FACILITATOR, 'facilitator:strike-concession', { concessionId: id });
    expect(Object.values(state.concessions)).toHaveLength(1);
    expect(Object.values(state.concessions)[0]).toMatchObject({ kept: false, text: 'Tribute every turn' });
  });

  it('refuses to strike a promise that was never made', () => {
    expect(refusal(playing(), 'facilitator:strike-concession', { concessionId: 'concession:9' }))
      .toBe('no such promise');
  });

  it('is not for a player to write', () => {
    const state = playing();
    expect(admit(state, data, {
      verb: 'facilitator:record-concession',
      payload: { npcFaction: 'pope', text: 'anything at all' },
    }, { seatId: 's1', kind: 'player', roleId: 'king_alfred' }).ok).toBe(false);
  });
});

describe('a concession is private', () => {
  it('reaches the player who made it and nobody else', () => {
    // What Wessex promised Rome is exactly what another player would pay to
    // know.
    let state = promise(playing(), {
      npcFaction: 'pope', roleId: 'king_alfred', text: 'The bishops freed',
    });
    const seenBy = (roleId) => projectView(state, data, {
      kind: 'player', seatId: 's1', roleId, teamId: state.roles[roleId].teamId,
    });

    const alfred = seenBy('king_alfred');
    expect(JSON.stringify(alfred.concessions)).toContain('The bishops freed');

    const guthrum = seenBy('guthrum_the_old');
    expect(JSON.stringify(guthrum.concessions ?? {})).not.toContain('The bishops freed');
  });

  it('is all there for the facilitator, who has to read it out at the end', () => {
    const state = promise(playing(), {
      npcFaction: 'pope', roleId: 'king_alfred', text: 'The bishops freed',
    });
    const view = projectView(state, data, { kind: 'facilitator', seatId: 's9', roleId: null });
    expect(JSON.stringify(view.concessions)).toContain('The bishops freed');
  });
});

describe('the ledger replays', () => {
  it('rebuilds every promise, kept and broken', () => {
    let state = promise(playing(), {
      npcFaction: 'franks', roleId: 'cenred', text: 'Kent, as a Frankish vassal',
    });
    state = promise(state, { npcFaction: 'britons', text: 'The West Country returned' });
    state = run(state, FACILITATOR, 'facilitator:strike-concession',
      { concessionId: Object.values(state.concessions)[0].id });

    const { state: rebuilt, refused } = replay(toSave(state), data);
    expect(refused).toEqual([]);
    expect(rebuilt.concessions).toEqual(state.concessions);
  });
});
