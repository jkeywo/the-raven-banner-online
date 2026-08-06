/**
 * <rb-clash-panel> — the five minutes a player spends fighting.
 *
 * The only screen anyone looks at during a battle phase, so it carries the
 * whole arc: pick a side, play a card face down, watch both turn over, decide
 * whether to lead, and see what it cost.
 *
 * It shows what it has been sent and no more. A card the host has not revealed
 * is not hidden here — it was never sent — so the tension is real rather than
 * enforced by this file behaving itself.
 */

const CARD_ORDER = ['A', '2', '3', '4', '5'];

const STAGE_PROMPT = {
  awaiting_tactics: 'Choose a card. Nobody sees it until you have both chosen.',
  tactics_revealed: 'Cards down.',
  awaiting_lead: 'Will you lead the charge yourself?',
  lead_revealed: 'You may still join the charge — but not leave it.',
  rolling: 'Throw your die. Neither of you sees the other until both are down.',
  rolls_revealed: 'Dice down.',
  resolved: '',
};

export class RbClashPanel extends HTMLElement {
  set data(value) { this._data = value; this._render(); }

  set view(value) { this._view = value; this._render(); }

  connectedCallback() { this._render(); }

  _emit(verb, payload) {
    this.dispatchEvent(new CustomEvent('rb-command', {
      bubbles: true, detail: { verb, payload },
    }));
  }

  connectedCallbackOnce() {}

  _render() {
    if (!this.isConnected || !this._view || !this._data) return;
    const view = this._view;
    const me = view.viewer?.roleId;

    if (view.phase.name !== 'battle') {
      this.innerHTML = '<p class="rb-empty">No battle is being fought.</p>';
      return;
    }

    const targets = view.battle?.targets ?? [];
    if (!targets.length) {
      this.innerHTML = `<p class="rb-empty">
        Waiting for the token holders to name their targets.</p>`;
      return;
    }

    const mine = Object.values(view.battle.clashes ?? {})
      .find((clash) => clash.attacker === me || clash.defender === me);

    this.innerHTML = `
      ${this._battles(targets, me)}
      ${mine ? this._clash(mine, me) : ''}
      ${this._otherClashes(mine, me)}`;

    this._wire();
  }

  /** The battles being fought, and which side you are on. */
  _battles(targets, me) {
    return `<div class="rb-battles">${targets.map((shireId) => {
      const sides = this._view.battle.sides?.[shireId] ?? { attackers: [], defenders: [] };
      const name = this._data.shires.shires[shireId]?.name ?? shireId;
      const side = sides.attackers.includes(me) ? 'attackers'
        : sides.defenders.includes(me) ? 'defenders' : null;
      const paired = this._view.battle.pairingComplete;
      return `
        <section class="rb-battle">
          <h3>${name}</h3>
          <p class="rb-meta">
            ${sides.attackers.length} attacking, ${sides.defenders.length} defending
            ${side ? ` · you are ${side === 'attackers' ? 'attacking' : 'defending'}` : ''}
          </p>
          ${paired || side ? '' : `
            <div class="rb-side-buttons">
              <button type="button" data-join="${shireId}" data-side="attackers">Attack</button>
              <button type="button" data-join="${shireId}" data-side="defenders">Defend</button>
            </div>`}
        </section>`;
    }).join('')}</div>`;
  }

  /** Your own clash, in whatever state it has reached. */
  _clash(clash, me) {
    const progress = this._view.clashProgress?.[clash.id] ?? {};
    const opponent = clash.attacker === me ? clash.defender : clash.attacker;
    const opponentName = this._data.roles.roles[opponent]?.name ?? opponent ?? 'nobody';
    const soldiers = this._view.roles?.[me]?.soldiers ?? 0;

    if (clash.auto) {
      return `<section class="rb-clash">
        <h3>Unopposed</h3>
        <p>Nobody stood against you. That counts as a win.</p></section>`;
    }

    return `
      <section class="rb-clash" data-clash="${clash.id}">
        <h3>Against ${opponentName}</h3>
        <p class="rb-prompt">${STAGE_PROMPT[clash.stage] ?? ''}</p>
        ${this._hand(clash, me, soldiers)}
        ${this._reveal(clash, me, opponent, progress)}
        ${this._lead(clash, me, opponent)}
        ${this._roll(clash, me, opponent, progress)}
        ${this._result(clash, me, opponent, opponentName)}
      </section>`;
  }

  /** Your five cards. The ones you cannot afford are visibly shut. */
  _hand(clash, me, soldiers) {
    if (clash.stage !== 'awaiting_tactics') return '';
    const chosen = clash.tactic?.[me] ?? null;
    return `<div class="rb-hand">${CARD_ORDER.map((card) => {
      const printed = this._data.tactics.tactics[card];
      const tooMany = printed.score > soldiers;
      return `
        <button type="button" class="rb-card${chosen === card ? ' is-chosen' : ''}"
                data-card="${card}" ${tooMany ? 'disabled' : ''}
                title="${tooMany ? `commits ${printed.score}, you have ${soldiers}` : ''}">
          <span class="rb-card-rank">${card}</span>
          <span class="rb-card-name">${printed.name}</span>
          <span class="rb-card-detail">${printed.score} soldiers</span>
        </button>`;
    }).join('')}
      <p class="rb-meta">${chosen ? 'Chosen. You may still change it.'
    : 'A card commits soldiers you must have.'}</p>
    </div>`;
  }

