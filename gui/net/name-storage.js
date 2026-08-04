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
