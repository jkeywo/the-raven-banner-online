/**
 * gui/host/event-pump.js — telling something outside the game that it moved.
 *
 * A Discord bot lives in another repository and wants to follow a game: move
 * people between voice channels when the phase turns, hand out a Discord role
 * when somebody claims Guthrum, say out loud that Lindsey has fallen. This is
 * the tap it drinks from. `docs/discord-integration.md` is the contract.
 *
 * Three rules govern everything below, and they are worth more than the
 * feature.
 *
 * **Off is off.** A pump exists only when the facilitator opened `host.html`
 * with `?events=<url>`. No parameter, no object — `eventPumpFor` returns null,
 * `PrimarySession` holds null, and its optional call short-circuits before it
 * even builds a projection to hand over. A default game does not connect, does
 * not compute, does not log and does not differ from the game it was before
 * this file existed. A parameter is the right switch for that because it is per
 * tab and per launch: it cannot be left on by a previous game, it is not in the
 * save, it is not in the command log, it is not in state, and so it can never
 * reach the reducer or a replay.
 *
 * **The pump observes; it does not participate.** It is handed a finished
 * spectator projection after the command has already been applied, logged,
 * persisted and broadcast. It has no way to write state, no way to refuse a
 * command, and nothing downstream waits on it.
 *
 * **A dead bot must not take the game with it.** The facilitator's tab *is* the
 * game. So every entry point swallows everything: a URL that will not parse, a
 * `WebSocket` constructor that throws, a socket that closes mid-game, a fetch
 * that rejects, a malformed view. The worst any of them can do is a line in the
 * host log and some events nobody receives.
 */

import { publicDigest, deriveEvents, stampEvents, encodeBatch } from './pump-events.js';

/** The query parameter on host.html that turns the pump on. */
export const EVENT_PARAM = 'events';

/** WebSocket for a live bot, HTTP POST for a webhook or a capture script. */
const WS_PROTOCOLS = new Set(['ws:', 'wss:']);
const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * How many batches to hold while the socket is down.
 *
 * Bounded on purpose. An unbounded queue behind a bot that never comes up is a
 * three-hour memory leak in the one tab that must not die, and the events it
 * would be holding are stale long before anyone reads them. `seq` is what makes
 * a dropped batch survivable: the bot can see the gap.
 */
const MAX_QUEUED = 64;

/** The gap between reconnection attempts, measured rather than timed. */
const RETRY_MS = 5000;

/**
 * The sink named on the URL, or null.
 *
 * Null for absent, empty, unparseable, or a scheme this cannot speak — all of
 * which mean the same thing to the caller, which is "do not build a pump". A
 * typo must fail to nothing rather than to something half-connected.
 */
export function pumpUrlFrom(location) {
  const search = location?.search;
  if (typeof search !== 'string' || search === '') return null;
  let raw;
  try {
    raw = new URLSearchParams(search).get(EVENT_PARAM);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!WS_PROTOCOLS.has(parsed.protocol) && !HTTP_PROTOCOLS.has(parsed.protocol)) return null;
  return parsed;
}

/**
 * A pump for this tab, or null if nobody asked for one.
 *
 * The whole off-switch, in one place: callers pass the result straight through
 * and never branch on it themselves.
 */
export function eventPumpFor({
  location, now, onLog,
  WebSocketImpl = globalThis.WebSocket,
  fetchImpl = globalThis.fetch,
} = {}) {
  let url = null;
  try {
    url = pumpUrlFrom(location);
  } catch {
    return null;
  }
  if (!url) return null;
  // Said out loud on the console. A facilitator who turned this on should be
  // able to see that it is on, and one who did not should never see this line.
  onLog?.(`[events] streaming to ${url.href}`);
  return new EventPump({ url, now, onLog, WebSocketImpl, fetchImpl });
}

export class EventPump {
  /**
   * @param {object} args
   * @param {URL} args.url  already parsed and scheme-checked
   */
  constructor({ url, now = () => Date.now(), onLog, WebSocketImpl, fetchImpl }) {
    this.url = url.href;
    this.mode = WS_PROTOCOLS.has(url.protocol) ? 'websocket' : 'http';
    this._now = now;
    this._log = onLog ?? (() => {});
    this._WebSocket = WebSocketImpl;
    this._fetch = fetchImpl;

    /** The previous public digest, or null until the first observation. */
    this._last = null;
    this._seq = 0;
    this._queue = [];
    this._socket = null;
    this._lastDialAt = -Infinity;
    this._closed = false;
    // Logged once per outage rather than once per failed send, so a bot that
    // is simply not running does not bury the host log a facilitator reads for
    // connection trouble.
    this._reportedDown = false;
  }

