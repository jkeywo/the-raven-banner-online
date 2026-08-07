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

  /**
   * The feudal web, read off the board and drawn as what it is: a tree.
   *
   * Homage is the thing on this panel with no control attached — it is sworn
   * and renounced by the players themselves — but it is what makes support,
   * elections and rebellion mean anything, and it was the one part of the
   * arrangement a facilitator could not see anywhere.
   *
   * It used to be a flat list of "X answered by Y, Z", which is the pairs
   * rather than the chain: a facilitator asking "who does this ultimately roll
   * up to" had to hold three lines in their head and join them. Nesting says
   * it in one glance, and the question people actually ask at the table —
   * whose man is he, in the end — is answered by looking up the indent.
   *
   * Derived from liegeId every render rather than kept, so it cannot fall out
   * of step with the rebellion in the column beside it that is about to change
   * it.
   */
  _tree(nameOf, crownName) {
    const roles = Object.values(this._state.roles ?? {});
    const vassalsOf = new Map();
    for (const role of roles) {
      if (!role.liegeId) continue;
      if (!vassalsOf.has(role.liegeId)) vassalsOf.set(role.liegeId, []);
      vassalsOf.get(role.liegeId).push(role.id);
    }

    // Crown by holder rather than holder by crown, which is the way round the
    // tree needs to read it — and a man may wear more than one.
    const crownsOf = new Map();
    for (const [crown, who] of Object.entries(this._state.crownHolders ?? {})) {
      if (!who) continue;
      if (!crownsOf.has(who)) crownsOf.set(who, []);
      crownsOf.get(who).push(crown);
    }

    const byName = (a, b) => nameOf(a).localeCompare(nameOf(b));

    // Guarded against a homage loop, which is not the same problem as
    // recursing forever. Nothing should be able to make one — swearing checks
    // — but this draws whatever the state says, and two men sworn to each
    // other have no root between them: walking down from the roots would drop
    // them off the panel entirely rather than hang. Silently losing a role
    // from the one place a facilitator goes to see the arrangement is the
    // worse failure of the two, so anybody left over is drawn as their own
    // root and labelled.
    const drawn = new Set();
    const branch = (id, seen) => {
      const worn = crownsOf.get(id) ?? [];
      const looped = seen.has(id);
      drawn.add(id);
      const under = looped ? [] : (vassalsOf.get(id) ?? []).slice().sort(byName);
      return `
        <li class="rb-tree-node" data-role="${id}"${worn.length ? ' data-crowned="true"' : ''}${
  looped ? ' data-loop="true"' : ''}>
          <span class="rb-tree-name">${worn.length
    ? '<span class="rb-tree-crown" aria-hidden="true">♛</span>' : ''}${escape(nameOf(id))}</span>
          ${looped ? '<span class="rb-meta">— homage loops here</span>' : ''}
          ${worn.length
    ? `<span class="rb-tree-crowns">${worn.map((c) => escape(crownName(c))).join(' &amp; ')}</span>`
    : ''}
          ${under.length
    ? `<ul class="rb-tree">${under.map((child) => branch(child, new Set([...seen, id]))).join('')}</ul>`
    : ''}
        </li>`;
    };

    // Households first, then the lords who stand alone. Sorted purely by name
    // the four unsworn Mercians were dealt out between the three great
    // households — Uchtred stranded below Alfred's men, reading like one of
    // them. Whether a man has anybody under him is the more useful split, and
    // it puts "everyone still on their own" together at the bottom where the
    // shape of the board can be read off it.
    const roots = roles.filter((role) => !role.liegeId).map((role) => role.id)
      .sort((a, b) => (vassalsOf.has(b) ? 1 : 0) - (vassalsOf.has(a) ? 1 : 0) || byName(a, b));
    let html = roots.map((id) => branch(id, new Set())).join('');
    const orphans = roles.map((r) => r.id).filter((id) => !drawn.has(id)).sort(byName);
    html += orphans.filter((id) => !drawn.has(id))
      .map((id) => branch(id, new Set([id]))).join('');
    if (!html) return '<p class="rb-empty">Nobody is at the top of anything.</p>';
    return `<ul class="rb-tree rb-tree-root">${html}</ul>`;
  }

  _render() {
    if (!this.isConnected || !this._state || !this._data) return;
    const nameOf = (id) => this._data.roles.roles[id]?.name ?? id;
    const crownName = (crown) => String(crown).replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());

    const open = Object.values(this._state.votes ?? {}).filter((v) => !v.resolved);
    const worn = Object.entries(this._state.crownHolders ?? {});

    // Two columns, and the split is by what the facilitator is doing rather
    // than by subject. The left is the standing arrangement — who answers to
    // whom, who wears what — which is read constantly and changes rarely. The
    // right is the queue of things waiting on a decision from this desk, which
    // is the opposite on both counts. Mixed together, the queue kept being
    // missed because it sat below a tree that grows down the page.
    this.innerHTML = `
      <div class="rb-feudal">
        <div class="rb-feudal-main">
          <h3>Who answers to whom</h3>
          <p class="rb-meta">${worn.length
    ? `Crowns worn: ${worn.map(([crown, who]) => `${crownName(crown)} (${nameOf(who)})`).join(' · ')}`
    : 'No crown is worn yet. Every one of them is still a claim.'}</p>
          ${this._tree(nameOf, crownName)}
        </div>

        <aside class="rb-feudal-side">
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

          <h3>Rebellions waiting on you</h3>
          ${this._rebellions(nameOf)}

          ${this._dead(nameOf, crownName)}
        </aside>
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

function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

customElements.define('rb-crown-panel', RbCrownPanel);
