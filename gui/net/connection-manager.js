/**
 * gui/net/connection-manager.js — the client half of the transport.
 *
 * Ported from project-phoenix-v2, minus its string-table boot. The parts worth
 * keeping are the ones that came from running real games on bad networks:
 *
 *   * Nothing is terminal. A closed channel, a connection error and a
 *     signalling error all land in the same backoff retry, because at an event
 *     a client that has given up is indistinguishable from a broken app.
 *   * A generation counter guards every callback, so a superseded peer's late
 *     events cannot resurrect a connection that has already been replaced.
 *   * ICE gets eight seconds before the attempt is abandoned. Without a
 *     timeout a half-open connection sits there looking fine forever.
 *   * `_identSent` resets on close. That one line is what makes reconnection
 *     resume a seat instead of quietly creating a new one.
 *
 * Deliberately absent: phoenix's unordered snapshot sub-channel. That exists
 * for sixty-hertz ship telemetry. This game sends a projection when something
 * happens, and every one of them matters, so everything rides the reliable
 * channel.
 */

import { parse, encode } from './wire.js';
import { nextBackoffDelay } from './backoff.js';

/** STUN gets most peers connected; TURN is for the ones behind symmetric NAT. */
export function defaultIceServers() {
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  ];
}

const CONNECT_TIMEOUT_MS = 8000;

export class ConnectionManager {
  constructor({ Peer = globalThis.Peer, timers = globalThis } = {}) {
    this._Peer = Peer;
    this._timers = timers;
    this.conn = null;
    this.peer = null;
    this._identSent = false;
    this._retryTimer = null;
    this._retryAttempt = 0;
    this._generation = 0;
    this._hostPeerId = null;
    this._opts = null;
  }

  get connected() {
    return this.conn !== null && this.conn.open;
  }

  /**
   * Dial the host and keep dialling.
   *
   * @param {string} hostPeerId  derived from the join code, so a refreshed
   *   host is reachable at the address this client is already retrying
   * @param {object} handlers  onData, onStatus, onLog, onError, getIdent
   */
  connect(hostPeerId, handlers = {}) {
    const Peer = this._Peer;
    if (!Peer || !hostPeerId) return;

    this._hostPeerId = hostPeerId;
    this._opts = handlers;
    this._identSent = false;
    this._clearRetryTimer();

    const generation = ++this._generation;
    const { onData, onStatus, onLog, onError, getIdent } = handlers;
    const log = (message) => onLog?.(message);
    const peer = new Peer({ config: { iceServers: handlers.iceServers ?? defaultIceServers() } });
    this.peer = peer;

    const current = () => this._generation === generation && this.peer === peer;

    peer.on('open', () => {
      if (!current()) return;
      onStatus?.('connecting');
      log(`[peer] dialling ${hostPeerId}, attempt ${this._retryAttempt + 1}`);

      const conn = peer.connect(hostPeerId, { reliable: true });
      this.conn = conn;
      const mine = () => current() && this.conn === conn;

      const timeout = this._timers.setTimeout(() => {
        if (mine() && !conn.open) {
          log('[peer] no answer; closing and retrying');
          this.conn = null;
          this._identSent = false;
          onStatus?.('disconnected');
          try { conn.close(); } catch { /* already gone */ }
          this._scheduleRetry();
        }
      }, CONNECT_TIMEOUT_MS);

      conn.on('open', () => {
        if (!mine()) return;
        this._timers.clearTimeout(timeout);
        this._retryAttempt = 0;
        this._clearRetryTimer();
        onStatus?.('ready');
        log('[peer] channel open');

        const ident = getIdent?.();
        if (ident && !this._identSent) {
          this._identSent = true;
          conn.send(encode(ident));
        }
      });

      conn.on('data', (raw) => {
        if (!mine()) return;
        const message = parse(raw);
        if (message) onData?.(message);
        else log('[peer] discarded a frame that was not a message');
      });

      conn.on('close', () => {
        if (!mine()) return;
        this._timers.clearTimeout(timeout);
        // Reset so the next open re-sends Identify. The host restores the seat
        // from the token, so this is what makes a reconnect resume rather than
        // arrive as a stranger.
        this._identSent = false;
        this.conn = null;
        onStatus?.('disconnected');
        this._scheduleRetry();
      });

      conn.on('error', (error) => {
        if (!mine()) return;
        this._timers.clearTimeout(timeout);
        onError?.(error?.type ?? 'error');
        this._identSent = false;
        this.conn = null;
        onStatus?.('disconnected');
        this._scheduleRetry();
      });
    });

    peer.on('disconnected', () => {
      if (!current()) return;
      onStatus?.('disconnected');
      peer.reconnect();
    });

    peer.on('error', (error) => {
      if (!current()) return;
      onError?.(error?.type ?? 'error');
      onStatus?.('disconnected');
      this._scheduleRetry();
    });
  }

  /** Put a message on the wire. Silently a no-op when offline, by design:
   *  a console should not have to check before every send. */
  send(message) {
    if (!this.connected) return false;
    this.conn.send(encode(message));
    return true;
  }

  /** The user-facing "try again" button: skip the wait and dial now. */
  retryNow() {
    if (this.connected) return;
    this._clearRetryTimer();
    this._reconnect();
  }

  disconnect() {
    this._clearRetryTimer();
    this._hostPeerId = null;
    this._opts = null;
    this._generation++;
    if (this.conn) { try { this.conn.close(); } catch { /* already gone */ } this.conn = null; }
    if (this.peer) { try { this.peer.destroy(); } catch { /* already gone */ } this.peer = null; }
  }

  _scheduleRetry() {
    this._clearRetryTimer();
    const delay = nextBackoffDelay(this._retryAttempt);
    this._retryAttempt++;
    this._opts?.onLog?.(`[peer] retrying in ${delay}ms (attempt ${this._retryAttempt})`);
    this._retryTimer = this._timers.setTimeout(() => this._reconnect(), delay);
  }

  _clearRetryTimer() {
    if (this._retryTimer) {
      this._timers.clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
  }

  /** Tear down whatever is left and dial again from scratch. */
  _reconnect() {
    const hostPeerId = this._hostPeerId;
    const handlers = this._opts;
    if (this.conn) { try { this.conn.close(); } catch { /* already gone */ } this.conn = null; }
    if (this.peer) { try { this.peer.destroy(); } catch { /* already gone */ } this.peer = null; }
    if (hostPeerId && handlers) this.connect(hostPeerId, handlers);
  }
}
