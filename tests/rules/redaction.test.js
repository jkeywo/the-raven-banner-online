import { describe, it, expect } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { projectView, unclassifiedPaths, auditProjection } from '../../gui/rules/views.js';
import {
  ruleFor, NOBODY, TACTICS_REVEALED, LEAD_REVEALED, ROLLS_REVEALED,
} from '../../gui/rules/visibility.js';
import { STAGES } from '../../gui/rules/clash.js';

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
      reinforcements: {},
      rolls: { guthrum_the_old: null, cenred: null },
      result: null, amendWindowEndsAt: null,
    },
    // A second clash, further on: the cards and declarations are up and Guthrum
    // has thrown his die while Cenred has not thrown his. The first die down is
    // the one that would tell the other fighter what they had to beat.
    c2: {
      id: 'c2', shireId: 'essex', stage: 'rolling', auto: false,
      attacker: 'guthrum_the_old', defender: 'cenred',
      tactic: { guthrum_the_old: '4', cenred: '3' },
      lead: { guthrum_the_old: false, cenred: false },
      reinforcements: {},
      rolls: { guthrum_the_old: 'SECRET::clash.c2.roll.guthrum', cenred: null },
      result: null, amendWindowEndsAt: null,
    },
  };

  // Mercenary cards already handed in. Public, because spending the card is a
  // public act — and populated here at all because the completeness check only
  // sees a path once something is actually stored at it, so an empty
  // `mercenaries: {}` in a fresh game hid this one from the manifest for a
  // while.
  state.battle.mercenaries = { essex: { attackers: 1, defenders: 0 } };
  // Alfred's black token declared Lindsey, so the pick about Lindsey is his,
  // and Wessex's — the same scope the declaration that won it has.
  state.battle.stewardPicks = { lindsey: 'SECRET::battle.stewardPick.lindsey' };
  // Populated for the same reason `mercenaries` is: the completeness walk only
  // sees a path once something is stored at it, so an empty object would leave
  // the manifest entry unverified and a forgotten one indistinguishable from a
  // correct one.
  state.battle.settled = { lindsey: true };

  state.envoys = {
    e1: { roleId: 'king_alfred', npcFaction: 'franks', open: true,
      messages: ['SECRET::envoy.alfred.message'] },
  };
  state.facilitatorNotes = { plan: 'SECRET::facilitatorNotes.plan' };
  // The battle phase's own channel, which is a separate key so the epilogue
  // never prints it — and facilitator-only for the same reason the umpire's
  // own notes are.
  state.battleNotes = { 'initiative:t1:spare': 'SECRET::battleNotes.spare' };
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

  it('never re-hides a clash secret it has already shown', () => {
    // Each reveal list has to be a suffix of the stage order: once a card is
    // face up it stays face up. Three hand-written arrays were three chances
    // to add a stage to two of them and leave a hole in the third — which is
    // exactly what adding `rolls_revealed` did, briefly re-hiding both tactic
    // cards at the one stage where the dice were already public.
    for (const list of [TACTICS_REVEALED, LEAD_REVEALED, ROLLS_REVEALED]) {
      expect(list.length).toBeGreaterThan(0);
      expect(list).toEqual(STAGES.slice(STAGES.indexOf(list[0])));
    }
    // And they open in the order the clash actually plays.
    expect(TACTICS_REVEALED.length).toBeGreaterThan(LEAD_REVEALED.length);
    expect(LEAD_REVEALED.length).toBeGreaterThan(ROLLS_REVEALED.length);
  });
});

describe('no sentinel reaches a seat the manifest does not grant it', () => {
  const state = loadedState();

  /** Exactly what each seat is entitled to. Everything else is a leak. */
  const OWN = {
    // His envoy thread with the Franks, and the steward he named for the
    // shire his own token took.
    alfred: ['SECRET::envoy.alfred.message', 'SECRET::battle.stewardPick.lindsey'],
    // His own tactic card, his own die, and his team's target before it is
    // announced.
    guthrum: ['SECRET::clash.c1.tactic.guthrum', 'SECRET::clash.c2.roll.guthrum',
      'SECRET::initiative.white.target'],
    // Alfred's team-mate, so Alfred's steward pick and nothing else.
    cenred: ['SECRET::battle.stewardPick.lindsey'],
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
      'SECRET::battleNotes.spare', 'SECRET::initiative.white.target',
      'SECRET::battle.stewardPick.lindsey', 'SECRET::log.entry']) {
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

  it('keeps a die secret until both are down', () => {
    // The same bargain as a card. Guthrum has thrown and Cenred has not, so
    // the number Cenred would have to beat is exactly what he may not see.
    expect(view('guthrum').battle.clashes.c2.rolls.guthrum_the_old)
      .toBe('SECRET::clash.c2.roll.guthrum');
    expect(view('cenred').battle.clashes.c2.rolls?.guthrum_the_old).toBeUndefined();
    // But he can see that he is the one being waited on.
    expect(view('cenred').clashProgress.c2.rollSubmitted).toEqual({
      guthrum_the_old: true, cenred: false,
    });
    expect(view('cenred').clashProgress.c2.rollsRevealed).toBe(false);
  });

  it('releases both dice the moment the machine reveals them', () => {
    const revealed = loadedState();
    revealed.battle.clashes.c2.rolls.cenred = 4;
    revealed.battle.clashes.c2.stage = 'resolved';
    const seen = projectView(revealed, data, VIEWERS.cenred);
    expect(seen.battle.clashes.c2.rolls.guthrum_the_old).toBe('SECRET::clash.c2.roll.guthrum');
    expect(seen.clashProgress.c2.rollsRevealed).toBe(true);
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

  it('scopes a conqueror\'s steward pick the way the declaration that won it is scoped', () => {
    // The same person, at the same table, about the same shire. Alfred's black
    // token declared Lindsey, so the pick is his and his team's; Guthrum, who
    // declared somewhere else entirely, has no business in it.
    expect(view('alfred').battle.stewardPicks.lindsey)
      .toBe('SECRET::battle.stewardPick.lindsey');
    expect(view('cenred').battle.stewardPicks.lindsey)
      .toBe('SECRET::battle.stewardPick.lindsey');
    expect(view('guthrum').battle.stewardPicks).toBeUndefined();
  });

  it('gives nobody the pick once the declaration behind it is gone', () => {
    // Fails closed rather than open: with nothing naming Lindsey there is no
    // owner to compare a viewer against, so the pick reaches only the
    // facilitator — who can still see it and settle by hand.
    const orphaned = loadedState();
    orphaned.initiative.declared = {};
    for (const who of ['alfred', 'cenred', 'guthrum']) {
      expect(JSON.stringify(projectView(orphaned, data, VIEWERS[who])), who)
        .not.toContain('SECRET::battle.stewardPick.lindsey');
    }
  });

  it('shows a spent mercenary card to everybody, unlike an unspent one', () => {
    // `roles.*.mercenary` is the card in your hand; this is the counter on the
    // table once it has bought a clash nobody fought.
    expect(view('cenred').battle.mercenaries.essex).toEqual({ attackers: 1, defenders: 0 });
    expect(view('spectator').battle.mercenaries.essex.attackers).toBe(1);
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
