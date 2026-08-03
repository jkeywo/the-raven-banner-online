import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { apply } from '../../gui/rules/reducer.js';
import { admit } from '../../gui/rules/admission.js';
import { projectView } from '../../gui/rules/views.js';

const data = await loadData();
const FACILITATOR = { seatId: 's9', kind: 'facilitator', roleId: null };

function playing(roleId, phaseName = 'encounter') {
  let state = createInitialState({ joinCode: 'RAVEN7Z', seed: 1, data });
  state.seats.s1 = { id: 's1', token: 't', name: 'A', roleId, kind: 'player', connected: true, lastSeen: 0 };
  state.seats.s9 = { id: 's9', token: 'f', name: 'F', roleId: null, kind: 'facilitator', connected: true, lastSeen: 0 };
  while (state.phase.name !== phaseName) {
    state = apply(state, data, { verb: 'facilitator:advance-phase', payload: {} },
      FACILITATOR, { ts: 0 }).state;
  }
  return { state, actor: { seatId: 's1', kind: 'player', roleId } };
}

function run(state, actor, verb, payload = {}, ts = 1) {
  const result = apply(state, data, { verb, payload }, actor, { ts });
  if (!result.ok) throw new Error(`${verb} refused: ${result.reason}`);
  return result.state;
}

const refusal = (state, actor, verb, payload = {}) =>
  admit(state, data, { verb, payload }, actor).reason;

describe('sending an envoy', () => {
  it('costs a warrior two silver and opens a conversation', () => {
    // The action does not buy a deal; it buys a hearing. What it actually
    // creates is a private thread with the facilitator.
    const { state, actor } = playing('king_alfred');
    const after = run(state, actor, 'send-envoy', { npcFaction: 'franks' });
    expect(after.roles.king_alfred.silver).toBe(2);
    const thread = Object.values(after.envoys)[0];
    expect(thread).toMatchObject({ roleId: 'king_alfred', npcFaction: 'franks', open: true });
    expect(thread.messages).toEqual([]);
  });

  it('costs Frida one, because trade is the whole of her', () => {
    const { state, actor } = playing('frida_anundottir');
    expect(run(state, actor, 'send-envoy', { npcFaction: 'britons' })
      .roles.frida_anundottir.silver).toBe(11);
  });

  it('sends a priest to Rome and nowhere else', () => {
    const { state, actor } = playing('archbishop_aethelred');
    expect(refusal(state, actor, 'send-envoy', { npcFaction: 'franks' })).toContain('the Pope');

    // Momentum starts at nothing, so Rome is out of reach until the first
    // maintenance phase has been collected — which is the game saying a
    // bishop's influence is something he builds rather than something he has.
    expect(refusal(state, actor, 'send-envoy', { npcFaction: 'pope' }))
      .toBe('not enough momentum — you have 0, this costs 1');

    state.roles.archbishop_aethelred.momentum = 3;
    const after = run(state, actor, 'send-envoy', { npcFaction: 'pope' });
    // Paid for in momentum, not silver.
    expect(after.roles.archbishop_aethelred.momentum).toBe(2);
    expect(after.roles.archbishop_aethelred.silver).toBe(4);
  });

  it('keeps the secular powers away from a priest, and Rome from everyone else', () => {
    expect(refusal(playing('king_alfred').state, playing('king_alfred').actor,
      'send-envoy', { npcFaction: 'pope' })).toContain('Britons');
  });

  it('is an encounter-phase action', () => {
    const { state, actor } = playing('king_alfred', 'maintenance');
    expect(refusal(state, actor, 'send-envoy', { npcFaction: 'franks' })).toContain('encounter');
  });

  it('will not open a second conversation with the same court', () => {
    // A second envoy to the same court is the same conversation, and should
    // join it rather than start a rival.
    const { state, actor } = playing('king_alfred');
    const after = run(state, actor, 'send-envoy', { npcFaction: 'franks' });
    expect(refusal(after, actor, 'send-envoy', { npcFaction: 'franks' }))
      .toContain('already have that conversation open');
    // A different court is a different conversation.
    expect(admit(after, data, { verb: 'send-envoy', payload: { npcFaction: 'britons' } }, actor).ok)
      .toBe(true);
  });

  it('says what it costs when you cannot pay', () => {
    const { state, actor } = playing('king_alfred');
    state.roles.king_alfred.silver = 1;
    expect(refusal(state, actor, 'send-envoy', { npcFaction: 'franks' }))
      .toBe('not enough silver — you have 1, this costs 2');
  });
});

