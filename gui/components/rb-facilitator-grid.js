/**
 * <rb-facilitator-grid> — the umpire's view of a battle phase.
 *
 * In the room this is a person standing at a map saying "you fight him, you
 * fight her", honouring whatever rivalries got announced, then calling for
 * dice. So this is a work queue rather than a dashboard: every battle, who has
 * joined which side, who is paired against whom, and what each clash is
 * waiting for.
 *
 * The facilitator can force any clash forward. That is not a back door — a
 * fighter who has walked away must not be able to stall twenty people — and it
 * travels the same pipeline as everything else, so it is in the log.
 */

import {
  battleNoteKey, heldBackToken, tally, clashesIn, conqueringDeclaration,
} from '../rules/battle.js';
import { TOKENS } from '../rules/state.js';

const STAGE_LABEL = {
  awaiting_tactics: 'choosing cards',
  tactics_revealed: 'cards down',
  awaiting_lead: 'deciding who leads',
  lead_revealed: 'may still join the charge',
  rolling: 'throwing their own dice',
  rolls_revealed: 'dice down',
  resolved: 'settled',
};

export class RbFacilitatorGrid extends HTMLElement {
  set data(value) { this._data = value; this._render(); }

  set state(value) { this._state = value; this._render(); }

  connectedCallback() { this._render(); }

  _emit(verb, payload) {
    this.dispatchEvent(new CustomEvent('rb-facilitate', {
      bubbles: true, detail: { verb, payload },
    }));
  }

  _name(roleId) {
    return roleId ? (this._data.roles.roles[roleId]?.name ?? roleId) : 'nobody';
  }

  /**
   * A note the battle phase filed because it had nowhere else to say it.
   *
   * `seizeInitiative` runs inside `effects`, and `facilitator:end-battles`
   * clears the board a line after calling it — so a phase that could not hand
   * the spare token out has to have written that down at the time. Without
   * this the button labelled "hand out the spare token" would look identical
   * whether it had or not.
   */
  _note(what) {
    const note = this._state.battleNotes?.[battleNoteKey(this._state.phase.turn, what)];
    return note ? `<p class="rb-meta rb-warn" data-initiative-note="${what}">${escape(note)}</p>` : '';
  }

  /**
   * A token this battle should move and cannot, said out loud.
   *
   * Derived here rather than written down when the settling ran, because it is
   * a fact about the board and not an event — `heldBackToken` reads the same
   * tally, declaration and holders that `settleBattle` read. That is what
   * gives the line a way to go away: clear the other counter or push this one
   * across, and the warning stops being true and stops being drawn. A stored
   * one would have sat here going stale until the phase ended, telling the
   * facilitator to do a thing they had already done.
   */
  _heldBack(state, shireId) {
    const held = heldBackToken(state, shireId);
    if (!held) return '';
    const shire = this._data.shires.shires[shireId]?.name ?? shireId;
    // Every name goes through _name, which answers 'nobody' for an unheld
    // token — a token can be sitting on the table with nobody behind it, and
    // a warning that reads "stays with null" is worse than no warning.
    const line = `${this._name(held.steward)} has won ${shire} twice over but already holds `
      + `the ${held.alsoHolds} token, so the ${held.token} token stays with `
      + `${this._name(held.stays)}. Move a counter by hand if it should change hands.`;
    return `<p class="rb-meta rb-warn" data-token-held-back="${shireId}">${escape(line)}</p>`;
  }

  /**
   * Who the conqueror named to take the shire, or that nobody has yet.
   *
   * This used to be a dropdown of attackers with the facilitator's hand on it,
   * which made the most political decision of the battle phase the umpire's to
   * make. It is the token holder's — `name-new-steward` — so what is left here
   * is a read-out, and the facilitator's job is to wait for it and then press
   * the button, which is what they do in the room.
   *
   * Waiting is said out loud rather than left as a blank, and it names what
   * settling anyway would do, because "Settle the shire" is a button that
   * moves a shire either way and a facilitator is entitled to know which way
   * before they press it.
   */
  _stewardPick(state, shireId) {
    // Nothing to name if the shire held: the pick is about who takes it.
    if (!tally(state, shireId).shireFalls) return '';

    const named = state.battle.stewardPicks?.[shireId] ?? null;
    if (named) {
      const by = conqueringDeclaration(state, shireId)?.roleId ?? null;
      return `<p class="rb-meta" data-steward-pick="${shireId}">${escape(
        `${this._name(by)} named ${this._name(named)} to take it.`)}</p>`;
    }

    const holder = conqueringDeclaration(state, shireId)?.roleId ?? null;
    const fallback = clashesIn(state, shireId)[0]?.attacker ?? null;
    const line = `Waiting on ${this._name(holder)} to name the new steward. `
      + `Settling now hands it to ${this._name(fallback)}, who was simply paired first.`;
    return `<p class="rb-meta rb-warn" data-steward-waiting="${shireId}">${escape(line)}</p>`;
  }

