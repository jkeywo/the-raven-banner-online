/**
 * gui/rules/commands/holdings.js — what your lands pay, and what you buy with it.
 *
 * The turn's housekeeping: collecting, recruiting, building, circling a
 * settlement, trading at the market, giving to another player, putting a burnt
 * one back — and burning somebody else's. They are one fragment because they
 * are one ledger. Every verb here moves silver, food, soldiers, ships or
 * momentum, and several of them are priced off the same three facts: whether
 * you hold a shipyard, whether your followers want feeding, and whether the
 * settlement in question is circled.
 *
 * Raiding sits here rather than with the battle phase on purpose. It is not a
 * fight — nobody rolls, nobody is paired — it is an economic act performed on
 * a settlement, sharing this fragment's vocabulary for naming one and its
 * arithmetic for paying for it.
 */

import {
  churchesHeld, factionReach, incomeFor, isDanish, isPagan, momentumGain,
} from '../derive.js';
import {
  affordable, dealable, dealingReason, no, ok, others, pretty, sameFaction, shireName,
  spend, stewarded, subjectOf, TRADEABLE_PHASES,
} from './shared.js';

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

const holdsShipyard = (state, roleId) =>
  SHIPYARDS.some((id) => state.shires[id]?.stewardRoleId === roleId);

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

/** A settlement as a dropdown should name it: its kind, and whether it is circled. */
const settlementLabel = (settlement) => {
  const kind = settlement.type[0].toUpperCase() + settlement.type.slice(1);
  return settlement.defended ? `${kind} (defended)` : kind;
};

export const HOLDINGS_COMMANDS = {
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
};
