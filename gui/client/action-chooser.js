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

import { factionReach } from '../rules/derive.js';

/**
 * @typedef {object} Field
 * @property {string} name
 * @property {string} label
 * @property {'select'|'number'} kind
 * @property {{value: string, label: string}[]} [options]
 * @property {number} [min]
 * @property {number} [max]
 */

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

  /** Everyone else who is in the game. */
  const others = () => Object.values(view.roles ?? {})
    .filter((role) => role.id !== me)
    .map((role) => ({ value: role.id, label: data.roles.roles[role.id]?.name ?? role.id }));

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
        { name: 'toRoleId', label: 'To', kind: 'select', options: others() },
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
