import { describe, it, expect, beforeEach } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { GameHost } from '../../gui/host/game-host.js';
import { PrimarySession, CoFacilitatorSession } from '../../gui/host/session.js';
import { __resetSequence } from '../../gui/net/command-gateway.js';
import { Peer, createBroker, settle } from '../fakes/peerjs-shim.js';

const data = await loadData();
const CODE = 'RAVEN7Z';
const PIN = '424242';

let broker;

beforeEach(() => {
  broker = createBroker();
  __resetSequence();
  globalThis.window = globalThis;
});

/** A running game, hosted, with a co-facilitator connected and caught up. */
async function paired() {
  const host = GameHost.create({
    joinCode: CODE, seed: 42, data, facilitatorPin: PIN, now: () => 1000,
  });
  const primary = new PrimarySession({
    host, onChange: () => {}, onStatus: () => {}, onLog: () => {}, Peer,
  });
  primary.start();
  await settle();

  const co = new CoFacilitatorSession({
    joinCode: CODE,
    pin: PIN,
    name: 'The other one',
    token: 'tok-co',
    data,
    onChange: () => {},
    onStatus: () => {},
    onLog: () => {},
    Peer,
  });
  co.start();
  await settle();
  return { host, primary, co };
}

describe('the co-facilitator', () => {
  it('is given the whole game, not a player’s slice of it', async () => {
    const { co } = await paired();
    // The PIN makes them an umpire, and an umpire sees everything.
    expect(co.state.viewer.kind).toBe('facilitator');
    expect(co.state.roles.king_alfred.silver).toBeTypeOf('number');
    expect(co.state.log).toBeInstanceOf(Array);
  });

  it('sees the roster the primary sees', async () => {
    const { primary, co } = await paired();
    expect(co.roster().map((s) => s.id).sort())
      .toEqual(primary.roster().map((s) => s.id).sort());
  });

  it('acts on the game over the wire', async () => {
    const { host, co } = await paired();
    expect(host.state.phase.name).toBe('lobby');
    co.submit('facilitator:advance-phase');
    await settle();
    expect(host.state.phase.name).toBe('team');
    // And the change comes back, so both consoles agree.
    expect(co.state.phase.name).toBe('team');
  });

  it('keeps a save that is ready before it is needed', async () => {
    const { host, co } = await paired();
    co.submit('facilitator:advance-phase');
    await settle();

    expect(co.canTakeOver).toBe(true);
    const mirror = co.save();
    expect(mirror.joinCode).toBe(CODE);
    expect(mirror.seed).toBe(host.state.seed);
    expect(mirror.log).toHaveLength(host.state.log.length);
    expect(mirror.facilitatorPin).toBe(PIN);
    // The roster too, or a short-handed game would come back with a player
    // who was never there.
    expect(mirror.roleIds).toEqual(Object.keys(host.state.roles));
  });

  it('has nothing to take over with before the first projection', () => {
    const co = new CoFacilitatorSession({
      joinCode: CODE, pin: PIN, name: 'x', token: 'tok', data,
      onChange: () => {}, onStatus: () => {}, onLog: () => {}, Peer,
    });
    expect(co.canTakeOver).toBe(false);
    expect(co.save()).toBe(null);
    expect(co.takeOver({ onChange: () => {}, onStatus: () => {}, onLog: () => {} }))
      .toMatchObject({ ok: false });
  });
});

describe('taking over', () => {
  it('rebuilds the game rather than adopting a snapshot', async () => {
    const { host, primary, co } = await paired();
    co.submit('facilitator:advance-phase');
    await settle();
    co.submit('facilitator:advance-phase');
    await settle();

    // The primary's machine dies.
    primary.stop();
    broker.peers.delete(primary.peer.peerId);
    await settle();

    const result = co.takeOver({ onChange: () => {}, onStatus: () => {}, onLog: () => {} });
    result.session.start();
    await settle();

    expect(result.ok).toBe(true);
    expect(result.refused).toEqual([]);
    // Same game, arrived at the same way.
    expect(result.session.state.phase).toEqual(host.state.phase);
    expect(result.session.state.roles).toEqual(host.state.roles);
    expect(result.session.state.log).toHaveLength(host.state.log.length);
  });

  it('carries the seats over, so nobody comes back a stranger', async () => {
    const { host, primary, co } = await paired();
    host.identify({ token: 'tok-alfred', name: 'Alice' });
    host.submit({ id: 'host', kind: 'facilitator' },
      { verb: 'facilitator:advance-phase', payload: {} });
    await settle();

    primary.stop();
    const result = co.takeOver({ onChange: () => {}, onStatus: () => {}, onLog: () => {} });
    expect(result.session.state.seatByToken['tok-alfred']).toBeTruthy();
  });

  it('keeps the PIN, so the other facilitator can come back in', async () => {
    const { primary, co } = await paired();
    primary.stop();
    const result = co.takeOver({ onChange: () => {}, onStatus: () => {}, onLog: () => {} });
    expect(result.session.facilitatorPin).toBe(PIN);
  });

  it('goes on running the game from the new machine', async () => {
    const { primary, co } = await paired();
    primary.stop();
    broker.peers.delete(primary.peer.peerId);

    const result = co.takeOver({ onChange: () => {}, onStatus: () => {}, onLog: () => {} });
    result.session.start();
    await settle();

    result.session.submit('facilitator:advance-phase');
    expect(result.session.state.phase.name).toBe('team');
  });

  it('cannot claim a code the original is still holding', async () => {
    // The address is the guard: two hosts cannot both hold it, so a takeover
    // while the primary is alive waits rather than running a second game.
    const { co } = await paired();
    const statuses = [];
    const result = co.takeOver({
      onChange: () => {}, onStatus: (s) => statuses.push(s), onLog: () => {},
    });
    result.session.start();
    await settle();

    expect(statuses).toContain('waiting-for-code');
    expect(statuses).not.toContain('hosting');
  });
});
