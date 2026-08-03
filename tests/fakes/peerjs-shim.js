/**
 * An in-process stand-in for PeerJS.
 *
 * Phoenix has one of these backed by BroadcastChannel, for driving real pages
 * under Playwright. This one is for vitest in Node, so it is a plain registry
 * and a microtask queue: no browser, no WebRTC, no waiting.
 *
 * It models the failure modes the transport actually has to survive, because
 * those are the ones worth testing and the ones you cannot produce on demand
 * at an event:
 *
 *   * `unavailable-id` — the broker still holding a dead host's address
 *   * `sever` — a channel dropping without either side closing it, which is
 *     what a laptop lid or a sleeping radio looks like from here
 *   * a peer id being taken, so a second host cannot claim a live room
 */

let broker = null;

/** A fresh, empty world. Call in `beforeEach` so tests cannot leak into each other. */
export function createBroker() {
  broker = {
    peers: new Map(),          // peerId -> Peer
    reserved: new Set(),       // ids the broker will refuse, as if still held
    severed: new Set(),        // "a|b" pairs that silently drop traffic
    nextId: 1,
  };
  return broker;
}

const pairKey = (a, b) => [a, b].sort().join('|');
const soon = (fn) => Promise.resolve().then(fn);

class Emitter {
  constructor() { this._handlers = new Map(); }

  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event).push(fn);
    return this;
  }

  emit(event, ...args) {
    for (const fn of this._handlers.get(event) ?? []) fn(...args);
  }
}

class Connection extends Emitter {
  constructor(localId, remoteId) {
    super();
    this.peer = remoteId;          // PeerJS calls the far end `peer`
    this._local = localId;
    this._remote = remoteId;
    this.open = false;
    this.sent = [];
  }

  send(data) {
    if (!this.open) return;
    if (broker.severed.has(pairKey(this._local, this._remote))) return;
    this.sent.push(data);
    const far = broker.peers.get(this._remote);
    const inbound = far?._conns.get(this._local);
    if (inbound) soon(() => inbound.emit('data', data));
  }

  close() {
    if (!this.open && this._closed) return;
    this._closed = true;
    this.open = false;
    const far = broker.peers.get(this._remote)?._conns.get(this._local);
    this.emit('close');
    if (far && far.open) {
      far.open = false;
      soon(() => far.emit('close'));
    }
  }

  /** Drop without either side closing: a radio sleeping, a lid shutting. */
  _sever() {
    this.open = false;
    this.emit('close');
  }
}

export class Peer extends Emitter {
  constructor(id, _options) {
    super();
    const wanted = typeof id === 'string' && id ? id : `peer-${broker.nextId++}`;
    this._conns = new Map();
    this.destroyed = false;

    if (broker.reserved.has(wanted) || broker.peers.has(wanted)) {
      this.id = wanted;
      // Real PeerJS reports this asynchronously, and the host's retry loop
      // depends on it arriving as an event rather than a throw.
      soon(() => this.emit('error', { type: 'unavailable-id' }));
      return;
    }

    this.id = wanted;
    broker.peers.set(this.id, this);
    soon(() => this.emit('open', this.id));
  }

  connect(remoteId) {
    const conn = new Connection(this.id, remoteId);
    this._conns.set(remoteId, conn);

    const far = broker.peers.get(remoteId);
    if (!far || broker.severed.has(pairKey(this.id, remoteId))) {
      // No answer at all: the caller's own timeout has to notice.
      return conn;
    }

    const inbound = new Connection(remoteId, this.id);
    far._conns.set(this.id, inbound);
    soon(() => {
      far.emit('connection', inbound);
      soon(() => {
        inbound.open = true;
        inbound.emit('open');
        conn.open = true;
        conn.emit('open');
      });
    });
    return conn;
  }

  reconnect() {
    if (!broker.peers.has(this.id)) broker.peers.set(this.id, this);
    soon(() => this.emit('open', this.id));
  }

  destroy() {
    this.destroyed = true;
    broker.peers.delete(this.id);
    for (const conn of this._conns.values()) conn.close();
    this._conns.clear();
  }
}

/** Hold an id as if a dead session still had it. */
export function reserveId(id) {
  broker.reserved.add(id);
}

/** Release it, as the broker eventually does. */
export function releaseId(id) {
  broker.reserved.delete(id);
}

/** Silently drop everything between two peers, closing both ends. */
export function severBetween(a, b) {
  broker.severed.add(pairKey(a, b));
  broker.peers.get(a)?._conns.get(b)?._sever();
  broker.peers.get(b)?._conns.get(a)?._sever();
}

export function reviveBetween(a, b) {
  broker.severed.delete(pairKey(a, b));
}

/** Let every queued microtask settle. The shim never uses real timers. */
export async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
