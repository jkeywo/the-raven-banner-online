/**
 * gui/rules/commands/facilitator.js — the umpire's hands, on the same pipeline
 * as everybody else's.
 *
 * What is left once each domain has kept the overrides that belong to it: the
 * clock, the end of the game, the heir who arrives, and the pencil that edits
 * the board directly. These have no domain of their own — they are the umpire
 * acting on the game as a whole — which is exactly why they are together, and
 * why a facilitator verb that *is* about a domain (answering a consent round,
 * pricing a rebellion, forcing a clash) is filed with that domain instead.
 *
 * None of it bypasses the reducer. An override that wrote to state directly
 * would be invisible to the log and would break replay, and replay is what
 * makes a crashed host recoverable — so these are commands like any other,
 * whose `admit` simply always says yes.
 */

import { PHASES, TOKENS, OUT_OF_PLAY } from '../state.js';
import { no, ok } from './shared.js';

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

export const FACILITATOR_COMMANDS = {
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
      // The two ends of the game are held at nothing by definition, so there
      // is no clock there either — and starting the pregame's would run a
      // zero-second phase straight into overtime and beep at a room that has
      // not sat down. "Next phase" is how the pregame is left.
      if (OUT_OF_PLAY.includes(ctx.state.phase.name)) return no('there is no clock running');
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
      // The two ends of the game are held at nothing by definition, so there
      // is no clock there either — and starting the pregame's would run a
      // zero-second phase straight into overtime and beep at a room that has
      // not sat down. "Next phase" is how the pregame is left.
      if (OUT_OF_PLAY.includes(ctx.state.phase.name)) return no('there is no clock running');
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

  /**
   * Clear a seat out of the roster, freeing whatever it was playing.
   *
   * Not the same job as remove-role, and the difference is the whole point.
   * remove-role takes a *character* out of the game and cascades: their shires
   * go unheld, their vassals lose a liege. This takes a *person* out of the
   * chair and touches nothing on the board — the character stays exactly as
   * they were, lands, silver and all, waiting for somebody else to pick them
   * up. Half a game in, that is almost always what an umpire means: a laptop
   * died, a player went home, and Cenred still holds two shires that somebody
   * at the table would like to play.
   *
   * The token goes with the seat. Leaving it would let the browser that owned
   * it resume straight back into a chair the facilitator has just cleared,
   * which is the one thing this command exists to prevent. A player who is
   * genuinely still there rejoins as a new seat and takes a character again,
   * which is the same road every late arrival walks.
   *
   * It does not refuse a connected seat. "Disconnected" is what the console
   * offers the button for, but connection is a guess about a network and not
   * a fact about a person: a seat can read as connected because a tab is open
   * on a laptop in a bag. The umpire is looking at the room and this panel is
   * the pencil, so it does what it is told and asks first.
   */
  'facilitator:remove-seat': {
    phases: '*',
    actor: 'facilitator',
    admit(ctx) {
      return ctx.state.seats[ctx.cmd.payload?.seatId] ? ok() : no('no such seat');
    },
    effects(draft, ctx) {
      const { seatId } = ctx.cmd.payload;
      delete draft.seats[seatId];
      for (const [token, id] of Object.entries(draft.seatByToken)) {
        if (id === seatId) delete draft.seatByToken[token];
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
