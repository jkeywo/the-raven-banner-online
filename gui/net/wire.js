/**
 * gui/net/wire.js — the message shapes, in one place.
 *
 * Small enough to read in a minute, which is the point: when a client and a
 * host disagree about a field, this is the file you open. Nothing here has
 * behaviour, so both sides can import it without dragging anything along.
 */

/** Client to host. */
export const IDENTIFY = 'Identify';
export const COMMAND = 'Command';

/** Host to client. */
export const VIEW = 'View';
export const RESULT = 'CommandResult';
export const REJECTED = 'Rejected';

/**
 * The first message on every opened connection.
 *
 * The token is a durable per-seat credential, not the peer id: peer ids change
 * on every page load, and a player who refreshes must land back in the same
 * chair. `pin` is only ever sent by someone claiming facilitator authority.
 *
 * @param {{token: string, name: string, pin?: string|null}} args
 */
export function identify({ token, name, pin = null }) {
  if (!token) throw new TypeError('wire: Identify needs a token');
  return { type: IDENTIFY, data: { token, name: name ?? '', pin } };
}

/**
 * A player's intent.
 *
 * `seq` is per-client and monotonic. The host remembers the last one it saw
 * from each seat and drops anything at or below it, which is what makes a
 * command replayed by a reconnecting client harmless rather than a second
 * purchase.
 */
export function command(verb, payload, seq) {
  if (typeof verb !== 'string' || !verb) throw new TypeError('wire: a command needs a verb');
  if (!Number.isInteger(seq)) throw new TypeError('wire: a command needs a sequence number');
  return { type: COMMAND, data: { verb, payload: payload ?? {}, seq } };
}

/** A recipient's redacted copy of the game. */
export function view(projection) {
  return { type: VIEW, data: projection };
}

/**
 * The host's answer to one command.
 *
 * Carries the reason on refusal, so a console can say "not enough silver —
 * you have 2, this costs 5" against the button that was pressed rather than
 * doing nothing and looking broken.
 */
export function result(seq, ok, reason = null) {
  return { type: RESULT, data: { seq, ok, ...(reason ? { reason } : {}) } };
}

/** A connection refused before it ever became a seat. */
export function rejected(reason) {
  return { type: REJECTED, data: { reason } };
}

/** Parse an inbound frame. Returns null rather than throwing on junk. */
export function parse(raw) {
  try {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const message = JSON.parse(text);
    return message && typeof message.type === 'string' ? message : null;
  } catch {
    return null;
  }
}

/** Serialise a frame for the wire. */
export function encode(message) {
  return JSON.stringify(message);
}
