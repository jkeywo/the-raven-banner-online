/**
 * <rb-seat-roster> — who is here and who they are playing.
 *
 * Shown to everyone, because faction membership and who holds which crown are
 * public in the paper game. What is *not* public is anyone's strength, so this
 * shows names and roles and nothing else.
 *
 * Set `.seats` and `.roles` as properties rather than attributes: they are
 * data, not strings, and stringifying a roster into the DOM to parse it back
 * out again would be a strange thing to do.
 */

export class RbSeatRoster extends HTMLElement {
  set seats(value) { this._seats = value ?? []; this._render(); }

  get seats() { return this._seats ?? []; }

  /** Optional map of roleId -> display name, for showing a role properly. */
  set roles(value) { this._roles = value ?? {}; this._render(); }

  connectedCallback() { this._render(); }

  _render() {
    if (!this.isConnected) return;
    const seats = [...this.seats].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

    if (seats.length === 0) {
      this.innerHTML = '<p class="rb-empty">Nobody has joined yet.</p>';
      return;
    }

    const rows = seats.map((seat) => {
      const role = seat.roleId
        ? (this._roles?.[seat.roleId]?.name ?? seat.roleName ?? seat.roleId)
        : null;
      return `
        <li class="rb-seat" data-connected="${seat.connected}">
          <span class="rb-seat-dot" aria-hidden="true"></span>
          <span class="rb-seat-name">${escape(seat.name || 'Unnamed')}</span>
          <span class="rb-seat-role">${role ? escape(role) : '<em>choosing</em>'}</span>
          ${seat.kind === 'facilitator' ? '<span class="rb-seat-tag">facilitator</span>' : ''}
        </li>`;
    }).join('');

    const playing = seats.filter((s) => s.kind === 'player').length;
    this.innerHTML = `
      <ul class="rb-roster">${rows}</ul>
      <p class="rb-meta">${playing} player${playing === 1 ? '' : 's'} seated.</p>`;
  }
}

/** The roster carries names people typed, so it never goes in raw. */
function escape(text) {
  return String(text).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

customElements.define('rb-seat-roster', RbSeatRoster);
