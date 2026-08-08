/**
 * gui/rules/commands/battle.js — naming a target, and everything that follows
 * from having named one.
 *
 * A battle in this game starts a phase before anybody fights: an initiative
 * token declares a shire in the Team Phase, the facilitator announces the
 * declarations, and only then do sides form, pair off and roll. That whole arc
 * is one fragment because the later verbs keep reading the earlier ones —
 * `name-new-steward` asks which token declared the attack, `announce-targets`
 * refuses when two tokens named one shire, and `set-initiative-target` may
 * only correct a declaration up until the moment it stops being a plan and
 * becomes a fight.
 *
 * Splitting the facilitator's battle verbs out into the overrides fragment
 * would have put that timing rule in one file and the thing it is timed
 * against in another. The clash machinery itself stays in `../clash.js` and
 * `../battle.js`; this is only the commands that drive it.
 */

import { TOKENS, outranks, tokenHeldBy } from '../state.js';
import { reachableFrom } from '../derive.js';
import {
  advanceClash, amendLead, confirmLead, sidesOf, stageAtLeast, MAX_REINFORCEMENT,
} from '../clash.js';
import {
  pairSides, settleClash, settleIfReady, seizeInitiative, tally, conqueringDeclaration,
} from '../battle.js';
import { affordable, no, ok, pretty, shireName, subjectOf } from './shared.js';

/** Which side of a battle this role joined, or null. */
const sideOf = (state, shireId, roleId) => ['attackers', 'defenders'].find(
  (side) => state.battle.sides[shireId]?.[side]?.includes(roleId)) ?? null;

/**
 * Two tokens that have named one shire, if any: the one that keeps it and the
 * one that has to choose again.
 *
 * White beats black beats the spare, so the answer never depends on who
 * clicked first. Only tokens somebody actually holds count — a declaration
 * left behind by a token taken off its holder is an orphan the grid already
 * labels, and blocking on it would point the facilitator at a control that
 * refuses ("nobody holds that token").
 *
 * @returns {{keeps: string, rechooses: string, shireId: string}|null}
 */
function clashingClaims(state) {
  const declared = state.initiative?.declared ?? {};
  const live = TOKENS.filter((token) => declared[token] && state.initiative[token]);
  for (const [i, token] of live.entries()) {
    for (const other of live.slice(i + 1)) {
      if (declared[token].shireId !== declared[other].shireId) continue;
      const [keeps, rechooses] = outranks(token, other) ? [token, other] : [other, token];
      return { keeps, rechooses, shireId: declared[token].shireId };
    }
  }
  return null;
}

