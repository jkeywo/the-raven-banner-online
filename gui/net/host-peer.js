/**
 * gui/net/host-peer.js — the facilitator's tab, answering the door.
 *
 * Phoenix's host is a Rust binary, so its client transport ported across but
 * this half had to be written. Three things it has to get right:
 *
 * **Claim the derived peer id, and keep claiming it.** The broker holds a dead
 * registration for a little while after a tab closes, so a host that refreshes
 * is told its own address is taken. Treating that as fatal would break the
 * recovery path for the very failure it accompanies — so `unavailable-id` is
 * retried on the same backoff the clients use, with the wait shown on screen.
 *
 * **Turn a connection into a seat.** Peer ids change every page load and mean
 * nothing; the token in the Identify message is the identity. A returning
 * player is matched back to the chair they had.
 *
 * **Send everyone their own game.** Every broadcast is per-recipient, because
 * every recipient sees a different game. There is no "send to all".
 *
 * Transport only. It knows nothing about rules — it hands commands to a
 * callback and sends back whatever that returns.
 */

import { parse, encode, IDENTIFY, COMMAND, rejected, result, view } from './wire.js';
import { peerIdForCode } from './join-code.js';
import { nextBackoffDelay } from './backoff.js';

/** How long a peer may stay silent before we treat the seat as away. */
export const IDLE_MS = 45_000;

export class HostPeer {
  /**
   * @param {object} args
   * @param {string} args.joinCode
   * @param {string} args.facilitatorPin  minted with the code, shown only here
   * @param {Function} args.onIdentify  ({token, name, wantsFacilitator}) -> seat|null
   * @param {Function} args.onCommand   (seat, {verb, payload, seq}) -> {ok, reason?}
   * @param {Function} args.viewFor     (seat) -> the projection for that seat
   * @param {Function} [args.onLog]
   * @param {Function} [args.onStatus]
   */
  constructor({
    joinCode, facilitatorPin, onIdentify, onCommand, viewFor,
    onLog, onStatus, Peer = globalThis.Peer, timers = globalThis,
  }) {
    this.joinCode = joinCode;
    this.peerId = peerIdForCode(joinCode);
    this._pin = facilitatorPin;
    this._onIdentify = onIdentify;
    this._onCommand = onCommand;
    this._viewFor = viewFor;
    this._log = onLog ?? (() => {});
    this._status = onStatus ?? (() => {});
    this._Peer = Peer;
    this._timers = timers;

    this.peer = null;
    /** seatId -> { conn, seat, lastSeq, lastSeen } */
    this.connections = new Map();
    this._claimAttempt = 0;
    this._claimTimer = null;
    this._stopped = false;
  }

  /** Claim the address and start accepting. Safe to call again after a failure. */
  start() {
    this._stopped = false;
    this._claim();
  }

  stop() {
    this._stopped = true;
    if (this._claimTimer) this._timers.clearTimeout(this._claimTimer);
    this._claimTimer = null;
    for (const entry of this.connections.values()) {
      try { entry.conn.close(); } catch { /* already gone */ }
    }
    this.connections.clear();
    if (this.peer) { try { this.peer.destroy(); } catch { /* already gone */ } this.peer = null; }
  }

  _claim() {
    if (this._stopped) return;
    // PeerJS is a vendored <script>, so it can simply not be there — a 404 on
    // the vendor file, or a browser extension that ate it. Throwing here
    // escapes into whatever called start(), which is a click handler, and the
    // console dies silently with no clue on screen. Saying so and stopping is
    // the honest failure: there is no retry that can conjure the library.
    if (typeof this._Peer !== 'function') {
      this._status('error');
      this._log('[host] PeerJS did not load — check vendor/peerjs.min.js is being served');
      return;
    }
    const peer = new this._Peer(this.peerId, {});
    this.peer = peer;

    peer.on('open', () => {
      if (this.peer !== peer) return;
      this._claimAttempt = 0;
      this._status('hosting');
      this._log(`[host] holding ${this.peerId}`);
    });

    peer.on('connection', (conn) => {
      if (this.peer !== peer) return;
      this._accept(conn);
    });

    peer.on('error', (error) => {
      if (this.peer !== peer) return;
      const type = error?.type ?? 'error';
      if (type === 'unavailable-id') {
        // The broker has not released our previous registration yet. This is
        // the expected state right after a host refresh, not a failure.
        this._status('waiting-for-code');
        this._log('[host] the room code is still held by the last session; waiting');
        this._retryClaim();
        return;
      }
      this._log(`[host] peer error: ${type}`);
      this._status('error');
      this._retryClaim();
    });

    peer.on('disconnected', () => {
      if (this.peer !== peer) return;
      this._status('reconnecting');
      peer.reconnect();
    });
  }

