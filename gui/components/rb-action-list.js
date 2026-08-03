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
 */

import { availableTo } from '../rules/admission.js';

/** Player-facing names. The verb ids are for the wire, not for reading. */
const LABELS = {
  'claim-role': 'Take a character',
  'declare-initiative-target': 'Declare your target',
  'swear-allegiance': 'Swear allegiance',
  'collect-income': 'Collect income',
  'recruit-soldiers': 'Recruit soldiers',
  'build-ship': 'Build a ship',
  trade: 'Trade',
};

const NOTES = {
  'collect-income': 'Income from your lands, and two momentum.',
  'recruit-soldiers': 'Five silver for one soldier.',
  'build-ship': 'Two silver for the first each turn, four after.',
  trade: 'Three silver buys a food; a food sells for two silver.',
  'declare-initiative-target': 'Only if you hold an initiative token.',
};

export class RbActionList extends HTMLElement {
  set data(value) { this._data = value; this._render(); }

  set view(value) { this._view = value; this._render(); }

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
      .filter((action) => action.verb !== 'claim-role');

    if (!actions.length) {
      this.innerHTML = `<p class="rb-empty">Nothing to do in the
        ${this._view.phase.name} phase — this one is for talking.</p>`;
      return;
    }

    this.innerHTML = `<ul class="rb-actions">${actions.map((action) => `
      <li class="rb-action" data-ok="${action.ok}">
        <button type="button" data-verb="${action.verb}" ${action.ok ? '' : 'disabled'}>
          ${LABELS[action.verb] ?? action.verb}
        </button>
        <span class="rb-action-note">${
  action.ok ? (NOTES[action.verb] ?? '') : escape(action.reason ?? '')}</span>
      </li>`).join('')}</ul>`;
  }
}

function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

customElements.define('rb-action-list', RbActionList);
