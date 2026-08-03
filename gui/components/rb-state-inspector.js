/**
 * <rb-state-inspector> — the umpire's hand, reaching into the game.
 *
 * A searchable tree of the whole state where any leaf can be edited. It exists
 * because the app will get something wrong during a game, and the alternative
 * to fixing it is a room of sixteen people watching a facilitator apologise.
 * A paper megagame has never had this problem: the umpire simply crosses out a
 * number. This is that pencil.
 *
 * Every edit goes out as `facilitator:set` through the same admission and
 * reducer as a player's command, so it lands in the log tagged as an override
 * and a replay reproduces it. That is what stops "the facilitator can change
 * anything" from meaning "the history is a polite fiction".
 *
 * Values are typed back the way they were typed out — a number stays a number,
 * a boolean a boolean — because a `castles` that quietly became the string "3"
 * would compare wrong everywhere afterwards and nobody would know why.
 */

/** Paths worth offering first, because they are what actually gets fixed. */
const SUGGESTED = [
  'roles.*.silver', 'roles.*.food', 'roles.*.soldiers', 'roles.*.momentum',
  'roles.*.wounds', 'shires.*.castles', 'shires.*.stewardRoleId',
  'aftermath.foreignInfluence',
];

/** Never editable here: changing one breaks replay rather than the game. */
const OFF_LIMITS = ['seed', 'rngCursor', 'log', 'schemaVersion', 'joinCode', 'seatByToken'];

const isBranch = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export class RbStateInspector extends HTMLElement {
  set state(value) {
    this._state = value;
    this._render();
  }

  connectedCallback() {
    if (!this._built) {
      this._built = true;
      this.innerHTML = `
        <div class="rb-inspector-head">
          <label>Find
            <input type="search" id="rb-inspector-find"
                   placeholder="silver, wiltshire, wounds…">
          </label>
          <p class="rb-meta">
            Every change here is logged as an override and replays with the
            game. The seed and the history are not editable — changing those
            would make the record disagree with the game it describes.
          </p>
        </div>
        <div class="rb-inspector-rows"></div>`;
      this.querySelector('#rb-inspector-find').addEventListener('input', (event) => {
        this._query = event.target.value.trim().toLowerCase();
        this._renderRows();
      });
    }
    this._render();
  }

  _render() {
    if (!this.isConnected || !this._built || !this._state) return;
    this._leaves = collectLeaves(this._state);
    this._renderRows();
  }

  _renderRows() {
    const query = this._query ?? '';
    const matches = query
      ? this._leaves.filter(({ path }) => path.toLowerCase().includes(query))
      : this._leaves.filter(({ path }) => SUGGESTED.some((pattern) => matchesPattern(pattern, path)));

    const rows = this.querySelector('.rb-inspector-rows');
    if (!matches.length) {
      rows.innerHTML = `<p class="rb-empty">${query
        ? 'Nothing matches that.' : 'Nothing to show.'}</p>`;
      return;
    }

    // Capped, because an unfiltered game state is a few thousand leaves and a
    // facilitator hunting through all of them mid-turn is not helped by more.
    const shown = matches.slice(0, 60);
    rows.innerHTML = `${shown.map(({ path, value }) => `
      <label class="rb-inspector-row">
        <span class="rb-inspector-path">${path}</span>
        ${renderInput(path, value)}
      </label>`).join('')}
      ${matches.length > shown.length
    ? `<p class="rb-meta">${matches.length - shown.length} more — narrow the search.</p>` : ''}`;

    for (const input of rows.querySelectorAll('[data-path]')) {
      input.onchange = () => this._commit(input);
    }
  }

  _commit(input) {
    const path = input.dataset.path;
    const raw = input.type === 'checkbox' ? input.checked : input.value;
    const value = coerce(raw, input.dataset.kind);
    this.dispatchEvent(new CustomEvent('rb-facilitate', {
      bubbles: true,
      detail: { verb: 'facilitator:set', payload: { path: path.split('.'), value } },
    }));
  }
}

/** Every editable leaf, as dotted paths. */
export function collectLeaves(state, prefix = [], out = []) {
  for (const [key, value] of Object.entries(state)) {
    const path = [...prefix, key];
    if (prefix.length === 0 && OFF_LIMITS.includes(key)) continue;
    if (isBranch(value)) collectLeaves(value, path, out);
    else if (!Array.isArray(value)) out.push({ path: path.join('.'), value });
  }
  return out;
}

/** `roles.*.silver` against `roles.king_alfred.silver`. */
export function matchesPattern(pattern, path) {
  const p = pattern.split('.');
  const s = path.split('.');
  return p.length === s.length && p.every((part, i) => part === '*' || part === s[i]);
}

/**
 * Read a typed value back out of a form field.
 *
 * A `castles` that silently became the string "3" would compare wrong
 * everywhere afterwards and nobody would know why, so the original type is
 * carried on the input and restored here.
 */
export function coerce(raw, kind) {
  if (kind === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  if (kind === 'boolean') return Boolean(raw);
  if (kind === 'null') return raw === '' ? null : raw;
  return raw;
}

function renderInput(path, value) {
  const kind = value === null ? 'null' : typeof value;
  if (kind === 'boolean') {
    return `<input type="checkbox" data-path="${path}" data-kind="boolean"
              ${value ? 'checked' : ''}>`;
  }
  if (kind === 'number') {
    return `<input type="number" data-path="${path}" data-kind="number" value="${value}">`;
  }
  return `<input type="text" data-path="${path}" data-kind="${kind}"
            value="${String(value ?? '').replace(/"/g, '&quot;')}">`;
}

customElements.define('rb-state-inspector', RbStateInspector);
