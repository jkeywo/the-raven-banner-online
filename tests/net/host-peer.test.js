import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  Peer, createBroker, reserveId, releaseId, severBetween, settle,
} from '../fakes/peerjs-shim.js';
import { HostPeer } from '../../gui/net/host-peer.js';
import { ConnectionManager } from '../../gui/net/connection-manager.js';
import { peerIdForCode } from '../../gui/net/join-code.js';
import { identify, command, VIEW, RESULT, REJECTED } from '../../gui/net/wire.js';

const CODE = 'RAVEN7Z';
const PIN = '424242';

/**
 * A host with a trivial seating policy: one seat per token, first come. The
 * real one is M4's; this is enough to exercise the transport.
 */
function makeHost(overrides = {}) {
  const seats = new Map();
  const commands = [];
  const host = new HostPeer({
    joinCode: CODE,
    facilitatorPin: PIN,
    Peer,
    onIdentify({ token, name, wantsFacilitator }) {
      if (!seats.has(token)) {
        if (seats.size >= 4) return null;                 // "full", for the test
        seats.set(token, { id: `s${seats.size + 1}`, token, name, kind: wantsFacilitator ? 'facilitator' : 'player' });
      }
      const seat = seats.get(token);
      seat.name = name;
      return seat;
    },
    onCommand(seat, cmd) {
      commands.push({ seat: seat.id, ...cmd });
      return cmd.verb === 'illegal'
        ? { ok: false, reason: 'not enough silver — you have 2, this costs 5' }
        : { ok: true };
    },
    viewFor: (seat) => ({ you: seat.id, kind: seat.kind }),
    ...overrides,
  });
  return { host, seats, commands };
}

/** A client that records everything it is told. */
function makeClient({ token, name, pin = null } = {}) {
  const received = [];
  const statuses = [];
  const manager = new ConnectionManager({ Peer });
  manager.connect(peerIdForCode(CODE), {
    onData: (message) => received.push(message),
    onStatus: (status) => statuses.push(status),
    getIdent: () => identify({ token, name, pin }),
  });
  return { manager, received, statuses };
}

beforeEach(() => {
  createBroker();
});

describe('claiming the room code', () => {
  it('answers at the address derived from the join code', async () => {
    const { host } = makeHost();
    host.start();
    await settle();
    expect(host.peerId).toBe('rbo1-raven7z');
    expect(host.peer.id).toBe('rbo1-raven7z');
  });

  it('waits for the broker to release a code the last session still holds', async () => {
    // Exactly what a facilitator refreshing their tab runs into, and the one
    // place where treating an error as fatal would break the recovery path
    // for the failure it accompanies.
    vi.useFakeTimers();
    reserveId(peerIdForCode(CODE));
    const statuses = [];
    const { host } = makeHost({ onStatus: (s) => statuses.push(s) });
    host.start();
    await settle();
    expect(statuses).toContain('waiting-for-code');
    expect(host.connections.size).toBe(0);

    releaseId(peerIdForCode(CODE));
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(statuses).toContain('hosting');
    host.stop();
    vi.useRealTimers();
  });

  it('says so rather than throwing when PeerJS never loaded', () => {
    // The library is a vendored <script>, so it can simply not be there — a
    // 404 on the vendor file, an extension that ate it. start() is called
    // from a click handler, so a throw here escapes into the handler and the
    // console dies with nothing on screen to say why.
    const statuses = [];
    const lines = [];
    const { host } = makeHost({
      Peer: undefined,
      onStatus: (s) => statuses.push(s),
      onLog: (line) => lines.push(line),
    });
    expect(() => host.start()).not.toThrow();
    expect(statuses).toContain('error');
    expect(lines.join(' ')).toContain('PeerJS did not load');
  });
});

describe('seating', () => {
  it('seats a client that identifies, and sends it its own view', async () => {
    const { host, seats } = makeHost();
    host.start();
    await settle();

    const alice = makeClient({ token: 'tok-a', name: 'Alice' });
    await settle();

    expect(seats.size).toBe(1);
    expect(host.connections.size).toBe(1);
    const views = alice.received.filter((m) => m.type === VIEW);
    expect(views).toHaveLength(1);
    expect(views[0].data).toEqual({ you: 's1', kind: 'player' });
    expect(alice.statuses).toContain('ready');
  });

  it('gives each seat a different game', async () => {
    const { host } = makeHost();
    host.start();
    await settle();
    const alice = makeClient({ token: 'tok-a', name: 'Alice' });
    const bob = makeClient({ token: 'tok-b', name: 'Bob' });
    await settle();

    host.broadcast();
    await settle();
    expect(alice.received.at(-1).data.you).toBe('s1');
    expect(bob.received.at(-1).data.you).toBe('s2');
  });

  it('refuses a facilitator claim with the wrong PIN rather than seating a player', async () => {
    // Being silently demoted is worse than being told no: an umpire who
    // thinks they have authority and does not will find out mid-adjudication.
    const { host, seats } = makeHost();
    host.start();
    await settle();
    const impostor = makeClient({ token: 'tok-x', name: 'Nobody', pin: '000000' });
    await settle();

    expect(seats.size).toBe(0);
    expect(impostor.received.map((m) => m.type)).toContain(REJECTED);
    expect(impostor.received.at(-1).data.reason).toContain('PIN');
  });

  it('seats a facilitator whose PIN is right', async () => {
    const { host, seats } = makeHost();
    host.start();
    await settle();
    makeClient({ token: 'tok-f', name: 'Umpire', pin: PIN });
    await settle();
    expect([...seats.values()][0].kind).toBe('facilitator');
  });

  it('turns away a client when the game is full', async () => {
    const { host } = makeHost();
    host.start();
    await settle();
    for (const t of ['a', 'b', 'c', 'd']) makeClient({ token: `tok-${t}`, name: t });
    await settle();
    const late = makeClient({ token: 'tok-late', name: 'Late' });
    await settle();
    expect(late.received.at(-1)).toMatchObject({ type: REJECTED });
  });
});

