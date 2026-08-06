/**
 * <rb-action-list> — what you can do now, and why you cannot do the rest.
 *
 * Built by asking the same admission functions the host will ask. The answer
 * here is presentation only — the host's is the one that decides — but asking
 * the real rules rather than reimplementing them means a control is never
 * greyed out for a reason the host would not give.
 *
 * Refused actions are shown rather than hidden, with the reason attached. A
 * player who cannot see that Recruit Soldiers exists cannot learn that it
 * costs five silver, and "why is there nothing here?" is a worse question than
 * "why can't I afford that?".
 *
 * Available actions come first, everything refused sits below under its own
 * heading — a player scans one short list of what they can actually do rather
 * than picking it out of everything the phase makes available in principle.
 *
 * A shire clicked on the map (`focusShireId`) promotes and marks whichever
 * available actions could target it, using the same field data the chooser
 * would render — so "click a target to see what you can do with it" can never
 * name an action the chooser would then refuse a shire for.
 */

import { availableTo } from '../rules/admission.js';
import { shireTargetsFor } from '../client/action-chooser.js';

/** Player-facing names. The verb ids are for the wire, not for reading. */
const LABELS = {
  'claim-role': 'Take a character',
  'swear-allegiance': 'Swear allegiance',
  'transfer-stewardship': 'Hand over a shire',
  'collect-income': 'Collect income',
  'recruit-soldiers': 'Recruit soldiers',
  'build-ship': 'Build a ship',
  reinforce: 'Reinforce a settlement',
  trade: 'Trade at market',
  give: 'Give to another player',
  'raid-settlement': 'Raid a settlement',
  'raise-christian-banners': 'Raise Christian banners',
  'defensive-fleet': 'Station a defensive fleet',
  'rebuild-settlement': 'Rebuild a settlement',
  'send-envoy': 'Send an envoy',
  'missionary-expedition': 'Send missionaries',
  'rousing-sermon': 'Preach a rousing sermon',
  baptise: 'Baptise a pagan',
  'request-settle': 'Settle a shire',
  'drive-out-missionaries': 'Drive out the missionaries',
  'offer-contract': 'Offer a trade contract',
  'answer-contract': 'Answer a trade offer',
  'cancel-contract': 'Cancel a trade contract',
  'request-allegiance': 'Ask to swear allegiance',
  'claim-crown': 'Claim a crown',
  'cast-vote': 'Cast your vote',
  'request-rebel': 'Ask to rebel',
  'confirm-rebel': 'Go through with it',
  'cancel-rebel': 'Call off your rebellion',
  'use-mercenary': 'Call in the mercenaries',
};

const NOTES = {
  'collect-income': 'Momentum, then whatever your lands pay.',
  'recruit-soldiers': 'Five silver for one soldier.',
  'build-ship': 'Only where there is a yard, if you are a Saxon.',
  reinforce: 'One momentum. Circles a settlement so it must be stormed.',
  trade: 'Three silver buys a food; a food sells for two silver.',
  give: 'Silver, food and ships only. Soldiers are yours alone.',
  'transfer-stewardship': 'They collect its income, and must hold it.',
  'swear-allegiance': 'Their crowns then count as support for you.',
  'raid-settlement': 'Two momentum, and two soldiers if it is defended.',
  'raise-christian-banners': 'Once a game. Soldiers equal to the turn.',
  'defensive-fleet': 'Two ships. Makes the shire dearer to reach by sea.',
  'rebuild-settlement': 'Six silver. It comes back undefended.',
  'send-envoy': 'Buys a hearing, not a deal.',
  'missionary-expedition': 'One momentum. The shire stops counting as pagan.',
  'rousing-sermon': 'One momentum. They gain a soldier.',
  baptise: 'Free, but they must agree. Ends their upkeep.',
  'request-settle': 'Every neighbouring steward has to agree first.',
  'drive-out-missionaries': 'One momentum. The cross comes down.',
  'offer-contract': 'A soldier each. Then two silver each, every turn.',
  'answer-contract': 'It costs you a soldier, and opens your port.',
  'cancel-contract': 'Team Phase only. The ship value goes back up.',
  'request-allegiance': 'They must agree, and must wear a crown or be a Dane.',
  'claim-crown': 'Every shire that supports it gets a say.',
  'request-rebel': 'The facilitator sets the price. You get the final say once you see it.',
  'use-mercenary': 'Once a game. Your side wins one more clash.',
};

/**
 * A few notes cannot be written in advance — what a rebellion actually costs
 * is a number the facilitator only just set, not a fact about the verb.
 * Falls through to the static NOTES above when there is nothing to compute.
 */
