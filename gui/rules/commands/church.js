/**
 * gui/rules/commands/church.js — the cross, and what it is worth.
 *
 * Four verbs about the one long argument the game is really about. A cross
 * planted in a Danish shire stops it counting as pagan at the end, lets the
 * priest treat it as his own ground, and buys a claim a baptised Dane can cash
 * years later — which is why the Dane whose shire it is has a printed way to
 * pull it back out. Preaching and baptism are the same argument aimed at a
 * person rather than at a place.
 *
 * They are one fragment because they share a subject rather than a phase: two
 * happen in the encounter phase and two in maintenance, and grouping them by
 * when they happen would have separated the cross from the man who takes it
 * down.
 */

import { isChristian, isDanish, isDanishHeld, isPagan } from '../derive.js';
import {
  affordable, no, ok, others, roleName, shireName, spend, stewarded, subjectOf,
} from './shared.js';

export const CHURCH_COMMANDS = {
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
};
