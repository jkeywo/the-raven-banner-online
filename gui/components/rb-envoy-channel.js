/**
 * <rb-envoy-channel> — a private line to a power nobody plays.
 *
 * In the room this is standing up, walking over to a facilitator and asking
 * the Franks for a fleet. The answer is never a price list — it is "what will
 * you give us for it?" — so this is a conversation rather than a shop.
 *
 * Only the sender and the facilitator ever see a thread. That is the manifest's
 * doing, not this component's: another player's negotiation with Rome is absent
 * from the projection entirely, so there is nothing here to leak.
 */

export class RbEnvoyChannel extends HTMLElement {
  set data(value) { this._data = value; this._render(); }

  set view(value) { this._view = value; this._render(); }

  connectedCallback() { this._render(); }

  _emit(verb, payload) {
    this.dispatchEvent(new CustomEvent('rb-command', { bubbles: true, detail: { verb, payload } }));
  }

  _render() {
    if (!this.isConnected || !this._view || !this._data) return;
    const me = this._view.viewer?.roleId;
    if (!me) { this.innerHTML = ''; return; }

    const archetype = this._data.roles.roles[me]?.archetype;
    const rules = this._data.factions.envoy?.[archetype];
    const threads = Object.values(this._view.envoys ?? {});

    if (!rules) {
      this.innerHTML = '<p class="rb-empty">Your archetype sends no envoys.</p>';
      return;
    }

    // Keeping the scroll position of an open thread is worth the bookkeeping:
    // a projection arrives on every command anyone in the game makes, and a
    // conversation that jumped to the top each time would be unusable.
    const openId = this._openId ?? threads.find((t) => t.open)?.id ?? null;

    this.innerHTML = `
      ${this._courts(rules, threads)}
      ${threads.length ? this._threads(threads, openId) : ''}`;
    this._wire();
  }

  _courts(rules, threads) {
    const cost = Object.entries(rules.cost)
      .map(([what, amount]) => `${amount} ${what}`).join(' and ');
    return `
      <p class="rb-meta">An envoy costs ${cost}, and buys you a hearing — not a
        deal. They will want something.</p>
      <div class="rb-courts">${rules.to.map((id) => {
    const npc = this._data.factions.npc[id] ?? { name: id };
    const already = threads.some((t) => t.npcFaction === id && t.open);
    return `
          <button type="button" data-send="${id}" ${already ? 'disabled' : ''}
                  title="${npc.wants ? `They want ${npc.wants}.` : ''}">
            <span class="rb-court-name">${npc.name}</span>
            <span class="rb-court-wants">${already ? 'already talking'
    : npc.wants ? `wants ${npc.wants}` : ''}</span>
          </button>`;
  }).join('')}</div>`;
  }

  _threads(threads, openId) {
    return `<div class="rb-threads">${threads.map((thread) => {
      const npc = this._data.factions.npc[thread.npcFaction] ?? { name: thread.npcFaction };
      const isOpen = thread.id === openId;
      return `
        <section class="rb-thread" data-thread="${thread.id}" ${isOpen ? 'open' : ''}>
          <button type="button" class="rb-thread-head" data-open="${thread.id}">
            <span>${npc.name}</span>
            <span class="rb-meta">${thread.messages.length} message${
  thread.messages.length === 1 ? '' : 's'}${thread.open ? '' : ' · closed'}</span>
          </button>
          ${isOpen ? `
            <ol class="rb-messages">${thread.messages.map((message) => `
              <li class="rb-message" data-mine="${message.from === thread.roleId}">
                <span class="rb-message-who">${message.from === thread.roleId
    ? 'You' : escape(npc.name)}</span>
                <span class="rb-message-text">${escape(message.text)}</span>
              </li>`).join('') || '<li class="rb-empty">Nothing said yet. Open with an offer.</li>'}
            </ol>
            ${thread.open ? `
              <form class="rb-envoy-form" data-say="${thread.id}">
                <textarea name="text" rows="2" maxlength="2000"
                  placeholder="What are you asking for, and what will you give?"></textarea>
                <button type="submit" class="rb-primary">Send</button>
              </form>`
    : '<p class="rb-meta">This conversation is closed.</p>'}` : ''}
        </section>`;
    }).join('')}</div>`;
  }

  _wire() {
    for (const button of this.querySelectorAll('[data-send]')) {
      button.onclick = () => this._emit('send-envoy', { npcFaction: button.dataset.send });
    }
    for (const button of this.querySelectorAll('[data-open]')) {
      button.onclick = () => {
        this._openId = this._openId === button.dataset.open ? null : button.dataset.open;
        this._render();
      };
    }
    for (const form of this.querySelectorAll('[data-say]')) {
      form.onsubmit = (event) => {
        event.preventDefault();
        const text = form.elements.text.value.trim();
        if (!text) return;
        this._emit('envoy-message', { threadId: form.dataset.say, text });
        form.elements.text.value = '';
      };
    }
  }
}

function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

customElements.define('rb-envoy-channel', RbEnvoyChannel);
