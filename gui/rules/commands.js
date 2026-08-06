/**
 * gui/rules/commands.js — every way the game can change, in one registry.
 *
 * A command declares which phases it belongs to, who may issue it, whether it
 * is legal right now (`admit`), and what it does (`effects`). Nothing mutates
 * state anywhere else.
 *
 * It also declares what it is called and what it still needs asking —
 * `label`, `note` and `fields`. A verb is one idea, and a console that had to
 * be told separately what to write on the button was a second, worse copy of
 * that idea. See the presentation block above `COMMANDS`.
 *
 * `admit` returns a reason, not a boolean, because the reason is the whole
 * value of enforcing rules for players: "you cannot afford that" against the
 * button they pressed beats a control that silently does nothing.
 *
 * Facilitator commands live in the same registry and travel the same pipeline.
 * Theirs simply always admit. That is deliberate — an override that bypassed
 * the reducer would be invisible to the log and would break replay, and replay
 * is what makes a crashed host recoverable.
 */

import { PHASES, TOKENS, outranks, tokenHeldBy, seatHolding } from './state.js';
import {
  incomeFor, isDanish, isPagan, isChristian, isDanishHeld, momentumGain,
  reachableFrom, factionReach, churchesHeld, electorate,
} from './derive.js';
import {
  advanceClash, amendLead, confirmLead, sidesOf, stageAtLeast, MAX_REINFORCEMENT,
} from './clash.js';
import {
  pairSides, settleClash, settleIfReady, seizeInitiative, tally, conqueringDeclaration,
} from './battle.js';

/**
 * Phases in which resources may change hands between players. Not during a
 * battle — and in the Team Phase, only within a team. See `dealingReason`.
 */
const TRADEABLE_PHASES = ['team', 'maintenance', 'encounter'];

/**
 * Phases in which the market will deal with you.
 *
 * The Team Phase is time given to a team to talk to itself. Nobody is walking
 * to the traders' table during it, so the bank is shut: silver becomes food in
 * the Maintenance Phase, or out among everybody else in the Encounter Phase.
 */
const MARKET_PHASES = ['maintenance', 'encounter'];

/** What can pass between players. Momentum and soldiers are yours alone. */
const TRADEABLE = ['silver', 'food', 'ships'];

/** The three shires with a yard. Named on every archetype's sheet. */
const SHIPYARDS = ['wiltshire', 'lundenwic', 'jorvik'];

const pretty = (id) => id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const holdsShipyard = (state, roleId) =>
  SHIPYARDS.some((id) => state.shires[id]?.stewardRoleId === roleId);

/**
 * Whether this role must feed its followers this maintenance phase.
 *
 * Pagan Danes only. Baptism ends it, which is a large part of why anyone
 * would consider being baptised.
 */
const owesUpkeep = (state, data, roleId) => isPagan(state, data, roleId);

/** Who this archetype may send envoys to, and what it costs them. */
const envoyRules = (data, roleId) =>
  data.factions.envoy?.[data.roles.roles[roleId]?.archetype] ?? null;

/** An open conversation between this role and this court, if there is one. */
const openThread = (state, roleId, npcFaction) =>
  Object.values(state.envoys).find(
    (thread) => thread.roleId === roleId && thread.npcFaction === npcFaction && thread.open,
  ) ?? null;

/**
 * Where a role may circle a settlement.
 *
 * A steward may do it in their own shires. A priest may also do it anywhere a
 * missionary cross stands, which is the reward for having sent one.
 */
function canReinforceIn(state, data, roleId, shire) {
  if (shire.stewardRoleId === roleId) return true;
  return data.roles.roles[roleId]?.archetype === 'saxon_priest' && shire.missionaryCross;
}

/**
 * Everybody who has to agree before a shire can be settled.
 *
 * The stewards of every adjacent shire, across map boundaries as well as
 * within one, minus the asker themselves — a Dane who already holds both sides
 * of a border does not need his own permission. A shire with no steward is
 * silent rather than obstructive.
 */
export function neighbourStewards(state, data, shireId, askerRoleId) {
  const stewards = new Set();
  for (const [a, b] of data.adjacency.edges) {
    const other = a === shireId ? b : b === shireId ? a : null;
    if (!other) continue;
    const steward = state.shires[other]?.stewardRoleId;
    if (steward && steward !== askerRoleId) stewards.add(steward);
  }
  return [...stewards].sort();
}

/**
 * Close a consent request once its answer is no longer in doubt.
 *
 * One refusal is enough to end it — the requirement is consent from *all* of
 * them — so a neighbour who says no does not have to wait for the rest.
 */
export function resolveConsent(draft, data, request) {
  const answers = Object.values(request.granted);
  const refused = answers.some((granted) => granted === false);
  const allAnswered = request.asked.every((who) => request.granted[who] !== undefined);
  if (!refused && !allAnswered) return;

  request.resolved = true;
  request.outcome = refused ? 'refused' : 'granted';
  if (refused) return;

  if (request.kind === 'allegiance') {
    swearTo(draft, request.roleId, request.liegeId);
    return;
  }
  if (request.kind !== 'settle') return;

  // Carried: now it costs something.
  const role = draft.roles[request.roleId];
  role.momentum -= 1;
  role.soldiers -= 3;
  role.silver -= 5;

  const shire = draft.shires[request.shireId];
  shire.danishSupport = true;
  // "add defenders to two settlements of your choice" — the app takes the two
  // that are not already defended, which is the only choice worth making.
  let toDefend = 2;
  for (const settlement of Object.values(shire.settlements)) {
    if (toDefend === 0) break;
    if (settlement.defended || settlement.destroyed) continue;
    settlement.defended = true;
    toDefend -= 1;
  }
}

/** Which side of a battle this role joined, or null. */
const sideOf = (state, shireId, roleId) => ['attackers', 'defenders'].find(
  (side) => state.battle.sides[shireId]?.[side]?.includes(roleId)) ?? null;

/** The crowns this role actually wears. */
const crownsHeldBy = (state, roleId) =>
  Object.keys(state.crownHolders).filter((crown) => state.crownHolders[crown] === roleId);

/**
 * Why this homage cannot be sworn, or null.
 *
 * The cycle check is the substantive one: two people each owing the other
 * would make the support rule walk forever, and the paper game has no notion
 * of it.
 */
function homageReason(state, roleId, to) {
  if (to !== null && to !== undefined && !state.roles[to]) return no('no such liege');
  if (to === roleId) return no('you cannot be your own liege');
  let at = to;
  const seen = new Set([roleId]);
  while (at) {
    if (seen.has(at)) return no('that would make the chain of homage a circle');
    seen.add(at);
    at = state.roles[at]?.liegeId ?? null;
  }
  return null;
}

/** Take a lord, and his faction with him. */
function swearTo(draft, roleId, liegeId) {
  const role = draft.roles[roleId];
  role.liegeId = liegeId ?? null;
  // A vassal's lands are controlled by their liege's faction, which is what
  // makes a faction's adjacency reach through the people who follow it.
  role.factionId = liegeId ? draft.roles[liegeId].factionId : roleId;
  for (const shire of Object.values(draft.shires)) {
    if (shire.stewardRoleId === roleId) shire.factionId = role.factionId;
  }
}

/**
 * The printed price of a rebellion, before an umpire has heard anything.
 *
 * Not applied automatically. It exists so the facilitator's pricing form has
 * something to start from — the rule that "this cost will be reduced,
 * potentially down to zero" is a judgement made about one rebellion at a
 * time, never a standing rate a vassal could bank on in advance.
 */
export const REBELLION_PRINTED_COST = { shires: 1, soldiers: 2 };

/** This role's open petition to rebel, in any of the given states. */
export function openRebellion(state, roleId, statuses = ['pending', 'priced']) {
  return Object.values(state.rebellions ?? {})
    .find((r) => r.roleId === roleId && statuses.includes(r.status)) ?? null;
}

/**
 * What breaking with your liege would cost, in words, or nothing yet.
 *
 * The one note that cannot be written in advance: what a rebellion costs is a
 * number the facilitator has only just set about this one rebellion, not a
 * fact about the verb. Nothing to say falls back to the verb's own silence
 * rather than to a sentence that would be wrong.
 */
function rebellionNote(state, roleId) {
  const mine = openRebellion(state, roleId);
  if (!mine) return undefined;
  if (mine.status === 'pending') return 'Waiting on the facilitator to set a price.';
  const { shires, soldiers } = mine.cost;
  return `Costs ${shires} shire${shires === 1 ? '' : 's'} and `
    + `${soldiers} soldier${soldiers === 1 ? '' : 's'}.`;
}

/**
 * Count an election, if it can be counted yet.
 *
 * Most votes wins and a tie fails, leaving the crown unworn to be contested
 * again. An app breaking a tie would be an app deciding who rules England on a
 * rule nobody wrote down.
 */
export function resolveVote(draft, vote, force = false) {
  const everyone = Object.keys(vote.electorate);
  if (!force && !everyone.every((who) => vote.cast[who])) return;

  const tally = {};
  for (const [who, forRoleId] of Object.entries(vote.cast)) {
    tally[forRoleId] = (tally[forRoleId] ?? 0) + vote.electorate[who];
  }
  const best = Math.max(0, ...Object.values(tally));
  const leaders = Object.keys(tally).filter((who) => tally[who] === best);

  vote.resolved = true;
  vote.tally = tally;
  if (best === 0 || leaders.length !== 1) {
    vote.outcome = 'failed';
    return;
  }
  vote.outcome = 'crowned';
  vote.winner = leaders[0];
  draft.crownHolders[vote.crown] = leaders[0];
}

/** The three shires with a contract card, in the order they are printed. */
const contractShires = (data) => data.meta.tradeContractShires;

const findContract = (state, id) => state.contracts.find((c) => c.id === id) ?? null;

/** The live or offered contract on a shire, if there is one. */
export function contractOn(state, shireId) {
  return state.contracts.find(
    (c) => c.shireId === shireId && (c.status === 'active' || c.status === 'offered')) ?? null;
}

/**
 * Sign a contract: a soldier from each side, and the port opens up.
 *
 * The ship value drops by two for everybody, not just for the signatories.
 * That is the cost of the bargain and the reason a steward might refuse one:
 * the same jetties that let a trader in let a fleet in.
 */
export function activateContract(draft, data, contract, stewardRoleId) {
  contract.status = 'active';
  contract.stewardRoleId = stewardRoleId;
  draft.roles[stewardRoleId].soldiers -= 1;
  draft.roles[contract.traderRoleId].soldiers -= 1;
  draft.shires[contract.shireId].shipCostDelta -= 2;
}

/** Tear one up. The soldiers do not come back; the ship value does. */
export function cancelContract(draft, data, contract, byRoleId) {
  contract.status = 'cancelled';
  contract.cancelledBy = byRoleId;
  draft.shires[contract.shireId].shipCostDelta += 2;
}

/**
 * When the phase now beginning should end.
 *
 * A deadline rather than a countdown, so a client works out what is left from
 * the clock on the wall. A browser that has been in a background tab has had
 * its timers throttled to about once a second and would otherwise come back
 * minutes adrift — which, in a game whose phases are five minutes long, is the
 * difference between having time to act and not.
 *
 * The lobby and the epilogue have no deadline: neither is a phase anybody is
 * waiting out.
 */
export function phaseEndsAt(state, data, payload, now) {
  if (payload?.endsAt !== undefined) return payload.endsAt;
  const printed = data.meta.phases.find((p) => p.id === state.phase.name);
  return printed ? now + Number(printed.minutes) * 60_000 : null;
}

/** How long is left, or how far past time we are. Negative means overtime. */
export function remainingMs(phase, now) {
  if (phase.paused) return phase.pausedRemainingMs ?? 0;
  return phase.endsAt === null ? null : phase.endsAt - now;
}

const ok = () => ({ ok: true });
const no = (reason) => ({ ok: false, reason });

/** The role a command acts for: a player's own, or whoever a facilitator names. */
export function subjectOf(ctx) {
  return ctx.actor.kind === 'facilitator'
    ? ctx.cmd.payload?.roleId ?? ctx.actor.roleId ?? null
    : ctx.actor.roleId;
}

