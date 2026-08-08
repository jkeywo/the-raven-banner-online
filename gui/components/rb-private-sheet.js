/**
 * <rb-private-sheet> — the page in front of you that nobody else can see.
 *
 * The paper game gives every player a folded sheet: resources on one side, a
 * brief on the other, and an explicit instruction not to show it to anyone.
 * This is that sheet.
 *
 * It renders only what the projection contains, which is the point — the
 * redaction already happened on the host, so there is nothing here that has to
 * remember to hide anything. If another player's silver is not in the view,
 * this cannot display it by mistake.
 *
 * Momentum and the four tracks stay in view always — a player checks those
 * constantly. Everything else sits in an accordion: opening one section
 * should not mean losing your place in another, so each is independent rather
 * than a set of tabs that hide each other.
 */

const TRACKS = [
  ['silver', 'Silver', 'From towns. Buys ships, soldiers and envoys.'],
  ['food', 'Food', 'From farms. Feeds soldiers after a clash.'],
  ['soldiers', 'Soldiers', 'Caps the tactic card you may play. Never tradeable.'],
  ['ships', 'Ships', 'Buys a turn’s access to a coastal shire.'],
];

export class RbPrivateSheet extends HTMLElement {
  set data(value) { this._data = value; this._render(); }

  set view(value) { this._view = value; this._render(); }

  connectedCallback() { this._render(); }

  _render() {
    if (!this.isConnected || !this._view || !this._data) return;

    const roleId = this._view.viewer?.roleId;
    if (!roleId) {
      this.innerHTML = '<p class="rb-empty">You are not playing a character.</p>';
      return;
    }

    const role = this._view.roles?.[roleId] ?? {};
    const printed = this._data.roles.roles[roleId] ?? {};
    const derived = this._view.derived?.roles?.[roleId] ?? {};
    const cap = this._data.meta.momentumCap;
    const fatal = this._data.meta.woundsFatal;

    const held = Object.entries(this._view.shires ?? {})
      .filter(([, shire]) => shire.stewardRoleId === roleId);

    this.innerHTML = `
      <header class="rb-sheet-head">
        <h2>${escape(printed.name ?? roleId)}</h2>
        <p class="rb-meta">
          ${title(printed.archetype)} · ${title(printed.team)}
          ${role.liegeId ? ` · sworn to ${escape(this._name(role.liegeId))}` : ' · sworn to nobody'}
        </p>
      </header>

      ${this._momentum(role.momentum ?? 0, cap, derived)}

      <dl class="rb-tracks">
        ${TRACKS.map(([key, label, note]) => `
          <div class="rb-track" title="${note}">
            <dt>${label}</dt>
            <dd>${role[key] ?? 0}</dd>
            ${this._trackModifier(key, derived.income)}
          </div>`).join('')}
      </dl>

      ${this._wounds(role.wounds ?? 0, fatal)}

      <div class="rb-sheet-accordion">
        ${this._section('Lands', this._lands(held), { open: true })}
        ${this._section('Crowns and claims', this._claims(role.claims ?? []))}
        ${this._section('What you have promised', this._promises())}
        ${this._section('Your goals', this._brief(this._view.brief))}
      </div>
    `;
  }

  /** One accordion section, or nothing at all if there is nothing to say. */
  _section(label, body, { open = false } = {}) {
    if (!body) return '';
    return `<details class="rb-sheet-section" ${open ? 'open' : ''}>
      <summary>${label}</summary>
      ${body}
    </details>`;
  }

  _name(roleId) {
    return this._data.roles.roles[roleId]?.name ?? roleId;
  }

  _momentum(value, cap, derived) {
    // Pips rather than a number: momentum is small, capped, and spent in ones.
    const pips = Array.from({ length: cap }, (_, i) => (
      `<span class="rb-pip${i < value ? ' is-full' : ''}"></span>`)).join('');
    return `
      <div class="rb-momentum">
        <span class="rb-track-label">Momentum</span>
        <span class="rb-pips" role="img" aria-label="${value} of ${cap}">${pips}</span>
        ${derived.momentumGain ? `<span class="rb-track-mod">+${derived.momentumGain}/turn</span>` : ''}
        ${derived.churches ? `<span class="rb-meta">${derived.churches} churches</span>` : ''}
      </div>`;
  }

