/**
 * gui/host/game-host.js — where the transport meets the rules.
 *
 * The one object that owns authoritative state. Everything that changes it
 * comes through here: admit, reduce, log, save, reproject, broadcast, in that
 * order, every time.
 *
 * **Seats are the exception, and deliberately so.** A seat is who is sitting in
 * a chair right now, not something that happened in the game. It is not
 * commanded, not logged, and not replayed — `replay()` recreates seats from the
 * log's own actor ids when it needs them. So `identify` writes seats directly
 * while everything else goes through the reducer. Keeping runtime identity out
 * of game history is what lets a save file be a seed and a log rather than a
 * snapshot of who happened to be connected.
 */

import { createInitialState, nextSeatId, seatForToken } from '../rules/state.js';
import { apply } from '../rules/reducer.js';
import { projectView } from '../rules/views.js';
import { replay } from '../rules/reducer.js';
import { toSave } from '../rules/command-log.js';

export class GameHost {
  /**
   * @param {object} args
   * @param {object} args.state  a fresh or restored GameState
   * @param {object} args.data   the static dataset
   * @param {Function} [args.onChange]  called after every accepted command
   * @param {() => number} [args.now]
   */
  constructor({ state, data, onChange, facilitatorPin = null, now = () => Date.now() }) {
    this.state = state;
    this.data = data;
    // Kept with the game rather than minted per tab. A host that refreshed
    // into a new PIN would lock out the co-facilitator, who is on a different
    // machine and has no way to learn the new one except by being told — at
    // exactly the moment everyone is busy working out what just happened.
    this.facilitatorPin = facilitatorPin;
    this._onChange = onChange ?? (() => {});
    this._now = now;
  }

  /** Start a game nobody has played yet. */
  static create({ joinCode, seed, data, roleIds, ...rest }) {
    return new GameHost({
      state: createInitialState({ joinCode, seed, data, roleIds }), data, ...rest,
    });
  }

  /**
   * Rebuild a game from a save.
   *
   * Refused entries are surfaced rather than swallowed: a log that no longer
   * replays cleanly means the rules changed under a save, and a facilitator
   * about to run a game on it should be told before the players arrive.
   */
  static restore({ save, data, roleIds, ...rest }) {
    const { state, refused } = replay(save, data, { roleIds });

    // Put everyone back in the chair they were in. Seats are not replayed --
    // they are not things that happened -- but the token-to-seat binding is
    // what makes a returning player the same player, so a host that came back
    // without it would greet all sixteen of them as strangers and hand out
    // their roles again.
    if (save.seats) {
      state.seats = structuredClone(save.seats);
      state.seatByToken = structuredClone(save.seatByToken ?? {});
      for (const seat of Object.values(state.seats)) seat.connected = false;
    }

    return {
      host: new GameHost({ state, data, facilitatorPin: save.facilitatorPin ?? null, ...rest }),
      refused,
    };
  }

  /**
   * Find or make the seat holding a token.
   *
   * The token is the identity, not the peer id: peer ids change on every page
   * load, and a player who refreshes has to land back in the chair they had.
   * Returns null when there is no room, which the transport turns into a
   * refusal the newcomer can read.
   *
   * @returns {object|null}
   */
  identify({ token, name, wantsFacilitator }) {
    const existing = seatForToken(this.state, token);
    if (existing) {
      existing.name = name || existing.name;
      existing.connected = true;
      existing.lastSeen = this._now();
      // Someone who was a player and now knows the PIN becomes an umpire, and
      // gives up the role they were holding on the way.
      if (wantsFacilitator && existing.kind !== 'facilitator') {
        existing.kind = 'facilitator';
        existing.roleId = null;
      }
      return existing;
    }

    const players = Object.values(this.state.seats).filter((s) => s.kind === 'player');
    if (!wantsFacilitator && players.length >= Object.keys(this.state.roles).length) {
      return null;
    }

    const seat = {
      id: nextSeatId(this.state),
      token,
      name: name || '',
      roleId: null,
      kind: wantsFacilitator ? 'facilitator' : 'player',
      connected: true,
      lastSeen: this._now(),
    };
    this.state.seats[seat.id] = seat;
    this.state.seatByToken[token] = seat.id;
    return seat;
  }

  /** Mark a seat as gone without forgetting it: the chair is still theirs. */
  disconnect(seatId) {
    const seat = this.state.seats[seatId];
    if (!seat) return;
    seat.connected = false;
    seat.lastSeen = this._now();
    this._onChange(this.state);
  }

  /**
   * Run one command through the pipeline.
   *
   * @returns {{ok: boolean, reason?: string}}
   */
  submit(seat, { verb, payload }) {
    const actor = { seatId: seat.id, kind: seat.kind, roleId: seat.roleId };
    const result = apply(this.state, this.data, { verb, payload }, actor, { ts: this._now() });
    if (!result.ok) return { ok: false, reason: result.reason };

    // `apply` deep-clones, so the seats it hands back are copies — while the
    // transport is holding references to the originals, one per open
    // connection. Replacing the map would strand those references; keeping the
    // old map would throw away whatever the command just did to a seat (a role
    // claim, for one). So fold the new values into the live objects and keep
    // the live map.
    for (const [id, updated] of Object.entries(result.state.seats)) {
      if (this.state.seats[id]) Object.assign(this.state.seats[id], updated);
      else this.state.seats[id] = updated;
    }
    result.state.seats = this.state.seats;
    result.state.seatByToken = this.state.seatByToken;
    this.state = result.state;
    this._onChange(this.state);
    return { ok: true };
  }

  /** One recipient's copy of the game. */
  viewFor(seat) {
    return projectView(this.state, this.data, {
      kind: seat.kind === 'facilitator' ? 'facilitator' : 'player',
      seatId: seat.id,
      roleId: seat.roleId,
      teamId: seat.roleId ? this.state.roles[seat.roleId]?.teamId ?? null : null,
    });
  }

  /** What gets written to storage or downloaded: a seed and a history. */
  save() {
    return { ...toSave(this.state), facilitatorPin: this.facilitatorPin, savedAt: this._now() };
  }

  /** The roster the facilitator's console shows. */
  roster() {
    return Object.values(this.state.seats).map((seat) => ({
      ...seat,
      token: undefined,
      roleName: seat.roleId ? this.data.roles.roles[seat.roleId]?.name ?? seat.roleId : null,
    }));
  }

  /** Roles nobody connected is playing, for the claim screen. */
  vacantRoles() {
    const taken = new Set(Object.values(this.state.seats)
      .filter((s) => s.connected && s.roleId).map((s) => s.roleId));
    return Object.keys(this.state.roles).filter((id) => !taken.has(id));
  }
}
