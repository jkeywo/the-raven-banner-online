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
          ${this._court(npc)}
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

          <form class="rb-envoy-form rb-concede" data-concede="${thread.id}">
            <label>What did they promise?
              <input name="text" maxlength="300"
                placeholder="e.g. Sussex, held of the Franks">
            </label>
            <button type="submit">Write it down</button>
          </form>
          ${this._ledgerFor(thread.npcFaction, thread.roleId)}
        </section>`;
    }).join('')}</div>`;

    this._wire();
  }

  /**
   * The briefing for one court.
   *
   * Enough to be played cold, because the facilitator is four foreign powers
   * at once while also running a clock. The openings are buttons rather than
   * prose: pressing one drops it into the reply box, where it can be edited
   * before it is sent, which is faster than remembering the line and typing it.
   */
  _court(npc) {
    return `
      <details class="rb-court-brief">
        <summary>${escape(npc.name)} — what they want</summary>
        ${npc.who ? `<p>${escape(npc.who)}</p>` : ''}
        <p class="rb-meta">They want ${escape(npc.wants ?? 'little')}.
          They can offer ${escape(npc.offers ?? 'little')}.</p>
        ${npc.note ? `<p class="rb-warn">${escape(npc.note)}</p>` : ''}
        ${(npc.asks ?? []).length ? `<p class="rb-meta">Press for:
          ${npc.asks.map(escape).join('; ')}.</p>` : ''}
        ${(npc.openings ?? []).length ? `<div class="rb-openings">${npc.openings
    .map((line) => `<button type="button" data-opening="${escape(line)}"
            >${escape(line)}</button>`).join('')}</div>` : ''}
      </details>`;
  }

  /** What this player has already promised this court. */
  _ledgerFor(npcFaction, roleId) {
    const promises = Object.values(this._state.concessions ?? {})
      .filter((c) => c.npcFaction === npcFaction && c.roleId === roleId);
    if (!promises.length) return '';
    return `<ul class="rb-ledger">${promises.map((c) => `
      <li data-kept="${c.kept}">
        <span>${c.kept ? '' : '<s>'}${escape(c.text)}${c.kept ? '' : '</s>'}</span>
        <span class="rb-meta">turn ${c.turn}</span>
        ${c.kept ? `<button type="button" data-strike="${c.id}">broken</button>` : ''}
      </li>`).join('')}</ul>`;
  }

  _wire() {
    // An opening goes into the box rather than out on the wire: the umpire
    // should get the last word on what a king actually says.
    for (const button of this.querySelectorAll('[data-opening]')) {
      button.onclick = () => {
        const box = button.closest('.rb-envoy-item').querySelector('textarea');
        box.value = button.dataset.opening;
        box.focus();
      };
    }
    for (const form of this.querySelectorAll('[data-concede]')) {
      form.onsubmit = (event) => {
        event.preventDefault();
        const text = form.elements.text.value.trim();
        if (!text) return;
        const thread = this._state.envoys[form.dataset.concede];
        this._emit('facilitator:record-concession',
          { npcFaction: thread.npcFaction, roleId: thread.roleId, text });
        form.elements.text.value = '';
      };
    }
    for (const button of this.querySelectorAll('[data-strike]')) {
      button.onclick = () => this._emit('facilitator:strike-concession',
        { concessionId: button.dataset.strike });
    }
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
