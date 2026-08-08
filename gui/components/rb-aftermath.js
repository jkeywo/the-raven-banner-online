/**
 * <rb-aftermath> — how England is doing, and what that will have meant.
 *
 * The endgame of the paper game is a sheet the assistant facilitator updates
 * each turn: four counters, each landing in a band, and each band a sentence
 * about what happened to the country. There is no winner — this is the closest
 * thing the game has to a score, and it belongs to everybody at once.
 *
 * All four are derived from the board rather than tracked, so this can never
 * disagree with the map it is describing. The fifth, Foreign Influence, is a
 * facilitator's judgement of what was promised to the Franks, the Britons and
 * the Pope, and no counter could hold it.
 */

/**
 * The band text, transcribed from "England in the Aftermath". Kept here rather
 * than in the dataset because it is what the counters *mean* to a reader, not
 * an input to any rule — nothing computes on these sentences.
 */
const BANDS = {
  paganism: {
    label: 'Paganism',
    of: 'pagan shires with no missionary',
    text: [
      'No significant pagan influence.',
      'The church takes on some pagan influence.',
      'The island becomes segregated between Christian and pagan control.',
      'Christianity once more leaves the shores of England.',
    ],
  },
  danelaw: {
    label: 'Danelaw',
    of: 'shires under Danish stewards',
    text: [
      'Little to no impact.',
      'Some Danish enclaves.',
      'Significant influence.',
      'Danish becomes the dominant culture.',
      'Saxon culture is replaced.',
    ],
  },
  disorder: {
    label: 'Disorder',
    of: 'shires held without support',
    text: [
      'A generation or two of peace.',
      'War is inevitable, but there is peace for the moment.',
      'The war continues, the land will be devastated.',
    ],
  },
  prosperity: {
    label: 'Prosperity',
    of: 'settlements still standing',
    text: [
      'Famine and poverty hit all levels of society.',
      'England will take decades to rebuild to its former strength.',
      'All of England prospers.',
    ],
  },
};

export class RbAftermath extends HTMLElement {
  set view(value) { this._view = value; this._render(); }

  connectedCallback() { this._render(); }

  _render() {
    if (!this.isConnected) return;
    const aftermath = this._view?.derived?.aftermath;
    if (!aftermath) {
      this.innerHTML = '<p class="rb-empty">Not started.</p>';
      return;
    }

    const counters = Object.entries(BANDS).map(([key, meta]) => {
      const counter = aftermath[key];
      if (!counter) return '';
      // A band index of -1 means the value fell outside every printed band,
      // which would be a data problem rather than a game state — say so
      // instead of rendering an empty sentence.
      const sentence = meta.text[counter.band] ?? 'Outside the printed bands.';
      const steps = meta.text.map((_, i) => (
        `<span class="rb-band${i === counter.band ? ' is-here' : ''}"></span>`)).join('');
      return `
        <li class="rb-counter">
          <div class="rb-counter-head">
            <span class="rb-counter-label">${meta.label}</span>
            <span class="rb-counter-value">${counter.value}</span>
          </div>
          <div class="rb-bands" role="img"
               aria-label="band ${counter.band + 1} of ${meta.text.length}">${steps}</div>
          <p class="rb-counter-text">${sentence}</p>
          <p class="rb-meta">${counter.value} ${meta.of}.</p>
        </li>`;
    }).join('');

    const influence = aftermath.foreignInfluence;
    this.innerHTML = `
      <ul class="rb-counters">${counters}</ul>
      <h3>Foreign Influence</h3>
      <p class="${influence ? '' : 'rb-empty'}">
        ${influence ? escape(influence)
    : 'Nothing has been promised to the Franks, the Britons or the Pope yet.'}
      </p>`;
  }
}

function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

customElements.define('rb-aftermath', RbAftermath);