function affordable(role, costs) {
  for (const [what, amount] of Object.entries(costs)) {
    if ((role[what] ?? 0) < amount) {
      return `not enough ${what} — you have ${role[what] ?? 0}, this costs ${amount}`;
    }
  }
  return null;
}

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

function spend(role, costs) {
  for (const [what, amount] of Object.entries(costs)) role[what] -= amount;
}

/**
 * Whether two characters answer to the same faction, and so sit at one table.
 *
 * Faction rather than the printed team, because homage moves it: a vassal's
 * lands and loyalties follow their liege, and so does who they may deal with
 * while the teams are sitting apart.
 */
const sameFaction = (state, roleId, otherId) => {
  const faction = state.roles[roleId]?.factionId;
  return Boolean(faction) && faction === state.roles[otherId]?.factionId;
};

/**
 * Why a deal with this person cannot be struck right now, or null.
 *
 * The Team Phase is the one stretch of the turn a team spends alone with
 * itself, which is what makes the Encounter Phase worth anything: crossing the
 * lines is supposed to cost you the walk. So a gift or a bargain aimed outside
 * your own faction waits until the room is back together, while anything
 * inside it is the whole point of the phase.
 */
const dealingReason = (state, roleId, otherId) =>
  (state.phase.name === 'team' && !sameFaction(state, roleId, otherId)
    ? no('the Team Phase is your own team\'s — deal with them in the maintenance or encounter phase')
    : null);

/*
 * -----------------------------------------------------------------------------
 * Presentation, and why it lives here.
 *
 * What a verb is called, the line under its button, and the questions it still
 * needs answered are all declared on the spec beside the `admit` they have to
 * agree with. They used to be three tables and a hand-written `probe` in two
 * other files, and they drifted: a verb could be added to the registry and
 * render as its own id at a player, or send an empty payload to a rule that
 * needed one, without a single test going red.
 *
 * `fields` is plain data — `{name, label, kind, options, min, max, value}` —
 * so this is still a pure rules module. The DOM that renders it stays in
 * `gui/client/action-chooser.js`, and nothing here knows that file exists.
 *
 * A field's options are always ones the game currently allows, which is what
 * lets `probe` be derived from them rather than written twice.
 */

/**
 * @typedef {object} Field
 * @property {string} name
 * @property {string} label
 * @property {'select'|'number'} kind
 * @property {{value: string, label: string}[]} [options]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [value]
 */

const roleName = (data, roleId) => data.roles.roles[roleId]?.name ?? roleId;

const shireName = (data, shireId) => data.shires.shires[shireId]?.name ?? shireId;

/** A settlement as a dropdown should name it: its kind, and whether it is circled. */
const settlementLabel = (settlement) => {
  const kind = settlement.type[0].toUpperCase() + settlement.type.slice(1);
  return settlement.defended ? `${kind} (defended)` : kind;
};

/** Everyone else who is in the game, or only those a filter keeps. */
const others = (state, data, roleId, keep = () => true) =>
  Object.values(state.roles ?? {})
    .filter((role) => role.id !== roleId && keep(role))
    .map((role) => ({ value: role.id, label: roleName(data, role.id) }));

/** The shires this player stewards, as options. */
const stewarded = (state, data, roleId) => Object.entries(state.shires ?? {})
  .filter(([, shire]) => shire.stewardRoleId === roleId)
  .map(([id]) => ({ value: id, label: shireName(data, id) }));

/**
 * Whether this character is one to strike a bargain with right now.
 *
 * The same question `dealingReason` answers for the reducer, asked the other
 * way round: a dropdown offering a deal the rules would refuse is a dropdown
 * offering a refusal.
 */
const dealable = (state, roleId, otherId) => !dealingReason(state, roleId, otherId);