  _reveal(clash, me, opponent, progress) {
    if (!progress.tacticsRevealed) {
      if (clash.stage !== 'awaiting_tactics') return '';
      const waiting = progress.tacticSubmitted?.[opponent];
      return `<p class="rb-meta">${waiting
        ? 'They have chosen. Waiting on you.' : 'Waiting for them to choose.'}</p>`;
    }
    const card = (roleId) => {
      const rank = clash.tactic?.[roleId];
      const printed = rank ? this._data.tactics.tactics[rank] : null;
      return printed
        ? `<span class="rb-card-shown"><b>${rank}</b> ${printed.name}
             <em>${printed.score} soldiers</em></span>`
        : '<span class="rb-card-shown">—</span>';
    };
    return `<div class="rb-reveal">
      <div>You ${card(me)}</div>
      <div>Them ${card(opponent)}</div>
    </div>`;
  }

  _lead(clash, me, opponent) {
    if (clash.stage === 'awaiting_lead') {
      const said = clash.lead?.[me];
      if (said !== null && said !== undefined) {
        return `<p class="rb-meta">You said you would
          ${said ? 'lead the charge' : 'hang back'}. Waiting for them.</p>`;
      }
      return `<div class="rb-lead-buttons">
        <button type="button" data-lead="true" class="rb-primary">Lead the charge</button>
        <button type="button" data-lead="false">Hang back</button>
      </div>`;
    }

    if (clash.stage === 'lead_revealed') {
      const theirs = clash.lead?.[opponent];
      const mine = clash.lead?.[me];
      const confirmed = clash.confirmed?.[me];
      return `
        <p>They are ${theirs ? '<strong>leading the charge</strong>' : 'hanging back'}.</p>
        ${mine ? '<p class="rb-meta">You are in the front rank already.</p>'
    : confirmed ? '<p class="rb-meta">You are hanging back. Waiting for them.</p>'
      : `<div class="rb-lead-buttons">
              <button type="button" data-lead="true" class="rb-primary">Join the charge</button>
              <button type="button" data-confirm>Stay back</button>
            </div>`}`;
    }
    return '';
  }

  /**
   * Your own die.
   *
   * Yours to throw, and only once. Whether they have thrown comes from
   * `clashProgress` rather than from the dice themselves, because the die they
   * threw is not here yet — that is the point of the stage.
   */
  _roll(clash, me, opponent, progress) {
    if (clash.stage !== 'rolling') return '';
    const mine = clash.rolls?.[me];
    if (mine === null || mine === undefined) {
      return `<div class="rb-roll">
        <button type="button" data-roll class="rb-primary">Throw your die</button>
        <p class="rb-meta">${progress.rollSubmitted?.[opponent]
    ? 'They have thrown. Waiting on you.' : 'Neither of you has thrown yet.'}</p>
      </div>`;
    }
    return `<div class="rb-roll">
      <p class="rb-rolled">You threw a <strong>${mine}</strong>.</p>
      <p class="rb-meta">${progress.rollSubmitted?.[opponent]
    ? 'Both dice are down.' : 'Waiting for them to throw.'}</p>
    </div>`;
  }

  _result(clash, me, opponent, opponentName) {
    if (!clash.result || clash.result.unopposed) return '';
    const r = clash.result;
    const won = r.winner === me;
    return `
      <div class="rb-clash-result" data-won="${won}">
        <p class="rb-clash-verdict">${won ? 'You won the clash.' : `${opponentName} won the clash.`}</p>
        <dl class="rb-detail">
          <dt>Rolls</dt><dd>you ${clash.rolls?.[me] ?? '—'},
            them ${clash.rolls?.[opponent] ?? '—'}</dd>
          <dt>Battle score</dt><dd>you ${r.scores?.[me] ?? '—'},
            them ${r.scores?.[opponent] ?? '—'}</dd>
          <dt>Your losses</dt><dd>${r.casualties?.[me] ?? 0} in the fighting${
  r.feeding?.[me]?.starved ? `, ${r.feeding[me].starved} starved after` : ''}</dd>
          ${r.wounds?.[me] ? `<dt>Wounds</dt><dd>you took ${r.wounds[me]}</dd>` : ''}
        </dl>
      </div>`;
  }

  /** Everyone else's fights, because the shire falls on the count of them. */
  _otherClashes(mine, me) {
    const others = Object.values(this._view.battle.clashes ?? {})
      .filter((clash) => clash !== mine);
    if (!others.length) return '';
    const name = (roleId) => this._data.roles.roles[roleId]?.name ?? roleId ?? 'nobody';
    return `<section class="rb-other-clashes">
      <h3>The rest of the battle</h3>
      <ul>${others.map((clash) => `
        <li>${name(clash.attacker)} against ${name(clash.defender)} —
          ${clash.result
    ? `<strong>${name(clash.result.winner)}</strong> won`
    : clash.stage.replace(/_/g, ' ')}</li>`).join('')}</ul>
    </section>`;
  }

  _wire() {
    const clashId = this.querySelector('[data-clash]')?.dataset.clash;
    for (const button of this.querySelectorAll('[data-join]')) {
      button.onclick = () => this._emit('join-battle', {
        shireId: button.dataset.join, side: button.dataset.side,
      });
    }
    for (const button of this.querySelectorAll('[data-card]')) {
      button.onclick = () => this._emit('submit-tactic', { clashId, card: button.dataset.card });
    }
    for (const button of this.querySelectorAll('[data-lead]')) {
      button.onclick = () => this._emit('declare-lead', {
        clashId, lead: button.dataset.lead === 'true',
      });
    }
    const stay = this.querySelector('[data-confirm]');
    if (stay) stay.onclick = () => this._emit('confirm-lead', { clashId });
    const die = this.querySelector('[data-roll]');
    if (die) die.onclick = () => this._emit('submit-roll', { clashId });
  }
}

customElements.define('rb-clash-panel', RbClashPanel);