  /**
   * Look at the game and say what changed.
   *
   * The single entry point, and the single place a throw could reach the
   * caller from — so nothing here is allowed to. `_last` and `_seq` advance
   * before anything is sent, so a send that fails costs one batch rather than
   * desynchronising every event after it.
   *
   * @param {object} view  a spectator projection
   * @returns {number} how many events were derived
   */
  observe(view) {
    if (this._closed) return 0;
    try {
      const next = publicDigest(view);
      const events = deriveEvents(this._last, next);
      this._last = next;
      if (events.length === 0) return 0;

      const stamped = stampEvents(events, {
        game: view?.joinCode ?? null,
        at: this._now(),
        seq: this._seq,
      });
      this._seq += stamped.length;
      this._send(encodeBatch(stamped));
      return stamped.length;
    } catch (error) {
      // Includes anything the derivation could throw on a shape nobody
      // expected. The game carries on; the stream is what suffers.
      this._log(`[events] dropped a batch: ${error?.message ?? error}`);
      return 0;
    }
  }

  /** Stop for good. Further observations are ignored rather than queued. */
  close() {
    this._closed = true;
    this._queue.length = 0;
    const socket = this._socket;
    this._socket = null;
    try { socket?.close(); } catch { /* already gone */ }
  }

  _send(body) {
    if (this.mode === 'http') { this._post(body); return; }
    this._queue.push(body);
    if (this._queue.length > MAX_QUEUED) this._queue.splice(0, this._queue.length - MAX_QUEUED);
    this._flush();
  }

  _post(body) {
    if (typeof this._fetch !== 'function') { this._reportDown('no fetch in this runtime'); return; }
    let pending;
    try {
      pending = this._fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-ndjson' },
        body,
      });
    } catch (error) {
      this._reportDown(error?.message ?? error);
      return;
    }
    // A rejected promise with no handler is an unhandled rejection, which is a
    // console error in a browser and a process-level event elsewhere. Caught
    // here so a bot that is down is quiet rather than alarming.
    Promise.resolve(pending).then(
      () => { this._reportedDown = false; },
      (error) => this._reportDown(error?.message ?? error));
  }

  _flush() {
    this._dial();
    const socket = this._socket;
    // readyState 1 is OPEN. Compared numerically because the constant lives on
    // the constructor, and a test double should not have to reproduce it.
    if (!socket || socket.readyState !== 1) return;
    try {
      while (this._queue.length) socket.send(this._queue.shift());
      this._reportedDown = false;
    } catch (error) {
      // Whatever is left is dropped rather than retried forever against a
      // socket that has already told us it cannot carry it.
      this._queue.length = 0;
      this._reportDown(error?.message ?? error);
    }
  }

  /**
   * Open a socket, at most one attempt per retry window.
   *
   * Lazy and untimed, both deliberately. Lazy because the tab that carries the
   * parameter might end up being the co-facilitator's, and a pump with nothing
   * to say should not hold a connection open. Untimed because the game
   * generates the only clock that matters here — a reconnection attempt on the
   * next state change costs nothing and needs no timer left running in a tab
   * that has to survive three hours.
   */
  _dial() {
    if (this._socket || this._closed) return;
    if (typeof this._WebSocket !== 'function') {
      this._reportDown('no WebSocket in this runtime');
      return;
    }
    const at = this._now();
    if (at - this._lastDialAt < RETRY_MS) return;
    this._lastDialAt = at;

    let socket;
    try {
      socket = new this._WebSocket(this.url);
    } catch (error) {
      this._reportDown(error?.message ?? error);
      return;
    }
    this._socket = socket;

    socket.onopen = () => {
      if (this._socket !== socket) return;
      this._reportedDown = false;
      this._log(`[events] connected to ${this.url}`);
      this._flush();
    };
    // Nothing to do but be present: an error event with no handler is noisy,
    // and a close always follows.
    socket.onerror = () => {};
    socket.onclose = () => {
      if (this._socket !== socket) return;
      this._socket = null;
      this._reportDown('the event sink closed the connection');
    };
  }

  _reportDown(why) {
    if (this._reportedDown) return;
    this._reportedDown = true;
    this._log(`[events] sink unreachable — ${why}`);
  }
}
