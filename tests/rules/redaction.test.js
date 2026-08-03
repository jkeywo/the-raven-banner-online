import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { projectView, unclassifiedPaths, auditProjection } from '../../gui/rules/views.js';
import { ruleFor, NOBODY } from '../../gui/rules/visibility.js';

const data = await loadData();

/**
 * A game in progress with every secret replaced by a unique sentinel, so a
 * leak is findable by string search rather than by knowing what to look for.
 */
function loadedState() {
  const state = createInitialState({ joinCode: 'TESTING', seed: 7, data });

  const seat = (id, token, name, roleId, kind = 'player') => ({
    id, token, name, roleId, kind, connected: true, lastSeen: 1,
  });
  state.seats = {
    s1: seat('s1', 'SECRET::token.alfred', 'Alfred player', 'king_alfred'),
    s2: seat('s2', 'SECRET::token.guthrum', 'Guthrum player', 'guthrum_the_old'),
    s3: seat('s3', 'SECRET::token.cenred', 'Cenred player', 'cenred'),
    s4: seat('s4', 'SECRET::token.facilitator', 'Facilitator', null, 'facilitator'),
  };
  state.seatByToken = {
    'SECRET::token.alfred': 's1', 'SECRET::token.guthrum': 's2',
    'SECRET::token.cenred': 's3', 'SECRET::token.facilitator': 's4',
  };
  state.roles.king_alfred.silver = 4242;
  state.roles.guthrum_the_old.silver = 9191;
  state.roles.king_alfred.wounds = 2;

  state.phase = { turn: 1, name: 'battle', endsAt: 1000, paused: false, pausedRemainingMs: null };

  // A team-scoped declaration that has not been announced yet.
  state.initiative.declared = {
    white: { roleId: 'guthrum_the_old', shireId: 'SECRET::initiative.white.target', revealed: false },
    black: { roleId: 'king_alfred', shireId: 'lindsey', revealed: true },
  };

  state.battle.clashes = {
    c1: {
      id: 'c1', shireId: 'essex', stage: 'awaiting_tactics', auto: false,
      attacker: 'guthrum_the_old', defender: 'cenred',
      tactic: { guthrum_the_old: 'SECRET::clash.c1.tactic.guthrum', cenred: '3' },
      lead: { guthrum_the_old: null, cenred: null },
      reinforcements: {}, rolls: {}, result: null, amendWindowEndsAt: null,
    },
  };

  state.envoys = {
    e1: { roleId: 'king_alfred', npcFaction: 'franks', open: true,
      messages: ['SECRET::envoy.alfred.message'] },
  };
  state.facilitatorNotes = { plan: 'SECRET::facilitatorNotes.plan' };
  state.log = [{ seq: 1, verb: 'claim-role', payload: 'SECRET::log.entry' }];
  state.seed = 987654;

  return state;
}

const VIEWERS = {
  alfred: { kind: 'player', roleId: 'king_alfred', teamId: 'wessex' },
  guthrum: { kind: 'player', roleId: 'guthrum_the_old', teamId: 'great_summer_army' },
  cenred: { kind: 'player', roleId: 'cenred', teamId: 'wessex' },
  spectator: { kind: 'spectator', roleId: null, teamId: null },
};

describe('the manifest is complete', () => {
  it('classifies every path in a loaded game', () => {
    // The half of the guarantee that matters most. A field added without a
    // manifest entry fails here, which means the cost of forgetting is a red
    // build rather than a leak nobody notices for months.
    expect(unclassifiedPaths(loadedState())).toEqual([]);
  });

  it('classifies every path in a fresh game too', () => {
    expect(unclassifiedPaths(createInitialState({ joinCode: 'A', seed: 1, data }))).toEqual([]);
  });
});

