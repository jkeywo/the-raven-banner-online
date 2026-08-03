/**
 * <rb-ballot> — the elections in progress, and where you stand in them.
 *
 * An election is public and slow: the electorate is made of shires rather than
 * of people, so a player wants to see who else has a say, how heavy their own
 * voice is, and how many have not spoken. Hiding any of that would make the
 * negotiation impossible — and the negotiation is the point, since the votes
 * themselves are only the arithmetic at the end of it.
 *
 * A vassal whose liege is standing gets one button rather than a choice. That
 * is the printed rule and it should look like an obligation, not an oversight.
 */

export class RbBallot extends HTMLElement {
  set data(value) { this._data = value; this._render(); }

  set view(value) { this._view = value; this._render(); }

  connectedCallback() { this._render(); }

  /** Elections this viewer still owes a vote to. */
  get pending() {
    const me = this._view?.viewer?.roleId;
    return Object.values(this._view?.votes ?? {})
      .filter((v) => !v.resolved && v.electorate[me] && !v.cast[me]);
  }

  _emit(verb, payload) {
    this.dispatchEvent(new CustomEvent('rb-command', { bubbles: true, detail: { verb, payload } }));
  }

  _render() {
    if (!this.isConnected || !this._view || !this._data) return;
    const me = this._view.viewer?.roleId;
    const votes = Object.values(this._view.votes ?? {});
    if (!votes.length) { this.innerHTML = ''; return; }

    const nameOf = (id) => this._data.roles.roles[id]?.name ?? id;
    const crownName = (crown) => String(crown).replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());

    const rank = (v) => (v.resolved ? 2 : (v.electorate[me] && !v.cast[me] ? 0 : 1));
    votes.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));

    this.innerHTML = `<ul class="rb-ballots">${votes.map((vote) => {
      const liege = this._view.roles?.[me]?.liegeId;
      const compelled = liege && vote.candidates.includes(liege) ? liege : null;
      const standing = compelled ? [compelled] : vote.candidates;
      const silent = Object.keys(vote.electorate).filter((who) => !vote.cast[who]);
      const mine = vote.cast[me];

      return `
        <li class="rb-ballot" data-asking="${rank(vote) === 0}" data-resolved="${vote.resolved}">
          <p class="rb-ballot-head">
            The crown of <strong>${crownName(vote.crown)}</strong>,
            put by ${nameOf(vote.openedBy)}.
          </p>
          ${vote.resolved
    ? `<p class="rb-ballot-outcome">${vote.outcome === 'crowned'
      ? `${nameOf(vote.winner)} is king.`
      : 'Nobody carried it. The crown stays unworn.'}</p>`
    : `<p class="rb-meta">${silent.length
      ? `${silent.length} still to speak` : 'counting'} —
        ${vote.electorate[me]
      ? `you have ${vote.electorate[me]} vote${vote.electorate[me] === 1 ? '' : 's'}`
      : 'you have no vote in this'}.</p>`}
          ${!vote.resolved && vote.electorate[me] && !mine ? `
            ${compelled ? `<p class="rb-meta">Your liege stands.
              You are sworn to vote for them.</p>` : ''}
            <div class="rb-ballot-buttons">${standing.map((who) => `
              <button type="button" class="rb-primary"
                data-for="${vote.id}|${who}">${nameOf(who)}</button>`).join('')}
            </div>` : ''}
          ${mine ? `<p class="rb-meta">You voted for ${nameOf(mine)}.</p>` : ''}
        </li>`;
    }).join('')}</ul>`;

    for (const button of this.querySelectorAll('[data-for]')) {
      const [voteId, forRoleId] = button.dataset.for.split('|');
      button.onclick = () => this._emit('cast-vote', { voteId, forRoleId });
    }
  }
}

customElements.define('rb-ballot', RbBallot);