  /**
   * Who has declared what, and the pencil to change it.
   *
   * Drawn in the Team Phase as well as the Battle Phase, because that is when
   * the plans are actually being made: a facilitator watching the targets
   * arrive can see the shape of the coming turn while there is still time to
   * ask about it. The same list carries over into the battle phase, where it
   * gains the button that turns plans into battles.
   *
   * @param {boolean} announceable whether to offer the Announce button — the
   *   command is battle-phase only, so offering it in the Team Phase would be
   *   a control that can only refuse.
   */
  _declared(state, announceable) {
    const plans = state.initiative.declared ?? {};
    // Held tokens *and* standing declarations, not one or the other. A token
    // can be taken off its holder — one click on the inspector's checkbox, or
    // a role removed from the game — and the declaration it made stays
    // behind. Listing only holders would hide that orphan while
    // `announce-targets` went on staging a battle from it.
    const rows = TOKENS.filter((token) => state.initiative[token] || plans[token]);
    const declaredCount = rows.filter((token) => plans[token]).length;
    const shireOptions = Object.keys(state.shires)
      .map((id) => `<option value="${id}">${this._data.shires.shires[id]?.name ?? id}</option>`)
      .join('');

    // Last turn's battles were never ended, so `battle.targets` is still full
    // and every retarget would refuse. Say so rather than offer the pencil.
    const stale = Boolean(state.battle.targets?.length) && !announceable;

    return `
      ${this._note('spare')}
      <p class="rb-meta">${declaredCount
    ? `${declaredCount} of ${rows.length} token${rows.length === 1 ? '' : 's'} declared`
      + `${announceable ? ', not yet announced' : ''}.`
    : 'No targets declared yet.'}</p>
      ${stale ? `<p class="rb-meta rb-warn" data-stale-targets>Last turn's battles were
        never ended, so these cannot be changed yet — end them on the battle
        tab first.</p>` : ''}
      ${rows.length ? `
        <ul class="rb-declared-targets">${rows.map((token) => {
    const plan = plans[token];
    const holder = state.initiative[token];
    return `
            <li>
              <span class="rb-inspector-stat-label">${token} — ${
  this._name(holder ?? plan?.roleId)}${holder ? '' : ' (token taken away)'}</span>
              ${plan ? '' : '<span class="rb-meta">none declared</span>'}
              <select data-retarget="${token}" ${stale ? 'disabled' : ''}>
                <option value="">nowhere yet</option>${shireOptions}
              </select>
              <button type="button" data-commit-retarget="${token}" ${stale ? 'disabled' : ''}>
                ${plan ? 'Change' : 'Set'}</button>
            </li>`;
  }).join('')}</ul>` : '<p class="rb-empty">Nobody holds an initiative token.</p>'}
      ${announceable ? `
        <button type="button" data-announce class="rb-primary"
          ${declaredCount ? '' : 'disabled'}>Announce the targets</button>` : ''}`;
  }

  /** Point each retarget dropdown at what is actually declared right now. */
  _syncRetargets(state) {
    for (const select of this.querySelectorAll('[data-retarget]')) {
      const token = select.dataset.retarget;
      select.value = state.initiative.declared?.[token]?.shireId ?? '';
    }
  }

  _render() {
    if (!this.isConnected || !this._state || !this._data) return;
    const state = this._state;
    const phase = state.phase.name;

    // The plans are laid in the Team Phase and fought over in the Battle
    // Phase, so the grid has something to say in both.
    if (phase !== 'battle' && phase !== 'team') {
      this.innerHTML = '<p class="rb-empty">Not a battle phase.</p>';
      return;
    }

    const targets = state.battle.targets ?? [];

    if (phase === 'team' || !targets.length) {
      this.innerHTML = this._declared(state, phase === 'battle');
      this._syncRetargets(state);
      this._wire();
      return;
    }

    this.innerHTML = `${targets.map((shireId) => this._battle(state, shireId)).join('')}
      ${this._note('spare')}
      <button type="button" data-end>End the battles and hand out the spare token</button>`;
    this._wire();
  }