  _retryClaim() {
    if (this._stopped || this._claimTimer) return;
    const delay = nextBackoffDelay(this._claimAttempt, 400, 5000);
    this._claimAttempt++;
    this._claimTimer = this._timers.setTimeout(() => {
      this._claimTimer = null;
      if (this.peer) { try { this.peer.destroy(); } catch { /* already gone */ } }
      this._claim();
    }, delay);
  }

  _accept(conn) {
    let seatId = null;

    conn.on('data', (raw) => {
      const message = parse(raw);
      if (!message) return;

      if (message.type === IDENTIFY) {
        const { token, name, pin } = message.data ?? {};
        if (!token) {
          conn.send(encode(rejected('no token')));
          return;
        }
        const wantsFacilitator = pin != null;
        if (wantsFacilitator && pin !== this._pin) {
          // Refused rather than quietly seated as a player: someone typing a
          // PIN believes they are an umpire, and being silently demoted is
          // worse than being told no.
          this._log('[host] refused a facilitator claim with the wrong PIN');
          conn.send(encode(rejected('that facilitator PIN is not right')));
          return;
        }

        const seat = this._onIdentify({ token, name, wantsFacilitator });
        if (!seat) {
          conn.send(encode(rejected('this game is full')));
          return;
        }

        // A seat reconnecting from a new tab supersedes its old connection,
        // so the stale one is closed rather than left to receive projections
        // nobody is reading.
        const existing = this.connections.get(seat.id);
        if (existing && existing.conn !== conn) {
          try { existing.conn.close(); } catch { /* already gone */ }
        }

        seatId = seat.id;
        this.connections.set(seat.id, {
          conn, seat, lastSeq: existing?.lastSeq ?? 0, lastSeen: Date.now(),
        });
        this._log(`[host] ${name || 'someone'} is in seat ${seat.id}`);
        this.sendTo(seat.id);
        return;
      }

      if (message.type === COMMAND) {
        const entry = seatId && this.connections.get(seatId);
        if (!entry) {
          conn.send(encode(rejected('identify first')));
          return;
        }
        entry.lastSeen = Date.now();

        const { verb, payload, seq } = message.data ?? {};
        // A command the client resent after a drop. Acknowledged as accepted,
        // because it was — the first time — and a client that sees a refusal
        // here would tell the player something false.
        if (Number.isInteger(seq) && seq <= entry.lastSeq) {
          conn.send(encode(result(seq, true)));
          return;
        }
        entry.lastSeq = seq ?? entry.lastSeq;

        const outcome = this._onCommand(entry.seat, { verb, payload, seq });
        conn.send(encode(result(seq, outcome.ok, outcome.reason)));
      }
    });

    conn.on('close', () => {
      if (seatId && this.connections.get(seatId)?.conn === conn) {
        this.connections.delete(seatId);
        this._log(`[host] seat ${seatId} dropped`);
      }
    });

    conn.on('error', () => {
      if (seatId && this.connections.get(seatId)?.conn === conn) {
        this.connections.delete(seatId);
      }
    });
  }

  /** Send one seat its own projection. */
  sendTo(seatId) {
    const entry = this.connections.get(seatId);
    if (!entry || !entry.conn.open) return false;
    entry.conn.send(encode(view(this._viewFor(entry.seat))));
    return true;
  }

  /**
   * Send everyone theirs.
   *
   * Not a broadcast in the usual sense: each recipient's copy is built for
   * them, because each of them is allowed to know something different.
   */
  broadcast() {
    let sent = 0;
    for (const seatId of this.connections.keys()) {
      if (this.sendTo(seatId)) sent++;
    }
    return sent;
  }

  /** Seats currently connected, for the facilitator's roster. */
  liveSeats() {
    return [...this.connections.values()].map(({ seat, lastSeen }) => ({
      ...seat, lastSeen, idle: Date.now() - lastSeen > IDLE_MS,
    }));
  }
}
