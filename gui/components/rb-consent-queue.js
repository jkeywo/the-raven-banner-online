/**
 * <rb-consent-queue> — the facilitator's view of who is waiting on whom.
 *
 * A settle request stalls on the one neighbour who has gone to make tea, and at
 * a live event that is always somebody. So each open request lists its silent
 * neighbours with a yes and a no beside each name, and offers to answer for
 * everyone still silent at once — which is really the umpire asking the table
 * out loud and hearing no objection.
 *
 * Answering on somebody's behalf goes through the same command everyone else
 * uses, so it lands in the log and replays like any other decision.
 */

export class RbConsentQueue extends HTMLElement {
  set data(value) { this._data = value; this._render(); }

  set state(value) { this._state = value; this._render(); }

  _emit(payload) {
    this.dispatchEvent(new CustomEvent('rb-facilitate', {
      bubbles: true,
      detail: { verb: 'facilitator:answer-consent', payload },
    }));
  }

  connectedCallback() { this._render(); }

  _render() {
    if (!this.isConnected || !this._state || !this._data) return;
    const open = Object.values(this._state.consents ?? {}).filter((r) => !r.resolved);

    if (!open.length) {
      this.innerHTML = '<p class="rb-empty">Nobody is waiting on a neighbour.</p>';
      return;
    }

    const nameOf = (id) => this._data.roles.roles[id]?.name ?? id;
    const shireOf = (id) => this._data.shires.shires[id]?.name ?? id;

    this.innerHTML = `<ul class="rb-consents">${open.map((request) => {
      const silent = request.asked.filter((who) => request.granted[who] === undefined);
      return `
        <li class="rb-consent" data-resolved="false">
          <p class="rb-consent-ask">
            <strong>${escape(nameOf(request.roleId))}</strong>
            ${request.kind === 'allegiance'
    ? `would follow <strong>${escape(nameOf(request.liegeId))}</strong>.`
    : `wants to settle <strong>${escape(shireOf(request.shireId))}</strong>.`}
          </p>
          <ul class="rb-consent-who">${request.asked.map((who) => `
            <li data-answer="${request.granted[who] ?? 'silent'}">
              ${escape(nameOf(who))} — ${request.granted[who] === true ? 'agreed'
    : request.granted[who] === false ? 'refused' : 'has not said'}
              ${request.granted[who] === undefined ? `
                <button type="button" data-for="${request.id}|${who}|yes">yes</button>
                <button type="button" data-for="${request.id}|${who}|no">no</button>` : ''}
            </li>`).join('') || '<li class="rb-empty">Nobody to ask.</li>'}</ul>
          ${silent.length ? `
            <div class="rb-consent-buttons">
              <button type="button" class="rb-primary" data-all="${request.id}|yes">
                Everyone still silent agrees
              </button>
              <button type="button" data-all="${request.id}|no">One of them refuses</button>
            </div>` : ''}
        </li>`;
    }).join('')}</ul>`;

    this._wire();
  }

  _wire() {
    for (const button of this.querySelectorAll('[data-for]')) {
      const [consentId, onBehalfOf, answer] = button.dataset.for.split('|');
      button.onclick = () => this._emit({ consentId, onBehalfOf, granted: answer === 'yes' });
    }
    for (const button of this.querySelectorAll('[data-all]')) {
      const [consentId, answer] = button.dataset.all.split('|');
      button.onclick = () => this._emit({ consentId, granted: answer === 'yes' });
    }
  }
}

function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

customElements.define('rb-consent-queue', RbConsentQueue);
