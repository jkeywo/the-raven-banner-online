/**
 * gui/rules/commands/contracts.js — the three cards, and the port they open.
 *
 * There are exactly three trade contracts in the game and one person holds all
 * of them, so this is small — but it is its own fragment because a contract is
 * the only thing in the rules with a life of its own. It is offered, signed,
 * cancelled, and it keeps paying both parties every maintenance phase in
 * between; it moves with the shire rather than with whoever signed it; and it
 * changes what the shire costs everybody else to reach by sea. The three verbs
 * and the four helpers that write that record belong together, so that "what
 * is true of a contract" is answerable in one place.
 */

import {
  affordable, dealable, dealingReason, no, ok, pretty, shireName, subjectOf, TRADEABLE_PHASES,
} from './shared.js';

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

export const CONTRACT_COMMANDS = {
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
    label: 'Offer a trade contract',
    note: 'A soldier each. Then two silver each, every turn.',
    fields: (state, data, roleId) => {
      const taken = new Set(Object.values(state.contracts ?? {})
        .filter((c) => c.status === 'active' || c.status === 'offered')
        .map((c) => c.shireId));
      return [{
        name: 'shireId',
        label: 'Contract for',
        kind: 'select',
        options: (data.meta.tradeContractShires ?? [])
          // A steward to sign it, and one the Team Phase would let her talk to.
          .filter((id) => !taken.has(id) && state.shires?.[id]?.stewardRoleId
            && dealable(state, roleId, state.shires[id].stewardRoleId))
          .map((id) => ({
            value: id,
            label: `${shireName(data, id)} — ${
              data.roles.roles[state.shires[id].stewardRoleId]?.name ?? 'its steward'}`,
          })),
      }];
    },
    // A card she could actually lay down, first. Asking after the first
    // printed shire regardless would grey the whole verb out over a Mercian
    // she may not deal with this phase, or over a contract she has already
    // offered, while the card still in her hand is perfectly legal — so the
    // probe has to answer "is there any offer at all?", not "is this one
    // particular offer good?".
    probe: (state, data, roleId) => {
      const shires = contractShires(data);
      const offerable = shires.find((id) => {
        const steward = state.shires[id]?.stewardRoleId;
        return steward && steward !== roleId
          && !dealingReason(state, roleId, steward)
          && !contractOn(state, id);
      });
      return { shireId: offerable ?? shires[0] };
    },
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
      // Usually a Saxon on the other side of the table, so usually a bargain
      // for a phase when the two of you are in the same room.
      const across = dealingReason(ctx.state, roleId, steward);
      if (across) return across;
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
    label: 'Answer a trade offer',
    note: 'It costs you a soldier, and opens your port.',
    fields: (state, data, roleId) => [
      {
        name: 'contractId',
        label: 'Their offer',
        kind: 'select',
        options: Object.values(state.contracts ?? {})
          // Answering is dealing, so an offer from across the lines is not
          // his to answer until the room is back together.
          .filter((c) => c.status === 'offered'
            && state.shires?.[c.shireId]?.stewardRoleId === roleId
            && dealable(state, roleId, c.traderRoleId))
          .map((c) => ({
            value: c.id,
            label: `${shireName(data, c.shireId)} — from ${
              data.roles.roles[c.traderRoleId]?.name ?? 'the trader'}`,
          })),
      },
      {
        name: 'accept',
        label: 'Well?',
        kind: 'select',
        options: [
          { value: 'yes', label: 'sign it — a soldier each' },
          { value: '', label: 'no thank you' },
        ],
      },
    ],
    toPayload: (values) => ({ ...values, accept: values.accept === 'yes' }),
    // An offer on a shire this player stewards, so the action does not appear
    // on everybody's list refused for a reason about somebody else's deal —
    // and one whose trader is his to answer today, so an offer from across the
    // lines does not hide one from his own side during the Team Phase.
    probe: (state, data, roleId) => {
      const his = state.contracts.filter((c) => c.status === 'offered'
        && state.shires[c.shireId]?.stewardRoleId === roleId);
      const answerable = his.find((c) => !dealingReason(state, roleId, c.traderRoleId));
      return { contractId: (answerable ?? his[0])?.id, accept: true };
    },
    admit(ctx) {
      const roleId = subjectOf(ctx);
      const contract = findContract(ctx.state, ctx.cmd.payload?.contractId);
      if (!contract) return no('no such contract');
      if (contract.status !== 'offered') return no('that offer is no longer open');
      if (ctx.state.shires[contract.shireId]?.stewardRoleId !== roleId) {
        return no('it is not yours to sign');
      }
      // Signing is dealing, and so is refusing to: both are answers given to
      // the trader's face, which the Team Phase is not the time for.
      const across = dealingReason(ctx.state, roleId, contract.traderRoleId);
      if (across) return across;
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
   *
   * Alone among the deals, this one is not held to your own faction. It is
   * Team-Phase-only by printed rule, and a contract is cross-faction by
   * nature — a Dane's card in a Saxon's shire — so a faction gate here would
   * make every contract in the game permanently uncancellable. Tearing one up
   * is also not a bargain: nobody's agreement is being asked for.
   */
  'cancel-contract': {
    phases: ['team'],
    actor: 'player',
    label: 'Cancel a trade contract',
    note: 'Team Phase only. The ship value goes back up.',
    fields: (state, data, roleId) => [{
      name: 'contractId',
      label: 'Tear up',
      kind: 'select',
      options: Object.values(state.contracts ?? {})
        .filter((c) => c.status === 'active'
          && (c.traderRoleId === roleId
            || state.shires?.[c.shireId]?.stewardRoleId === roleId))
        .map((c) => ({ value: c.id, label: shireName(data, c.shireId) })),
    }],
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
};