describe('commands', () => {
  it('carries a refusal reason back to the client that asked', async () => {
    const { host } = makeHost();
    host.start();
    await settle();
    const alice = makeClient({ token: 'tok-a', name: 'Alice' });
    await settle();

    alice.manager.send(command('illegal', {}, 1));
    await settle();
    const answer = alice.received.filter((m) => m.type === RESULT).at(-1);
    expect(answer.data).toMatchObject({ seq: 1, ok: false });
    expect(answer.data.reason).toContain('not enough silver');
  });

  it('ignores a command replayed after a reconnect, but still says yes', async () => {
    // A client that resent something in flight when the channel dropped must
    // not be charged twice — and must not be told it failed, because it did
    // not: it happened the first time.
    const { host, commands } = makeHost();
    host.start();
    await settle();
    const alice = makeClient({ token: 'tok-a', name: 'Alice' });
    await settle();

    alice.manager.send(command('recruit-soldiers', {}, 1));
    await settle();
    alice.manager.send(command('recruit-soldiers', {}, 1));
    await settle();

    expect(commands.filter((c) => c.verb === 'recruit-soldiers')).toHaveLength(1);
    const answers = alice.received.filter((m) => m.type === RESULT);
    expect(answers).toHaveLength(2);
    expect(answers.every((a) => a.data.ok)).toBe(true);
  });

  it('refuses a command from a connection that never identified', async () => {
    const { host } = makeHost();
    host.start();
    await settle();
    const stranger = new Peer(null, {});
    await settle();
    const conn = stranger.connect(peerIdForCode(CODE));
    const seen = [];
    conn.on('data', (raw) => seen.push(JSON.parse(raw)));
    await settle();
    conn.send(JSON.stringify(command('recruit-soldiers', {}, 1)));
    await settle();
    expect(seen.at(-1)).toMatchObject({ type: REJECTED });
  });
});

describe('reconnection', () => {
  it('returns a refreshed player to the same seat', async () => {
    const { host, seats } = makeHost();
    host.start();
    await settle();

    const first = makeClient({ token: 'tok-a', name: 'Alice' });
    await settle();
    expect(first.received.at(-1).data.you).toBe('s1');

    // A refresh: the old peer goes away, a new one dials with the same token.
    first.manager.disconnect();
    await settle();
    const second = makeClient({ token: 'tok-a', name: 'Alice' });
    await settle();

    expect(seats.size).toBe(1);
    expect(second.received.at(-1).data.you).toBe('s1');
    expect(host.connections.size).toBe(1);
  });

  it('supersedes the old connection when a seat reappears in a new tab', async () => {
    const { host } = makeHost();
    host.start();
    await settle();
    makeClient({ token: 'tok-a', name: 'Alice' });
    await settle();
    const firstConn = host.connections.get('s1').conn;

    makeClient({ token: 'tok-a', name: 'Alice again' });
    await settle();

    expect(host.connections.size).toBe(1);
    expect(host.connections.get('s1').conn).not.toBe(firstConn);
    expect(firstConn.open).toBe(false);
  });

  it('retries on its own after the channel drops silently', async () => {
    // A lid closing or a radio sleeping: neither side called close, and the
    // client has to notice and come back without anyone pressing anything.
    vi.useFakeTimers();
    const { host } = makeHost();
    host.start();
    await settle();
    const alice = makeClient({ token: 'tok-a', name: 'Alice' });
    await settle();
    expect(host.connections.size).toBe(1);

    severBetween(alice.manager.peer.id, peerIdForCode(CODE));
    await settle();
    expect(alice.statuses).toContain('disconnected');
    expect(host.connections.size).toBe(0);

    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(host.connections.size).toBe(1);
    host.stop();
    vi.useRealTimers();
  });

  it('drops a seat from the roster when its connection closes', async () => {
    const { host } = makeHost();
    host.start();
    await settle();
    const alice = makeClient({ token: 'tok-a', name: 'Alice' });
    await settle();
    expect(host.liveSeats()).toHaveLength(1);

    alice.manager.disconnect();
    await settle();
    expect(host.liveSeats()).toHaveLength(0);
  });
});