  /**
   * What a stat is worth next maintenance phase, shown on the card it belongs
   * to rather than as a separate paragraph underneath everything. A landless
   * role earns a fixed amount instead of rent from land, which is worth
   * saying right where the number it changes is sitting.
   */
  _trackModifier(key, income) {
    const amount = income?.[key];
    if (!amount) return '';
    return `<span class="rb-track-mod">+${amount}${income.landless ? ' landless' : '/turn'}</span>`;
  }

  _wounds(value, fatal) {
    if (!value) return '';
    const dying = value >= fatal - 1;
    return `<p class="rb-wounds${dying ? ' is-grave' : ''}">
      ${value} wound${value === 1 ? '' : 's'} of ${fatal}.
      ${value >= fatal ? 'Your character has fallen — speak to a facilitator.'
    : dying ? 'One more would kill you.' : ''}
    </p>`;
  }

  _lands(held) {
    if (!held.length) return '<p class="rb-empty">You steward nothing.</p>';
    const rows = held.map(([id, shire]) => {
      const printed = this._data.shires.shires[id];
      const supported = this._view.derived?.shires?.[id]?.supported;
      const standing = Object.values(shire.settlements ?? {}).filter((s) => !s.destroyed).length;
      return `<li>
        <span class="rb-land-name">${escape(printed?.name ?? id)}</span>
        <span class="rb-meta">${shire.castles} castles · ${standing} settlements</span>
        ${supported ? '' : '<span class="rb-warn">no support</span>'}
      </li>`;
    }).join('');
    return `<ul class="rb-lands">${rows}</ul>`;
  }

  /**
   * What you claim, and which of it you actually wear.
   *
   * The difference is the whole feudal game: a claim on a crown somebody else
   * has been elected to is worth nothing, and a player should be able to see
   * that at a glance rather than by noticing their income has fallen.
   */
  _claims(crowns) {
    const worn = Object.entries(this._view.crownHolders ?? {})
      .filter(([, who]) => who === this._view.viewer?.roleId).map(([crown]) => crown);
    const taken = crowns.filter((c) => this._view.crownHolders?.[c]
      && this._view.crownHolders[c] !== this._view.viewer?.roleId);
    if (!crowns.length && !worn.length) return '';

    return `
      ${worn.length ? `<p><strong>Wears:</strong> ${worn.map((c) => title(c)).join(', ')}</p>` : ''}
      ${crowns.length ? `<p><strong>Claims:</strong> ${crowns.map((c) => (
    taken.includes(c) ? `<s>${title(c)}</s>` : title(c))).join(', ')}
        ${taken.length ? '<span class="rb-warn">crowned elsewhere</span>' : ''}</p>` : ''}`;
  }

  /**
   * What you have promised foreign powers.
   *
   * Yours only — what Wessex offered Rome is exactly what another player would
   * pay to know, and the projection never sends it to them. It is here because
   * a bargain struck three turns ago is easy to forget and the epilogue will
   * not have forgotten it.
   */
  _promises() {
    const mine = Object.values(this._view.concessions ?? {});
    if (!mine.length) return '';
    return `
      <ul class="rb-ledger">${mine.map((c) => `
        <li data-kept="${c.kept}">
          <span>${c.kept ? '' : '<s>'}${escape(c.text)}${c.kept ? '' : '</s>'}</span>
          <span class="rb-meta">${escape(this._data.factions.npc[c.npcFaction]?.name
    ?? c.npcFaction)}, turn ${c.turn}</span>
        </li>`).join('')}</ul>`;
  }

  _brief(brief) {
    if (!brief) return '';
    const goals = (brief.goals ?? []).map((g) => `<li>${escape(g)}</li>`).join('');
    const guidance = (brief.guidance ?? []).map((g) => `<li>${escape(g)}</li>`).join('');
    return `
      <p class="rb-meta">
        Nobody wins this game. At the end you judge your own part in it against
        these — so keep them to yourself.
      </p>
      <ul class="rb-goals">${goals}</ul>
      ${guidance ? `<h4>Guidance</h4><ul class="rb-guidance">${guidance}</ul>` : ''}`;
  }
}

const title = (text) => String(text ?? '').replace(/_/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());

/** Briefs are prose from a PDF and lands carry names people chose. */
function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

customElements.define('rb-private-sheet', RbPrivateSheet);
