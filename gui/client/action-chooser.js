/**
 * gui/client/action-chooser.js — the questions an action still needs answered.
 *
 * Most actions are a button. A few need one more thing: which settlement,
 * which way round, how much and to whom. Rather than a modal for each, this
 * describes the fields an action wants and builds a small inline form from the
 * projection — so the choices offered are always ones the game currently
 * allows, and a player is not invited to give away silver they do not have.
 *
 * Pure description plus one render function. The sending is the caller's job,
 * which keeps this testable without a network.
 *
 * It asks the rules the same questions the host will. A projection is
 * state-shaped, so `derive.js` works on it directly -- and reimplementing
 * "which shires can this faction reach" here would be a second answer waiting
 * to disagree with the first.
 */

import { factionReach, isChristian, isPagan, isDanishHeld } from '../rules/derive.js';

/**
 * @typedef {object} Field
 * @property {string} name
 * @property {string} label
 * @property {'select'|'number'} kind
 * @property {{value: string, label: string}[]} [options]
 * @property {number} [min]
 * @property {number} [max]
 */

const crownName = (crown) => String(crown ?? '').replace(/_/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());

const settlementLabel = (settlement) => {
  const kind = settlement.type[0].toUpperCase() + settlement.type.slice(1);
  return settlement.defended ? `${kind} (defended)` : kind;
};

/**
 * What an action still needs, given the game as this player can see it.
 *
 * @returns {Field[]} empty when the action is just a button
 */