export const COMMANDS = {
  // --- lobby ---------------------------------------------------------------
  'claim-role': {
    // Any phase, not just the lobby. People arrive late, drop out, and get
    // reseated onto a character whose player has gone home — a game that can
    // only be joined before it starts is not one that survives a real evening.
    phases: '*',
    actor: 'player',
    label: 'Take a character',
    // The one command a seat issues before it has a role, so it is exempt
    // from the check that a player command must have one.
    roleless: true,
    admit(ctx) {
      const { state, cmd } = ctx;
      const roleId = cmd.payload?.roleId;
      if (!state.roles[roleId]) return no('no such role in this game');
      // A role held by someone who has dropped off is fair game; a facilitator
      // can always reassign either way.
      const holder = seatHolding(state, roleId);
      if (holder && holder.id !== ctx.actor.seatId && holder.connected) {
        return no(`${roleId} is already being played`);
      }
      return ok();
    },
    effects(draft, ctx) {
      const seatId = ctx.actor.seatId;
      const taking = ctx.cmd.payload.roleId;
      // One seat, one role: whoever was in this chair leaves whatever they
      // were playing, and whoever was playing this role loses the chair.
      for (const seat of Object.values(draft.seats)) {
        if (seat.roleId === taking) seat.roleId = null;
      }
      draft.seats[seatId].roleId = taking;
    },
  },

  // --- team phase ----------------------------------------------------------
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

  /**
   * Change who you answer to.
   *
   * A Dane may do this freely in the Team Phase — their sheets say so plainly,
   * and a warband that follows whoever is winning is the point. A Saxon's
   * homage needs the other party's agreement, so theirs goes through
   * `request-allegiance` and a consent round, or through a facilitator, who is
   * the one who heard them agree in the room.
   */
  'swear-allegiance': {
    phases: ['team'],
    actor: 'player',
    label: 'Swear allegiance',
    note: 'Their crowns then count as support for you.',
    // Standing alone comes first, and is always available — which is what
    // makes the derived probe answer "is there any homage to swear at all?"
    // with a yes.
    fields: (state, data, roleId) => [{
      name: 'liegeId',
      label: 'Follow',
      kind: 'select',
      options: [{ value: '', label: 'nobody — stand alone' }, ...others(state, data, roleId)],
    }],
    // An empty choice is standing alone, and the rules spell that null.
    toPayload: (values) => ({ liegeId: values.liegeId || null }),
    admit(ctx) {
      const roleId = subjectOf(ctx);
      if (ctx.actor.kind !== 'facilitator' && !isDanish(ctx.state, ctx.data, roleId)) {
        return no('a Saxon swears homage in front of a facilitator');
      }
      return homageReason(ctx.state, roleId, ctx.cmd.payload?.liegeId) ?? ok();
    },
    effects(draft, ctx) {
      swearTo(draft, subjectOf(ctx), ctx.cmd.payload.liegeId);
    },
  },

  /**
   * A Saxon asks to become somebody's man.
   *
   * "Target: The holder of a Saxon crown, or a Dane. Effect: With their consent
   * you become their vassal, joining their faction. You cannot be in an
   * existing faction when you swear allegiance."
   *
   * All three clauses bite. A crownless Saxon cannot take vassals at all,
   * which is what makes an election worth winning; and a Saxon who already has
   * a liege has to rebel first, which is what makes changing sides cost
   * something.
   */
  'request-allegiance': {
    phases: ['team'],
    actor: 'player',
    label: 'Ask to swear allegiance',
    note: 'They must agree, and must wear a crown or be a Dane.',
    fields: (state, data, roleId) => [{
      name: 'liegeId',
      label: 'Follow',
      kind: 'select',
      // Only people who could actually take you: a crowned Saxon, or a Dane.
      options: others(state, data, roleId, (role) =>
        Object.values(state.crownHolders ?? {}).includes(role.id)
        || isDanish(state, data, role.id)),
    }],
    admit(ctx) {
      const roleId = subjectOf(ctx);
      if (isDanish(ctx.state, ctx.data, roleId)) {
        return no('a Dane simply chooses, and needs nobody\'s leave');
      }
      if (ctx.state.roles[roleId]?.liegeId) {
        return no('you are already somebody\'s man — rebel first');
      }
      const to = ctx.cmd.payload?.liegeId;
      const reason = homageReason(ctx.state, roleId, to);
      if (reason) return reason;
      if (!to) return no('say whom you would follow');
      if (!isDanish(ctx.state, ctx.data, to) && crownsHeldBy(ctx.state, to).length === 0) {
        return no('they wear no crown, so they have no vassals to take');
      }
      if (Object.values(ctx.state.consents).some(
        (c) => !c.resolved && c.kind === 'allegiance' && c.roleId === roleId)) {
        return no('you are already asking somebody');
      }
      return ok();
    },
    effects(draft, ctx) {
      const roleId = subjectOf(ctx);
      const liegeId = ctx.cmd.payload.liegeId;
      const id = `allegiance:${roleId}:${Object.keys(draft.consents).length + 1}`;
      draft.consents[id] = {
        id,
        kind: 'allegiance',
        roleId,
        liegeId,
        asked: [liegeId],
        granted: {},
        resolved: false,
        outcome: null,
      };
    },
  },

  // --- crowns --------------------------------------------------------------
  /**
   * Put a crown to the shires that answer to it.
   *
   * "All saxon stewards of shires that have support for this crown (regardless
   * of who their liege is) can vote for who has the right to the crown."
   *
   * The electorate is made of ground rather than of people, so a king cannot
   * pack it by taking vassals — he has to hold shires whose peasants would
   * accept him. A vassal whose liege wants the same crown is compelled to vote
   * for them and barred from standing, which is the whole of Ceowulf and
   * Gainbeald's problem: same team, same crown, and only one of them can have
   * it.
   *
   * Most votes wins. A tie fails and the crown stays unworn, to be contested
   * again — the alternative is an app breaking a tie nobody agreed it should.
   */
  'claim-crown': {
    phases: ['team'],
    actor: 'player',
    label: 'Claim a crown',
    note: 'Every shire that supports it gets a say.',
    fields: (state, data, roleId) => [{
      name: 'crown',
      label: 'Claim',
      kind: 'select',
      options: (state.roles[roleId]?.claims ?? [])
        .filter((crown) => !state.crownHolders?.[crown])
        .map((crown) => ({ value: crown, label: pretty(crown) })),
    }],
    // A crown he claims that nobody wears, and failing that one he claims at
    // all. The first half is what the chooser offers, and is why a king with a
    // second claim keeps the verb — asking after his first claim regardless
    // usually asks after the crown already on his own head. The second half is
    // for the king whose every claim is spoken for: "Wessex already has a
    // king" is the truth, where an empty dropdown would have him told he has
    // no claim, which is not.
    probe: (state, data, roleId) => {
      const claims = state.roles[roleId]?.claims ?? [];
      return { crown: claims.find((crown) => !state.crownHolders?.[crown]) ?? claims[0] };
    },
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const { crown } = ctx.cmd.payload ?? {};
      const role = ctx.state.roles[roleId];
      if (!role?.claims.includes(crown)) return no('you have no claim on that crown');
      if (ctx.state.crownHolders[crown]) {
        return no(`${pretty(crown)} already has a king`);
      }
      const liege = role.liegeId;
      if (liege && ctx.state.roles[liege]?.claims.includes(crown)) {
        return no('you cannot claim a crown your liege claims');
      }
      if (Object.values(ctx.state.votes).some((v) => !v.resolved && v.crown === crown)) {
        return no('that election is already being held');
      }
      if (Object.keys(electorate(ctx.state, ctx.data, crown)).length === 0) {
        return no('no shire that supports it has a Saxon steward to vote');
      }
      return ok();
    },
    effects(draft, ctx, { data }) {
      const roleId = subjectOf(ctx);
      const { crown } = ctx.cmd.payload;
      const id = `crown:${crown}:${Object.keys(draft.votes).length + 1}`;
      // Everybody with a claim stands, minus anyone whose own liege claims it
      // — they are barred from claiming, so they cannot be crowned either.
      const candidates = Object.values(draft.roles)
        .filter((role) => role.claims.includes(crown))
        .filter((role) => !(role.liegeId && draft.roles[role.liegeId]?.claims.includes(crown)))
        .map((role) => role.id).sort();
      draft.votes[id] = {
        id,
        kind: 'crown',
        crown,
        openedBy: roleId,
        candidates,
        // Fixed when the election opens. A shire changing hands halfway
        // through would otherwise silently change who was voting.
        electorate: electorate(draft, data, crown),
        cast: {},
        resolved: false,
        outcome: null,
        winner: null,
      };
    },
  },

  /** One elector's voice, weighted by the ground they hold. */
  'cast-vote': {
    phases: '*',
    actor: 'player',
    label: 'Cast your vote',
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const vote = ctx.state.votes[ctx.cmd.payload?.voteId];
      if (!vote) return no('no such election');
      if (vote.resolved) return no('that election is over');
      if (!vote.electorate[roleId]) return no('you have no vote in this');
      if (vote.cast[roleId]) return no('you have voted');
      const forRoleId = ctx.cmd.payload?.forRoleId;
      if (!vote.candidates.includes(forRoleId)) return no('they are not standing');
      // "If your liege has a claim you must vote for them."
      const liege = ctx.state.roles[roleId]?.liegeId;
      if (liege && vote.candidates.includes(liege) && forRoleId !== liege) {
        return no('your liege stands — you are sworn to vote for them');
      }
      return ok();
    },
    effects(draft, ctx) {
      const vote = draft.votes[ctx.cmd.payload.voteId];
      vote.cast[subjectOf(ctx)] = ctx.cmd.payload.forRoleId;
      resolveVote(draft, vote);
    },
  },

  /**
   * The facilitator calls the count.
   *
   * An election that waits for an elector who has gone home never ends, and a
   * megagame runs on a clock. Counting what is in the room is what an umpire
   * does.
   */
  'facilitator:close-vote': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      const vote = ctx.state.votes[ctx.cmd.payload?.voteId];
      if (!vote) return no('no such election');
      return vote.resolved ? no('that election is over') : ok();
    },
    effects(draft, ctx) {
      resolveVote(draft, draft.votes[ctx.cmd.payload.voteId], true);
    },
  },

  /**
   * Ask to break with your liege.
   *
   * "Cost: Transfer one shire and two soldiers to your liege. This cost will be
   * reduced (potentially down to zero) by the organisers if the liege has lost
   * the favour of God" — printed on the Saxon sheets only. A Dane already
   * changes liege freely in the Team Phase, so has no rebellion to ask for and
   * no cost to be judged on.
   *
   * Opens a petition rather than doing anything, because the price is a
   * judgement made about this rebellion rather than a standing rate: the
   * facilitator has to actually be asked before it can be set.
   */
  'request-rebel': {
    phases: ['team'],
    actor: 'player',
    label: 'Ask to rebel',
    note: 'The facilitator sets the price. You get the final say once you see it.',
    // Named up front, whatever it ends up costing — the facilitator has not
    // priced it yet, so this is what you would offer if a shire is part of the
    // bill. A landless rebel is asked nothing, which is also what `admit` says.
    fields: (state, data, roleId) => {
      const held = stewarded(state, data, roleId);
      return held.length
        ? [{ name: 'shireId', label: 'Offer', kind: 'select', options: held }]
        : [];
    },
    admit(ctx) {
      const roleId = subjectOf(ctx);
      if (isDanish(ctx.state, ctx.data, roleId)) {
        return no('a Dane simply changes liege — no rebellion needed');
      }
      if (!ctx.state.roles[roleId]?.liegeId) return no('you answer to nobody already');
      if (openRebellion(ctx.state, roleId)) return no('you have already asked to rebel');

      const held = Object.values(ctx.state.shires).filter((s) => s.stewardRoleId === roleId);
      if (held.length === 0) return ok();
      const shire = ctx.state.shires[ctx.cmd.payload?.shireId];
      if (!shire) return no('name the shire you would hand over');
      if (shire.stewardRoleId !== roleId) return no('that is not yours to offer');
      return ok();
    },
    effects(draft, ctx) {
      const roleId = subjectOf(ctx);
      const id = `rebellion:${roleId}:${Object.keys(draft.rebellions).length + 1}`;
      draft.rebellions[id] = {
        id,
        roleId,
        liegeId: draft.roles[roleId].liegeId,
        shireId: ctx.cmd.payload?.shireId ?? null,
        status: 'pending',
        cost: null,
        note: '',
      };
    },
  },

  /**
   * The umpire names the price.
   *
   * Answered in the open and before the fact, because a price a vassal cannot
   * see is not a price they can weigh — they still have to confirm it once it
   * is set.
   */
  'facilitator:price-rebellion': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      const { roleId, shires, soldiers } = ctx.cmd.payload ?? {};
      const request = openRebellion(ctx.state, roleId);
      if (!request) return no('nobody is waiting on a price for that');
      if (![0, 1].includes(shires)) return no('a rebellion costs one shire or none');
      if (!Number.isInteger(soldiers) || soldiers < 0 || soldiers > 2) {
        return no('a rebellion costs between none and two soldiers');
      }
      return ok();
    },
    effects(draft, ctx) {
      const { roleId, shires, soldiers, note } = ctx.cmd.payload;
      const request = openRebellion(draft, roleId);
      request.cost = { shires, soldiers };
      request.note = note ?? '';
      request.status = 'priced';
    },
  },

  /**
   * The rebel's final say.
   *
   * The price is the facilitator's; whether to pay it is still the vassal's
   * own decision, made with the number actually in front of them rather than
   * the printed default they asked against.
   */
  'confirm-rebel': {
    phases: '*',
    actor: 'player',
    label: 'Go through with it',
    note: (state, data, roleId) => rebellionNote(state, roleId),
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const request = openRebellion(ctx.state, roleId, ['priced']);
      if (!request) return no('nothing priced yet — the facilitator has not set a price');
      const reason = affordable(ctx.state.roles[roleId], { soldiers: request.cost.soldiers });
      return reason ? no(reason) : ok();
    },
    effects(draft, ctx) {
      const roleId = subjectOf(ctx);
      const request = openRebellion(draft, roleId, ['priced']);
      const role = draft.roles[roleId];
      const liegeId = request.liegeId;

      role.soldiers -= request.cost.soldiers;
      draft.roles[liegeId].soldiers += request.cost.soldiers;
      if (request.cost.shires > 0 && request.shireId
        && draft.shires[request.shireId]?.stewardRoleId === roleId) {
        draft.shires[request.shireId].stewardRoleId = liegeId;
        draft.shires[request.shireId].factionId = draft.roles[liegeId].factionId;
      }

      // "You leave your faction, which means you are free to swear a new
      // allegiance, claim a crown or remain independent." A faction of one is
      // still a faction, and it is his.
      role.liegeId = null;
      role.factionId = roleId;
      for (const shire of Object.values(draft.shires)) {
        if (shire.stewardRoleId === roleId) shire.factionId = roleId;
      }
      request.status = 'done';
    },
  },

  /** Think better of it. Free at any stage — nothing was spent until this. */
  'cancel-rebel': {
    phases: '*',
    actor: 'player',
    label: 'Call off your rebellion',
    note: (state, data, roleId) => rebellionNote(state, roleId),
    admit(ctx) {
      const request = openRebellion(ctx.state, subjectOf(ctx));
      return request ? ok() : no('nothing to call off');
    },
    effects(draft, ctx) {
      openRebellion(draft, subjectOf(ctx)).status = 'cancelled';
    },
  },

  /**
   * Hand a shire to somebody else.
   *
   * Team-phase business in the paper game, and a real move: stewardship is
   * what pays you, what you must defend, and — through the support box — what
   * makes you legitimate. Giving one away is how a faction consolidates behind
   * whoever can actually hold the border.
   */
  'transfer-stewardship': {
    phases: ['team'],
    actor: 'player',
    label: 'Hand over a shire',
    note: 'They collect its income, and must hold it.',
    // "Do I hold a shire, and is there anyone to hand it to?" — which is what
    // the derived probe asks, off the first of each list.
    fields: (state, data, roleId) => [
      {
        name: 'shireId',
        label: 'Which shire',
        kind: 'select',
        options: stewarded(state, data, roleId),
      },
      { name: 'toRoleId', label: 'To', kind: 'select', options: others(state, data, roleId) },
    ],
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const shire = ctx.state.shires[ctx.cmd.payload?.shireId];
      if (!shire) return no('no such shire');
      if (shire.stewardRoleId !== roleId && ctx.actor.kind !== 'facilitator') {
        return no('you are not the steward of that shire');
      }
      const to = ctx.cmd.payload?.toRoleId;
      if (!ctx.state.roles[to]) return no('no such character');
      if (to === shire.stewardRoleId) return no('they already hold it');
      return ok();
    },
    effects(draft, ctx) {
      const shire = draft.shires[ctx.cmd.payload.shireId];
      shire.stewardRoleId = ctx.cmd.payload.toRoleId;
      // The shire's faction follows its steward, which is what moves it on the
      // Danelaw and Disorder counters.
      shire.factionId = draft.roles[ctx.cmd.payload.toRoleId].factionId;
    },
  },

  /**
   * Give silver, food or ships to another player.
   *
   * Freely, and at any time except during a battle — the printed rules are
   * emphatic that this is a negotiating game and the currency of a promise is
   * being able to keep it on the spot. Momentum and soldiers are yours alone
   * and never move.
   *
   * The one qualification is the Team Phase, where a gift stays inside the
   * team, because that phase is the team's own.
   */
  give: {
    phases: TRADEABLE_PHASES,
    actor: 'player',
    label: 'Give to another player',
    note: 'Silver, food and ships only. Soldiers are yours alone.',
    fields: (state, data, roleId) => [
      {
        name: 'toRoleId',
        label: 'To',
        kind: 'select',
        // In the Team Phase a gift stays inside the team, so offering the
        // rest of the table is offering a refusal.
        options: others(state, data, roleId, (role) => dealable(state, roleId, role.id)),
      },
      {
        name: 'what',
        label: 'What',
        kind: 'select',
        // Only what they actually hold: offering to give away nothing is a
        // way of finding out you have none, but a slow one.
        options: TRADEABLE
          .filter((what) => (state.roles[roleId]?.[what] ?? 0) > 0)
          .map((what) => ({
            value: what,
            label: `${what} (you have ${state.roles[roleId][what]})`,
          })),
      },
      { name: 'amount', label: 'How much', kind: 'number', min: 1, max: 99, value: 1 },
    ],
    // A form hands back strings, and the rules count with this one.
    toPayload: (values) => ({ ...values, amount: Number(values.amount) }),
    // "Is there anyone to give anything to, and anything to give?" — written
    // out rather than derived, because the fields offer only people this phase
    // allows a deal with. With nobody left the derived probe would report "no
    // such character" where the true answer is that the Team Phase is the
    // team's own, which is the sentence a player needs.
    probe: (state, data, roleId) => {
      const others = Object.keys(state.roles).filter((id) => id !== roleId);
      // A teammate first: in the Team Phase they are the only lawful answer,
      // and in the other two they are as good an answer as anybody.
      const to = others.find((id) => sameFaction(state, roleId, id)) ?? others[0];
      const what = TRADEABLE.find((kind) => (state.roles[roleId]?.[kind] ?? 0) > 0);
      return { toRoleId: to, what, amount: 1 };
    },
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const { toRoleId, what, amount } = ctx.cmd.payload ?? {};
      if (!ctx.state.roles[toRoleId]) return no('no such character');
      if (toRoleId === roleId) return no('you already have it');
      const across = dealingReason(ctx.state, roleId, toRoleId);
      if (across) return across;
      if (!TRADEABLE.includes(what)) {
        return no(`${what ?? 'that'} cannot change hands — only ${TRADEABLE.join(', ')}`);
      }
      if (!Number.isInteger(amount) || amount <= 0) return no('say how much');
      const reason = affordable(ctx.state.roles[roleId], { [what]: amount });
      return reason ? no(reason) : ok();
    },
    effects(draft, ctx) {
      const { toRoleId, what, amount } = ctx.cmd.payload;
      draft.roles[subjectOf(ctx)][what] -= amount;
      draft.roles[toRoleId][what] += amount;
    },
  },

  // --- maintenance phase ---------------------------------------------------
  /**
   * The one thing everybody does every maintenance phase: momentum, then
   * income, and for a pagan Dane the upkeep their followers demand.
   *
   * The upkeep is a choice the sheets make mandatory — pay five silver for two
   * soldiers, or lose one — so it is a payload rather than something the app
   * picks. A Dane with neither the silver nor a soldier to lose is simply
   * poorer than the rule anticipated, and gets on with it.
   */
  'collect-income': {
    phases: ['maintenance'],
    actor: 'player',
    label: 'Collect income',
    note: 'Momentum, then whatever your lands pay.',
    // Only a pagan Dane is asked; everyone else just collects.
    fields: (state, data, roleId) => (isPagan(state, data, roleId)
      ? [{
        name: 'upkeep',
        label: 'Your followers',
        kind: 'select',
        options: [
          { value: 'pay', label: 'Pay five silver for two soldiers' },
          { value: 'lose', label: 'Lose a soldier' },
        ],
      }]
      : []),
    // Losing a soldier, not paying for two: both are offered because both are
    // choices, but only one of them is always affordable, and a probe that
    // asked after the five silver would grey the whole action out for the
    // pagan Dane who most needs to collect.
    probe: { upkeep: 'lose' },
    admit(ctx) {
      const roleId = subjectOf(ctx);
      if (ctx.state.roles[roleId].perTurn.collected) {
        return no('you have already collected this turn');
      }
      if (owesUpkeep(ctx.state, ctx.data, roleId)) {
        const choice = ctx.cmd.payload?.upkeep;
        if (choice !== 'pay' && choice !== 'lose') {
          return no('your followers want feeding — pay five silver for two soldiers, or lose one');
        }
        if (choice === 'pay' && ctx.state.roles[roleId].silver < 5) {
          return no('not enough silver to pay your followers — you must lose a soldier');
        }
      }
      return ok();
    },
    effects(draft, ctx, { data }) {
      const roleId = subjectOf(ctx);
      const role = draft.roles[roleId];

      role.momentum = Math.min(
        Number(data.meta.momentumCap), role.momentum + momentumGain(draft, data, roleId));

      if (owesUpkeep(draft, data, roleId)) {
        if (ctx.cmd.payload.upkeep === 'pay') {
          role.silver -= 5;
          role.soldiers += 2;
        } else {
          role.soldiers = Math.max(0, role.soldiers - 1);   // "if able"
        }
      }

      // A contract pays *both* signatories two silver a turn: the trader who
      // arranged it and the steward whose port it runs through. Paying only
      // the trader would make the deal worthless to the person being asked
      // for a soldier, which is the half that has to be persuaded.
      for (const contract of draft.contracts) {
        if (contract.status !== 'active') continue;
        if (contract.traderRoleId === roleId
            || draft.shires[contract.shireId]?.stewardRoleId === roleId) {
          role.silver += 2;
        }
      }

      const income = incomeFor(draft, data, roleId);
      role.silver += income.silver;
      role.food += income.food;
      role.soldiers += income.soldiers;
      role.perTurn.collected = true;
    },
  },

  'recruit-soldiers': {
    phases: ['maintenance'],
    actor: 'player',
    label: 'Recruit soldiers',
    note: 'Five silver for one soldier.',
    admit(ctx) {
      // Not on the Danish Warrior sheet: their soldiers come from upkeep and
      // from home, not from a purse.
      const archetype = ctx.data.roles.roles[subjectOf(ctx)]?.archetype;
      if (archetype === 'danish_warrior') return no('your archetype cannot recruit');
      const reason = affordable(ctx.state.roles[subjectOf(ctx)], { silver: 5 });
      return reason ? no(reason) : ok();
    },
    effects(draft, ctx) {
      const role = draft.roles[subjectOf(ctx)];
      spend(role, { silver: 5 });
      role.soldiers += 1;
    },
  },

  'build-ship': {
    phases: ['maintenance'],
    actor: 'player',
    label: 'Build a ship',
    note: 'Only where there is a yard, if you are a Saxon.',
    admit(ctx) {
      const roleId = subjectOf(ctx);
      // Saxons can only build where there is a yard to build in. Danes brought
      // their own shipwrights and can build anywhere, for more.
      if (!isDanish(ctx.state, ctx.data, roleId) && !holdsShipyard(ctx.state, roleId)) {
        return no(`only the steward of ${SHIPYARDS.map(pretty).join(', ')} can build ships`);
      }
      const reason = affordable(ctx.state.roles[roleId],
        { silver: shipPrice(ctx.state, ctx.data, roleId) });
      return reason ? no(reason) : ok();
    },
    effects(draft, ctx, { data }) {
      const roleId = subjectOf(ctx);
      const role = draft.roles[roleId];
      spend(role, { silver: shipPrice(draft, data, roleId) });
      role.ships += 1;
      role.perTurn.shipsBuilt += 1;
    },
  },

  /** Circle a settlement's letter: it now needs storming rather than walking into. */
  reinforce: {
    phases: ['maintenance'],
    actor: 'player',
    label: 'Reinforce a settlement',
    note: 'One momentum. Circles a settlement so it must be stormed.',
    // Shires whose settlements this player may circle, and which still have
    // one left uncircled.
    fields: (state, data, roleId) => [{
      name: 'target',
      label: 'Which settlement',
      kind: 'select',
      options: Object.entries(state.shires ?? {})
        .flatMap(([shireId, shire]) => Object.values(shire.settlements ?? {})
          .filter((s) => !s.defended && !s.destroyed && shire.stewardRoleId === roleId)
          .map((s) => ({
            value: `${shireId}|${s.id}`,
            label: `${shireName(data, shireId)} — ${settlementLabel(s)}`,
          }))),
    }],
    toPayload: (values) => {
      const [shireId, settlementId] = String(values.target ?? '').split('|');
      return { shireId, settlementId };
    },
    // "Is there a settlement anywhere I could circle?" — a wider question than
    // the dropdown answers, because `canReinforceIn` also lets a priest circle
    // where his cross stands and the dropdown only offers his own shires. A
    // derived probe would grey the verb out for a priest whose only ground is
    // a mission, which the rules plainly allow.
    probe: (state, data, roleId) => {
      for (const [shireId, shire] of Object.entries(state.shires)) {
        if (!canReinforceIn(state, data, roleId, shire)) continue;
        const open = Object.values(shire.settlements)
          .find((x) => !x.defended && !x.destroyed);
        if (open) return { shireId, settlementId: open.id };
      }
      return {};
    },
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const reason = affordable(ctx.state.roles[roleId], { momentum: 1 });
      if (reason) return no(reason);

      const shire = ctx.state.shires[ctx.cmd.payload?.shireId];
      if (!shire) return no('no such shire');
      if (!canReinforceIn(ctx.state, ctx.data, roleId, shire)) {
        return no('you can only reinforce a shire you steward');
      }
      const settlement = shire.settlements[ctx.cmd.payload?.settlementId];
      if (!settlement) return no('no such settlement');
      if (settlement.destroyed) return no('that settlement has been destroyed');
      if (settlement.defended) return no('that settlement is already defended');
      return ok();
    },
    effects(draft, ctx) {
      const role = draft.roles[subjectOf(ctx)];
      spend(role, { momentum: 1 });
      draft.shires[ctx.cmd.payload.shireId]
        .settlements[ctx.cmd.payload.settlementId].defended = true;
    },
  },

  trade: {
    // The market, not another player: the bank is shut during the Team Phase.
    phases: MARKET_PHASES,
    actor: 'player',
    label: 'Trade at market',
    note: 'Three silver buys a food; a food sells for two silver.',
    // Selling food first, and so the probe's answer to "could you trade at
    // all?": it is the cheaper of the two, so it answers the question
    // honestly for a player who has not chosen a direction yet.
    fields: () => [{
      name: 'give',
      label: 'Which way',
      kind: 'select',
      options: [
        { value: 'food', label: 'Sell a food for two silver' },
        { value: 'silver', label: 'Buy a food for three silver' },
      ],
    }],
    admit(ctx) {
      const role = ctx.state.roles[subjectOf(ctx)];
      const limit = ctx.data.roles.roles[subjectOf(ctx)].archetype === 'danish_trader' ? 2 : 1;
      if (role.perTurn.tradesUsed >= limit) return no('you have traded as often as you may');
      const { give } = ctx.cmd.payload ?? {};
      if (give !== 'silver' && give !== 'food') return no('trade silver for food, or food for silver');
      const reason = affordable(role, give === 'silver' ? { silver: 3 } : { food: 1 });
      return reason ? no(reason) : ok();
    },
    effects(draft, ctx) {
      const role = draft.roles[subjectOf(ctx)];
      // Asymmetric, as printed: three silver buys one food, one food sells
      // for two silver.
      if (ctx.cmd.payload.give === 'silver') { role.silver -= 3; role.food += 1; }
      else { role.food -= 1; role.silver += 2; }
      role.perTurn.tradesUsed += 1;
    },
  },

  /**
   * Once a game, and free: the banners go up and the faithful turn out.
   *
   * Scales with the turn, so it is worth more the longer you hold it — a
   * first-turn Alfred gains one soldier, a fifth-turn Alfred five. The whole
   * design of the card is "save this for when it matters".
   */
  'raise-christian-banners': {
    phases: ['maintenance'],
    actor: 'player',
    label: 'Raise Christian banners',
    note: 'Once a game. Soldiers equal to the turn.',
    admit(ctx) {
      const roleId = subjectOf(ctx);
      if (isDanish(ctx.state, ctx.data, roleId) && !ctx.state.roles[roleId].baptised) {
        return no('the banners are Christian');
      }
      if (ctx.state.roles[roleId].once.christianBanners) {
        return no('you have raised them once already');
      }
      const churches = churchesHeld(ctx.state, roleId);
      if (churches < 3) return no(`you control ${churches} churches and this needs 3`);
      return ok();
    },
    effects(draft, ctx) {
      const role = draft.roles[subjectOf(ctx)];
      role.soldiers += draft.phase.turn;
      role.once.christianBanners = true;
    },
  },

  /** Two ships stood offshore make a shire harder to come at by sea. */
  'defensive-fleet': {
    phases: ['maintenance'],
    actor: 'player',
    label: 'Station a defensive fleet',
    note: 'Two ships. Makes the shire dearer to reach by sea.',
    fields: (state, data, roleId) => [{
      name: 'shireId',
      label: 'Which shire',
      kind: 'select',
      // Coastal only: there is nothing to guard inland.
      options: stewarded(state, data, roleId)
        .filter(({ value }) => data.shires.shires[value]?.shipCost !== null),
    }],
    // A coastal shire he holds, and failing that any shire he holds — the same
    // two halves as claim-crown, for the same two reasons. A steward of one
    // inland shire and one coastal one had the verb greyed out over the inland
    // one; a steward of nothing but inland shires should be told there is no
    // coast to guard rather than that he holds no shire at all.
    probe: (state, data, roleId) => {
      const held = stewarded(state, data, roleId);
      const coastal = held.find(({ value }) => data.shires.shires[value]?.shipCost !== null);
      return { shireId: (coastal ?? held[0])?.value };
    },
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const shire = ctx.state.shires[ctx.cmd.payload?.shireId];
      if (!shire) return no('no such shire');
      if (shire.stewardRoleId !== roleId) return no('you can only guard a shire you steward');
      if (ctx.data.shires.shires[shire.id].shipCost === null) {
        return no('that shire has no coast to guard');
      }
      const reason = affordable(ctx.state.roles[roleId], { ships: 2 });
      return reason ? no(reason) : ok();
    },
    effects(draft, ctx) {
      spend(draft.roles[subjectOf(ctx)], { ships: 2 });
      draft.shires[ctx.cmd.payload.shireId].shipCostDelta += 1;
    },
  },

  /** Six silver puts a burned settlement back. */
  'rebuild-settlement': {
    phases: ['maintenance'],
    actor: 'player',
    label: 'Rebuild a settlement',
    note: 'Six silver. It comes back undefended.',
    fields: (state, data, roleId) => [{
      name: 'target',
      label: 'Which ruin',
      kind: 'select',
      options: Object.entries(state.shires ?? {})
        .filter(([, shire]) => shire.stewardRoleId === roleId)
        .flatMap(([shireId, shire]) => Object.values(shire.settlements ?? {})
          .filter((s) => s.destroyed)
          .map((s) => ({
            value: `${shireId}|${s.id}`,
            label: `${shireName(data, shireId)} — ${s.type}`,
          }))),
    }],
    toPayload: (values) => {
      const [shireId, settlementId] = String(values.target ?? '').split('|');
      return { shireId, settlementId };
    },
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const reason = affordable(ctx.state.roles[roleId], { silver: 6 });
      if (reason) return no(reason);
      const shire = ctx.state.shires[ctx.cmd.payload?.shireId];
      if (!shire) return no('no such shire');
      if (shire.stewardRoleId !== roleId) return no('you can only rebuild where you steward');
      const settlement = shire.settlements[ctx.cmd.payload?.settlementId];
      if (!settlement) return no('no such settlement');
      if (!settlement.destroyed) return no('that settlement is still standing');
      return ok();
    },
    effects(draft, ctx) {
      spend(draft.roles[subjectOf(ctx)], { silver: 6 });
      const settlement = draft.shires[ctx.cmd.payload.shireId]
        .settlements[ctx.cmd.payload.settlementId];
      settlement.destroyed = false;
      // It comes back as it was printed, undefended: rebuilding a place is not
      // the same as walling it.
      settlement.defended = false;
    },
  },

  /**
   * Ask the neighbours whether you may settle.
   *
   * The only action in the game that needs other people's agreement before it
   * happens, and the printed requirement is broad: *"Consent from the stewards
   * of all adjacent Shires"* — every neighbour, whatever side they are on, so
   * a Dane wanting to put down roots has to talk to the Saxons he has been
   * raiding.
   *
   * Modelled as a request rather than an instant action, because that is what
   * it is. Nothing is spent until it carries; a refusal costs the asker
   * nothing but the time. A shire with no steward consents by default — there
   * is nobody to ask — and the facilitator can force it through for anyone who
   * has wandered off, which at a live event is always somebody.
   */
  'request-settle': {
    phases: ['maintenance'],
    actor: 'player',
    label: 'Settle a shire',
    note: 'Every neighbouring steward has to agree first.',
    fields: (state, data, roleId) => [{
      name: 'shireId',
      label: 'Settle',
      kind: 'select',
      // Yours, and not already settled — asking twice about the same ground
      // wastes everybody's evening.
      options: stewarded(state, data, roleId)
        .filter(({ value }) => !state.shires[value]?.danishSupport),
    }],
    // Same reason as missionary-expedition: with every held shire already
    // settled the fields are empty, and "no such shire" is a worse answer
    // than "you have already settled there".
    probe: (state, data, roleId) => {
      const held = stewarded(state, data, roleId).map(({ value }) => value);
      return { shireId: held.find((id) => !state.shires[id]?.danishSupport) ?? held[0] };
    },
    admit(ctx) {
      const roleId = subjectOf(ctx);
      if (!isDanish(ctx.state, ctx.data, roleId)) return no('only Danes settle');
      const shire = ctx.state.shires[ctx.cmd.payload?.shireId];
      if (!shire) return no('no such shire');
      if (shire.stewardRoleId !== roleId) return no('you can only settle a shire you steward');
      if (shire.danishSupport) return no('you have already settled there');
      if (Object.values(ctx.state.consents).some(
        (c) => c.shireId === shire.id && !c.resolved)) {
        return no('you are already asking about that shire');
      }
      const reason = affordable(ctx.state.roles[roleId],
        { momentum: 1, soldiers: 3, silver: 5 });
      return reason ? no(reason) : ok();
    },
    effects(draft, ctx, { data }) {
      const roleId = subjectOf(ctx);
      const shireId = ctx.cmd.payload.shireId;
      const id = `settle:${shireId}:${Object.keys(draft.consents).length + 1}`;
      draft.consents[id] = {
        id,
        kind: 'settle',
        roleId,
        shireId,
        // Every neighbour with somebody in charge of it. An unheld shire has
        // nobody to object.
        asked: neighbourStewards(draft, data, shireId, roleId),
        granted: {},
        resolved: false,
        outcome: null,
      };
    },
  },

  /** A neighbour says yes, or says no. */
  'answer-consent': {
    phases: '*',
    actor: 'player',
    admit(ctx) {
      const request = ctx.state.consents[ctx.cmd.payload?.consentId];
      if (!request) return no('no such request');
      if (request.resolved) return no('that has already been settled one way or the other');
      const roleId = subjectOf(ctx);
      if (!request.asked.includes(roleId)) return no('nobody asked you');
      if (typeof ctx.cmd.payload?.granted !== 'boolean') return no('yes or no?');
      return ok();
    },
    effects(draft, ctx, { data }) {
      const request = draft.consents[ctx.cmd.payload.consentId];
      request.granted[subjectOf(ctx)] = ctx.cmd.payload.granted;
      resolveConsent(draft, data, request);
    },
  },

  /**
   * The facilitator answers for a neighbour who is not at their screen.
   *
   * Twenty people should not wait on one person who has gone to make tea, and
   * in the room this is simply the umpire asking them out loud.
   */
  'facilitator:answer-consent': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      const request = ctx.state.consents[ctx.cmd.payload?.consentId];
      if (!request) return no('no such request');
      return request.resolved ? no('that has already been settled') : ok();
    },
    effects(draft, ctx, { data }) {
      const request = draft.consents[ctx.cmd.payload.consentId];
      const { onBehalfOf, granted } = ctx.cmd.payload;
      if (onBehalfOf) request.granted[onBehalfOf] = Boolean(granted);
      // With no name, the facilitator is answering for everyone still silent.
      else for (const who of request.asked) request.granted[who] ??= Boolean(granted);
      resolveConsent(draft, data, request);
    },
  },

  /**
   * Take the cross back out again.
   *
   * On the Danish sheets only. A Saxon steward with a missionary in his own
   * shire has no reason to want him gone, and no printed way to do it.
   */
  'drive-out-missionaries': {
    phases: ['encounter'],
    actor: 'player',
    label: 'Drive out the missionaries',
    note: 'One momentum. The cross comes down.',
    fields: (state, data, roleId) => [{
      name: 'shireId',
      label: 'Which shire',
      kind: 'select',
      options: stewarded(state, data, roleId)
        .filter(({ value }) => state.shires[value]?.missionaryCross),
    }],
    admit(ctx) {
      const roleId = subjectOf(ctx);
      if (!isDanish(ctx.state, ctx.data, roleId)) return no('only Danes drive out missionaries');
      const reason = affordable(ctx.state.roles[roleId], { momentum: 1 });
      if (reason) return no(reason);
      const shire = ctx.state.shires[ctx.cmd.payload?.shireId];
      if (!shire) return no('no such shire');
      if (shire.stewardRoleId !== roleId) return no('you do not control that shire');
      if (!shire.missionaryCross) return no('there are no missionaries there');
      return ok();
    },
    effects(draft, ctx) {
      spend(draft.roles[subjectOf(ctx)], { momentum: 1 });
      draft.shires[ctx.cmd.payload.shireId].missionaryCross = false;
    },
  },

  // --- trade contracts -----------------------------------------------------
  /**
   * The trader proposes a contract on one of the three named shires.
   *
   * There are exactly three cards — Wrekinsets, Kent and the West Country —
   * and the trader holds all of them. The deal costs a soldier from each side
   * and pays each of them two silver every maintenance phase thereafter, so it
   * is the one arrangement in the game that is plainly good for both parties
   * and still has to be negotiated, because the steward is usually a Saxon
   * being asked to garrison a Danish trade route.
   *
   * Offering costs nothing. The soldiers are handed over on acceptance, which
   * is when the deal exists.
   */
  'offer-contract': {
    phases: TRADEABLE_PHASES,
    actor: 'player',
    label: 'Offer a trade contract',
    note: 'A soldier each. Then two silver each, every turn.',
    fields: (state, data, roleId) => {
      const taken = new Set(Object.values(state.contracts ?? {})
        .filter((c) => c.status === 'active' || c.status === 'offered')
        .map((c) => c.shireId));
      return [{
        name: 'shireId',
        label: 'Contract for',
        kind: 'select',
        options: (data.meta.tradeContractShires ?? [])
          // A steward to sign it, and one the Team Phase would let her talk to.
          .filter((id) => !taken.has(id) && state.shires?.[id]?.stewardRoleId
            && dealable(state, roleId, state.shires[id].stewardRoleId))
          .map((id) => ({
            value: id,
            label: `${shireName(data, id)} — ${
              data.roles.roles[state.shires[id].stewardRoleId]?.name ?? 'its steward'}`,
          })),
      }];
    },
    // A card she could actually lay down, first. Asking after the first
    // printed shire regardless would grey the whole verb out over a Mercian
    // she may not deal with this phase, or over a contract she has already
    // offered, while the card still in her hand is perfectly legal — so the
    // probe has to answer "is there any offer at all?", not "is this one
    // particular offer good?".
    probe: (state, data, roleId) => {
      const shires = contractShires(data);
      const offerable = shires.find((id) => {
        const steward = state.shires[id]?.stewardRoleId;
        return steward && steward !== roleId
          && !dealingReason(state, roleId, steward)
          && !contractOn(state, id);
      });
      return { shireId: offerable ?? shires[0] };
    },
    admit(ctx) {
      const roleId = subjectOf(ctx);
      if (ctx.data.roles.roles[roleId]?.archetype !== 'danish_trader') {
        return no('only the Danish Trader holds the contracts');
      }
      const { shireId } = ctx.cmd.payload ?? {};
      if (!ctx.data.meta.tradeContractShires.includes(shireId)) {
        return no(`there is no contract for ${pretty(shireId ?? 'that')}`);
      }
      const steward = ctx.state.shires[shireId]?.stewardRoleId;
      if (!steward) return no('nobody stewards it, so there is nobody to sign');
      if (steward === roleId) return no('you cannot contract with yourself');
      // Usually a Saxon on the other side of the table, so usually a bargain
      // for a phase when the two of you are in the same room.
      const across = dealingReason(ctx.state, roleId, steward);
      if (across) return across;
      const existing = contractOn(ctx.state, shireId);
      if (existing?.status === 'active') return no('that contract is already running');
      if (existing?.status === 'offered') return no('you have already offered that one');
      const reason = affordable(ctx.state.roles[roleId], { soldiers: 1 });
      return reason ? no(reason) : ok();
    },
    effects(draft, ctx) {
      const roleId = subjectOf(ctx);
      const { shireId } = ctx.cmd.payload;
      // A re-offer after a cancellation is a new deal, so the old record stays
      // where it is and this one goes on the end.
      draft.contracts.push({
        id: `contract:${shireId}:${draft.contracts.length + 1}`,
        shireId,
        traderRoleId: roleId,
        stewardRoleId: draft.shires[shireId].stewardRoleId,
        status: 'offered',
      });
    },
  },

  /**
   * The steward signs, or does not.
   *
   * Both soldiers are taken here and the shire's ship value drops by two,
   * which is the part everybody else notices: a contracted port is cheaper to
   * reach by sea, for the enemy as much as for the trader.
   */
  'answer-contract': {
    phases: TRADEABLE_PHASES,
    actor: 'player',
    label: 'Answer a trade offer',
    note: 'It costs you a soldier, and opens your port.',
    fields: (state, data, roleId) => [
      {
        name: 'contractId',
        label: 'Their offer',
        kind: 'select',
        options: Object.values(state.contracts ?? {})
          // Answering is dealing, so an offer from across the lines is not
          // his to answer until the room is back together.
          .filter((c) => c.status === 'offered'
            && state.shires?.[c.shireId]?.stewardRoleId === roleId
            && dealable(state, roleId, c.traderRoleId))
          .map((c) => ({
            value: c.id,
            label: `${shireName(data, c.shireId)} — from ${
              data.roles.roles[c.traderRoleId]?.name ?? 'the trader'}`,
          })),
      },
      {
        name: 'accept',
        label: 'Well?',
        kind: 'select',
        options: [
          { value: 'yes', label: 'sign it — a soldier each' },
          { value: '', label: 'no thank you' },
        ],
      },
    ],
    toPayload: (values) => ({ ...values, accept: values.accept === 'yes' }),
    // An offer on a shire this player stewards, so the action does not appear
    // on everybody's list refused for a reason about somebody else's deal —
    // and one whose trader is his to answer today, so an offer from across the
    // lines does not hide one from his own side during the Team Phase.
    probe: (state, data, roleId) => {
      const his = state.contracts.filter((c) => c.status === 'offered'
        && state.shires[c.shireId]?.stewardRoleId === roleId);
      const answerable = his.find((c) => !dealingReason(state, roleId, c.traderRoleId));
      return { contractId: (answerable ?? his[0])?.id, accept: true };
    },
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const contract = findContract(ctx.state, ctx.cmd.payload?.contractId);
      if (!contract) return no('no such contract');
      if (contract.status !== 'offered') return no('that offer is no longer open');
      if (ctx.state.shires[contract.shireId]?.stewardRoleId !== roleId) {
        return no('it is not yours to sign');
      }
      // Signing is dealing, and so is refusing to: both are answers given to
      // the trader's face, which the Team Phase is not the time for.
      const across = dealingReason(ctx.state, roleId, contract.traderRoleId);
      if (across) return across;
      if (typeof ctx.cmd.payload?.accept !== 'boolean') return no('sign it or do not');
      if (!ctx.cmd.payload.accept) return ok();
      // Both sides pay a soldier, so a trader who has spent his since offering
      // cannot sign either.
      for (const who of [roleId, contract.traderRoleId]) {
        const reason = affordable(ctx.state.roles[who], { soldiers: 1 });
        if (reason) {
          return no(who === roleId ? reason
            : `${pretty(ctx.data.roles.roles[contract.traderRoleId]?.name ?? 'the trader')}`
              + ' has no soldier left to send');
        }
      }
      return ok();
    },
    effects(draft, ctx, { data }) {
      const roleId = subjectOf(ctx);
      const contract = findContract(draft, ctx.cmd.payload.contractId);
      if (!ctx.cmd.payload.accept) { contract.status = 'declined'; return; }
      activateContract(draft, data, contract, roleId);
    },
  },

  /**
   * Either party tears it up.
   *
   * "Either party can cancel this contract at any time during the Team Phase
   * by handing this contract to an organiser" — so the window is printed, and
   * the ship value goes back up when it closes.
   *
   * Cancellation rights follow the current steward rather than whoever signed.
   * A shire that changes hands takes its contract with it, which is also how
   * the income works.
   *
   * Alone among the deals, this one is not held to your own faction. It is
   * Team-Phase-only by printed rule, and a contract is cross-faction by
   * nature — a Dane's card in a Saxon's shire — so a faction gate here would
   * make every contract in the game permanently uncancellable. Tearing one up
   * is also not a bargain: nobody's agreement is being asked for.
   */
  'cancel-contract': {
    phases: ['team'],
    actor: 'player',
    label: 'Cancel a trade contract',
    note: 'Team Phase only. The ship value goes back up.',
    fields: (state, data, roleId) => [{
      name: 'contractId',
      label: 'Tear up',
      kind: 'select',
      options: Object.values(state.contracts ?? {})
        .filter((c) => c.status === 'active'
          && (c.traderRoleId === roleId
            || state.shires?.[c.shireId]?.stewardRoleId === roleId))
        .map((c) => ({ value: c.id, label: shireName(data, c.shireId) })),
    }],
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const contract = findContract(ctx.state, ctx.cmd.payload?.contractId);
      if (!contract) return no('no such contract');
      if (contract.status !== 'active') return no('that contract is not running');
      const steward = ctx.state.shires[contract.shireId]?.stewardRoleId;
      if (roleId !== contract.traderRoleId && roleId !== steward) {
        return no('you are not party to it');
      }
      return ok();
    },
    effects(draft, ctx, { data }) {
      cancelContract(draft, data, findContract(draft, ctx.cmd.payload.contractId),
        subjectOf(ctx));
    },
  },

  /**
   * Send missionaries into a Danish shire.
   *
   * A cross does three things at once, which is why one momentum is cheap for
   * it: the shire stops counting toward Paganism at the end, the priest may
   * reinforce there as though it were their own, and a Dane who is later
   * baptised gains a de jure claim on every Danish shire that has one. Sending
   * a missionary is how the church buys a claim it can cash years later.
   */
  'missionary-expedition': {
    phases: ['maintenance'],
    actor: 'player',
    label: 'Send missionaries',
    note: 'One momentum. The shire stops counting as pagan.',
    fields: (state, data) => [{
      name: 'shireId',
      label: 'Which shire',
      kind: 'select',
      options: Object.keys(state.shires ?? {})
        .filter((id) => isDanishHeld(state, data, id) && !state.shires[id].missionaryCross)
        .map((id) => ({ value: id, label: shireName(data, id) })),
    }],
    // The fields offer only shires with no cross yet, so once every Danish
    // shire is crossed they offer nothing and a derived probe would name no
    // shire at all — earning "no such shire", which reads to a player as a
    // broken app rather than as the game fact that the work is done. Falling
    // back to a crossed one gets the true answer instead.
    probe: (state, data) => {
      const danish = Object.keys(state.shires ?? {})
        .filter((id) => isDanishHeld(state, data, id));
      return { shireId: danish.find((id) => !state.shires[id].missionaryCross) ?? danish[0] };
    },
    admit(ctx) {
      const roleId = subjectOf(ctx);
      if (ctx.data.roles.roles[roleId]?.archetype !== 'saxon_priest') {
        return no('only a priest sends missionaries');
      }
      const reason = affordable(ctx.state.roles[roleId], { momentum: 1 });
      if (reason) return no(reason);

      const shire = ctx.state.shires[ctx.cmd.payload?.shireId];
      if (!shire) return no('no such shire');
      // "One occupied or settled Danish shire" — held by a Dane, or one they
      // have Settled. No adjacency, and no limit per turn.
      if (!isDanishHeld(ctx.state, ctx.data, shire.id)) {
        return no('missionaries go to Danish shires');
      }
      if (shire.missionaryCross) return no('a cross already stands there');
      return ok();
    },
    effects(draft, ctx) {
      spend(draft.roles[subjectOf(ctx)], { momentum: 1 });
      draft.shires[ctx.cmd.payload.shireId].missionaryCross = true;
    },
  },

  // --- encounter phase -----------------------------------------------------
  /** A momentum spent preaching puts a soldier in somebody else's hand. */
  'rousing-sermon': {
    phases: ['encounter'],
    actor: 'player',
    label: 'Preach a rousing sermon',
    note: 'One momentum. They gain a soldier.',
    fields: (state, data, roleId) => [{
      name: 'targetRoleId',
      label: 'Preach to',
      kind: 'select',
      options: others(state, data, roleId, (role) => isChristian(state, data, role.id)),
    }],
    admit(ctx) {
      const roleId = subjectOf(ctx);
      if (ctx.data.roles.roles[roleId]?.archetype !== 'saxon_priest') {
        return no('only a priest preaches');
      }
      const reason = affordable(ctx.state.roles[roleId], { momentum: 1 });
      if (reason) return no(reason);

      const target = ctx.cmd.payload?.targetRoleId;
      if (!ctx.state.roles[target]) return no('no such character');
      if (target === roleId) return no('preach to somebody else');
      if (!isChristian(ctx.state, ctx.data, target)) return no('they are not a Christian');
      return ok();
    },
    effects(draft, ctx) {
      spend(draft.roles[subjectOf(ctx)], { momentum: 1 });
      draft.roles[ctx.cmd.payload.targetRoleId].soldiers += 1;
    },
  },

  /**
   * Baptise a willing pagan.
   *
   * Free, as printed — the cost is that they have to agree, and a Dane agreeing
   * is the whole negotiation. What they get is a goal about Christian England
   * and a de jure claim on every Danish shire with a cross in it; what they
   * stop paying is the followers' upkeep. What they keep is their support in
   * shires they have Settled, since the printed rule says "Danes", not "pagan
   * Danes".
   *
   * The priest counts two extra churches for every baptism they perform, which
   * is what can push a faction over the ten that buys a third momentum.
   */
  baptise: {
    phases: ['encounter'],
    actor: 'player',
    label: 'Baptise a pagan',
    note: 'Free, but they must agree. Ends their upkeep.',
    fields: (state, data, roleId) => [
      {
        name: 'targetRoleId',
        label: 'Baptise',
        kind: 'select',
        options: Object.keys(state.roles ?? {})
          .filter((id) => isPagan(state, data, id))
          .map((id) => ({ value: id, label: roleName(data, id) })),
      },
      // Not a formality. A conversion agreed out loud is the whole
      // negotiation, and the app should never perform one without it — which
      // is why "go and ask them" comes first and the derived probe therefore
      // reports the verb refused until somebody has actually agreed.
      {
        name: 'willing',
        label: 'Have they agreed?',
        kind: 'select',
        options: [
          { value: '', label: 'not yet — go and ask them' },
          { value: 'yes', label: 'yes, they are willing' },
        ],
      },
    ],
    toPayload: (values) => ({ ...values, willing: values.willing === 'yes' }),
    admit(ctx) {
      const roleId = subjectOf(ctx);
      if (ctx.data.roles.roles[roleId]?.archetype !== 'saxon_priest') {
        return no('only a priest baptises');
      }
      const target = ctx.cmd.payload?.targetRoleId;
      if (!ctx.state.roles[target]) return no('no such character');
      if (!isPagan(ctx.state, ctx.data, target)) return no('they are already Christian');
      // "One willing pagan character". Willingness is agreed out loud and
      // confirmed here, so the app never converts anybody against their will.
      if (!ctx.cmd.payload?.willing) return no('they have to agree to it');
      return ok();
    },
    effects(draft, ctx, { data }) {
      const roleId = subjectOf(ctx);
      const convert = draft.roles[ctx.cmd.payload.targetRoleId];
      convert.baptised = true;
      // A de jure claim on every Danish shire the church has already reached.
      convert.deJureShires = Object.keys(draft.shires).filter(
        (id) => draft.shires[id].missionaryCross && isDanishHeld(draft, data, id));
      draft.roles[roleId].baptismsPerformed += 1;
    },
  },

  /**
   * Burn a settlement and carry off what it was worth.
   *
   * The one action that reaches on the faction's behalf rather than your own —
   * "a settlement in a shire adjacent to one your faction controls" — so a
   * landless Dane can raid beside a shire his jarl took, which is most of what
   * a landless Dane is for.
   *
   * Raiding is not gated on support, unlike income: a defended settlement that
   * pays its holder nothing is still perfectly worth burning.
   */
  'raid-settlement': {
    phases: ['encounter'],
    actor: 'player',
    label: 'Raid a settlement',
    note: 'Two momentum, and two soldiers if it is defended.',
    // Only what the faction can actually reach, so a player is not invited
    // to burn something on the other side of England. Defended settlements
    // are offered too: burning one costs two soldiers on top and is often
    // exactly what somebody wants to do.
    fields: (state, data, roleId) => {
      const reach = new Set(factionReach(state, data, state.roles?.[roleId]?.factionId));
      return [{
        name: 'target',
        label: 'Which settlement',
        kind: 'select',
        options: Object.entries(state.shires ?? {})
          .filter(([shireId]) => reach.has(shireId))
          .flatMap(([shireId, shire]) => Object.values(shire.settlements ?? {})
            .filter((s) => !s.destroyed)
            .map((s) => ({
              value: `${shireId}|${s.id}`,
              label: `${shireName(data, shireId)} — ${settlementLabel(s)}`,
            }))),
      }];
    },
    toPayload: (values) => {
      const [shireId, settlementId] = String(values.target ?? '').split('|');
      return { shireId, settlementId };
    },
    // The cheapest raid there is, rather than the first the dropdown lists.
    // A defended settlement costs two soldiers on top of the two momentum, so
    // a probe that happened to land on one would answer "not enough soldiers"
    // for a player who could perfectly well burn the undefended farm next
    // door — which is a refusal about the wrong question.
    probe: (state, data, roleId) => {
      const role = state.roles[roleId];
      for (const shireId of factionReach(state, data, role?.factionId)) {
        const target = Object.values(state.shires[shireId].settlements)
          .find((s) => !s.destroyed && !s.defended);
        if (target) return { shireId, settlementId: target.id };
      }
      return {};
    },
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const role = ctx.state.roles[roleId];
      const shire = ctx.state.shires[ctx.cmd.payload?.shireId];
      if (!shire) return no('no such shire');
      if (!factionReach(ctx.state, ctx.data, role.factionId).includes(shire.id)) {
        return no('your faction holds nothing next to that shire');
      }
      const settlement = shire.settlements[ctx.cmd.payload?.settlementId];
      if (!settlement) return no('no such settlement');
      if (settlement.destroyed) return no('somebody has already burned it');

      const cost = { momentum: 2, ...(settlement.defended ? { soldiers: 2 } : {}) };
      const reason = affordable(role, cost);
      return reason ? no(reason) : ok();
    },
    effects(draft, ctx, { data }) {
      const roleId = subjectOf(ctx);
      const role = draft.roles[roleId];
      const settlement = draft.shires[ctx.cmd.payload.shireId]
        .settlements[ctx.cmd.payload.settlementId];

      spend(role, { momentum: 2, ...(settlement.defended ? { soldiers: 2 } : {}) });
      settlement.destroyed = true;

      const spoils = data.meta.raidSpoils[settlement.type] ?? {};
      role.silver += spoils.silver ?? 0;
      role.food += spoils.food ?? 0;
    },
  },

  // --- encounter phase, diplomacy ------------------------------------------
  /**
   * Open a line to a power nobody plays.
   *
   * Every envoy action on every sheet ends the same way — "by talking to an
   * organiser" — because the deal is a conversation, not a table of prices.
   * So this does not buy anything. It buys the *conversation*: a private
   * thread with the facilitator, who speaks for the Franks and the Britons and
   * the Pope and will want something for whatever you are asking.
   *
   * A priest deals with Rome and pays in momentum; everyone else deals with
   * the secular powers and pays in silver, and Frida pays half because trade
   * is the whole of her character.
   */
  'send-envoy': {
    phases: ['encounter'],
    actor: 'player',
    label: 'Send an envoy',
    note: 'Buys a hearing, not a deal.',
    fields: (state, data, roleId) => [{
      name: 'npcFaction',
      label: 'To',
      kind: 'select',
      options: (envoyRules(data, roleId)?.to ?? [])
        .map((id) => ({ value: id, label: data.factions.npc[id]?.name ?? id })),
    }],
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const rules = envoyRules(ctx.data, roleId);
      if (!rules) return no('your archetype sends no envoys');

      const { npcFaction } = ctx.cmd.payload ?? {};
      if (!rules.to.includes(npcFaction)) {
        const names = rules.to.map((id) => ctx.data.factions.npc[id]?.name ?? id);
        return no(`you can send to ${names.join(', ')}`);
      }
      // One open thread per power: a second envoy to the same court is the
      // same conversation, and should join it rather than start a rival.
      if (openThread(ctx.state, roleId, npcFaction)) {
        return no('you already have that conversation open');
      }
      const reason = affordable(ctx.state.roles[roleId], rules.cost);
      return reason ? no(reason) : ok();
    },
    effects(draft, ctx, { data }) {
      const roleId = subjectOf(ctx);
      const { npcFaction } = ctx.cmd.payload;
      spend(draft.roles[roleId], envoyRules(data, roleId).cost);
      const id = `${roleId}:${npcFaction}:${Object.keys(draft.envoys).length + 1}`;
      draft.envoys[id] = {
        id,
        roleId,
        npcFaction,
        open: true,
        messages: [],
      };
    },
  },

  /** Say something down a thread you already have open. */
  'envoy-message': {
    phases: '*',
    actor: 'player',
    admit(ctx) {
      const thread = ctx.state.envoys[ctx.cmd.payload?.threadId];
      if (!thread) return no('no such conversation');
      if (thread.roleId !== subjectOf(ctx) && ctx.actor.kind !== 'facilitator') {
        return no('that conversation is not yours');
      }
      if (!thread.open) return no('that conversation is closed');
      const text = String(ctx.cmd.payload?.text ?? '').trim();
      if (!text) return no('say something');
      if (text.length > 2000) return no('that is too long to send');
      return ok();
    },
    effects(draft, ctx) {
      const thread = draft.envoys[ctx.cmd.payload.threadId];
      thread.messages.push({
        from: ctx.actor.kind === 'facilitator' ? thread.npcFaction : thread.roleId,
        text: String(ctx.cmd.payload.text).trim(),
        at: ctx.now,
      });
    },
  },

  /**
   * The facilitator answering as the Franks, or the Pope, or whoever.
   *
   * Their own verb rather than a flag on the player's, so the log reads as a
   * conversation between two parties and an audit can tell who said what.
   */
  'facilitator:envoy-reply': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      const thread = ctx.state.envoys[ctx.cmd.payload?.threadId];
      if (!thread) return no('no such conversation');
      return String(ctx.cmd.payload?.text ?? '').trim() ? ok() : no('say something');
    },
    effects(draft, ctx) {
      const thread = draft.envoys[ctx.cmd.payload.threadId];
      thread.messages.push({
        from: thread.npcFaction,
        text: String(ctx.cmd.payload.text).trim(),
        at: ctx.now,
      });
      thread.open = true;
    },
  },

  /** Close a thread once the deal is struck or refused. */
  'facilitator:envoy-close': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      return ctx.state.envoys[ctx.cmd.payload?.threadId] ? ok() : no('no such conversation');
    },
    effects(draft, ctx) {
      draft.envoys[ctx.cmd.payload.threadId].open = false;
    },
  },

  /**
   * Write down what was promised, and by whom.
   *
   * Foreign Influence is the one Aftermath counter with no number behind it —
   * it is the facilitator's account of what England sold to the Franks, the
   * Britons, the Danish Kings and Rome. Trying to remember four courts' worth
   * of bargains at the debrief is how that line ends up blank, so each is
   * written as it is struck.
   *
   * Promises are kept even when they are broken. A concession that was made
   * and then reneged on is struck through rather than deleted, because the
   * epilogue is about what England did, not about what is still true.
   */
  'facilitator:record-concession': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      const { npcFaction, roleId, text } = ctx.cmd.payload ?? {};
      if (!ctx.data.factions.npc[npcFaction]) return no('no such court');
      if (roleId && !ctx.state.roles[roleId]) return no('no such character');
      return String(text ?? '').trim() ? ok() : no('what was promised?');
    },
    effects(draft, ctx) {
      const { npcFaction, roleId, text } = ctx.cmd.payload;
      const id = `concession:${Object.keys(draft.concessions).length + 1}`;
      draft.concessions[id] = {
        id,
        npcFaction,
        roleId: roleId ?? null,
        text: String(text).trim(),
        turn: draft.phase.turn,
        at: ctx.now,
        kept: true,
      };
    },
  },

  /** Mark a promise broken, without pretending it was never made. */
  'facilitator:strike-concession': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      return ctx.state.concessions[ctx.cmd.payload?.concessionId] ? ok() : no('no such promise');
    },
    effects(draft, ctx) {
      draft.concessions[ctx.cmd.payload.concessionId].kept = false;
    },
  },

  // --- battle phase --------------------------------------------------------
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

  // --- facilitator ---------------------------------------------------------
  'facilitator:advance-phase': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      return ctx.state.phase.name === 'epilogue' ? no('the game is over') : ok();
    },
    effects(draft, ctx, { data }) {
      const at = PHASES.indexOf(draft.phase.name);
      if (draft.phase.name === 'lobby') {
        draft.phase.name = PHASES[0];
      } else if (at === PHASES.length - 1) {
        if (draft.phase.turn >= Number(data.meta.turns)) {
          draft.phase.name = 'epilogue';
        } else {
          draft.phase.turn += 1;
          draft.phase.name = PHASES[0];
          for (const role of Object.values(draft.roles)) {
            role.perTurn = { shipsBuilt: 0, tradesUsed: 0 };
          }
          draft.initiative.declared = {};
        }
      } else {
        draft.phase.name = PHASES[at + 1];
      }
      // Announcing the battle phase is what releases the team-scoped targets.
      if (draft.phase.name === 'battle') {
        for (const declaration of Object.values(draft.initiative.declared)) {
          declaration.revealed = true;
        }
      }
      draft.phase.paused = false;
      draft.phase.pausedRemainingMs = null;
      draft.phase.endsAt = phaseEndsAt(draft, data, ctx.cmd.payload, ctx.now);
    },
  },

  /**
   * Stop and restart the clock.
   *
   * Paused, the deadline means nothing, so what is left is stored instead and
   * a new deadline is worked out on the way back. Without that, a five-minute
   * pause to sort out a rules argument would eat the phase it interrupted.
   */
  'facilitator:pause-clock': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      return ctx.state.phase.endsAt === null && !ctx.state.phase.paused
        ? no('there is no clock running') : ok();
    },
    effects(draft, ctx) {
      if (draft.phase.paused) {
        draft.phase.endsAt = ctx.now + (draft.phase.pausedRemainingMs ?? 0);
        draft.phase.paused = false;
        draft.phase.pausedRemainingMs = null;
      } else {
        draft.phase.pausedRemainingMs = Math.max(0, draft.phase.endsAt - ctx.now);
        draft.phase.paused = true;
        draft.phase.endsAt = null;
      }
    },
  },

  /** Give a phase more time, or take some back. Minutes, plus or minus. */
  'facilitator:extend-clock': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      const minutes = Number(ctx.cmd.payload?.minutes);
      if (!Number.isFinite(minutes) || minutes === 0) return no('say how many minutes');
      return ctx.state.phase.endsAt === null && !ctx.state.phase.paused
        ? no('there is no clock running') : ok();
    },
    effects(draft, ctx) {
      const by = Number(ctx.cmd.payload.minutes) * 60_000;
      if (draft.phase.paused) {
        draft.phase.pausedRemainingMs = Math.max(0, (draft.phase.pausedRemainingMs ?? 0) + by);
      } else {
        draft.phase.endsAt = Math.max(ctx.now, draft.phase.endsAt + by);
      }
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
   * Call time.
   *
   * The game normally ends by running out of turns, but a room runs out of
   * evening first about as often. Ending it explicitly freezes the board so
   * the debrief is read off a position nobody can still be changing.
   */
  'facilitator:end-game': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      return ctx.state.phase.name === 'epilogue' ? no('the game is already over') : ok();
    },
    effects(draft, ctx) {
      draft.phase.name = 'epilogue';
      draft.phase.endsAt = null;
      draft.phase.paused = false;
      draft.phase.pausedRemainingMs = null;
      draft.aftermath.endedAt = ctx.now;
      draft.aftermath.endedOnTurn = draft.phase.turn;
    },
  },

  /**
   * The heir arrives.
   *
   * "If a character dies they return immediately with a replacement character
   * – usually their heir. They keep the same character sheet, but you should
   * change it in at least one of the following ways" — a goal, a claim, or the
   * foreign sympathies toward them.
   *
   * So death is not elimination and never was: the seat keeps playing, with
   * the same lands, soldiers and silver, as somebody else. The wounds go back
   * to zero because the new man has not been in a fight yet, and the crowns go
   * because "the new character will need to claim any crowns they want to
   * hold, even if their previous character already held them" — an election
   * won by a dead man does not bind the shires to his son.
   *
   * The three levers are the facilitator's, and they are the point of the
   * rule: it exists so the umpire can make a losing game interesting again.
   * The app records what they changed rather than deciding it.
   */
  'facilitator:heir-arrives': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      const role = ctx.state.roles[ctx.cmd.payload?.roleId];
      if (!role) return no('no such character');
      return ok();
    },
    effects(draft, ctx) {
      const { roleId, note, addClaim, dropClaim } = ctx.cmd.payload;
      const role = draft.roles[roleId];

      role.dead = false;
      role.wounds = 0;
      role.generation += 1;
      // Whatever crowns the father wore are back on the table.
      for (const [crown, who] of Object.entries(draft.crownHolders)) {
        if (who === roleId) delete draft.crownHolders[crown];
      }
      if (dropClaim) role.claims = role.claims.filter((crown) => crown !== dropClaim);
      if (addClaim && !role.claims.includes(addClaim)) role.claims.push(addClaim);
      // What the umpire changed, in their own words, for the epilogue.
      if (note) {
        draft.facilitatorNotes[`heir:${roleId}:${role.generation}`] = String(note);
      }
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
   * Nudge a number by an amount, rather than replacing it.
   *
   * The inspector used to read a value and write a replacement, which is
   * exactly wrong while players are also changing the game: a facilitator who
   * opens the panel, reads "12", and types "15" a few seconds later can undo
   * whatever a player spent in between, because "15" overwrites whatever is
   * there rather than adding three to it. A delta commutes — it is applied
   * against whatever the value actually is at the moment the command reaches
   * the reducer, not whatever it was when the facilitator looked — so it
   * cannot go stale between typing and committing.
   *
   * Refused rather than clamped if it would take the value below zero,
   * because a silently clamped edit is a facilitator being told "yes" to a
   * change that did not happen.
   */
  'facilitator:adjust': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      const { path, delta } = ctx.cmd.payload ?? {};
      if (!Array.isArray(path) || !path.length) return no('an adjustment needs a path');
      if (typeof delta !== 'number' || !Number.isFinite(delta)) {
        return no('say how much to change it by');
      }
      let at = ctx.state;
      for (const key of path.slice(0, -1)) {
        at = at?.[key];
        if (at === undefined || at === null) return no('no such value');
      }
      const current = at[path[path.length - 1]];
      if (typeof current !== 'number') return no('that is not a number');
      if (current + delta < 0) return no(`would go negative — it is ${current} right now`);
      return ok();
    },
    effects(draft, ctx) {
      const { path, delta } = ctx.cmd.payload;
      let at = draft;
      for (const key of path.slice(0, -1)) at = at[key];
      at[path[path.length - 1]] += delta;
    },
  },

  /**
   * Hand a shire to somebody, or to nobody, by fiat.
   *
   * A raw path override could set `stewardRoleId` alone and leave `factionId`
   * pointing at whoever used to hold it — a stale value nothing would notice
   * until the next thing that reads a shire's faction reads the wrong one.
   * This keeps the two in step the same way capture and `swearTo` already do.
   */
  'facilitator:set-steward': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      const { shireId, roleId } = ctx.cmd.payload ?? {};
      if (!ctx.state.shires[shireId]) return no('no such shire');
      if (roleId !== null && !ctx.state.roles[roleId]) return no('no such character');
      return ok();
    },
    effects(draft, ctx) {
      const { shireId, roleId } = ctx.cmd.payload;
      draft.shires[shireId].stewardRoleId = roleId;
      draft.shires[shireId].factionId = roleId ? draft.roles[roleId].factionId : null;
    },
  },

  /** Circle a settlement, or strike it out, without a player having done it. */
  'facilitator:set-settlement': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      const { shireId, settlementId, field, value } = ctx.cmd.payload ?? {};
      if (!ctx.state.shires[shireId]?.settlements[settlementId]) return no('no such settlement');
      if (!['defended', 'destroyed'].includes(field)) return no('nothing there by that name');
      if (typeof value !== 'boolean') return no('say yes or no');
      return ok();
    },
    effects(draft, ctx) {
      const { shireId, settlementId, field, value } = ctx.cmd.payload;
      draft.shires[shireId].settlements[settlementId][field] = value;
    },
  },

  /** Give a character a claim they were not printed with. */
  'facilitator:add-claim': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      const { roleId, crown } = ctx.cmd.payload ?? {};
      if (!ctx.state.roles[roleId]) return no('no such character');
      if (!ctx.data.factions.crownLetter[crown]) return no('no such crown');
      if (ctx.state.roles[roleId].claims.includes(crown)) return no('already claims it');
      return ok();
    },
    effects(draft, ctx) {
      draft.roles[ctx.cmd.payload.roleId].claims.push(ctx.cmd.payload.crown);
    },
  },

  /** Take one away. */
  'facilitator:remove-claim': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      const { roleId, crown } = ctx.cmd.payload ?? {};
      if (!ctx.state.roles[roleId]?.claims.includes(crown)) return no('does not claim it');
      return ok();
    },
    effects(draft, ctx) {
      const role = draft.roles[ctx.cmd.payload.roleId];
      role.claims = role.claims.filter((c) => c !== ctx.cmd.payload.crown);
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

  /**
   * Bring a role into a game already running.
   *
   * The console prefills resources, claims and stewardship from the printed
   * sheet before the facilitator ever sees this command — this just takes
   * whatever they finished editing and commits it in one piece, the same
   * shape createInitialState builds a role in at the very start.
   */
  'facilitator:add-role': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      const { roleId } = ctx.cmd.payload ?? {};
      if (!ctx.data.roles.roles[roleId]) return no('no such role in this game');
      if (ctx.state.roles[roleId]) return no('already in the game');
      return ok();
    },
    effects(draft, ctx, { data }) {
      const { roleId, resources = {}, claims, stewardship = [] } = ctx.cmd.payload;
      const printed = data.roles.roles[roleId];
      const liege = printed.liege && draft.roles[printed.liege] ? printed.liege : null;

      draft.roles[roleId] = {
        id: roleId,
        ...printed.start,
        wounds: 0,
        liegeId: liege,
        teamId: printed.team,
        factionId: liege ? draft.roles[liege].factionId : roleId,
        claims: claims ?? [...printed.claims],
        baptised: false,
        deJureShires: [],
        baptismsPerformed: 0,
        dead: false,
        generation: 0,
        once: { christianBanners: false, mercenary: false },
        mercenary: false,
        perTurn: { shipsBuilt: 0, tradesUsed: 0 },
        ...resources,
      };

      for (const shireId of stewardship) {
        if (!draft.shires[shireId]) continue;
        draft.shires[shireId].stewardRoleId = roleId;
        draft.shires[shireId].factionId = draft.roles[roleId].factionId;
      }
    },
  },

  /**
   * Take a role back out.
   *
   * Everything that could point at them is cleared rather than left dangling
   * — their shires, a seat that was playing them, a token, a crown, and
   * anyone who was sworn to them, who loses their liege exactly as though he
   * had died without an heir.
   */
  'facilitator:remove-role': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      return ctx.state.roles[ctx.cmd.payload?.roleId] ? ok() : no('not in the game');
    },
    effects(draft, ctx) {
      const { roleId } = ctx.cmd.payload;
      delete draft.roles[roleId];

      for (const shire of Object.values(draft.shires)) {
        if (shire.stewardRoleId !== roleId) continue;
        shire.stewardRoleId = null;
        shire.factionId = null;
      }
      for (const seat of Object.values(draft.seats)) {
        if (seat.roleId === roleId) seat.roleId = null;
      }
      for (const token of TOKENS) {
        if (draft.initiative[token] === roleId) draft.initiative[token] = null;
      }
      for (const crown of Object.keys(draft.crownHolders)) {
        if (draft.crownHolders[crown] === roleId) delete draft.crownHolders[crown];
      }
      for (const other of Object.values(draft.roles)) {
        if (other.liegeId !== roleId) continue;
        other.liegeId = null;
        other.factionId = other.id;
        for (const shire of Object.values(draft.shires)) {
          if (shire.stewardRoleId === other.id) shire.factionId = other.id;
        }
      }
    },
  },

  'facilitator:set': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      return Array.isArray(ctx.cmd.payload?.path) && ctx.cmd.payload.path.length
        ? ok() : no('an override needs a path');
    },
    effects(draft, ctx) {
      const { path, value } = ctx.cmd.payload;
      let at = draft;
      for (const key of path.slice(0, -1)) {
        if (at[key] === undefined) at[key] = {};
        at = at[key];
      }
      at[path[path.length - 1]] = value;
    },
  },
};

