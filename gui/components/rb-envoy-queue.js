/**
 * <rb-envoy-queue> — every conversation the facilitator is holding at once.
 *
 * They are the Franks, the Britons, the Danish Kings and the Pope, all four,
 * simultaneously, while also running a clock. So this is a queue sorted by who
 * has been waiting longest with nobody having answered them, and it says what
 * each power wants so the umpire does not have to remember four agendas.
 *
 * The reply goes out as that court, not as the facilitator. Everyone knows a
 * person is typing it; keeping the fiction in the interface is what makes it
 * feel like an embassy rather than a support ticket.
 */

export class RbEnvoyQueue extends HTMLElement {
  set data(value) { this._data = value; this._render(); }

  set state(value) { this._state = value; this._render(); }

  connectedCallback() { this._render(); }

  _emit(verb, payload) {
    this.dispatchEvent(new CustomEvent('rb-facilitate', { bubbles: true, detail: { verb, payload } }));
  }

  _render() {
    if (!this.isConnected || !this._state || !this._data) return;
    const threads = Object.values(this._state.envoys ?? {});

    if (!threads.length) {
      this.innerHTML = '<p class="rb-empty">Nobody has sent an envoy.</p>';
      return;
    }

    // Waiting on you first, then open, then closed. Within each, oldest last
    // word first — the person who has been ignored longest is the one to
    // answer next.
    const lastWord = (t) => t.messages[t.messages.length - 1];
    const rank = (t) => {
      if (!t.open) return 2;
      const last = lastWord(t);
      return last && last.from === t.roleId ? 0 : 1;
    };
    threads.sort((a, b) => rank(a) - rank(b)
      || (lastWord(a)?.at ?? 0) - (lastWord(b)?.at ?? 0));

    this.innerHTML = `<div class="rb-envoy-queue">${threads.map((thread) => {
      const npc = this._data.factions.npc[thread.npcFaction] ?? { name: thread.npcFaction };
      const who = this._data.roles.roles[thread.roleId]?.name ?? thread.roleId;
      const waiting = rank(thread) === 0;
      return `
        <section class="rb-envoy-item" data-waiting="${waiting}" data-open="${thread.open}">
          <header>
            <strong>${escape(who)}</strong> to <strong>${escape(npc.name)}</strong>
            ${waiting ? '<span class="rb-waiting">waiting on you</span>' : ''}
            ${thread.open ? '' : '<span class="rb-meta">closed</span>'}
          </header>
          ${npc.wants ? `<p class="rb-meta">They want ${escape(npc.wants)}.
            They can offer ${escape(npc.offers ?? 'little')}.</p>` : ''}
          <ol class="rb-messages">${thread.messages.map((m) => `
            <li class="rb-message" data-mine="${m.from !== thread.roleId}">
              <span class="rb-message-who">${m.from === thread.roleId
    ? escape(who) : escape(npc.name)}</span>
              <span class="rb-message-text">${escape(m.text)}</span>
            </li>`).join('') || '<li class="rb-empty">They have not said anything yet.</li>'}
          </ol>
          <form class="rb-envoy-form" data-reply="${thread.id}">
            <textarea name="text" rows="2" maxlength="2000"
              placeholder="Answer as ${escape(npc.name)}…"></textarea>
            <div class="rb-envoy-buttons">
              <button type="submit" class="rb-primary">Reply</button>
              ${thread.open ? `<button type="button" data-close="${thread.id}">Close it</button>` : ''}
            </div>
          </form>
        </section>`;
    }).join('')}</div>`;

    this._wire();
  }

  _wire() {
    for (const form of this.querySelectorAll('[data-reply]')) {
      form.onsubmit = (event) => {
        event.preventDefault();
        const text = form.elements.text.value.trim();
        if (!text) return;
        this._emit('facilitator:envoy-reply', { threadId: form.dataset.reply, text });
        form.elements.text.value = '';
      };
    }
    for (const button of this.querySelectorAll('[data-close]')) {
      button.onclick = () => this._emit('facilitator:envoy-close', { threadId: button.dataset.close });
    }
  }
}

function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

customElements.define('rb-envoy-queue', RbEnvoyQueue);
