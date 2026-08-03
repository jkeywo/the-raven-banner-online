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
          </div>`).join('')}
      </dl>

      ${this._wounds(role.wounds ?? 0, fatal)}
      ${this._income(derived.income)}
      ${this._lands(held)}
      ${this._claims(role.crowns ?? [])}
      ${this._brief(this._view.brief)}
    `;
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
        ${derived.churches ? `<span class="rb-meta">${derived.churches} churches</span>` : ''}
      </div>`;
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

  _income(income) {
    if (!income) return '';
    if (income.landless) {
      return `<p class="rb-meta">Holding no land, you collect
        ${income.food} food and ${income.soldiers} soldier each maintenance phase.</p>`;
    }
    return `<p class="rb-meta">Your lands pay
      ${income.silver} silver and ${income.food} food each maintenance phase.</p>`;
  }

  _lands(held) {
    if (!held.length) return '<h3>Lands</h3><p class="rb-empty">You steward nothing.</p>';
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
    return `<h3>Lands</h3><ul class="rb-lands">${rows}</ul>`;
  }

  _claims(crowns) {
    if (!crowns.length) return '';
    return `<h3>Claims</h3><p>${crowns.map((c) => title(c)).join(', ')}</p>`;
  }

  _brief(brief) {
    if (!brief) return '';
    const goals = (brief.goals ?? []).map((g) => `<li>${escape(g)}</li>`).join('');
    const guidance = (brief.guidance ?? []).map((g) => `<li>${escape(g)}</li>`).join('');
    return `
      <h3>Your goals</h3>
      <p class="rb-meta">
        Nobody wins this game. At the end you judge your own part in it against
        these — so keep them to yourself.
      </p>
      <ul class="rb-goals">${goals}</ul>
      ${guidance ? `<h3>Guidance</h3><ul class="rb-guidance">${guidance}</ul>` : ''}`;
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