describe('no sentinel reaches a seat the manifest does not grant it', () => {
  const state = loadedState();

  /** Exactly what each seat is entitled to. Everything else is a leak. */
  const OWN = {
    // His envoy thread with the Franks, and nothing else in the fixture.
    alfred: ['SECRET::envoy.alfred.message'],
    // His own tactic card, and his own team's target before it is announced.
    guthrum: ['SECRET::clash.c1.tactic.guthrum', 'SECRET::initiative.white.target'],
    cenred: [],
    spectator: [],
  };

  it.each(Object.entries(VIEWERS))('%s', (name, viewer) => {
    const json = JSON.stringify(projectView(state, data, viewer));
    const leaked = [...new Set([...json.matchAll(/SECRET::[\w.]+/g)].map((m) => m[0]))];
    expect(leaked.sort()).toEqual([...OWN[name]].sort());
  });

  it('gives the facilitator everything, deliberately', () => {
    // They wrote the briefs and hold the only copy of the game. Hiding
    // anything from them would only make adjudication harder.
    const json = JSON.stringify(projectView(state, data, { kind: 'facilitator' }));
    for (const secret of ['SECRET::clash.c1.tactic.guthrum', 'SECRET::facilitatorNotes.plan',
      'SECRET::initiative.white.target', 'SECRET::log.entry']) {
      expect(json).toContain(secret);
    }
  });
});

describe('the specific things the game keeps quiet', () => {
  const state = loadedState();
  const view = (v) => projectView(state, data, VIEWERS[v]);

  it('keeps a resource total to its owner', () => {
    expect(view('alfred').roles.king_alfred.silver).toBe(4242);
    expect(view('cenred').roles.king_alfred.silver).toBeUndefined();
    // Position stays public even while strength does not.
    expect(view('cenred').roles.king_alfred.liegeId).toBeDefined();
  });

  it('keeps a tactic card secret until both are in', () => {
    expect(view('guthrum').battle.clashes.c1.tactic.guthrum_the_old)
      .toBe('SECRET::clash.c1.tactic.guthrum');
    expect(view('cenred').battle.clashes.c1.tactic?.guthrum_the_old).toBeUndefined();
    // But both sides can see that they are waiting on someone.
    expect(view('cenred').clashProgress.c1.tacticSubmitted).toEqual({
      guthrum_the_old: true, cenred: true,
    });
    expect(view('cenred').clashProgress.c1.tacticsRevealed).toBe(false);
  });

  it('releases both cards the moment the machine reveals them', () => {
    const revealed = loadedState();
    revealed.battle.clashes.c1.stage = 'tactics_revealed';
    const seen = projectView(revealed, data, VIEWERS.cenred);
    expect(seen.battle.clashes.c1.tactic.guthrum_the_old).toBe('SECRET::clash.c1.tactic.guthrum');
    expect(seen.clashProgress.c1.tacticsRevealed).toBe(true);
  });

  it('scopes an initiative target to the declaring team until it is announced', () => {
    // Guthrum's own team may see it; Wessex may not, which is the digital
    // stand-in for the teams sitting at separate tables.
    expect(view('guthrum').initiative.declared.white.shireId)
      .toBe('SECRET::initiative.white.target');
    expect(view('cenred').initiative.declared.white).toBeUndefined();
    // Alfred's is already announced, so it is everybody's business.
    expect(view('guthrum').initiative.declared.black.shireId).toBe('lindsey');
  });

  it('never sends a seat token to a player, in a value or in a key', () => {
    // A projection can redact a value but not a key, so seats are keyed by a
    // public seat id and the token lives inside the record. Getting this
    // wrong once is what put the check here.
    expect(ruleFor(['seats', 's1', 'token']).audience).toBe(NOBODY);
    expect(ruleFor(['seatByToken', 'anything']).audience).toBe(NOBODY);
    for (const [name, viewer] of Object.entries(VIEWERS)) {
      const json = JSON.stringify(projectView(state, data, viewer));
      expect(json, name).not.toContain('SECRET::token.');
    }
  });

  it('shows a spectator the board and nothing private', () => {
    const seen = view('spectator');
    expect(seen.shires.wiltshire).toBeDefined();
    expect(seen.derived.aftermath.disorder.value).toBe(3);
    expect(seen.roles.king_alfred.silver).toBeUndefined();
    expect(seen.battle.clashes.c1.tactic).toBeUndefined();
  });
});

describe('audit', () => {
  it('reports the paths a viewer was given', () => {
    const paths = auditProjection(loadedState(), data, VIEWERS.alfred);
    expect(paths).toContain('roles.king_alfred.silver');
    expect(paths).not.toContain('roles.guthrum_the_old.silver');
    expect(paths).not.toContain('seed');
  });
});
