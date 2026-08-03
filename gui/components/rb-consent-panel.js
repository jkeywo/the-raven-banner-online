/**
 * <rb-consent-panel> — the one place in the game where you wait on other people.
 *
 * Settling a shire "requires consent from the stewards of all adjacent Shires",
 * so a Dane who asks has to stand there while three neighbours make up their
 * minds. In the room that is a conversation across a table. Here it needs a
 * surface, or the asker has no idea whether anyone has even seen the question.
 *
 * Two audiences, one list: a neighbour who has been asked gets two buttons, and
 * the asker gets a tally of who has answered and who has not. Everyone else sees
 * it too — a settlement is public business, and knowing that Halfdan is trying
 * to put down roots next door is exactly the sort of thing to trade on.
 *
 * Resolved requests stay for a moment rather than vanishing, because "did that
 * go through?" is the first thing anybody asks.
 */

export class RbConsentPanel extends HTMLElement {
  set data(value) { this._data = value; this._render(); }

  set view(value) { this._view = value; this._render(); }

  connectedCallback() { this._render(); }

  /** Requests this viewer is being asked to answer. */
  get pending() {
    const me = this._view?.viewer?.roleId;
    return Object.values(this._view?.consents ?? {})
      .filter((r) => !r.resolved && r.asked.includes(me) && r.granted[me] === undefined);
  }

  _emit(verb, payload) {
    this.dispatchEvent(new CustomEvent('rb-command', { bubbles: true, detail: { verb, payload } }));
  }

  _render() {
    if (!this.isConnected || !this._view || !this._data) return;
    const me = this._view.viewer?.roleId;
    const requests = Object.values(this._view.consents ?? {});
    if (!requests.length) { this.innerHTML = ''; return; }

    // Waiting on you first, then still open, then done with.
    const rank = (r) => (r.resolved ? 2
      : (r.asked.includes(me) && r.granted[me] === undefined ? 0 : 1));
    requests.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));

    const nameOf = (id) => this._data.roles.roles[id]?.name ?? id;
    const shireOf = (id) => this._data.shires.shires[id]?.name ?? id;

    this.innerHTML = `<ul class="rb-consents">${requests.map((request) => {
      const yours = request.roleId === me;
      const mine = request.granted[me];
      const asking = rank(request) === 0;
      return `
        <li class="rb-consent" data-asking="${asking}" data-resolved="${request.resolved}">
          <p class="rb-consent-ask">
            <strong>${escape(yours ? 'You' : nameOf(request.roleId))}</strong>
            ${request.kind === 'allegiance'
    ? `${yours ? 'would' : 'would'} follow
              <strong>${escape(nameOf(request.liegeId))}</strong>.`
    : `${yours ? 'want' : 'wants'} to settle
              <strong>${escape(shireOf(request.shireId))}</strong>.`}
          </p>
          ${request.resolved
    ? `<p class="rb-consent-outcome">${request.outcome === 'granted'
      ? (request.kind === 'allegiance' ? 'He took the homage.' : 'The neighbours agreed.')
      : (request.kind === 'allegiance' ? 'He would not have him.'
        : 'Somebody refused. Nothing was spent.')}</p>`
    : `<ul class="rb-consent-who">${request.asked.map((who) => `
              <li data-answer="${request.granted[who] ?? 'silent'}">
                ${escape(nameOf(who))} — ${request.granted[who] === true ? 'agreed'
    : request.granted[who] === false ? 'refused' : 'has not said'}
              </li>`).join('') || '<li class="rb-empty">Nobody to ask.</li>'}</ul>`}
          ${asking ? `
            <div class="rb-consent-buttons">
              <button type="button" class="rb-primary" data-yes="${request.id}">Agree</button>
              <button type="button" data-no="${request.id}">Refuse</button>
            </div>`
    : mine !== undefined && !request.resolved
      ? `<p class="rb-meta">You ${mine ? 'agreed' : 'refused'}.</p>` : ''}
        </li>`;
    }).join('')}</ul>`;

    this._wire();
  }

  _wire() {
    for (const button of this.querySelectorAll('[data-yes]')) {
      button.onclick = () => this._emit('answer-consent',
        { consentId: button.dataset.yes, granted: true });
    }
    for (const button of this.querySelectorAll('[data-no]')) {
      button.onclick = () => this._emit('answer-consent',
        { consentId: button.dataset.no, granted: false });
    }
  }
}

function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

customElements.define('rb-consent-panel', RbConsentPanel);
