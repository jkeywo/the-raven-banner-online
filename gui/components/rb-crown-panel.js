/**
 * <rb-crown-panel> — the facilitator's end of the feudal system.
 *
 * Three jobs the umpire has that nobody else can do. One: call the count on an
 * election that is waiting for somebody who has gone home, because an
 * election that never ends stops the game around it. Two: price a rebellion —
 * the printed rule is a judgement about one vassal's one liege, made when
 * they actually ask, not a standing rate. Three: bring back the fallen.
 *
 * A rebellion is priced, not decided: the vassal still confirms or calls it
 * off once they see the number, so this panel is only ever half of it.
 */

const REBELLION = [
  { label: 'the full price — a shire and two soldiers', shires: 1, soldiers: 2 },
  { label: 'soldiers only — he keeps his land', shires: 0, soldiers: 2 },
  { label: 'a shire only', shires: 1, soldiers: 0 },
  { label: 'nothing at all', shires: 0, soldiers: 0 },
];

export class RbCrownPanel extends HTMLElement {
  set data(value) { this._data = value; this._render(); }

  set state(value) { this._state = value; this._render(); }

  connectedCallback() { this._render(); }

  _emit(verb, payload) {
    this.dispatchEvent(new CustomEvent('rb-facilitate', { bubbles: true, detail: { verb, payload } }));
  }

  /**
   * Whoever has been killed and is waiting on their heir.
   *
   * Death is not elimination: the player keeps the sheet, the lands and the
   * silver, and comes back as somebody else. The guide asks the umpire to
   * change at least one thing — a goal, a claim, or how the foreign courts
   * feel about them — so the form asks for exactly that and records it.
   */
  _dead(nameOf, crownName) {
    const fallen = Object.values(this._state.roles ?? {}).filter((role) => role.dead);
    if (!fallen.length) return '';
    const crowns = Object.keys(this._data.factions.crownLetter ?? {});
    const options = (selected) => `<option value="">—</option>${crowns
      .map((crown) => `<option value="${crown}"
        ${crown === selected ? 'selected' : ''}>${crownName(crown)}</option>`).join('')}`;

    return `
      <h3>The fallen</h3>
      <ul class="rb-relief">${fallen.map((role) => `
        <li>
          <form data-heir="${role.id}">
            <p><strong>${nameOf(role.id)}</strong> is dead. Their heir takes the
              same sheet, with the wounds wiped and any crown back on the table.</p>
            <label>Change at least one thing
              <input name="note" maxlength="200"
                placeholder="e.g. his son wants peace with the Danes">
            </label>
            <label>Add a claim <select name="addClaim">${options()}</select></label>
            <label>Drop a claim <select name="dropClaim">${options()}</select></label>
            <button type="submit" class="rb-primary">The heir arrives</button>
          </form>
        </li>`).join('')}</ul>`;
  }

  /**
   * A vassal has asked to rebel, and is waiting on a price.
   *
   * The four presets are the same four the rule prints, so pricing one is a
   * single choice rather than typing two numbers — pick the option, commit,
   * and the vassal sees the number next.
   */
  _rebellions(nameOf) {
    const open = Object.values(this._state.rebellions ?? {})
      .filter((r) => r.status === 'pending' || r.status === 'priced');
    if (!open.length) return '<p class="rb-empty">Nobody has asked to rebel.</p>';

    return `<ul class="rb-relief">${open.map((request) => `
      <li>
        <p><strong>${nameOf(request.roleId)}</strong>
          <span class="rb-meta">wants to leave ${nameOf(request.liegeId)}</span>
          ${request.status === 'priced'
    ? `<span class="rb-meta">— priced at ${request.cost.shires} shire(s),
        ${request.cost.soldiers} soldiers. Waiting on them now.</span>`
    : ''}
        </p>
        <form data-price="${request.roleId}">
          <label>Price it
            <select name="price">${REBELLION.map((option) => `
              <option value="${option.shires}|${option.soldiers}">${option.label}</option>`).join('')}
            </select>
          </label>
          <button type="submit" class="rb-primary">Commit</button>
        </form>
      </li>`).join('')}</ul>`;
  }

  _render() {
    if (!this.isConnected || !this._state || !this._data) return;
    const nameOf = (id) => this._data.roles.roles[id]?.name ?? id;
    const crownName = (crown) => String(crown).replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());

    const open = Object.values(this._state.votes ?? {}).filter((v) => !v.resolved);
    const worn = Object.entries(this._state.crownHolders ?? {});

    this.innerHTML = `
      <div class="rb-crowns">
        <h3>Crowns worn</h3>
        <p class="rb-meta">${worn.length
    ? worn.map(([crown, who]) => `${crownName(crown)}: ${nameOf(who)}`).join(' · ')
    : 'None. Every crown is still a claim.'}</p>

        <h3>Elections</h3>
        ${open.length ? `<ul class="rb-ballots">${open.map((vote) => {
    const silent = Object.keys(vote.electorate).filter((who) => !vote.cast[who]);
    return `
            <li class="rb-ballot" data-resolved="false">
              <p class="rb-ballot-head">The crown of
                <strong>${crownName(vote.crown)}</strong> —
                ${vote.candidates.map(nameOf).join(' against ')}</p>
              <p class="rb-meta">${silent.length
      ? `waiting on ${silent.map(nameOf).join(', ')}`
      : 'everyone has spoken'}</p>
              <div class="rb-ballot-buttons">
                <button type="button" data-close="${vote.id}">Call the count</button>
              </div>
            </li>`;
  }).join('')}</ul>` : '<p class="rb-empty">Nobody is standing for anything.</p>'}

        ${this._dead(nameOf, crownName)}

        <h3>Rebellions waiting on you</h3>
        ${this._rebellions(nameOf)}
      </div>`;

    for (const form of this.querySelectorAll('[data-heir]')) {
      form.onsubmit = (event) => {
        event.preventDefault();
        this._emit('facilitator:heir-arrives', {
          roleId: form.dataset.heir,
          note: form.elements.note.value.trim() || undefined,
          addClaim: form.elements.addClaim.value || undefined,
          dropClaim: form.elements.dropClaim.value || undefined,
        });
      };
    }
    for (const button of this.querySelectorAll('[data-close]')) {
      button.onclick = () => this._emit('facilitator:close-vote', { voteId: button.dataset.close });
    }
    for (const form of this.querySelectorAll('[data-price]')) {
      form.onsubmit = (event) => {
        event.preventDefault();
        const [shires, soldiers] = form.elements.price.value.split('|').map(Number);
        this._emit('facilitator:price-rebellion',
          { roleId: form.dataset.price, shires, soldiers });
      };
    }
  }
}

customElements.define('rb-crown-panel', RbCrownPanel);
