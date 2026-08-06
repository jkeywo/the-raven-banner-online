/**
 * gui/rules/commands/lobby.js — taking a chair, at any point in the evening.
 *
 * One verb, and it is on its own because it is the only one that runs before
 * its issuer is anybody. Every other command in the game asks what a character
 * may do; this one asks what a *seat* may do, and the exemption that lets a
 * roleless player issue it would be an odd footnote sitting in the middle of a
 * fragment about shires and soldiers.
 */

import { seatHolding } from '../state.js';
import { no, ok } from './shared.js';

export const LOBBY_COMMANDS = {
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
};
