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

import { battleNoteKey, heldBackToken } from '../rules/battle.js';

const STAGE_LABEL = {
  awaiting_tactics: 'choosing cards',
  tactics_revealed: 'cards down',
  awaiting_lead: 'deciding who leads',
  lead_revealed: 'may still join the charge',
  rolling: 'ready to roll',
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

  _render() {
    if (!this.isConnected || !this._state || !this._data) return;
    const state = this._state;

    if (state.phase.name !== 'battle') {
      this.innerHTML = '<p class="rb-empty">Not a battle phase.</p>';
      return;
    }

    const declared = Object.entries(state.initiative.declared ?? {});
    const targets = state.battle.targets ?? [];

    if (!targets.length) {
      const shireOptions = Object.keys(state.shires)
        .map((id) => `<option value="${id}">${this._data.shires.shires[id]?.name ?? id}</option>`)
        .join('');
      this.innerHTML = `
        ${this._note('spare')}
        <p class="rb-meta">${declared.length
    ? `${declared.length} target${declared.length === 1 ? '' : 's'} declared but not announced.`
    : 'No targets declared yet.'}</p>
        ${declared.length ? `
          <ul class="rb-declared-targets">${declared.map(([token, d]) => `
            <li>
              <span class="rb-inspector-stat-label">${token} — ${this._name(d.roleId)}</span>
              <select data-retarget="${token}">${shireOptions}</select>
              <button type="button" data-commit-retarget="${token}">Change</button>
            </li>`).join('')}</ul>` : ''}
        <button type="button" data-announce class="rb-primary"
          ${declared.length ? '' : 'disabled'}>Announce the targets</button>`;
      for (const select of this.querySelectorAll('[data-retarget]')) {
        const token = select.dataset.retarget;
        select.value = declared.find(([t]) => t === token)?.[1]?.shireId ?? '';
      }
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
                <button type="button" data-resolve="${clash.id}">Roll it</button>`}
            </li>`).join('')}</ul>
        ` : `<button type="button" data-pair="${shireId}" class="rb-primary"
               ${sides.attackers.length ? '' : 'disabled'}>Pair the fighters</button>`}

        ${allDone ? `
          <div class="rb-settle">
            ${this._heldBack(state, shireId)}
            <label>New steward if it falls
              <select data-steward="${shireId}">
                ${sides.attackers.map((r) => `<option value="${r}">${this._name(r)}</option>`).join('')}
              </select>
            </label>
            <button type="button" data-settle="${shireId}" class="rb-primary">Settle the shire</button>
          </div>` : ''}
      </section>`;
  }

  _wire() {
    const announce = this.querySelector('[data-announce]');
    if (announce) announce.onclick = () => this._emit('facilitator:announce-targets', {});

    for (const button of this.querySelectorAll('[data-commit-retarget]')) {
      button.onclick = () => {
        const token = button.dataset.commitRetarget;
        const shireId = this.querySelector(`[data-retarget="${token}"]`).value;
        this._emit('facilitator:set-initiative-target', { token, shireId });
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
      const shireId = button.dataset.settle;
      button.onclick = () => this._emit('facilitator:settle-battle', {
        shireId,
        newSteward: this.querySelector(`[data-steward="${shireId}"]`)?.value ?? null,
      });
    }
  }
}

function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

customElements.define('rb-facilitator-grid', RbFacilitatorGrid);