export const BATTLE_COMMANDS = {
  'declare-initiative-target': {
    phases: ['team'],
    actor: 'player',
    // The map's Target button is how a token holder declares now, so nothing
    // renders these — rb-action-list filters the verb out. They stay as the
    // answer to `shireTargetsFor`, which is what would highlight the legal
    // shires if the verb ever came back to the list, and they are the derived
    // probe's answer to "is there any declaration available at all?".
    //
    // Reach-filtered for the same reason raid-settlement is: a player should
    // not be invited to attack the other side of England, and a probe that
    // asked after an unreachable shire would grey the Target button out for
    // everybody — the first shire on the map is almost never one the token
    // holder can attack.
    fields: (state, data, roleId) => [{
      name: 'shireId',
      label: 'Attack',
      kind: 'select',
      options: reachableFrom(state, data, roleId)
        .map((id) => ({ value: id, label: shireName(data, id) })),
    }],
    admit(ctx) {
      const { state, data, cmd } = ctx;
      const roleId = subjectOf(ctx);
      const token = tokenHeldBy(state.initiative, roleId);
      if (!token) return no('you do not hold an initiative token');
      // And only one of them. `effects` writes the declaration under whichever
      // token comes first, so a holder of two would name one shire and have
      // the other token's declaration quietly never made. Nothing a player can
      // do reaches this state — a raw `facilitator:set` can — but
      // facilitator:set-initiative-target already refuses it with "clear one
      // first", and two commands reading the same board have to agree about it.
      const also = TOKENS.find((other) => other !== token && state.initiative[other] === roleId);
      if (also) {
        return no(`you hold the ${token} and ${also} tokens — the facilitator must clear one first`);
      }
      // Turn one is written down for you. From turn two it is your problem,
      // which is exactly the moment the game hands the plan over.
      // `declared` itself, not just an entry in it, can be missing here: a
      // player's own redacted view prunes an object down to nothing once it
      // holds no key that player may see, rather than leaving an empty one.
      if (state.initiative.declared?.[token]?.fixed) {
        return no('this turn\'s target is fixed by the rules');
      }
      if (!state.shires[cmd.payload?.shireId]) return no('no such shire');
      // The same gate join-battle puts on an attacker, and for the same
      // reason: a token names where your army goes, and an army goes where it
      // can march, sail or be welcomed. Declaring further than that would let
      // the battle phase stand up a fight nobody could have reached.
      if (!reachableFrom(state, data, roleId).includes(cmd.payload.shireId)) {
        return no('you cannot reach that shire');
      }
      // Deliberately NOT refused for naming a shire another token has already
      // named. Two tokens may not end up attacking one shire — white beats
      // black beats the spare, and the loser chooses again — but that
      // collision is settled at `facilitator:announce-targets`, where every
      // declaration is public anyway. Refusing here would answer "has anyone
      // secretly named this shire?" for any player willing to try each shire
      // in their reach, a whole phase before that is anybody's business, and
      // at no cost, since a declaration is freely rewritable. An un-announced
      // target is the one secret team scoping exists to keep.
      return ok();
    },
    effects(draft, ctx) {
      const roleId = subjectOf(ctx);
      const token = tokenHeldBy(draft.initiative, roleId);
      draft.initiative.declared[token] = {
        roleId, shireId: ctx.cmd.payload.shireId, revealed: false,
      };
    },
  },

  /** Throw in with an attack, or stand against one. */
  'join-battle': {
    phases: ['battle'],
    actor: 'player',
    probe: (state) => ({ shireId: state.battle.targets[0], side: 'attackers' }),
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const { shireId, side } = ctx.cmd.payload ?? {};
      if (!ctx.state.battle.targets.includes(shireId)) return no('no battle is being fought there');
      if (side !== 'attackers' && side !== 'defenders') return no('attack or defend?');
      if (ctx.state.battle.pairingComplete) return no('the fighters are already paired');
      if (side === 'attackers' && !reachableFrom(ctx.state, ctx.data, roleId).includes(shireId)) {
        return no('you cannot reach that shire');
      }
      return ok();
    },
    effects(draft, ctx) {
      const roleId = subjectOf(ctx);
      const { shireId, side } = ctx.cmd.payload;
      const sides = draft.battle.sides[shireId] ??= { attackers: [], defenders: [] };
      // Joining one side leaves the other, so nobody fights themselves.
      sides.attackers = sides.attackers.filter((id) => id !== roleId);
      sides.defenders = sides.defenders.filter((id) => id !== roleId);
      sides[side].push(roleId);
    },
  },

  /**
   * Hand in the mercenary card.
   *
   * "Your side counts as achieving victory in one additional clash during the
   * battle." Once per game, after the sides are set but before the pairing —
   * so it is spent knowing who joined and not knowing who you will face.
   * Either side of that line and the decision stops being interesting.
   */
  'use-mercenary': {
    phases: ['battle'],
    actor: 'player',
    label: 'Call in the mercenaries',
    note: 'Once a game. Your side wins one more clash.',
    fields: (state, data) => [{
      name: 'shireId',
      label: 'Which battle',
      kind: 'select',
      options: (state.battle?.targets ?? [])
        .map((id) => ({ value: id, label: shireName(data, id) })),
    }],
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const role = ctx.state.roles[roleId];
      if (!role?.mercenary) return no('you have no mercenaries to call on');
      const { shireId } = ctx.cmd.payload ?? {};
      if (!ctx.state.battle.targets.includes(shireId)) return no('no battle is being fought there');
      if (ctx.state.battle.pairingComplete) return no('the fighters are already paired');
      if (!sideOf(ctx.state, shireId, roleId)) return no('you are not in that battle');
      return ok();
    },
    effects(draft, ctx) {
      const roleId = subjectOf(ctx);
      const { shireId } = ctx.cmd.payload;
      const side = sideOf(draft, shireId, roleId);
      const hired = draft.battle.mercenaries[shireId] ?? { attackers: 0, defenders: 0 };
      hired[side] += 1;
      draft.battle.mercenaries[shireId] = hired;
      draft.roles[roleId].once.mercenary = true;
      // Spent. The card is handed over, not merely ticked off.
      draft.roles[roleId].mercenary = false;
    },
  },

  /**
   * Choose a card, in secret.
   *
   * Freely changeable until the other side has chosen too — the commitment is
   * the reveal, not the click.
   */
  'submit-tactic': {
    phases: ['battle'],
    actor: 'player',
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const clash = ctx.state.battle.clashes[ctx.cmd.payload?.clashId];
      if (!clash) return no('no such clash');
      if (!sidesOf(clash).includes(roleId)) return no('you are not fighting in that clash');
      if (clash.stage !== 'awaiting_tactics') return no('the cards are already down');

      const card = ctx.cmd.payload?.card;
      const printed = ctx.data.tactics.tactics[card];
      if (!printed) return no('no such card');
      // A card commits soldiers you must actually have.
      if (printed.score > ctx.state.roles[roleId].soldiers) {
        return no(`you have only ${ctx.state.roles[roleId].soldiers} soldiers `
          + `and that card commits ${printed.score}`);
      }
      return ok();
    },
    effects(draft, ctx) {
      const clash = draft.battle.clashes[ctx.cmd.payload.clashId];
      clash.tactic[subjectOf(ctx)] = ctx.cmd.payload.card;
      advanceClash(clash);
    },
  },

  /**
   * Say whether you are in the front rank, and change your mind once.
   *
   * Before the reveal this is a plain declaration. After it, the ratchet: you
   * may join a charge you did not expect, but you cannot step back out of one.
   */
  'declare-lead': {
    phases: ['battle'],
    actor: 'player',
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const clash = ctx.state.battle.clashes[ctx.cmd.payload?.clashId];
      if (!clash) return no('no such clash');
      if (!sidesOf(clash).includes(roleId)) return no('you are not fighting in that clash');
      if (typeof ctx.cmd.payload?.lead !== 'boolean') return no('lead the charge, or do not');

      if (clash.stage === 'awaiting_lead') return ok();
      if (clash.stage === 'lead_revealed') {
        if (!ctx.cmd.payload.lead) {
          return no('you can join the charge, but you cannot leave it');
        }
        if (clash.lead[roleId]) return no('you are already leading');
        return ok();
      }
      return no('too late to change your mind');
    },
    effects(draft, ctx) {
      const clash = draft.battle.clashes[ctx.cmd.payload.clashId];
      const roleId = subjectOf(ctx);
      if (clash.stage === 'awaiting_lead') clash.lead[roleId] = ctx.cmd.payload.lead;
      else amendLead(clash, roleId, ctx.cmd.payload.lead);
      advanceClash(clash);
    },
  },

  /** Stand pat once both declarations are up. */
  'confirm-lead': {
    phases: ['battle'],
    actor: 'player',
    admit(ctx) {
      const clash = ctx.state.battle.clashes[ctx.cmd.payload?.clashId];
      if (!clash) return no('no such clash');
      if (!sidesOf(clash).includes(subjectOf(ctx))) return no('you are not fighting in that clash');
      if (clash.stage !== 'lead_revealed') return no('there is nothing to confirm');
      return ok();
    },
    effects(draft, ctx) {
      const clash = draft.battle.clashes[ctx.cmd.payload.clashId];
      confirmLead(clash, subjectOf(ctx));
      advanceClash(clash);
    },
  },

  /**
   * Throw your own die.
   *
   * One die per fighter, thrown by the fighter, because that is what the two of
   * them would do across a table — and because a facilitator rolling for
   * sixteen people in turn is the phase's slowest minute.
   *
   * The die is drawn through the injected `roll`, so it advances the cursor in
   * state like every other random number in the game. Two fighters racing to
   * roll cannot diverge on replay: the log records the order the host actually
   * applied them in, and a replay re-applies that order.
   *
   * Once yours is thrown you cannot throw it again — there is no re-roll in the
   * printed rules, and a die you could re-throw until you liked it would not be
   * a die. The second one down settles the clash on the spot.
   */
  'submit-roll': {
    phases: ['battle'],
    actor: 'player',
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const clash = ctx.state.battle.clashes[ctx.cmd.payload?.clashId];
      if (!clash) return no('no such clash');
      if (!sidesOf(clash).includes(roleId)) return no('you are not fighting in that clash');
      if (clash.stage !== 'rolling') {
        return no(stageAtLeast(clash.stage, 'rolling')
          ? 'the dice are already read' : 'there is still something to decide');
      }
      if (clash.rolls[roleId] !== null && clash.rolls[roleId] !== undefined) {
        return no('you have already rolled');
      }
      return ok();
    },
    effects(draft, ctx, { data, roll }) {
      const clash = draft.battle.clashes[ctx.cmd.payload.clashId];
      clash.rolls[subjectOf(ctx)] = roll(6);
      // The machine decides whether that was the second die; the settlement
      // follows from it rather than from this command knowing it was last.
      if (advanceClash(clash) === 'rolls_revealed') {
        settleClash(draft, data, clash);
        // And that may have been the last clash of the battle. Nobody has to
        // press anything for a battle that is simply over — unless the shire
        // falls and its conqueror has not yet said who takes it, which
        // `settleIfReady` holds for.
        settleIfReady(draft, data, clash.shireId);
      }
    },
  },

  /**
   * Name who takes a shire you have just taken.
   *
   * The spoils belong to whoever spent the token, not to the umpire. In the
   * room the holder says "give it to Ubba" and the facilitator writes it down;
   * the console used to skip the saying and let the facilitator pick from a
   * dropdown of attackers, which quietly moved the most political decision in
   * the battle phase off the table it belongs on. So this is the holder's own
   * command, and `settleBattle` reads it before it reaches for any default.
   *
   * Only the declaring holder — `conqueringDeclaration` decides which one when
   * two tokens named the same shire, and says there why. Not the whole team:
   * an initiative token sits in front of one person, and a faction that wants
   * a say has the same lever it has for everything else, which is talking to
   * them.
   *
   * Only after the shire has actually fallen, because until the last clash is
   * read there is nothing to give away — a pick taken earlier would be a
   * promise about a battle, and the battle phase already has enough of those.
   * Changeable until the facilitator settles, the same bargain a tactic card
   * gets: the commitment is the settling, not the click.
   *
   * Only an attacker, because a shire goes to somebody who was there for it.
   * That is also what the old dropdown offered, so the rule is not new — it
   * has simply moved from being a thing the console happened to render into
   * being a thing the reducer enforces.
   */
  'name-new-steward': {
    phases: ['battle'],
    actor: 'player',
    // "Is there any shire I could be naming a steward for?" — so it probes the
    // first one that has actually fallen rather than the first one on the
    // board, which is usually still being fought over and would answer "the
    // fighting is not over" for a battle two shires along that is finished.
    probe: (state) => {
      const shireId = (state.battle.targets ?? []).find((id) => tally(state, id).shireFalls)
        ?? state.battle.targets?.[0];
      return { shireId, stewardRoleId: state.battle.sides?.[shireId]?.attackers?.[0] };
    },
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const { shireId, stewardRoleId } = ctx.cmd.payload ?? {};
      if (!ctx.state.battle.targets.includes(shireId)) return no('no battle was fought there');

      // A battle settles itself the moment nothing is owed, and this pick is
      // usually the last thing owed — so naming a steward is final, and the
      // console asks before sending it.
      if (ctx.state.battle.settled?.[shireId]) return no('that battle is already settled');

      const declaration = conqueringDeclaration(ctx.state, shireId);
      if (!declaration) return no('nobody declared an attack there');
      if (declaration.roleId !== roleId) {
        return no('only the holder whose token declared that attack names its steward');
      }

      const result = tally(ctx.state, shireId);
      if (!result.resolved) return no('the fighting is not over');
      if (!result.shireFalls) return no('the shire held');

      if (!ctx.state.roles[stewardRoleId]) return no('no such role in this game');
      if (ctx.state.roles[stewardRoleId].dead) return no('that character is dead');
      if (!(ctx.state.battle.sides[shireId]?.attackers ?? []).includes(stewardRoleId)) {
        return no('name somebody who attacked it');
      }
      return ok();
    },
    effects(draft, ctx) {
      // `stewardPicks` can be missing rather than empty on a state loaded from
      // a save written before this command existed, and `end-battles` writes a
      // fresh battle object that has it — so this is about old files, not
      // about the reducer's own output.
      draft.battle.stewardPicks ??= {};
      draft.battle.stewardPicks[ctx.cmd.payload.shireId] = ctx.cmd.payload.stewardRoleId;
      // The other order: the fighting finished first and the battle has been
      // waiting on this. Either arrival can be the last thing owed, so both
      // ask rather than either assuming.
      settleIfReady(draft, ctx.data, ctx.cmd.payload.shireId);
    },
  },

  /**
   * Announce the targets, so everyone can pick a side.
   *
   * Separate from declaring one, because a declaration is team business until
   * the phase opens and a target is everybody's.
   */
  'facilitator:announce-targets': {
    phases: ['battle'],
    actor: 'facilitator',
    admit(ctx) {
      // Where a collision between two tokens gets settled. Not earlier: until
      // this moment a declaration is its team's own business, and a rule that
      // refused a player for colliding would tell them what another team had
      // secretly chosen. Here every declaration is about to be public anyway,
      // and the facilitator — who can already see all three — is the one who
      // can go and ask the loser to name somewhere else.
      const clash = clashingClaims(ctx.state);
      if (clash) {
        return no(`the ${clash.keeps} and ${clash.rechooses} tokens have both named `
          + `${pretty(clash.shireId)}. The ${clash.keeps} token takes it — ask the `
          + `${clash.rechooses} holder to name somewhere else, then announce again.`);
      }
      return ok();
    },
    effects(draft) {
      for (const declaration of Object.values(draft.initiative.declared)) {
        declaration.revealed = true;
        if (!draft.battle.targets.includes(declaration.shireId)) {
          draft.battle.targets.push(declaration.shireId);
        }
      }
    },
  },

  /**
   * Put the fighters in pairs.
   *
   * The facilitator does this by hand in the room, honouring rivalries people
   * have announced, so an explicit pairing is accepted and a sensible default
   * offered when none is given.
   */
  'facilitator:pair-clashes': {
    phases: ['battle'],
    actor: 'facilitator',
    admit(ctx) {
      const shireId = ctx.cmd.payload?.shireId;
      if (!ctx.state.battle.targets.includes(shireId)) return no('nobody is attacking there');
      const sides = ctx.state.battle.sides[shireId];
      if (!sides?.attackers.length) return no('nobody has joined the attack');
      return ok();
    },
    effects(draft, ctx) {
      const { shireId, pairs } = ctx.cmd.payload;
      const sides = draft.battle.sides[shireId];
      const { clashes, spareDefenders } = pairSides({
        attackers: sides.attackers, defenders: sides.defenders, shireId, pairs,
      });
      for (const clash of clashes) draft.battle.clashes[clash.id] = clash;
      draft.battle.spare ??= {};
      draft.battle.spare[shireId] = spareDefenders;
      draft.battle.pairingComplete = true;
      // Attackers who walked in unopposed are seeded already resolved, so a
      // battle nobody turned up to defend is over the moment it is paired.
      settleIfReady(draft, ctx.data, shireId);
    },
  },

  /**
   * An extra defender throws soldiers into someone else's clash.
   *
   * Worth a point of battle score each, and it costs them the chance to scout
   * — the printed rules make it one or the other.
   */
  reinforce_clash: {
    phases: ['battle'],
    actor: 'player',
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const clash = ctx.state.battle.clashes[ctx.cmd.payload?.clashId];
      if (!clash) return no('no such clash');
      if (sidesOf(clash).includes(roleId)) return no('you are busy fighting your own clash');
      if (!(ctx.state.battle.spare?.[clash.shireId] ?? []).includes(roleId)) {
        return no('only a defender without a clash of their own may reinforce');
      }
      if (clash.stage !== 'awaiting_tactics') return no('the cards are already down');
      if ((ctx.state.battle.scouts?.[clash.shireId] ?? []).includes(roleId)) {
        return no('you are already scouting');
      }
      const soldiers = Number(ctx.cmd.payload?.soldiers);
      if (!Number.isInteger(soldiers) || soldiers < 1 || soldiers > MAX_REINFORCEMENT) {
        return no(`commit one or ${MAX_REINFORCEMENT} soldiers`);
      }
      const reason = affordable(ctx.state.roles[roleId], { soldiers });
      return reason ? no(reason) : ok();
    },
    effects(draft, ctx) {
      const clash = draft.battle.clashes[ctx.cmd.payload.clashId];
      clash.reinforcements[subjectOf(ctx)] = Number(ctx.cmd.payload.soldiers);
    },
  },

  /** Be useful without being in the line: a scout counts toward the token. */
  scout: {
    phases: ['battle'],
    actor: 'player',
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const shireId = ctx.cmd.payload?.shireId;
      if (!(ctx.state.battle.spare?.[shireId] ?? []).includes(roleId)) {
        return no('only a defender without a clash of their own may scout');
      }
      const reinforcing = Object.values(ctx.state.battle.clashes)
        .some((c) => c.shireId === shireId && c.reinforcements[roleId]);
      if (reinforcing) return no('you have already committed soldiers to a clash');
      if ((ctx.state.battle.scouts?.[shireId] ?? []).includes(roleId)) {
        return no('you are already scouting');
      }
      return ok();
    },
    effects(draft, ctx) {
      const { shireId } = ctx.cmd.payload;
      draft.battle.scouts ??= {};
      (draft.battle.scouts[shireId] ??= []).push(subjectOf(ctx));
    },
  },

  /**
   * Force a stalled clash through to a result.
   *
   * The fighters roll their own dice now, so this is no longer how a clash
   * normally ends — it is the override for when one of them has gone to make
   * tea and the phase cannot wait. It works from wherever the clash has got to:
   * a card nobody chose, a declaration nobody made, one die down or none.
   *
   * Whatever a player did commit stands. A die already thrown is never thrown
   * again here, because re-rolling somebody's five into a two under the guise
   * of unsticking a clash is the one thing an umpire must not be able to do by
   * accident — and it is logged as an override either way, so the room can see
   * afterwards which clashes were finished for their fighters rather than by
   * them.
   */
  'facilitator:resolve-clash': {
    phases: ['battle'],
    actor: 'facilitator',
    admit(ctx) {
      const clash = ctx.state.battle.clashes[ctx.cmd.payload?.clashId];
      if (!clash) return no('no such clash');
      if (clash.stage === 'resolved') return no('that clash is already settled');
      return ok();
    },
    effects(draft, ctx, { data, roll }) {
      const clash = draft.battle.clashes[ctx.cmd.payload.clashId];

      // A fighter who never chose gets the least they could have committed,
      // rather than the clash stalling on somebody who has gone to make tea.
      for (const roleId of sidesOf(clash)) {
        clash.tactic[roleId] ??= 'A';
        clash.lead[roleId] ??= false;
      }
      clash.stage = 'rolling';
      // Only the dice that are actually missing.
      for (const roleId of sidesOf(clash)) clash.rolls[roleId] ??= roll(6);

      advanceClash(clash);
      settleClash(draft, data, clash);
      // Forcing the last clash through finishes the battle just as a player's
      // own die would, so it settles the same way. Without this, a shire that
      // HELD after a forced clash had no player command left to fire and the
      // token a twice-winning defender is owed would never move.
      settleIfReady(draft, data, clash.shireId);
    },
  },

  /**
   * Count the clashes and move the board.
   *
   * `newSteward` survives in the payload but is no longer a choice: it sits
   * below the conqueror's own `name-new-steward` pick in `settleBattle`, and
   * the grid stopped sending it when the holder gained the decision. What it
   * is for is the shire whose token holder has walked out of the room — the
   * facilitator can still name a taker rather than being stuck with "whoever
   * was paired first", and the log records that they did.
   */
  'facilitator:settle-battle': {
    phases: ['battle'],
    actor: 'facilitator',
    admit(ctx) {
      const shireId = ctx.cmd.payload?.shireId;
      if (!ctx.state.battle.targets.includes(shireId)) return no('no battle was fought there');
      // Settling moves a steward and takes a castle down, so twice is not the
      // same as once. A battle now settles itself the moment nothing is owed,
      // which makes "already done" the ordinary state of this button rather
      // than a mistake nobody would make.
      if (ctx.state.battle.settled?.[shireId]) return no('that battle is already settled');
      return ok();
    },
    effects(draft, ctx) {
      // Forced: this is the override for a table that has stalled — a
      // conqueror who has walked away without naming anyone, most likely — so
      // it settles past the hold that stops the automatic path.
      settleIfReady(draft, ctx.data, ctx.cmd.payload.shireId, {
        force: true, newSteward: ctx.cmd.payload.newSteward ?? null,
      });
    },
  },

  /** Clear the board and hand out the temporary token. */
  'facilitator:end-battles': {
    phases: ['battle'],
    actor: 'facilitator',
    admit: ok,
    effects(draft) {
      seizeInitiative(draft);
      draft.battle = { targets: [], sides: {}, clashes: {}, spare: {}, scouts: {},
        mercenaries: {}, stewardPicks: {}, settled: {}, pairingComplete: false };
    },
  },

  /**
   * Move an initiative token onto a role, or off it.
   *
   * White, black and bonus are three separate fields but not three
   * independent ones: a role may be the value of at most one of them, because
   * on the table they are three counters and nobody is handed two. So
   * assigning one does have to go looking for who else the named role might
   * already be holding, and refuse rather than quietly leave them with a
   * second. Taking a token off (`roleId: null`) is always allowed — that is
   * the way out of a double-hold, not into one.
   */
  'facilitator:assign-initiative': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      const { token, roleId } = ctx.cmd.payload ?? {};
      if (!TOKENS.includes(token)) return no('no such token');
      if (roleId === null) return ok();
      if (!ctx.state.roles[roleId]) return no('no such character');
      const held = tokenHeldBy(ctx.state.initiative, roleId);
      // Re-affirming the token they already hold is a no-op, not a second one.
      if (held && held !== token) {
        return no(`${pretty(roleId)} already holds the ${held} token`);
      }
      return ok();
    },
    effects(draft, ctx) {
      draft.initiative[ctx.cmd.payload.token] = ctx.cmd.payload.roleId ?? null;
    },
  },

  /**
   * Correct a declared target, up until the moment it stops being one thing
   * and becomes a battle.
   *
   * Once facilitator:announce-targets has run, the shires it named are
   * public and the battle machinery is already standing on them — reaching
   * back to move a target after that would be moving a fight, not fixing a
   * plan. Before that moment, this overrides even a turn-one fixed target,
   * same as any other facilitator edit.
   *
   * Deliberately no reachability gate: a facilitator moving a target is
   * usually recording something that happened in the room, and the room beats
   * the model. The one-token check below is not that — it is a consistency
   * guard, because this command writes the token's holder into the
   * declaration and a holder of two tokens would be written into two.
   */
  'facilitator:set-initiative-target': {
    phases: ['team', 'battle'],
    actor: 'facilitator',
    admit(ctx) {
      const { token, shireId } = ctx.cmd.payload ?? {};
      if (!TOKENS.includes(token)) return no('no such token');
      const holder = ctx.state.initiative[token];
      if (!holder) return no('nobody holds that token');
      // This command never moves a token onto anybody, so it cannot itself
      // create a double-hold — it can only inherit one, from a raw
      // facilitator:set or a save written before one-token-per-role was a
      // rule. That is exactly when a facilitator wants telling, rather than
      // being handed two declarations under one name.
      const also = TOKENS.find((other) => other !== token
        && ctx.state.initiative[other] === holder);
      if (also) return no(`${pretty(holder)} also holds the ${also} token — clear one first`);
      if (ctx.state.battle.targets.length) return no('the targets are already announced');
      if (!ctx.state.shires[shireId]) return no('no such shire');
      // A collision with another token is not refused here either. The
      // facilitator can see every declaration, so nothing leaks by letting
      // them make one — and announce is where it gets settled, with a message
      // aimed at the person who has to act on it.
      return ok();
    },
    effects(draft, ctx) {
      const { token, shireId } = ctx.cmd.payload;
      const roleId = draft.initiative[token];
      draft.initiative.declared[token] = {
        roleId, shireId, revealed: draft.initiative.declared[token]?.revealed ?? false,
      };
    },
  },
};
