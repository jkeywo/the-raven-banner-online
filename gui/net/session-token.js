/**
 * gui/net/session-token.js — the credential that gets you back in your chair.
 *
 * A peer id changes on every page load, so it cannot be identity. The token
 * can: it survives a refresh, and the host matches it back to the seat that
 * held it. That is the whole of reconnection.
 *
 * Ported from project-phoenix-v2, which learned two things the hard way:
 *
 * 1. A token in `localStorage` is shared by every tab of an origin, so two
 *    consoles open on one laptop read the *same* token, and the host routes
 *    everything to whichever identified last. The other becomes a ghost whose
 *    taps succeed and show nothing. So the token lives in `sessionStorage`,
 *    which is per-tab and survives a reload, and only the first tab adopts the
 *    persistent one.
 * 2. Liveness has to be answerable synchronously at load, because the decision
 *    is made before anything is on screen. Hence a short-TTL heartbeat registry
 *    rather than cleanup on unload, which mobile browsers do not reliably run.
 *
 * Keyed per join code, so a facilitator and a player on one machine are two
 * seats rather than a collision.
 */

export const HEARTBEAT_MS = 2000;
export const REGISTRY_TTL_MS = 6000;

const tabKey = (code) => `rbo:tok:${code}`;
const sharedKey = (code) => `rbo:tok:shared:${code}`;
const registryKey = (code) => `rbo:tabs:${code}`;

/** 32 hex characters from a getRandomValues-compatible source. */
export function mintToken(getRandomValues) {
  const bytes = getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Drop registry entries older than the TTL. Never mutates its input. */
export function pruneRegistry(registry, now, ttl = REGISTRY_TTL_MS) {
  return Object.fromEntries(
    Object.entries(registry ?? {})
      .filter(([, e]) => e && typeof e.ts === 'number' && now - e.ts <= ttl));
}

/** Is this token held right now by a live tab other than mine? */
export function isClaimedByOtherTab(registry, token, myTabId, now, ttl = REGISTRY_TTL_MS) {
  if (!token) return false;
  return Object.entries(registry ?? {}).some(([tabId, e]) => (
    tabId !== myTabId && e?.token === token && now - e.ts <= ttl));
}

/**
 * Which token this tab should use, and what to write down.
 *
 * Pure, so the interesting case — a second tab opening while the first is
 * live — is a unit test rather than something you find out at an event.
 *
 * @returns {{token: string, storeAsTab: boolean, storeAsShared: boolean}}
 */
export function decideToken({
  tabToken, tabTokenClaimed = false, isReload = false,
  sharedToken, sharedClaimed, freshToken,
}) {
  // This tab reloading: reuse its own token untouched.
  if (tabToken && (!tabTokenClaimed || isReload)) {
    return { token: tabToken, storeAsTab: false, storeAsShared: false };
  }
  // The first or only tab: adopt the persistent token, so a full browser
  // restart still lands back in the same seat.
  if (sharedToken && !sharedClaimed) {
    return { token: sharedToken, storeAsTab: true, storeAsShared: false };
  }
  // A concurrent tab, or a machine that has never played: mint one. Seed the
  // shared slot only if it is empty, so we never clobber another tab's.
  return { token: freshToken, storeAsTab: true, storeAsShared: !sharedToken };
}

/**
 * Resolve this tab's token against real storage and keep its lease alive.
 *
 * Falls back to an in-memory token when storage is unavailable — a private
 * window should still be able to play, it just will not survive a refresh.
 *
 * @param {string} code  the join code, so seats are scoped to one game
 * @param {Window} [win]
 */
export function installSessionToken(code, win = globalThis.window) {
  const getRandomValues = (array) => win.crypto.getRandomValues(array);
  const freshToken = mintToken(getRandomValues);

  let sessionStore;
  let localStore;
  try {
    sessionStore = win.sessionStorage;
    localStore = win.localStorage;
  } catch {
    return freshToken;
  }
  if (!sessionStore || !localStore) return freshToken;

  const tabId = mintToken(getRandomValues);
  const readRegistry = () => {
    try {
      return pruneRegistry(JSON.parse(localStore.getItem(registryKey(code))) || {}, Date.now());
    } catch {
      return {};
    }
  };

  const now = Date.now();
  const registry = readRegistry();
  const tabToken = sessionStore.getItem(tabKey(code));
  const sharedToken = localStore.getItem(sharedKey(code));
  const navigation = win.performance?.getEntriesByType?.('navigation')?.[0];

  const { token, storeAsTab, storeAsShared } = decideToken({
    tabToken,
    tabTokenClaimed: isClaimedByOtherTab(registry, tabToken, tabId, now),
    isReload: navigation?.type === 'reload',
    sharedToken,
    sharedClaimed: isClaimedByOtherTab(registry, sharedToken, tabId, now),
    freshToken,
  });

  try {
    if (storeAsTab) sessionStore.setItem(tabKey(code), token);
    if (storeAsShared) localStore.setItem(sharedKey(code), token);
  } catch { /* private mode; the token still works for this session */ }

  const beat = () => {
    try {
      const live = readRegistry();
      live[tabId] = { token, ts: Date.now() };
      localStore.setItem(registryKey(code), JSON.stringify(live));
    } catch { /* nothing to do but carry on */ }
  };
  beat();
  win.setInterval?.(beat, HEARTBEAT_MS);
  win.addEventListener?.('pagehide', () => {
    try {
      const live = readRegistry();
      delete live[tabId];
      localStore.setItem(registryKey(code), JSON.stringify(live));
    } catch { /* the TTL will clear it soon enough */ }
  });

  return token;
}