export function fieldsFor(verb, view, data) {
  const me = view.viewer?.roleId;
  const mine = view.roles?.[me] ?? {};

  /** Everyone else who is in the game, or only those a filter keeps. */
  const others = (keep = () => true) => Object.values(view.roles ?? {})
    .filter((role) => role.id !== me && keep(role))
    .map((role) => ({ value: role.id, label: data.roles.roles[role.id]?.name ?? role.id }));

  /** Whether the teams are currently sitting apart. */
  const teamPhase = () => view.phase?.name === 'team';

  /**
   * Whether this character is one to strike a bargain with right now.
   *
   * The rules refuse a deal across the lines while the teams sit apart, so a
   * dropdown offering one is offering a refusal. Cancelling a contract is
   * exempt from that and so is exempt from this.
   */
  const dealable = (roleId) => !teamPhase()
    || (Boolean(mine.factionId) && view.roles?.[roleId]?.factionId === mine.factionId);

  /** Shires this player stewards. */
  const held = () => Object.entries(view.shires ?? {})
    .filter(([, shire]) => shire.stewardRoleId === me)
    .map(([id]) => ({ value: id, label: data.shires.shires[id]?.name ?? id }));

  switch (verb) {
    case 'trade':
      return [{
        name: 'give',
        label: 'Which way',
        kind: 'select',
        options: [
          { value: 'food', label: 'Sell a food for two silver' },
          { value: 'silver', label: 'Buy a food for three silver' },
        ],
      }];

    case 'give':
      return [
        {
          name: 'toRoleId',
          label: 'To',
          kind: 'select',
          // In the Team Phase a gift stays inside the team, so offering the
          // rest of the table is offering a refusal.
          options: others((role) => dealable(role.id)),
        },
        {
          name: 'what',
          label: 'What',
          kind: 'select',
          // Only what they actually hold: offering to give away nothing is a
          // way of finding out you have none, but a slow one.
          options: ['silver', 'food', 'ships']
            .filter((what) => (mine[what] ?? 0) > 0)
            .map((what) => ({ value: what, label: `${what} (you have ${mine[what]})` })),
        },
        { name: 'amount', label: 'How much', kind: 'number', min: 1, max: 99, value: 1 },
      ];

    case 'reinforce': {
      // Shires whose settlements this player may circle, and which still have
      // one left uncircled.
      const options = Object.entries(view.shires ?? {})
        .flatMap(([shireId, shire]) => Object.values(shire.settlements ?? {})
          .filter((s) => !s.defended && !s.destroyed && shire.stewardRoleId === me)
          .map((s) => ({
            value: `${shireId}|${s.id}`,
            label: `${data.shires.shires[shireId]?.name ?? shireId} — ${settlementLabel(s)}`,
          })));
      return [{ name: 'target', label: 'Which settlement', kind: 'select', options }];
    }

    case 'transfer-stewardship':
      return [
        { name: 'shireId', label: 'Which shire', kind: 'select', options: held() },
        { name: 'toRoleId', label: 'To', kind: 'select', options: others() },
      ];

    case 'swear-allegiance':
      return [{
        name: 'liegeId',
        label: 'Follow',
        kind: 'select',
        options: [{ value: '', label: 'nobody — stand alone' }, ...others()],
      }];

    case 'declare-initiative-target':
      return [{
        name: 'shireId',
        label: 'Attack',
        kind: 'select',
        options: Object.keys(view.shires ?? {})
          .map((id) => ({ value: id, label: data.shires.shires[id]?.name ?? id })),
      }];

    case 'raid-settlement': {
      // Only what the faction can actually reach, so a player is not invited
      // to burn something on the other side of England.
      const factionId = view.roles?.[me]?.factionId;
      const reach = new Set(factionReach(view, data, factionId));
      const options = Object.entries(view.shires ?? {})
        .filter(([shireId]) => reach.has(shireId))
        .flatMap(([shireId, shire]) => Object.values(shire.settlements ?? {})
          .filter((s) => !s.destroyed)
          .map((s) => ({
            value: `${shireId}|${s.id}`,
            label: `${data.shires.shires[shireId]?.name ?? shireId} — ${settlementLabel(s)}`,
          })));
      return [{ name: 'target', label: 'Which settlement', kind: 'select', options }];
    }

    case 'defensive-fleet':
      return [{
        name: 'shireId',
        label: 'Which shire',
        kind: 'select',
        // Coastal only: there is nothing to guard inland.
        options: held().filter(({ value }) => data.shires.shires[value]?.shipCost !== null),
      }];

    case 'rebuild-settlement': {
      const options = Object.entries(view.shires ?? {})
        .filter(([, shire]) => shire.stewardRoleId === me)
        .flatMap(([shireId, shire]) => Object.values(shire.settlements ?? {})
          .filter((s) => s.destroyed)
          .map((s) => ({
            value: `${shireId}|${s.id}`,
            label: `${data.shires.shires[shireId]?.name ?? shireId} — ${s.type}`,
          })));
      return [{ name: 'target', label: 'Which ruin', kind: 'select', options }];
    }

    case 'send-envoy':
      return [{
        name: 'npcFaction',
        label: 'To',
        kind: 'select',
        options: (data.factions.envoy?.[data.roles.roles[me]?.archetype]?.to ?? [])
          .map((id) => ({ value: id, label: data.factions.npc[id]?.name ?? id })),
      }];

    case 'missionary-expedition':
      return [{
        name: 'shireId',
        label: 'Which shire',
        kind: 'select',
        options: Object.keys(view.shires ?? {})
          .filter((id) => isDanishHeld(view, data, id) && !view.shires[id].missionaryCross)
          .map((id) => ({ value: id, label: data.shires.shires[id]?.name ?? id })),
      }];

    case 'rousing-sermon':
      return [{
        name: 'targetRoleId',
        label: 'Preach to',
        kind: 'select',
        options: Object.keys(view.roles ?? {})
          .filter((id) => id !== me && isChristian(view, data, id))
          .map((id) => ({ value: id, label: data.roles.roles[id]?.name ?? id })),
      }];

    case 'baptise':
      return [
        {
          name: 'targetRoleId',
          label: 'Baptise',
          kind: 'select',
          options: Object.keys(view.roles ?? {})
            .filter((id) => isPagan(view, data, id))
            .map((id) => ({ value: id, label: data.roles.roles[id]?.name ?? id })),
        },
        // Not a formality. A conversion agreed out loud is the whole
        // negotiation, and the app should never perform one without it.
        {
          name: 'willing',
          label: 'Have they agreed?',
          kind: 'select',
          options: [
            { value: '', label: 'not yet — go and ask them' },
            { value: 'yes', label: 'yes, they are willing' },
          ],
        },
      ];

    case 'request-settle':
      return [{
        name: 'shireId',
        label: 'Settle',
        kind: 'select',
        // Yours, and not already settled — asking twice about the same ground
        // wastes everybody's evening.
        options: held().filter(({ value }) => !view.shires[value]?.danishSupport),
      }];

    case 'drive-out-missionaries':
      return [{
        name: 'shireId',
        label: 'Which shire',
        kind: 'select',
        options: held().filter(({ value }) => view.shires[value]?.missionaryCross),
      }];

    case 'offer-contract': {
      const taken = new Set(Object.values(view.contracts ?? {})
        .filter((c) => c.status === 'active' || c.status === 'offered')
        .map((c) => c.shireId));
      return [{
        name: 'shireId',
        label: 'Contract for',
        kind: 'select',
        options: (data.meta.tradeContractShires ?? [])
          // A steward to sign it, and one the Team Phase would let her talk to.
          .filter((id) => !taken.has(id) && view.shires?.[id]?.stewardRoleId
            && dealable(view.shires[id].stewardRoleId))
          .map((id) => ({
            value: id,
            label: `${data.shires.shires[id]?.name ?? id} — ${
              data.roles.roles[view.shires[id].stewardRoleId]?.name ?? 'its steward'}`,
          })),
      }];
    }

    case 'answer-contract':
      return [
        {
          name: 'contractId',
          label: 'Their offer',
          kind: 'select',
          options: Object.values(view.contracts ?? {})
            // Answering is dealing, so an offer from across the lines is not
            // his to answer until the room is back together.
            .filter((c) => c.status === 'offered'
              && view.shires?.[c.shireId]?.stewardRoleId === me
              && dealable(c.traderRoleId))
            .map((c) => ({
              value: c.id,
              label: `${data.shires.shires[c.shireId]?.name ?? c.shireId} — from ${
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
      ];

    case 'cancel-contract':
      return [{
        name: 'contractId',
        label: 'Tear up',
        kind: 'select',
        options: Object.values(view.contracts ?? {})
          .filter((c) => c.status === 'active'
            && (c.traderRoleId === me || view.shires?.[c.shireId]?.stewardRoleId === me))
          .map((c) => ({
            value: c.id,
            label: data.shires.shires[c.shireId]?.name ?? c.shireId,
          })),
      }];

    case 'request-allegiance':
      return [{
        name: 'liegeId',
        label: 'Follow',
        kind: 'select',
        // Only people who could actually take you: a crowned Saxon, or a Dane.
        options: Object.keys(view.roles ?? {})
          .filter((id) => id !== me
            && (Object.values(view.crownHolders ?? {}).includes(id)
              || view.derived?.roles?.[id]?.danish))
          .map((id) => ({ value: id, label: data.roles.roles[id]?.name ?? id })),
      }];

    case 'claim-crown':
      return [{
        name: 'crown',
        label: 'Claim',
        kind: 'select',
        options: (mine.claims ?? [])
          .filter((crown) => !view.crownHolders?.[crown])
          .map((crown) => ({ value: crown, label: crownName(crown) })),
      }];

    case 'request-rebel':
      // Named up front, whatever it ends up costing — the facilitator has
      // not priced it yet, so this is what you would offer if a shire is
      // part of the bill.
      return held().length ? [{
        name: 'shireId',
        label: 'Offer',
        kind: 'select',
        options: held(),
      }] : [];

    case 'use-mercenary':
      return [{
        name: 'shireId',
        label: 'Which battle',
        kind: 'select',
        options: (view.battle?.targets ?? [])
          .map((id) => ({ value: id, label: data.shires.shires[id]?.name ?? id })),
      }];

    case 'collect-income':
      // Only a pagan Dane is asked; everyone else just collects.
      return view.derived?.roles?.[me]?.pagan
        ? [{
          name: 'upkeep',
          label: 'Your followers',
          kind: 'select',
          options: [
            { value: 'pay', label: 'Pay five silver for two soldiers' },
            { value: 'lose', label: 'Lose a soldier' },
          ],
        }]
        : [];

    default:
      return [];
  }
}

/**
 * The shires this action could land on, for pointing at them on the map.
 *
 * Reads the same options the chooser itself renders, so a highlighted shire
 * can never disagree with what the dropdown actually offers — this has no
 * knowledge of its own, only the fields' options split on `|` where a target
 * names a settlement rather than a shire outright.
 *
 * @returns {string[]} shire ids, or empty for an action with no shire field
 */
export function shireTargetsFor(verb, view, data) {
  const field = fieldsFor(verb, view, data)
    .find((f) => f.name === 'shireId' || f.name === 'target');
  if (!field) return [];
  const ids = field.options.map((o) => String(o.value).split('|')[0]);
  return [...new Set(ids.filter((id) => data.shires.shires[id]))];
}

/** Turn a filled-in form into the payload the command expects. */
export function payloadFrom(verb, values) {
  if (verb === 'raid-settlement' || verb === 'rebuild-settlement') {
    const [shireId, settlementId] = String(values.target ?? '').split('|');
    return { shireId, settlementId };
  }
  if (verb === 'reinforce') {
    const [shireId, settlementId] = String(values.target ?? '').split('|');
    return { shireId, settlementId };
  }
  if (verb === 'give') return { ...values, amount: Number(values.amount) };
  if (verb === 'swear-allegiance') return { liegeId: values.liegeId || null };
  if (verb === 'baptise') return { ...values, willing: values.willing === 'yes' };
  if (verb === 'answer-contract') return { ...values, accept: values.accept === 'yes' };
  return values;
}

/** Build the form. Returns null when the action needs nothing. */
export function renderChooser(verb, view, data, doc = globalThis.document) {
  const fields = fieldsFor(verb, view, data);
  if (!fields.length) return null;

  const form = doc.createElement('form');
  form.className = 'rb-chooser';
  form.dataset.verb = verb;
  form.innerHTML = `${fields.map((field) => `
    <label>${field.label}
      ${field.kind === 'select'
    ? `<select name="${field.name}" ${field.options.length ? '' : 'disabled'}>
            ${field.options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')
            || '<option>nothing available</option>'}
          </select>`
    : `<input type="number" name="${field.name}" min="${field.min ?? 1}"
             max="${field.max ?? 99}" value="${field.value ?? 1}">`}
    </label>`).join('')}
    <div class="rb-chooser-buttons">
      <button type="submit" class="rb-primary">Do it</button>
      <button type="button" data-cancel>Cancel</button>
    </div>`;
  return form;
}

/** Read a chooser form back out. */
export function valuesFrom(form) {
  return Object.fromEntries(new FormData(form).entries());
}
