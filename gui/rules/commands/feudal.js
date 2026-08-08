/**
 * gui/rules/commands/feudal.js — who answers to whom, and who wears what.
 *
 * Homage, crowns, rebellion and stewardship are one subject rather than four.
 * A crown decides who may take vassals; a vassal's shires follow their liege's
 * faction; a rebellion is how a vassal stops being one; and handing a shire
 * over is how a faction consolidates behind whoever can hold the border. Each
 * of those verbs reads or writes `liegeId`, `factionId` and a shire's steward,
 * so they are kept where the reader can see all four at once — a change to
 * what a liege means that missed one of them is exactly the bug this fragment
 * is shaped to prevent.
 *
 * `swearTo` is exported because a Saxon's homage is agreed rather than
 * declared, and so is carried by the consent machinery rather than here.
 */

import { isDanish, electorate } from '../derive.js';
import {
  affordable, no, ok, others, pretty, stewarded, subjectOf,
} from './shared.js';

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
export function swearTo(draft, roleId, liegeId) {
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

export const FEUDAL_COMMANDS = {
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
};
