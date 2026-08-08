/**
 * gui/net/name-storage.js — so a name is typed once per machine, not once per game.
 *
 * Unlike the session token, a name is not scoped to a join code: the same
 * person is the same person across every game they sit down to, facilitator
 * or player alike. One shared key, one value.
 */

const KEY = 'rbo:name';

/** Whatever was last saved, or '' if there is nothing — never throws. */
export function loadSavedName(win = globalThis.window) {
  try {
    return win.localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

/** Silently does nothing in private mode — a name just gets retyped there. */
export function saveName(name, win = globalThis.window) {
  try {
    if (name) win.localStorage.setItem(KEY, name);
  } catch { /* private mode; nothing survives, and that is fine */ }
}

/**
 * Forget it, so the next load asks rather than assuming.
 *
 * `saveName('')` deliberately will not do this: a blank is what an untouched
 * field gives you, and taking that as "forget me" would lose the name every
 * time somebody tabbed past it. Forgetting has to be asked for.
 */
export function forgetName(win = globalThis.window) {
  try {
    win.localStorage.removeItem(KEY);
  } catch { /* nothing stored, nothing to remove */ }
}