describe('the conversation', () => {
  function talking() {
    const { state, actor } = playing('king_alfred');
    return { state: run(state, actor, 'send-envoy', { npcFaction: 'franks' }), actor };
  }

  it('carries messages both ways, attributed', () => {
    let { state, actor } = talking();
    const threadId = Object.keys(state.envoys)[0];
    state = run(state, actor, 'envoy-message', { threadId, text: 'Send me a fleet.' });
    state = run(state, FACILITATOR, 'facilitator:envoy-reply',
      { threadId, text: 'And what does Wessex offer for it?' }, 2);

    expect(state.envoys[threadId].messages).toEqual([
      { from: 'king_alfred', text: 'Send me a fleet.', at: 1 },
      // The reply comes from the court, not from the facilitator: everyone
      // knows a person is typing it, and keeping the fiction is the point.
      { from: 'franks', text: 'And what does Wessex offer for it?', at: 2 },
    ]);
  });

  it('goes on working outside the encounter phase', () => {
    // A negotiation started in one phase does not stop mid-sentence because
    // the clock moved on.
    let { state, actor } = talking();
    const threadId = Object.keys(state.envoys)[0];
    state = run(state, FACILITATOR, 'facilitator:advance-phase', {});
    expect(state.phase.name).not.toBe('encounter');
    expect(admit(state, data, { verb: 'envoy-message', payload: { threadId, text: 'Well?' } },
      actor).ok).toBe(true);
  });

  it('refuses an empty message rather than sending one', () => {
    const { state, actor } = talking();
    const threadId = Object.keys(state.envoys)[0];
    expect(refusal(state, actor, 'envoy-message', { threadId, text: '   ' })).toBe('say something');
  });

  it('will not let a player into somebody else’s negotiation', () => {
    const { state } = talking();
    const threadId = Object.keys(state.envoys)[0];
    const other = { seatId: 's2', kind: 'player', roleId: 'guthrum_the_old' };
    expect(refusal(state, other, 'envoy-message', { threadId, text: 'Deal with me instead' }))
      .toContain('not yours');
  });

  it('closes, and stays closed to the player', () => {
    let { state, actor } = talking();
    const threadId = Object.keys(state.envoys)[0];
    state = run(state, FACILITATOR, 'facilitator:envoy-close', { threadId });
    expect(state.envoys[threadId].open).toBe(false);
    expect(refusal(state, actor, 'envoy-message', { threadId, text: 'Wait' })).toContain('closed');
    // The facilitator can always reopen it by answering.
    state = run(state, FACILITATOR, 'facilitator:envoy-reply', { threadId, text: 'One more thing.' });
    expect(state.envoys[threadId].open).toBe(true);
  });
});

describe('a negotiation is private', () => {
  it('reaches its sender and the facilitator, and nobody else', () => {
    let { state, actor } = playing('king_alfred');
    state = run(state, actor, 'send-envoy', { npcFaction: 'franks' });
    const threadId = Object.keys(state.envoys)[0];
    state = run(state, actor, 'envoy-message',
      { threadId, text: 'SECRET::alfred-offers-kent' });

    const seenBy = (roleId) => JSON.stringify(projectView(state, data, {
      kind: 'player', seatId: 'x', roleId, teamId: state.roles[roleId].teamId,
    }));

    expect(seenBy('king_alfred')).toContain('SECRET::alfred-offers-kent');
    // Not even his own vassal, and certainly not the Danes.
    expect(seenBy('cenred')).not.toContain('SECRET::');
    expect(seenBy('guthrum_the_old')).not.toContain('SECRET::');
    expect(JSON.stringify(projectView(state, data, { kind: 'facilitator' })))
      .toContain('SECRET::alfred-offers-kent');
  });
});

describe('the override', () => {
  it('changes a value and says in the log that a facilitator did it', () => {
    // The whole point: when the app gets something wrong mid-game, the
    // alternative to fixing it is sixteen people watching an apology.
    const { state } = playing('king_alfred');
    const after = run(state, FACILITATOR, 'facilitator:set',
      { path: ['roles', 'king_alfred', 'silver'], value: 40 });
    expect(after.roles.king_alfred.silver).toBe(40);
    expect(after.log.at(-1)).toMatchObject({ verb: 'facilitator:set', override: true });
  });

  it('replays, so a corrected game stays corrected', async () => {
    const { replay } = await import('../../gui/rules/reducer.js');
    const { toSave } = await import('../../gui/rules/command-log.js');
    const { state } = playing('king_alfred');
    const after = run(state, FACILITATOR, 'facilitator:set',
      { path: ['shires', 'wiltshire', 'castles'], value: 2 });
    const { state: rebuilt, refused } = replay(toSave(after), data);
    expect(refused).toEqual([]);
    expect(rebuilt.shires.wiltshire.castles).toBe(2);
  });

  it('is not open to a player', () => {
    const { state, actor } = playing('king_alfred');
    expect(refusal(state, actor, 'facilitator:set',
      { path: ['roles', 'king_alfred', 'silver'], value: 999 }))
      .toBe('only a facilitator may do that');
  });
});
