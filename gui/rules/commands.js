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
import { incomeFor } from './derive.js';

/** Phases in which resources may change hands. Not during a battle. */
const TRADEABLE_PHASES = ['team', 'maintenance', 'encounter'];

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
    phases: ['lobby'],
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

  'swear-allegiance': {
    phases: ['team'],
    actor: 'player',
    admit(ctx) {
      const roleId = subjectOf(ctx);
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

  // --- maintenance phase ---------------------------------------------------
  'collect-income': {
    phases: ['maintenance'],
    actor: 'player',
    admit(ctx) {
      return ctx.state.roles[subjectOf(ctx)].perTurn.collected
        ? no('you have already collected this turn') : ok();
    },
    effects(draft, ctx, { data }) {
      const roleId = subjectOf(ctx);
      const role = draft.roles[roleId];
      const income = incomeFor(draft, data, roleId);
      role.silver += income.silver;
      role.food += income.food;
      role.soldiers += income.soldiers;
      role.momentum = Math.min(data.meta.momentumCap, role.momentum + 2);
      role.perTurn.collected = true;
    },
  },

  'recruit-soldiers': {
    phases: ['maintenance'],
    actor: 'player',
    admit(ctx) {
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
      const role = ctx.state.roles[subjectOf(ctx)];
      const reason = affordable(role, { silver: shipPrice(ctx.state, ctx.data, subjectOf(ctx)) });
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

  trade: {
    phases: TRADEABLE_PHASES,
    actor: 'player',
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
    admit: ok,
    effects(draft, ctx) {
      const at = PHASES.indexOf(draft.phase.name);
      if (draft.phase.name === 'lobby') {
        draft.phase.name = PHASES[0];
      } else if (at === PHASES.length - 1) {
        draft.phase.turn += 1;
        draft.phase.name = PHASES[0];
        for (const role of Object.values(draft.roles)) {
          role.perTurn = { shipsBuilt: 0, tradesUsed: 0 };
        }
        draft.initiative.declared = {};
      } else {
        draft.phase.name = PHASES[at + 1];
      }
      // Announcing the battle phase is what releases the team-scoped targets.
      if (draft.phase.name === 'battle') {
        for (const declaration of Object.values(draft.initiative.declared)) {
          declaration.revealed = true;
        }
      }
      draft.phase.endsAt = ctx.cmd.payload?.endsAt ?? null;
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
 * What the next ship costs. Two silver for the first of the turn, four after,
 * and the discount belongs to the stewards of the three shipbuilding shires.
 */
export function shipPrice(state, data, roleId) {
  const yards = ['wiltshire', 'lundenwic', 'jorvik'];
  const isShipwright = yards.some((id) => state.shires[id]?.stewardRoleId === roleId);
  const danish = data.factions.danishArchetypes.includes(data.roles.roles[roleId].archetype);
  const first = danish ? (isShipwright ? 2 : 3) : 2;
  if (danish) return first;
  return state.roles[roleId].perTurn.shipsBuilt === 0 && isShipwright ? first : 4;
}

/** Commands a role could issue in this phase, whether or not they can afford them. */
export function commandsInPhase(phaseName) {
  return Object.entries(COMMANDS)
    .filter(([, spec]) => spec.phases === '*' || spec.phases.includes(phaseName))
    .map(([verb]) => verb);
}