function dynamicNote(verb, view) {
  if (verb !== 'confirm-rebel' && verb !== 'cancel-rebel') return undefined;
  const me = view.viewer?.roleId;
  const mine = Object.values(view.rebellions ?? {})
    .find((r) => r.roleId === me && (r.status === 'pending' || r.status === 'priced'));
  if (!mine) return undefined;
  if (mine.status === 'pending') return 'Waiting on the facilitator to set a price.';
  const { shires, soldiers } = mine.cost;
  return `Costs ${shires} shire${shires === 1 ? '' : 's'} and `
    + `${soldiers} soldier${soldiers === 1 ? '' : 's'}.`;
}

/** Verbs that need the player to say more before they mean anything. */
export const NEEDS_CHOICE = new Set([
  'trade', 'give', 'reinforce', 'transfer-stewardship',
  'swear-allegiance',
  'raid-settlement', 'defensive-fleet', 'rebuild-settlement', 'send-envoy',
  'missionary-expedition', 'rousing-sermon', 'baptise',
  'request-settle', 'drive-out-missionaries',
  'offer-contract', 'answer-contract', 'cancel-contract',
  'request-allegiance', 'claim-crown', 'request-rebel', 'use-mercenary',
]);

/**
 * Verbs a bespoke control already owns, so a generic row here would be a
 * second, worse way to do the same thing — and, unlabelled, would print its
 * own verb at the player.
 */
const ELSEWHERE = new Set(['claim-role', 'declare-initiative-target', 'name-new-steward']);

export class RbActionList extends HTMLElement {
  set data(value) { this._data = value; this._render(); }

  set view(value) { this._view = value; this._render(); }

  /** The shire last clicked on the map, or null to clear the promotion. */
  set focusShireId(value) { this._focusShireId = value; this._render(); }

  connectedCallback() { this._render(); }

  _render() {
    if (!this.isConnected || !this._view || !this._data) return;
    const roleId = this._view.viewer?.roleId;
    if (!roleId) { this.innerHTML = ''; return; }

    // The client holds a redacted projection, so anything whose legality turns
    // on a secret cannot be judged here. Those come back as refused for a
    // reason that is about the view rather than the game, which is why the
    // host's answer is the only one that counts.
    const actor = { seatId: this._view.viewer.seatId, kind: 'player', roleId };
    const actions = availableTo(this._view, this._data, actor)
      // Declaring an initiative target has its own control now — click the
      // shire on the map, then Target — rather than a dropdown here that
      // offered every shire in England regardless of the one just clicked.
      // Naming the steward of a shire you have taken is the same story: the
      // clash panel draws it beside the battle it is about, where the names on
      // the buttons are the people who actually fought.
      .filter((action) => !ELSEWHERE.has(action.verb));

    if (!actions.length) {
      this.innerHTML = `<p class="rb-empty">Nothing to do in the
        ${this._view.phase.name} phase — this one is for talking.</p>`;
      return;
    }

    // Which available actions the focused shire is a legal target of. Asking
    // afresh on every render rather than caching: the fields it reads already
    // change with the view, so a cache would be one more thing to invalidate.
    const relevant = this._focusShireId
      ? new Set(actions
        .filter((a) => a.ok
          && shireTargetsFor(a.verb, this._view, this._data).includes(this._focusShireId))
        .map((a) => a.verb))
      : new Set();

    const available = actions.filter((a) => a.ok)
      .sort((a, b) => Number(relevant.has(b.verb)) - Number(relevant.has(a.verb)));
    const unavailable = actions.filter((a) => !a.ok);

    const row = (action) => `
      <li class="rb-action" data-ok="${action.ok}" data-relevant="${relevant.has(action.verb)}">
        <button type="button" data-verb="${action.verb}" ${action.ok ? '' : 'disabled'}>
          ${LABELS[action.verb] ?? action.verb}${NEEDS_CHOICE.has(action.verb) ? '…' : ''}
        </button>
        <span class="rb-action-note">${
  action.ok ? (dynamicNote(action.verb, this._view) ?? NOTES[action.verb] ?? '')
    : escape(action.reason ?? '')}</span>
      </li>`;

    this.innerHTML = `
      <ul class="rb-actions rb-actions-available">${available.map(row).join('')}</ul>
      ${unavailable.length ? `
        <h4 class="rb-actions-heading">Not right now</h4>
        <ul class="rb-actions rb-actions-unavailable">${unavailable.map(row).join('')}</ul>`
    : ''}`;
  }
}

function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

customElements.define('rb-action-list', RbActionList);