/**
 * What the next ship costs.
 *
 * The two archetypes price it differently, and the difference is the story:
 * a Saxon can only build in one of the three yards, cheaply for the first each
 * turn and dearly after. A Dane arrived by sea with his own shipwrights and
 * can build anywhere for three — or for two, once a turn, if he has taken a
 * yard from a Saxon.
 */
export function shipPrice(state, data, roleId) {
  const yard = holdsShipyard(state, roleId);
  const built = state.roles[roleId].perTurn.shipsBuilt;
  if (isDanish(state, data, roleId)) return yard && built === 0 ? 2 : 3;
  return built === 0 ? 2 : 4;
}

/**
 * What a verb is called, for the button that issues it.
 *
 * A verb nobody has named prints its own id, which is ugly enough that
 * somebody notices — better than a blank button nobody can identify.
 */
export function labelFor(verb) {
  return COMMANDS[verb]?.label ?? verb;
}

/**
 * The line under the button, or nothing.
 *
 * A note may be a function of the game rather than a sentence, because a few
 * of them are about a number somebody has only just set. See `rebellionNote`.
 */
export function noteFor(verb, state, data, roleId = state?.viewer?.roleId ?? null) {
  const note = COMMANDS[verb]?.note;
  return (typeof note === 'function' ? note(state, data, roleId) : note) ?? '';
}

