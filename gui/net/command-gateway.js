/**
 * gui/net/command-gateway.js — the only door out of a player's browser.
 *
 * Every intent a console raises leaves through here. It is the one module that
 * knows the envelope shape and the one that knows how to reach the transport,
 * so "this control talks to the network" is an edge you can grep for rather
 * than a convention people remember.
 *
 * DOM-free and side-effect-free at import, with the transport resolved lazily —
 * from an explicit argument in tests, or from the live manager in a browser.
 * That is what lets the whole thing be unit tested in Node.
 *
 * The pattern is phoenix's; the envelope is this game's.
 */

import { command } from './wire.js';

/**
 * Per-client, monotonic, and never reset — not even on reconnect.
 *
 * The host drops anything at or below the last sequence it saw from a seat, so
 * a command still in flight when the channel dropped is harmless when the
 * client resends it. Restarting the count would defeat that: the replayed
 * command would look new and be applied twice.
 */
let sequence = 0;

/** The next sequence number. Exported so a console can label a pending action. */
export function nextSeq() {
  return ++sequence;
}

/** Test seam. Never call this from application code. */
export function __resetSequence() {
  sequence = 0;
}

/**
 * Resolve something to send with: an explicit transport, or the live manager.
 *
 * @param {{send: (message: object) => boolean}|null} [transport]
 * @returns {((message: object) => boolean) | null} null when there is nowhere
 *   to send, which is the normal state between a drop and a reconnect
 */
export function resolveTransport(transport) {
  if (transport && typeof transport.send === 'function') {
    return (message) => transport.send(message);
  }
  const live = globalThis.window?.connectionManager;
  if (live && typeof live.send === 'function') return (message) => live.send(message);
  return null;
}

/**
 * Send one command.
 *
 * @param {string} verb
 * @param {object} [payload]
 * @param {{send: Function}} [transport]
 * @returns {{envelope: object, sent: boolean}} the envelope either way, so a
 *   console can show a pending action even while offline
 */
export function sendCommand(verb, payload, transport) {
  const envelope = command(verb, payload, nextSeq());
  const send = resolveTransport(transport);
  return { envelope, sent: send ? Boolean(send(envelope)) : false };
}
