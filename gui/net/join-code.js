/**
 * gui/net/join-code.js — the six characters that are the whole lobby.
 *
 * There is no server and no room list. The join code *is* the address: the
 * host derives its peer id from it, so a facilitator who refreshes reclaims the
 * same id and every client already retrying against it reconnects with nobody
 * doing anything. That one property is the backbone of host crash recovery,
 * and it is why the code is derived rather than issued.
 *
 * Pure and DOM-free apart from `codeFromLocation`, which takes the location
 * object rather than reaching for `window`.
 */

/**
 * No O/0 or I/1: the code gets read aloud over voice and typed by sixteen
 * people at once, and those are the two pairs that cost you a minute each time.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Characters of randomness, before the check character. */
export const CODE_LENGTH = 6;

/**
 * The wire protocol version, carried in the peer id.
 *
 * Bump it whenever the message shapes change incompatibly. A stale client then
 * cannot reach a new host at all, which is a far kinder failure than a
 * connection that opens and then quietly disagrees about what a command means.
 */
export const PROTOCOL = 'rbo1';

/** A check character over the code body. Catches the usual typo and transposition. */
function checkChar(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    sum += (CODE_ALPHABET.indexOf(body[i]) + 1) * (i + 1);
  }
  return CODE_ALPHABET[sum % CODE_ALPHABET.length];
}

/**
 * Mint a code. Randomness is passed in so this stays pure and testable.
 *
 * @param {() => number} random
 */
export function mintJoinCode(random = Math.random) {
  let body = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    body += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return body + checkChar(body);
}

/**
 * Uppercase, with spaces and punctuation dropped.
 *
 * Deliberately does not guess at O/0 or I/1. They are excluded from the
 * alphabet so they never appear in a real code, which means a code containing
 * one was misheard — and silently "correcting" it could produce a different
 * code that is also valid, sending someone confidently into the wrong game.
 * Better to reject it and have them ask again.
 */
export function normaliseJoinCode(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Whether a code is well formed and its check character agrees. */
export function isValidJoinCode(code) {
  const value = String(code ?? '').toUpperCase();
  if (value.length !== CODE_LENGTH + 1) return false;
  if ([...value].some((c) => !CODE_ALPHABET.includes(c))) return false;
  return checkChar(value.slice(0, CODE_LENGTH)) === value[CODE_LENGTH];
}

/**
 * The host's peer id for a code. Deterministic, which is the point: a
 * refreshed host asks the broker for the same address it had before.
 */
export function peerIdForCode(code) {
  return `${PROTOCOL}-${String(code).toLowerCase()}`;
}

/** The code from a `#CODE` fragment, or null. */
export function codeFromLocation(location) {
  const code = String(location?.hash ?? '').replace(/^#/, '').toUpperCase();
  return isValidJoinCode(code) ? code : null;
}

/** The link to hand to players — pasteable into a voice chat. */
export function playerLink(location, code) {
  const base = `${location.origin}${location.pathname}`.replace(/host\.html$/, 'index.html');
  return `${base}#${code}`;
}

/**
 * A facilitator PIN, shown only on the host screen.
 *
 * Without it, anyone holding the join code could identify as an umpire and
 * gain the power to edit any value in the game. The join code is shouted over
 * voice; this is not.
 *
 * @param {() => number} random
 */
export function mintFacilitatorPin(random = Math.random) {
  return String(Math.floor(random() * 900000) + 100000);
}