/**
 * What this action still needs answered, given the game as this player sees it.
 *
 * `roleId` defaults to the viewer of a projection: a client asking what its
 * own player may choose is the common case, and a projection is state-shaped,
 * so the same functions answer for the host — which passes the role it means.
 *
 * @returns {Field[]} empty when the action is just a button
 */
export function fieldsFor(verb, state, data, roleId = state?.viewer?.roleId ?? null) {
  return COMMANDS[verb]?.fields?.(state, data, roleId) ?? [];
}

/**
 * Turn a filled-in form into the payload the command expects.
 *
 * Most verbs want exactly what was chosen. The few that do not say so on their
 * own spec, next to the fields whose values they are rewriting — a form hands
 * back strings, and a settlement is chosen as one option but admitted as two
 * keys.
 */
export function payloadFrom(verb, values) {
  const spec = COMMANDS[verb];
  return spec?.toPayload ? spec.toPayload(values) : values;
}

/**
 * A representative legal instance of this command, for `availableTo`.
 *
 * Derived from the fields, because a field's options are by construction ones
 * the game currently allows — so "is there any way to do this at all?" is
 * answered off the same list the player would be picking from, and there is no
 * second hand-written answer to drift away from it. It goes through
 * `payloadFrom` for the same reason the form does: a probe the command's own
 * `admit` would not recognise is worse than no probe at all.
 *
 * A spec may still write its own `probe` where the first option is not the
 * representative one — where the cheapest instance is not the first, or where
 * an empty dropdown should still be refused in the phase's own words rather
 * than with "no such thing". Each of those says why where it is written.
 */
