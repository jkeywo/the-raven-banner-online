/**
 * gui/rules/commands.js — every way the game can change, in one registry.
 *
 * A command declares which phases it belongs to, who may issue it, whether it
 * is legal right now (`admit`), and what it does (`effects`). Nothing mutates
 * state anywhere else.
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

import { PHASES, seatHolding } from './state.js';
import {
  incomeFor, isDanish, isPagan, isChristian, isDanishHeld, momentumGain,
  reachableFrom, factionReach, churchesHeld, electorate,
} from './derive.js';
import {
  advanceClash, amendLead, confirmLead, sidesOf, resolveClash, MAX_REINFORCEMENT,
} from './clash.js';
import { pairSides, defendedSettlements, settleBattle, seizeInitiative } from './battle.js';

/** Phases in which resources may change hands. Not during a battle. */
const TRADEABLE_PHASES = ['team', 'maintenance', 'encounter'];

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

/** What a rebellion costs this vassal, after any relief the umpire has granted. */
export function rebellionCost(state, roleId) {
  const relief = state.rebellionRelief?.[roleId];
  return { shires: relief?.shires ?? 1, soldiers: relief?.soldiers ?? 2 };
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

function spend(role, costs) {
  for (const [what, amount] of Object.entries(costs)) role[what] -= amount;
}

export const COMMANDS = {
  // --- lobby ---------------------------------------------------------------
  'claim-role': {
    // Any phase, not just the lobby. People arrive late, drop out, and get
    // reseated onto a character whose player has gone home — a game that can
    // only be joined before it starts is not one that survives a real evening.
    phases: '*',
    actor: 'player',
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
    probe: (state) => ({ shireId: Object.keys(state.shires)[0] }),
    admit(ctx) {
      const { state, cmd } = ctx;
      const roleId = subjectOf(ctx);
      const token = Object.keys(state.initiative)
        .find((k) => ['white', 'black', 'bonus'].includes(k) && state.initiative[k] === roleId);
      if (!token) return no('you do not hold an initiative token');
      // Turn one is written down for you. From turn two it is your problem,
      // which is exactly the moment the game hands the plan over.
      if (state.initiative.declared[token]?.fixed) {
        return no('this turn\'s target is fixed by the rules');
      }
      if (!state.shires[cmd.payload?.shireId]) return no('no such shire');
      return ok();
    },
    effects(draft, ctx) {
      const roleId = subjectOf(ctx);
      const token = ['white', 'black', 'bonus'].find((k) => draft.initiative[k] === roleId);
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
    // Standing alone is always an option, so it answers the question.
    probe: { liegeId: null },
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
    probe: (state, data) => ({
      liegeId: Object.keys(state.roles).find((id) => isDanish(state, data, id)),
    }),
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
    probe: (state, data, roleId) => ({ crown: state.roles[roleId]?.claims?.[0] }),
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
   * Break with your liege.
   *
   * "Cost: Transfer one shire and two soldiers to your liege. This cost will be
   * reduced (potentially down to zero) by the organisers if the liege has lost
   * the favour of God."
   *
   * So the price is a facilitator's judgement as much as a rule, and the relief
   * is set separately and in the open — a vassal should be able to see what
   * rebelling would cost before deciding to do it.
   */
  rebel: {
    phases: ['team'],
    actor: 'player',
    probe: (state, data, roleId) => ({
      shireId: Object.keys(state.shires).find((id) => state.shires[id].stewardRoleId === roleId),
    }),
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const liege = ctx.state.roles[roleId]?.liegeId;
      if (!liege) return no('you answer to nobody already');
      const cost = rebellionCost(ctx.state, roleId);
      const reason = affordable(ctx.state.roles[roleId], { soldiers: cost.soldiers });
      if (reason) return no(reason);
      if (cost.shires === 0) return ok();
      const shire = ctx.state.shires[ctx.cmd.payload?.shireId];
      const held = Object.values(ctx.state.shires).filter((s) => s.stewardRoleId === roleId);
      // A landless vassal cannot hand over a shire, and the paper rule does not
      // ask them to. They pay the soldiers and go.
      if (held.length === 0) return ok();
      if (!shire) return no('name the shire you are giving up');
      if (shire.stewardRoleId !== roleId) return no('that is not yours to give');
      return ok();
    },
    effects(draft, ctx) {
      const roleId = subjectOf(ctx);
      const role = draft.roles[roleId];
      const liegeId = role.liegeId;
      const cost = rebellionCost(draft, roleId);

      role.soldiers -= cost.soldiers;
      draft.roles[liegeId].soldiers += cost.soldiers;
      const shireId = ctx.cmd.payload?.shireId;
      if (cost.shires > 0 && shireId && draft.shires[shireId]?.stewardRoleId === roleId) {
        draft.shires[shireId].stewardRoleId = liegeId;
        draft.shires[shireId].factionId = draft.roles[liegeId].factionId;
      }

      // "You leave your faction, which means you are free to swear a new
      // allegiance, claim a crown or remain independent." A faction of one is
      // still a faction, and it is his.
      role.liegeId = null;
      role.factionId = roleId;
      for (const shire of Object.values(draft.shires)) {
        if (shire.stewardRoleId === roleId) shire.factionId = roleId;
      }
      // The relief was a ruling about one rebellion, not a standing rate.
      delete draft.rebellionRelief[roleId];
    },
  },

  /**
   * What this rebellion will cost, if the umpire has heard enough to lower it.
   *
   * Set in the open and before the fact, because a price a vassal cannot see
   * is not a price they can weigh.
   */
  'facilitator:set-rebellion-relief': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      const { roleId, shires, soldiers } = ctx.cmd.payload ?? {};
      if (!ctx.state.roles[roleId]) return no('no such character');
      if (![0, 1].includes(shires)) return no('a rebellion costs one shire or none');
      if (!Number.isInteger(soldiers) || soldiers < 0 || soldiers > 2) {
        return no('a rebellion costs between none and two soldiers');
      }
      return ok();
    },
    effects(draft, ctx) {
      const { roleId, shires, soldiers, note } = ctx.cmd.payload;
      draft.rebellionRelief[roleId] = { shires, soldiers, note: note ?? '' };
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
    // "Do I hold a shire, and is there anyone to hand it to?"
    probe: (state, data, roleId) => ({
      shireId: Object.keys(state.shires).find((id) => state.shires[id].stewardRoleId === roleId),
      toRoleId: Object.keys(state.roles).find((id) => id !== roleId),
    }),
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
   */
  give: {
    phases: TRADEABLE_PHASES,
    actor: 'player',
    // "Is there anyone to give anything to, and anything to give?"
    probe: (state, data, roleId) => {
      const to = Object.keys(state.roles).find((id) => id !== roleId);
      const what = TRADEABLE.find((kind) => (state.roles[roleId]?.[kind] ?? 0) > 0);
      return { toRoleId: to, what, amount: 1 };
    },
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const { toRoleId, what, amount } = ctx.cmd.payload ?? {};
      if (!ctx.state.roles[toRoleId]) return no('no such character');
      if (toRoleId === roleId) return no('you already have it');
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
    // "Is there a settlement anywhere I could circle?"
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
    phases: TRADEABLE_PHASES,
    actor: 'player',
    // What "could you trade at all?" means, for an action list asking without
    // a player having chosen a direction yet. Selling food is the cheaper of
    // the two, so it is the one that answers the question honestly.
    probe: { give: 'food' },
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
    probe: (state, data, roleId) => ({
      shireId: Object.keys(state.shires).find((id) => state.shires[id].stewardRoleId === roleId),
    }),
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
    probe: (state, data, roleId) => {
      for (const [shireId, shire] of Object.entries(state.shires)) {
        if (shire.stewardRoleId !== roleId) continue;
        const ruin = Object.values(shire.settlements).find((s) => s.destroyed);
        if (ruin) return { shireId, settlementId: ruin.id };
      }
      return {};
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
    probe: (state, data, roleId) => ({
      shireId: Object.keys(state.shires).find((id) => state.shires[id].stewardRoleId === roleId),
    }),
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
    probe: (state, data, roleId) => ({
      shireId: Object.keys(state.shires).find(
        (id) => state.shires[id].missionaryCross && state.shires[id].stewardRoleId === roleId),
    }),
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
    probe: (state, data) => ({ shireId: contractShires(data, state)[0] }),
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
    // An offer on a shire this player stewards, so the action does not appear
    // on everybody's list refused for a reason about somebody else's deal.
    probe: (state, data, roleId) => ({
      contractId: state.contracts.find((c) => c.status === 'offered'
        && state.shires[c.shireId]?.stewardRoleId === roleId)?.id,
      accept: true,
    }),
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const contract = findContract(ctx.state, ctx.cmd.payload?.contractId);
      if (!contract) return no('no such contract');
      if (contract.status !== 'offered') return no('that offer is no longer open');
      if (ctx.state.shires[contract.shireId]?.stewardRoleId !== roleId) {
        return no('it is not yours to sign');
      }
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
   */
  'cancel-contract': {
    phases: ['team'],
    actor: 'player',
    probe: (state, data, roleId) => ({
      contractId: state.contracts.find((c) => c.status === 'active'
        && (c.traderRoleId === roleId
          || state.shires[c.shireId]?.stewardRoleId === roleId))?.id,
    }),
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
    probe: (state, data, roleId) => ({
      shireId: Object.keys(state.shires).find((id) => isDanishHeld(state, data, id)),
    }),
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
    probe: (state, data, roleId) => ({
      targetRoleId: Object.keys(state.roles).find(
        (id) => id !== roleId && isChristian(state, data, id)),
    }),
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
    probe: (state, data, roleId) => ({
      targetRoleId: Object.keys(state.roles).find((id) => isPagan(state, data, id)),
    }),
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
    probe: (state, data, roleId) => ({
      npcFaction: envoyRules(data, roleId)?.to?.[0],
    }),
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
    probe: (state) => ({ shireId: state.battle.targets[0] }),
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
    admit: ok,
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
   * Roll a clash and apply what it costs.
   *
   * Facilitator-driven so the dice happen when the room is ready for them, and
   * so a clash whose fighter has walked away can still be finished.
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
      for (const roleId of sidesOf(clash)) clash.rolls[roleId] = roll(6);

      const outcome = resolveClash(clash, data, {
        defendedSettlements: defendedSettlements(draft, clash.shireId),
        food: Object.fromEntries(sidesOf(clash).map((id) => [id, draft.roles[id].food])),
      });

      for (const roleId of sidesOf(clash)) {
        const role = draft.roles[roleId];
        role.soldiers = Math.max(0, role.soldiers - outcome.casualties[roleId]);
        role.food -= outcome.feeding[roleId].foodSpent;
        role.soldiers = Math.max(0, role.soldiers - outcome.feeding[roleId].starved);
        role.wounds += outcome.wounds[roleId];
        if (role.wounds >= Number(data.meta.woundsFatal)) role.dead = true;
        // Reinforcing soldiers are spent whatever happens.
        const committed = clash.reinforcements[roleId];
        if (committed) draft.roles[roleId].soldiers = Math.max(0, role.soldiers - committed);
      }
      // A reinforcing player is not in the clash, so their soldiers are taken
      // here rather than in the loop above.
      for (const [roleId, soldiers] of Object.entries(clash.reinforcements)) {
        if (sidesOf(clash).includes(roleId)) continue;
        draft.roles[roleId].soldiers = Math.max(0, draft.roles[roleId].soldiers - soldiers);
      }

      clash.result = outcome;
      clash.stage = 'resolved';
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

  /** Count the clashes and move the board. */
  'facilitator:settle-battle': {
    phases: ['battle'],
    actor: 'facilitator',
    admit(ctx) {
      const shireId = ctx.cmd.payload?.shireId;
      if (!ctx.state.battle.targets.includes(shireId)) return no('no battle was fought there');
      return ok();
    },
    effects(draft, ctx) {
      settleBattle(draft, ctx.data, ctx.cmd.payload.shireId,
        { newSteward: ctx.cmd.payload.newSteward ?? null });
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
        mercenaries: {}, pairingComplete: false };
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

/** Commands a role could issue in this phase, whether or not they can afford them. */
export function commandsInPhase(phaseName) {
  return Object.entries(COMMANDS)
    .filter(([, spec]) => spec.phases === '*' || spec.phases.includes(phaseName))
    .map(([verb]) => verb);
}
