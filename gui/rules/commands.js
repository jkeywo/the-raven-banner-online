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
import { incomeFor, isDanish, isPagan, momentumGain } from './derive.js';

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
   * homage is a feudal matter that needs the other party's agreement, so it
   * goes through a facilitator, who is the one who heard them agree.
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
      const to = ctx.cmd.payload?.liegeId;
      if (to !== null && !ctx.state.roles[to]) return no('no such liege');
      if (to === roleId) return no('you cannot be your own liege');
      // A cycle would make the support rule walk forever, and the paper game
      // has no notion of two people each owing the other.
      let at = to;
      const seen = new Set([roleId]);
      while (at) {
        if (seen.has(at)) return no('that would make the chain of homage a circle');
        seen.add(at);
        at = ctx.state.roles[at]?.liegeId ?? null;
      }
      return ok();
    },
    effects(draft, ctx) {
      draft.roles[subjectOf(ctx)].liegeId = ctx.cmd.payload.liegeId;
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

      // The Danish Trader is paid for every contract that is in use.
      if (data.roles.roles[roleId]?.archetype === 'danish_trader') {
        role.silver += 2 * draft.contracts.filter((c) => c.active).length;
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
