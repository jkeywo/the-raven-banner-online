/**
 * gui/host/persistence.js — the three layers between a game and oblivion.
 *
 * The whole game lives in one browser tab. That is the deliberate trade behind
 * host authority, and it is also the single failure that can end a three-hour
 * session outright, so it gets three independent recoveries rather than one
 * good one:
 *
 *   1. A **derived peer id** (in `gui/net/join-code.js`), so a refreshed host
 *      is reachable at the address every client is already retrying. Survives
 *      a refresh. Recovers nothing on its own — it just means nobody has to
 *      re-enter anything.
 *   2. **Autosave to local storage**, debounced, plus an unconditional write
 *      when the page is hidden or unloaded. Survives a refresh, a tab restore
 *      and a browser crash. Does not survive the machine.
 *   3. **A downloaded file**, offered at every phase boundary. The only one
 *      that survives hardware failure: a fresh browser on a borrowed laptop
 *      imports it, re-mints the same join code, and everyone reconnects.
 *
 * A save is a seed and a command log, not a snapshot, so it cannot disagree
 * with its own history and is a few kilobytes rather than a whole board.
 */

export const SAVE_PREFIX = 'rbo:save:';
export const DEBOUNCE_MS = 250;

const keyFor = (joinCode) => `${SAVE_PREFIX}${joinCode}`;

/**
 * Autosave, wired to a host.
 *
 * Storage is injected rather than reached for, so the interesting cases —
 * a quota error, a private window with no storage at all — are tests instead
 * of things you discover at an event.
 */
export class Persistence {
  /**
   * @param {object} args
   * @param {Storage} [args.storage]
   * @param {object} [args.timers]  setTimeout/clearTimeout, injectable
   * @param {Function} [args.onError]  called when a write fails
   */
  constructor({ storage = globalThis.localStorage, timers = globalThis, onError } = {}) {
    this._storage = storage;
    this._timers = timers;
    this._onError = onError ?? (() => {});
    this._pending = null;
    this.lastError = null;
  }

  /** Queue a save. Repeated calls inside the window collapse into one write. */
  schedule(save) {
    if (this._pending) this._timers.clearTimeout(this._pending);
    this._pending = this._timers.setTimeout(() => {
      this._pending = null;
      this.write(save);
    }, DEBOUNCE_MS);
  }

  /**
   * Write now, skipping the debounce. Used on `pagehide` and
   * `visibilitychange`, where there may be no next tick.
   *
   * @returns {boolean} whether it landed
   */
  write(save) {
    if (!this._storage) return false;
    try {
      this._storage.setItem(keyFor(save.joinCode), JSON.stringify(save));
      this.lastError = null;
      return true;
    } catch (error) {
      // Almost always a full quota. Reported rather than thrown, because a
      // failed autosave must not take the running game down with it — the
      // downloadable file is still there.
      this.lastError = error;
      this._onError(error);
      return false;
    }
  }

  /** The save for a join code, or null. */
  read(joinCode) {
    if (!this._storage) return null;
    try {
      const raw = this._storage.getItem(keyFor(joinCode));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /** Every game this browser has a save for, newest first. */
  list() {
    if (!this._storage) return [];
    const saves = [];
    for (let i = 0; i < this._storage.length; i++) {
      const key = this._storage.key(i);
      if (!key?.startsWith(SAVE_PREFIX)) continue;
      try {
        const save = JSON.parse(this._storage.getItem(key));
        if (save?.joinCode) saves.push(save);
      } catch { /* a corrupt entry is not worth failing the list over */ }
    }
    return saves.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
  }

  forget(joinCode) {
    try { this._storage?.removeItem(keyFor(joinCode)); } catch { /* nothing to do */ }
  }

  /** Stop any queued write. */
  cancel() {
    if (this._pending) this._timers.clearTimeout(this._pending);
    this._pending = null;
  }
}

/** What a downloaded save is called. Sorts chronologically, reads plainly. */
export function saveFilename(state) {
  const turn = String(state.phase.turn).padStart(2, '0');
  return `raven-${state.joinCode}-t${turn}-${state.phase.name}.json`;
}

/**
 * Check a file someone is importing before handing it to the replayer.
 *
 * Deliberately strict about shape and quiet about content: whether the log
 * still replays is `GameHost.restore`'s business, and it reports what it
 * refused.
 *
 * @returns {{ok: true, save: object} | {ok: false, reason: string}}
 */
export function parseSave(text) {
  let save;
  try {
    save = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'that file is not readable as a save' };
  }
  if (!save || typeof save !== 'object') return { ok: false, reason: 'that file is not a save' };
  if (typeof save.joinCode !== 'string' || !save.joinCode) {
    return { ok: false, reason: 'that save has no join code' };
  }
  if (!Number.isInteger(save.seed)) return { ok: false, reason: 'that save has no seed' };
  if (!Array.isArray(save.log)) return { ok: false, reason: 'that save has no history' };
  return { ok: true, save };
}

/**
 * Offer a save as a download.
 *
 * The escape hatch that survives the machine dying, so it is a plain anchor
 * click with no dependencies and nothing that can be blocked.
 */
export function downloadSave(save, filename, doc = globalThis.document) {
  offer(new Blob([JSON.stringify(save, null, 1)], { type: 'application/json' }), filename, doc);
}

/**
 * The debrief as a page that stands on its own.
 *
 * Styles inlined and nothing fetched, so it can be mailed round the week after
 * with the app long closed and the host tab long gone. This is the only
 * artefact of the evening anybody keeps.
 */
export function epiloguePage(body, joinCode) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>The Raven Banner — ${joinCode}</title>
<style>
  body { font: 16px/1.5 Georgia, serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem;
         color: #2b2118; background: #f6f1e6; }
  h1, h2, h3 { font-family: Georgia, serif; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 0.3rem 0.6rem; border-bottom: 1px solid #d8cdb8; }
  ul { list-style: none; padding: 0; }
  li { padding: 0.2rem 0; }
  .rb-meta { color: #6b5c48; font-size: 0.85em; }
  .rb-empty { color: #6b5c48; font-style: italic; }
  dt { font-weight: 600; margin-top: 0.7rem; }
  dd { margin: 0; }
</style></head>
<body><h1>The Raven Banner</h1>${body}</body></html>`;
}

export function downloadPage(html, filename, doc = globalThis.document) {
  offer(new Blob([html], { type: 'text/html' }), filename, doc);
}

function offer(blob, filename, doc) {
  const url = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = filename;
  doc.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next tick: revoking immediately can beat the download in
  // some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
