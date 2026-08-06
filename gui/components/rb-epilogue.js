/**
 * <rb-epilogue> — what the facilitator reads out when the game is over.
 *
 * "Give an overview of the state of the island, both the political and
 * military situation at the end of the game as well as summarising the
 * outcomes from England in the Aftermath." That is a great deal to assemble
 * from memory after five turns of also being four foreign courts, so it is
 * assembled here instead: the counters with the sentence printed under each
 * band, who ended holding what, the factions as they finished rather than as
 * they began, and every promise made abroad.
 *
 * All of it derived from the board. An epilogue that could disagree with the
 * map it describes would be worse than no epilogue at all.
 */

import { epilogue } from '../rules/epilogue.js';

const title = (text) => String(text ?? '').replace(/_/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());

export class RbEpilogue extends HTMLElement {
  set data(value) { this._data = value; this._render(); }

  set state(value) { this._state = value; this._render(); }

  connectedCallback() { this._render(); }

  /** The report as it stands, for anybody who wants to save or print it. */
  get report() {
    return this._state && this._data ? epilogue(this._state, this._data) : null;
  }

  _render() {
    if (!this.isConnected || !this._state || !this._data) return;
    const report = this.report;
    const nameOf = (id) => this._data.roles.roles[id]?.name ?? id;
    const shireName = (id) => this._data.shires.shires[id]?.name ?? id;

    this.innerHTML = `
      <article class="rb-epilogue">
        <h3>England in the Aftermath</h3>
        <dl class="rb-verdicts">${Object.values(report.counters).map((counter) => `
          <dt>${title(counter.title)} <span class="rb-meta">${counter.value}
            ${counter.start === counter.value ? '— where it started'
    : `— from ${counter.start}`}</span></dt>
          <dd>${counter.sentence}</dd>`).join('')}
        </dl>

        <h3>Foreign Influence</h3>
        <p class="rb-meta">${report.foreignInfluence.note}</p>
        ${report.foreignInfluence.prose
    ? `<p>${escape(report.foreignInfluence.prose)}</p>`
    : '<p class="rb-empty">Nothing written down. The ledger below is what there is.</p>'}
        ${report.foreignInfluence.promises.length ? `
          <ul class="rb-ledger">${report.foreignInfluence.promises.map((promise) => `
            <li data-kept="${promise.kept}">
              <span>${promise.kept ? '' : '<s>'}${escape(promise.text)}${promise.kept ? '' : '</s>'}</span>
              <span class="rb-meta">${escape(this._data.factions.npc[promise.npcFaction]?.name
    ?? promise.npcFaction)}${promise.roleId ? `, from ${escape(nameOf(promise.roleId))}` : ''},
                turn ${promise.turn}</span>
            </li>`).join('')}</ul>`
    : '<p class="rb-empty">Nobody promised anybody anything.</p>'}

        <h3>How the factions finished</h3>
        <ul class="rb-factions">${report.factions.map((faction) => `
          <li>
            <strong>${title(faction.id)}</strong>
            <span class="rb-meta">${faction.shires} shire${faction.shires === 1 ? '' : 's'}${
  faction.crowns.length ? `, wearing ${faction.crowns.map(title).join(' and ')}` : ''}</span>
            <span class="rb-meta">${faction.members.map(nameOf).join(', ')}</span>
          </li>`).join('')}
        </ul>

        <h3>Where everybody ended</h3>
        <table class="rb-final">
          <thead><tr><th>Who</th><th>Held</th><th>Crowns</th><th>Left over</th></tr></thead>
          <tbody>${report.players.map((player) => `
            <tr>
              <td>${escape(player.name)}${player.generation
  ? ` <span class="rb-meta">(the ${ordinal(player.generation + 1)})</span>` : ''}${
  player.baptised ? ' <span class="rb-meta">baptised</span>' : ''}</td>
              <td>${player.shires.map(shireName).join(', ') || '—'}</td>
              <td>${player.crowns.map(title).join(', ') || '—'}</td>
              <td class="rb-meta">${player.resources.silver} silver,
                ${player.resources.soldiers} soldiers,
                ${player.resources.food} food,
                ${player.resources.ships} ships</td>
            </tr>`).join('')}
          </tbody>
        </table>

        ${Object.keys(report.notes).length ? `
          <h3>What the umpire changed</h3>
          <ul class="rb-ledger">${Object.entries(report.notes).map(([key, note]) => `
            <li><span>${escape(note)}</span>
              <span class="rb-meta">${escape(key)}</span></li>`).join('')}</ul>` : ''}
      </article>`;
  }
}

const ordinal = (n) => {
  const names = ['first', 'second', 'third', 'fourth', 'fifth'];
  return names[n - 1] ?? `${n}th`;
};

function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

customElements.define('rb-epilogue', RbEpilogue);