export function probeFor(verb, state, data, roleId) {
  const spec = COMMANDS[verb];
  if (!spec) return {};
  if (spec.probe !== undefined) {
    return (typeof spec.probe === 'function'
      ? spec.probe(state, data, roleId) : spec.probe) ?? {};
  }
  const values = {};
  for (const field of fieldsFor(verb, state, data, roleId)) {
    values[field.name] = field.kind === 'number'
      ? field.value ?? field.min ?? 1
      : field.options?.[0]?.value;
  }
  return payloadFrom(verb, values);
}

/**
 * The shires this action could land on, for pointing at them on the map.
 *
 * Reads the same options the chooser itself renders, so a highlighted shire
 * can never disagree with what the dropdown actually offers — this has no
 * knowledge of its own, only the fields' options split on `|` where a target
 * names a settlement rather than a shire outright.
 *
 * @returns {string[]} shire ids, or empty for an action with no shire field
 */
export function shireTargetsFor(verb, state, data, roleId = state?.viewer?.roleId ?? null) {
  const field = fieldsFor(verb, state, data, roleId)
    .find((f) => f.name === 'shireId' || f.name === 'target');
  if (!field) return [];
  const ids = field.options.map((o) => String(o.value).split('|')[0]);
  return [...new Set(ids.filter((id) => data.shires.shires[id]))];
}

/** Commands a role could issue in this phase, whether or not they can afford them. */
export function commandsInPhase(phaseName) {
  return Object.entries(COMMANDS)
    .filter(([, spec]) => spec.phases === '*' || spec.phases.includes(phaseName))
    .map(([verb]) => verb);
}