  _battle(state, shireId) {
    const sides = state.battle.sides?.[shireId] ?? { attackers: [], defenders: [] };
    const clashes = Object.values(state.battle.clashes).filter((c) => c.shireId === shireId);
    const shire = state.shires[shireId];
    const name = this._data.shires.shires[shireId]?.name ?? shireId;

    const wins = clashes.reduce((n, c) => n + (c.result?.winner === c.attacker ? 1 : 0), 0);
    const held = clashes.filter((c) => c.result && c.result.winner !== c.attacker).length;
    const scouts = (state.battle.scouts?.[shireId] ?? []).length;
    const allDone = clashes.length > 0 && clashes.every((c) => c.stage === 'resolved');

    return `
      <section class="rb-battle-block">
        <h3>${name}</h3>
        <p class="rb-meta">
          Held by ${this._name(shire.stewardRoleId)} · ${shire.castles} castles ·
          ${clashes.length ? `attackers ${wins}, defenders ${held}${
  scouts ? ` (+${scouts} scouting)` : ''}` : 'not yet paired'}
        </p>

        <div class="rb-sides">
          <div><strong>Attacking</strong><br>${
  sides.attackers.map((r) => this._name(r)).join('<br>') || '<em>nobody</em>'}</div>
          <div><strong>Defending</strong><br>${
  sides.defenders.map((r) => this._name(r)).join('<br>') || '<em>nobody</em>'}</div>
        </div>

        ${clashes.length ? `
          <ul class="rb-clash-rows">${clashes.map((clash) => `
            <li class="rb-clash-row" data-stage="${clash.stage}">
              <span>${this._name(clash.attacker)} v ${this._name(clash.defender)}</span>
              <span class="rb-meta">${clash.auto ? 'unopposed'
    : STAGE_LABEL[clash.stage] ?? clash.stage}${
  clash.result && !clash.auto ? ` — ${this._name(clash.result.winner)} won` : ''}</span>
              ${clash.stage === 'resolved' ? '' : `
                <button type="button" data-resolve="${clash.id}"
                        title="Fills in whatever is missing and settles it. A die a
                               fighter has already thrown is kept.">Force it through</button>`}
            </li>`).join('')}</ul>
        ` : `<button type="button" data-pair="${shireId}" class="rb-primary"
               ${sides.attackers.length ? '' : 'disabled'}>Pair the fighters</button>`}

        ${allDone ? `
          <div class="rb-settle">
            ${this._heldBack(state, shireId)}
            ${this._stewardPick(state, shireId)}
            <button type="button" data-settle="${shireId}" class="rb-primary">Settle the shire</button>
          </div>` : ''}
      </section>`;
  }

  _wire() {
    const announce = this.querySelector('[data-announce]');
    if (announce) announce.onclick = () => this._emit('facilitator:announce-targets', {});

    for (const button of this.querySelectorAll('[data-commit-retarget]')) {
      const token = button.dataset.commitRetarget;
      const select = this.querySelector(`[data-retarget="${token}"]`);
      // "nowhere yet" is not a shire, so committing it could only earn a
      // refusal in the log. The button waits until the dropdown says
      // something the command can actually take.
      const settle = () => { button.disabled = select.disabled || !select.value; };
      settle();
      select.onchange = settle;
      button.onclick = () => {
        if (!select.value) return;
        this._emit('facilitator:set-initiative-target', { token, shireId: select.value });
      };
    }

    const end = this.querySelector('[data-end]');
    if (end) end.onclick = () => this._emit('facilitator:end-battles', {});

    for (const button of this.querySelectorAll('[data-pair]')) {
      button.onclick = () => this._emit('facilitator:pair-clashes', { shireId: button.dataset.pair });
    }
    for (const button of this.querySelectorAll('[data-resolve]')) {
      button.onclick = () => this._emit('facilitator:resolve-clash', { clashId: button.dataset.resolve });
    }
    for (const button of this.querySelectorAll('[data-settle]')) {
      // No `newSteward`: the conqueror names their own, and settleBattle reads
      // the pick before it reaches for anything else. Sending one from here
      // would be the free choice this console gave up.
      button.onclick = () => this._emit('facilitator:settle-battle',
        { shireId: button.dataset.settle });
    }
  }
}

function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

customElements.define('rb-facilitator-grid', RbFacilitatorGrid);
