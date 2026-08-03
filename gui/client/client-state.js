/**
 * gui/client/client-state.js — the last thing the host told us, and who is listening.
 *
 * A client holds no game state of its own. It holds the most recent projection
 * and re-renders from it; it never patches, merges or predicts. That is what
 * makes a reconnect trivial — the next projection is simply the truth, and
 * there is nothing to reconcile.
 *
 * Pending commands are the one exception, and they are presentation only: a
 * button that has been pressed but not yet answered, so a slow link looks slow
 * rather than broken.
 */

import { RESULT, VIEW, REJECTED } from '../net/wire.js';

export class ClientState {
  constructor() {
    this.view = null;
    this.status = 'connecting';
    this.rejection = null;
    /** seq -> {verb, at} for commands sent and not yet answered. */
    this.pending = new Map();
    /** The last refusal, for showing against the control that caused it. */
    this.lastRefusal = null;
    this._listeners = new Set();
  }

  /** @param {(state: ClientState) => void} fn @returns {() => void} unsubscribe */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _announce() {
    for (const fn of this._listeners) fn(this);
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this._announce();
  }

  /** Note a command as in flight so the UI can show it as pending. */
  awaiting(seq, verb) {
    this.pending.set(seq, { verb, at: Date.now() });
    this._announce();
  }

  /** Handle one message from the host. */
  receive(message) {
    if (message.type === VIEW) {
      this.view = message.data;
      this.rejection = null;
      this._announce();
      return;
    }
    if (message.type === RESULT) {
      const { seq, ok, reason } = message.data;
      const sent = this.pending.get(seq);
      this.pending.delete(seq);
      this.lastRefusal = ok ? null : { verb: sent?.verb ?? null, reason };
      this._announce();
      return;
    }
    if (message.type === REJECTED) {
      // Refused before we ever became a seat: a wrong PIN, or a full game.
      this.rejection = message.data.reason;
      this._announce();
    }
  }

  /** The role this seat is playing, from the projection. */
  get roleId() {
    return this.view?.viewer?.roleId ?? null;
  }

  get isFacilitator() {
    return this.view?.viewer?.kind === 'facilitator';
  }
}
