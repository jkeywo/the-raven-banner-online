/**
 * gui/rules/commands/consent.js — the things one player cannot do alone.
 *
 * A consent request is a standing question held in state: somebody asks,
 * several people answer, and the request carries or fails once the answer is
 * no longer in doubt. Settling a shire needs every neighbouring steward;
 * Saxon homage needs the one person being sworn to. They share the machinery
 * because they are the same shape, and keeping the machinery next to the verbs
 * that open and answer a round is what stops a second, subtly different
 * "have they all said yes yet?" appearing beside the next agreement type.
 *
 * The verbs the facilitator uses to answer for somebody who has wandered off
 * live here too, rather than with the other overrides: they are the same
 * question asked by a different mouth.
 */

import { isDanish } from '../derive.js';
import { affordable, no, ok, stewarded, subjectOf } from './shared.js';
import { swearTo } from './feudal.js';

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
 * The kinds of agreement this machinery can carry, and what carrying means.
 *
 * `resolveConsent` decides *whether* a round carried — everybody answered, and
 * nobody said no — which is the same question whatever was being asked. What
 * happens next is not the same question at all: homage moves a liege, settling
 * spends a Dane's momentum and puts defenders on two settlements. Those used to
 * be branches on `request.kind` inside the counting, which meant the next
 * agreement type (a crown vote is nearly this shape) would have been a third
 * branch in a function that has no business knowing about crowns.
 *
 * So each kind declares its own `carry(draft, data, request)`, and the counting
 * delegates. A kind nobody has taught this table about resolves and does
 * nothing, which is what a round with no consequence should do.
 */
export const CONSENT_KINDS = {
  /**
   * A Saxon becomes somebody's man, once that somebody agrees.
   *
   * The whole of it, because homage is one write: `swearTo` moves the liege,
   * the faction, and the faction of every shire they steward together.
   */
  allegiance: {
    carry(draft, data, request) {
      swearTo(draft, request.roleId, request.liegeId);
    },
  },

  /**
   * A Dane puts down roots, once every neighbouring steward has agreed.
   *
   * This is where settling costs something. Nothing was spent while the round
   * was open — a refusal costs the asker only the time — so the price is paid
   * at the moment it carries and nowhere else.
   */
  settle: {
    carry(draft, data, request) {
      const role = draft.roles[request.roleId];
      role.momentum -= 1;
      role.soldiers -= 3;
      role.silver -= 5;

      const shire = draft.shires[request.shireId];
      shire.danishSupport = true;
      // "add defenders to two settlements of your choice" — the app takes the
      // two that are not already defended, which is the only choice worth
      // making.
      let toDefend = 2;
      for (const settlement of Object.values(shire.settlements)) {
        if (toDefend === 0) break;
        if (settlement.defended || settlement.destroyed) continue;
        settlement.defended = true;
        toDefend -= 1;
      }
    },
  },
};

/**
 * Close a consent request once its answer is no longer in doubt.
 *
 * One refusal is enough to end it — the requirement is consent from *all* of
 * them — so a neighbour who says no does not have to wait for the rest.
 *
 * Whether it carried is settled here; what carrying means is the kind's own
 * business. See `CONSENT_KINDS`.
 */
export function resolveConsent(draft, data, request) {
  const answers = Object.values(request.granted);
  const refused = answers.some((granted) => granted === false);
  const allAnswered = request.asked.every((who) => request.granted[who] !== undefined);
  if (!refused && !allAnswered) return;

  request.resolved = true;
  request.outcome = refused ? 'refused' : 'granted';
  if (refused) return;

  CONSENT_KINDS[request.kind]?.carry(draft, data, request);
}

export const CONSENT_COMMANDS = {
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
};
