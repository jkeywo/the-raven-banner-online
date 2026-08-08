/**
 * gui/host/session.js — where the facilitator console gets its game from.
 *
 * There are two facilitators at a Raven Banner table and only one of them is
 * hosting. The console is the same console for both: the same clock, the same
 * envoy queue, the same inspector. What differs is one seam — whether a
 * command is applied here or sent over the wire, and whether the state is owned
 * or received.
 *
 * So the console talks to a session rather than to a GameHost, and there are
 * two kinds. The primary owns the game. The co-facilitator is a client with
 * facilitator authority that keeps a full mirror, and can become the primary
 * without anybody re-entering anything — which is the whole point, because the
 * moment you need it is the moment a laptop has died in front of sixteen
 * people.
 *
 * Both expose the same four things: `state`, `roster()`, `submit()`, `save()`.
 */

import { GameHost } from './game-host.js';
import { HostPeer } from '../net/host-peer.js';
import { ConnectionManager } from '../net/connection-manager.js';
import { peerIdForCode } from '../net/join-code.js';
import { identify } from '../net/wire.js';
import { sendCommand } from '../net/command-gateway.js';
import { ClientState } from '../client/client-state.js';
import { toSave } from '../rules/command-log.js';

/**
 * The facilitator whose tab holds the game.
 *
 * A thin wrapper: it is the arrangement that was already there, named so the
 * console can stop caring which side of the seam it is on.
 */
export class PrimarySession {
  /**
   * @param {object} args
   * @param {import('./event-pump.js').EventPump|null} [args.pump]  null in a
   *   default game, which is what makes the pump cost nothing when it is off
   */
  constructor({ host, onChange, onStatus, onLog, pump = null, Peer = globalThis.Peer }) {
    this.kind = 'primary';
    this.host = host;
    this.pump = pump;
    this._onChange = onChange;
    this.peer = new HostPeer({
      joinCode: host.state.joinCode,
      facilitatorPin: host.facilitatorPin,
      onIdentify: (args) => host.identify(args),
      onCommand: (seat, cmd) => host.submit(seat, cmd),
      viewFor: (seat) => host.viewFor(seat),
      onStatus,
      onLog,
      Peer,
    });
    host._onChange = () => {
      this.peer.broadcast();
      onChange();
      // Last, and only when a facilitator asked for one. The optional call
      // short-circuits its own argument, so a game without a pump does not
      // build the extra projection either — off is off rather than cheap.
      //
      // Everything the game needs has already happened by here, and the throw
      // is caught a second time even though the pump catches its own: this tab
      // is the game, and no integration with an outside service is worth a
      // command failing in front of sixteen people. A dead bot gets a line in
      // the host log and nothing else.
      try {
        this.pump?.observe(host.spectatorView());
      } catch (error) {
        onLog?.(`[events] the pump threw and was ignored: ${error?.message ?? error}`);
      }
    };
  }

  start() { this.peer.start(); }

  stop() {
    this.peer.stop();
    this.pump?.close();
  }

  get state() { return this.host.state; }

  get joinCode() { return this.host.state.joinCode; }

  get facilitatorPin() { return this.host.facilitatorPin; }

  roster() { return this.host.roster(); }

  /** Applied here, because here is where the game is. */
  submit(verb, payload = {}) {
    return this.host.submit({ id: 'host', kind: 'facilitator', roleId: null }, { verb, payload });
  }

  save() { return this.host.save(); }
}

/**
 * The other facilitator.
 *
 * Connected as a client that identified with the PIN, so the host sends it the
 * unredacted projection — which is state-shaped, and therefore everything a
 * save needs. It writes that mirror down on every projection, so the moment the
 * primary dies the game is already on this machine.
 */
export class CoFacilitatorSession {
  /**
   * @param {object} args
   * @param {string} args.joinCode
   * @param {string} args.pin
   * @param {string} args.name
   * @param {string} args.token  this tab's session token
   */
  constructor({
    joinCode, pin, name, token, data, onChange, onStatus, onLog,
    Peer = globalThis.Peer, manager = new ConnectionManager({ Peer }),
  }) {
    this.kind = 'co';
    this.joinCode = joinCode;
    this.facilitatorPin = pin;
    this._data = data;
    this._Peer = Peer;
    this._token = token;
    this._name = name;
    this._onChange = onChange;
    this._onStatus = onStatus;
    this._log = onLog ?? (() => {});
    this.client = new ClientState();
    this.manager = manager;
    // What command-gateway resolves to when a control sends something.
    globalThis.window.connectionManager = manager;

    this.client.subscribe(() => onChange());
  }

  start() {
    this.manager.connect(peerIdForCode(this.joinCode), {
      onData: (message) => this.client.receive(message),
      onStatus: (status) => this._onStatus(status),
      getIdent: () => identify({
        token: this._token, name: this._name, pin: this.facilitatorPin,
      }),
    });
  }

  stop() { this.manager.disconnect?.(); }

  /**
   * The mirror.
   *
   * Null until the first projection arrives, which is the honest answer: a
   * co-facilitator who has never connected has nothing to take over with.
   */
  get state() { return this.client.view; }

  roster() { return Object.values(this.client.view?.seats ?? {}); }

  /** Sent, because the game is on the other machine. */
  submit(verb, payload = {}) {
    const { envelope, sent } = sendCommand(verb, payload);
    if (sent) this.client.awaiting(envelope.data.seq, verb);
    else this._log('[co] not connected — that did not go anywhere');
    return { ok: sent, reason: sent ? null : 'not connected to the host' };
  }

  /** Whether there is enough here to take the game over with. */
  get canTakeOver() {
    return Boolean(this.client.view?.log && this.client.view?.seed !== undefined);
  }

  save() {
    if (!this.canTakeOver) return null;
    return {
      ...toSave(this.client.view),
      facilitatorPin: this.facilitatorPin,
      savedAt: Date.now(),
    };
  }

  /**
   * Become the host.
   *
   * Rebuilt from the mirrored log rather than adopted as a snapshot, so the
   * game that carries on is one the rules could have reached — the same
   * guarantee a crashed host gets when it comes back.
   *
   * The address is the guard. Two hosts cannot both hold `peerIdForCode`, so
   * if the original is still alive this waits on a code it will never get and
   * says so, rather than quietly running a second copy of the game.
   */
  takeOver({ onChange, onStatus, onLog, pump = null }) {
    const save = this.save();
    if (!save) return { ok: false, reason: 'nothing has arrived from the host yet' };

    this.stop();
    const { host, refused } = GameHost.restore({ save, data: this._data });
    // Built but not started: the caller adopts it, and adoption is what
    // claims the code. Starting here as well would leave two peers racing for
    // one address from the same tab.
    // The pump follows the tab, not the game: this machine is the host now, so
    // whatever this tab was opened with is what streams. Null unless the
    // co-facilitator's own URL carried the parameter.
    const session = new PrimarySession({
      host, onChange, onStatus, onLog, pump, Peer: this._Peer,
    });
    return { ok: true, session, refused };
  }
}
