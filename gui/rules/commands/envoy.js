/**
 * gui/rules/commands/envoy.js — the four courts nobody plays, and what was
 * promised to them.
 *
 * Every envoy action on every printed sheet ends "by talking to an organiser",
 * so none of this is a table of prices: it is a private conversation with the
 * facilitator, who speaks for the Franks and the Britons and the Danish Kings
 * and Rome. The verbs here open a thread, say something down it, answer as the
 * court, and close it.
 *
 * The concessions ledger lives here rather than with the epilogue that reads
 * it, because a promise is written down at the moment it is struck — in the
 * middle of the conversation that struck it — and Foreign Influence is the one
 * Aftermath counter with no number behind it. Trying to remember four courts'
 * worth of bargains at the debrief is how that line ends up blank.
 */

import { affordable, no, ok, spend, subjectOf } from './shared.js';

/** Who this archetype may send envoys to, and what it costs them. */
const envoyRules = (data, roleId) =>
  data.factions.envoy?.[data.roles.roles[roleId]?.archetype] ?? null;

/** An open conversation between this role and this court, if there is one. */
const openThread = (state, roleId, npcFaction) =>
  Object.values(state.envoys).find(
    (thread) => thread.roleId === roleId && thread.npcFaction === npcFaction && thread.open,
  ) ?? null;

export const ENVOY_COMMANDS = {
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
};
