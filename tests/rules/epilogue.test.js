import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply } from '../../gui/rules/reducer.js';
import { admit } from '../../gui/rules/admission.js';
import { epilogue } from '../../gui/rules/derive.js';

const data = await loadData();
const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };

function playing() {
  let state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
  state.seats.s9 = { id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
  state = apply(state, data, { verb: 'facilitator:advance-phase', payload: {} },
    FACILITATOR, { ts: 0 }).state;
  return state;
}

function run(state, verb, payload = {}) {
  const result = apply(state, data, { verb, payload }, FACILITATOR, { ts: 1000 });
  if (!result.ok) throw new Error(`${verb} refused: ${result.reason}`);
  return result.state;
}

describe('calling time', () => {
  it('freezes the board and stops the clock', () => {
    const state = run(playing(), 'facilitator:end-game');
    expect(state.phase).toMatchObject({ name: 'epilogue', endsAt: null, paused: false });
    expect(state.aftermath).toMatchObject({ endedAt: 1000, endedOnTurn: 1 });
  });

  it('cannot be done twice', () => {
    const state = run(playing(), 'facilitator:end-game');
    expect(admit(state, data, { verb: 'facilitator:end-game', payload: {} }, FACILITATOR))
      .toMatchObject({ ok: false, reason: 'the game is already over' });
  });

  it('is not a player’s to call', () => {
    expect(admit(playing(), data, { verb: 'facilitator:end-game', payload: {} },
      { seatId: 's1', kind: 'player', roleId: 'king_alfred' }).ok).toBe(false);
  });
});

describe('the four counters', () => {
  it('each carry the sentence printed under their band', () => {
    const report = epilogue(playing(), data);
    // Turn zero, so the sentences are the ones the printed tracker starts on.
    expect(report.counters.paganism)
      .toMatchObject({ value: 3, sentence: 'The church takes on some pagan influence.' });
    expect(report.counters.danelaw)
      .toMatchObject({ value: 3, sentence: 'Some Danish enclaves.' });
    expect(report.counters.disorder)
      .toMatchObject({ value: 3, sentence: 'War is inevitable, but there is peace for the moment.' });
    expect(report.counters.prosperity)
      .toMatchObject({ value: 75, sentence: 'All of England prospers.' });
  });

  it('say where each one started, so a change is legible', () => {
    const state = playing();
    state.shires.jorvik.missionaryCross = true;
    const report = epilogue(state, data);
    expect(report.counters.paganism).toMatchObject({ value: 2, start: 3 });
  });

  it('follow the board down as it burns', () => {
    const state = playing();
    for (const shire of Object.values(state.shires)) {
      for (const settlement of Object.values(shire.settlements)) settlement.destroyed = true;
    }
    const report = epilogue(state, data);
    expect(report.counters.prosperity)
      .toMatchObject({ value: 0, sentence: 'Famine and poverty hit all levels of society.' });
  });
});

describe('who ended holding what', () => {
  it('lists everybody, heaviest first', () => {
    const report = epilogue(playing(), data);
    expect(report.players).toHaveLength(16);
    const held = report.players.map((p) => p.shires.length);
    expect([...held].sort((a, b) => b - a)).toEqual(held);
    expect(report.players[0].shires.length).toBeGreaterThan(0);
  });

  it('says what is left in front of them', () => {
    const report = epilogue(playing(), data);
    const alfred = report.players.find((p) => p.id === 'king_alfred');
    expect(alfred.resources).toMatchObject({ silver: expect.any(Number), soldiers: expect.any(Number) });
    expect(alfred.name).toBe('King Alfred');
  });

  it('names a man who is not the man who started', () => {
    let state = playing();
    state.roles.ceowulf.dead = true;
    state = run(state, 'facilitator:heir-arrives', { roleId: 'ceowulf' });
    const report = epilogue(state, data);
    expect(report.players.find((p) => p.id === 'ceowulf').generation).toBe(1);
  });

  it('reports the crowns actually worn', () => {
    const state = playing();
    state.crownHolders.mercia = 'ceowulf';
    const report = epilogue(state, data);
    expect(report.players.find((p) => p.id === 'ceowulf').crowns).toEqual(['mercia']);
    expect(report.players.find((p) => p.id === 'gainbeald').crowns).toEqual([]);
  });
});

describe('the factions as they finished', () => {
  it('groups by where people ended, not where they began', () => {
    const state = playing();
    // Cenred has broken with Wessex and stands alone.
    state.roles.cenred.factionId = 'cenred';
    const report = epilogue(state, data);
    const alone = report.factions.find((f) => f.id === 'cenred');
    expect(alone.members).toEqual(['cenred']);
    expect(report.factions.find((f) => f.id === 'wessex').members).not.toContain('cenred');
  });

  it('counts a faction’s shires and its crowns together', () => {
    const state = playing();
    state.crownHolders.mercia = 'ceowulf';
    const report = epilogue(state, data);
    const mercia = report.factions.find((f) => f.id === 'mercia');
    expect(mercia.crowns).toEqual(['mercia']);
    expect(mercia.shires).toBe(Object.values(state.shires)
      .filter((s) => s.stewardRoleId && state.roles[s.stewardRoleId].factionId === 'mercia').length);
  });
});

describe('foreign influence', () => {
  it('carries the printed note, the prose and the whole ledger', () => {
    let state = playing();
    state = run(state, 'facilitator:record-concession',
      { npcFaction: 'franks', roleId: 'king_alfred', text: 'Sussex, held of the Franks' });
    state = run(state, 'facilitator:record-concession',
      { npcFaction: 'pope', roleId: 'king_alfred', text: 'The bishops freed' });
    const [first] = Object.values(state.concessions);
    state = run(state, 'facilitator:strike-concession', { concessionId: first.id });
    state = run(state, 'facilitator:set',
      { path: ['aftermath', 'foreignInfluence'], value: 'Rome got its way.' });

    const report = epilogue(state, data);
    expect(report.foreignInfluence.note).toContain('concessions');
    expect(report.foreignInfluence.prose).toBe('Rome got its way.');
    // Kept first: the debrief wants the deals before the betrayals.
    expect(report.foreignInfluence.promises.map((p) => p.kept)).toEqual([true, false]);
  });

  it('is honest about an empty ledger', () => {
    expect(epilogue(playing(), data).foreignInfluence.promises).toEqual([]);
  });
});

describe('what the umpire changed', () => {
  it('is carried through to the debrief', () => {
    let state = playing();
    state.roles.ceowulf.dead = true;
    state = run(state, 'facilitator:heir-arrives',
      { roleId: 'ceowulf', note: 'His son wants peace with the Danes.' });
    expect(Object.values(epilogue(state, data).notes))
      .toContain('His son wants peace with the Danes.');
  });

  it('is only that, after a whole game of battle phases filing their own notes', () => {
    // This page gets printed and mailed round the week after, so the heading
    // has to keep meaning what it says. Every battle phase that could not hand
    // the spare token out writes a line somewhere — with four factions "more
    // than one stayed out" is the ordinary case, so a five-turn game writes
    // about five of them. None of them is anything the umpire changed, and
    // none of them belongs under a heading claiming they were.
    let state = playing();
    state.roles.ceowulf.dead = true;
    state = run(state, 'facilitator:heir-arrives',
      { roleId: 'ceowulf', note: 'His son wants peace with the Danes.' });

    let guard = 0;
    while (state.phase.name !== 'epilogue' && (guard += 1) < 100) {
      // Exactly what the grid's "End the battles and hand out the spare
      // token" button sends, every turn.
      if (state.phase.name === 'battle') state = run(state, 'facilitator:end-battles');
      state = run(state, 'facilitator:advance-phase');
    }

    expect(state.phase.name).toBe('epilogue');
    // The notes were genuinely written — this is not passing because nothing
    // happened.
    expect(Object.keys(state.battleNotes).length).toBeGreaterThan(1);

    const { notes } = epilogue(state, data);
    expect(Object.values(notes)).toEqual(['His son wants peace with the Danes.']);
    expect(Object.keys(notes).filter((key) => key.startsWith('initiative:'))).toEqual([]);
  });
});
