import { describe, it, expect, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadData } from '../helpers/load-data.js';
import { createInitialState } from '../../gui/rules/state.js';
import { projectView } from '../../gui/rules/views.js';
import { GameHost } from '../../gui/host/game-host.js';
import { PrimarySession } from '../../gui/host/session.js';
import { EventPump, eventPumpFor, pumpUrlFrom } from '../../gui/host/event-pump.js';
import { EVENT_TYPES, ENVELOPE_KEYS, PUMP_SCHEMA_VERSION } from '../../gui/host/pump-events.js';
import { Peer, createBroker } from '../fakes/peerjs-shim.js';

const data = await loadData();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CODE = 'RAVEN7Z';
const PIN = '424242';
const SINK = 'ws://bot.test/raven';

/**
 * A WebSocket that goes nowhere, and can be made to misbehave on purpose.
 *
 * Every instance registers itself, because "how many sockets did a default
 * game open?" is the question the off-switch has to answer.
 */
class FakeSocket {
  static made = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;                 // CONNECTING
    this.sent = [];
    this.throwOnSend = false;
    FakeSocket.made.push(this);
  }

  open() { this.readyState = 1; this.onopen?.(); }

  send(frame) {
    if (this.throwOnSend) throw new Error('the socket is gone');
    this.sent.push(frame);
  }

  close() { this.readyState = 3; this.onclose?.(); }

  /** Every JSON line this socket has carried, in order. */
  lines() {
    return this.sent.flatMap((frame) => frame.split('\n')).filter(Boolean).map((l) => JSON.parse(l));
  }
}

const spectatorOf = (state) => projectView(state, data, { kind: 'spectator' });

const seat = (id, name, roleId, over = {}) => ({
  id, token: `tok-${id}`, name, roleId, kind: 'player', connected: true, lastSeen: 1, ...over,
});

function seated() {
  const state = createInitialState({ joinCode: CODE, seed: 42, data });
  state.seats = { s1: seat('s1', 'Alice', 'cenred'), s2: seat('s2', 'Bryn', 'guthrum_the_old') };
  return state;
}

/** A pump wired to a fake socket, with a clock a test can move. */
function pumped({ url = SINK, at = 1730000000000, fetchImpl } = {}) {
  const log = [];
  let clock = at;
  const pump = new EventPump({
    url: new URL(url),
    now: () => clock,
    onLog: (line) => log.push(line),
    WebSocketImpl: FakeSocket,
    fetchImpl,
  });
  return { pump, log, tick: (ms) => { clock += ms; } };
}

beforeEach(() => {
  FakeSocket.made = [];
  createBroker();
  globalThis.window = globalThis;
});

describe('off is off', () => {
  it('builds no pump without the parameter', () => {
    expect(eventPumpFor()).toBe(null);
    expect(eventPumpFor({ location: {} })).toBe(null);
    expect(eventPumpFor({ location: { search: '' } })).toBe(null);
    expect(eventPumpFor({ location: { search: '?seat=1' } })).toBe(null);
  });

  it('builds no pump for a parameter that is not a sink', () => {
    // A typo has to fail to nothing rather than to something half-connected.
    for (const search of ['?events=', '?events=nonsense', '?events=ftp://bot.test/x',
      '?events=/relative/path', '?events=javascript:alert(1)']) {
      expect(pumpUrlFrom({ search })).toBe(null);
      expect(eventPumpFor({ location: { search } })).toBe(null);
    }
  });

  it('builds one, and says so, when a facilitator asks', () => {
    const log = [];
    const pump = eventPumpFor({
      location: { search: `?events=${SINK}` }, onLog: (l) => log.push(l), WebSocketImpl: FakeSocket,
    });
    expect(pump).toBeInstanceOf(EventPump);
    expect(pump.mode).toBe('websocket');
    // Visible on the facilitator's own console: on should look on.
    expect(log.join('\n')).toContain(SINK);
    // Named but not dialled. Nothing has happened in the game yet.
    expect(FakeSocket.made).toHaveLength(0);
  });

  it('reads an http sink as a POST target', () => {
    const pump = eventPumpFor({
      location: { search: '?events=https://bot.test/raven' }, fetchImpl: () => Promise.resolve({}),
    });
    expect(pump.mode).toBe('http');
  });

  it('does no work at all in a default game', () => {
    const host = GameHost.create({
      joinCode: CODE, seed: 42, data, facilitatorPin: PIN, now: () => 1000,
    });
    const session = new PrimarySession({
      host, onChange: () => {}, onStatus: () => {}, onLog: () => {}, Peer,
    });
    expect(session.pump).toBe(null);

    // The optional call short-circuits its own argument, so the extra
    // projection is not merely discarded — it is never built.
    let projections = 0;
    const real = host.spectatorView.bind(host);
    host.spectatorView = () => { projections += 1; return real(); };

    host.identify({ token: 'tok-a', name: 'Alice' });
    expect(host.submit(host.state.seats.s1,
      { verb: 'claim-role', payload: { roleId: 'cenred' } }).ok).toBe(true);
    expect(session.submit('facilitator:advance-phase').ok).toBe(true);
    host.disconnect('s1');

    expect(projections).toBe(0);
    expect(FakeSocket.made).toEqual([]);
  });

  it('never fires while a save is being replayed', () => {
    // Replay happens inside `restore`, before anything is wired to the pump,
    // which is the whole reason the pump hangs off the session rather than the
    // reducer. A save that replays four commands must not narrate them again.
    const host = GameHost.create({
      joinCode: CODE, seed: 42, data, facilitatorPin: PIN, now: () => 1000,
    });
    host.identify({ token: 'tok-a', name: 'Alice' });
    host.submit(host.state.seats.s1, { verb: 'claim-role', payload: { roleId: 'cenred' } });
    host.submit({ id: 'host', kind: 'facilitator', roleId: null },
      { verb: 'facilitator:advance-phase', payload: {} });
    const save = host.save();

    const { pump } = pumped();
    const { host: restored } = GameHost.restore({ save, data });
    const session = new PrimarySession({
      host: restored, onChange: () => {}, onStatus: () => {}, onLog: () => {}, pump, Peer,
    });

    expect(FakeSocket.made).toHaveLength(0);

    // ...and the first real change opens with the position, not with a
    // retelling of the log.
    session.submit('facilitator:advance-phase');
    const socket = FakeSocket.made[0];
    socket.open();
    expect(socket.lines().map((e) => e.type)).toEqual(['game.opened']);
  });
});

describe('emitting', () => {
  it('sends line-delimited JSON once the socket is up', () => {
    const { pump } = pumped();
    const before = seated();
    pump.observe(spectatorOf(before));

    const socket = FakeSocket.made[0];
    expect(socket.url).toBe(`${SINK}`);
    // Held while the socket is still connecting rather than thrown away.
    expect(socket.sent).toHaveLength(0);
    socket.open();
    expect(socket.lines().map((e) => e.type)).toEqual(['game.opened']);

    const after = structuredClone(before);
    after.phase.name = 'team';
    after.shires.lindsey.stewardRoleId = 'halfdan_ragnarsson';
    pump.observe(spectatorOf(after));

    const types = socket.lines().map((e) => e.type);
    expect(types).toEqual(['game.opened', 'game.phase', 'board.steward']);
    // One frame per state change, whatever it holds.
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent.every((frame) => frame.endsWith('\n'))).toBe(true);
  });

  it('numbers every event from zero so a bot can see a gap', () => {
    const { pump } = pumped();
    const before = seated();
    pump.observe(spectatorOf(before));
    FakeSocket.made[0].open();

    const after = structuredClone(before);
    after.phase.name = 'team';
    after.seats.s3 = seat('s3', 'Cerdic', null);
    pump.observe(spectatorOf(after));

    expect(FakeSocket.made[0].lines().map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('stamps the join code and the host clock on every line', () => {
    const { pump } = pumped({ at: 1730000000000 });
    pump.observe(spectatorOf(seated()));
    FakeSocket.made[0].open();

    const [event] = FakeSocket.made[0].lines();
    expect(event.game).toBe(CODE);
    expect(event.at).toBe(1730000000000);
    expect(event.v).toBe(PUMP_SCHEMA_VERSION);
  });

  it('says nothing when a command changed nothing anybody outside can see', () => {
    const { pump } = pumped();
    const state = seated();
    pump.observe(spectatorOf(state));
    FakeSocket.made[0].open();

    // A private resource moved. The board did not.
    const after = structuredClone(state);
    after.roles.cenred.silver += 5;
    expect(pump.observe(spectatorOf(after))).toBe(0);
    expect(FakeSocket.made[0].lines()).toHaveLength(1);
  });

  it('follows a whole game through the session seam', () => {
    const { pump } = pumped();
    const host = GameHost.create({
      joinCode: CODE, seed: 42, data, facilitatorPin: PIN, now: () => 1000,
    });
    const session = new PrimarySession({
      host, onChange: () => {}, onStatus: () => {}, onLog: () => {}, pump, Peer,
    });

    host.identify({ token: 'tok-a', name: 'Alice' });
    host.submit(host.state.seats.s1, { verb: 'claim-role', payload: { roleId: 'cenred' } });
    FakeSocket.made[0].open();
    session.submit('facilitator:advance-phase');
    host.disconnect('s1');

    const types = FakeSocket.made[0].lines().map((e) => e.type);
    expect(types[0]).toBe('game.opened');
    expect(types).toContain('game.phase');
    expect(types).toContain('seat.left');
  });

  it('posts a batch when the sink is an http endpoint', async () => {
    const calls = [];
    const { pump } = pumped({
      url: 'https://bot.test/raven',
      fetchImpl: (url, init) => { calls.push({ url, init }); return Promise.resolve({ ok: true }); },
    });
    pump.observe(spectatorOf(seated()));

    expect(FakeSocket.made).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://bot.test/raven');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['content-type']).toBe('application/x-ndjson');
    expect(JSON.parse(calls[0].init.body.trim()).type).toBe('game.opened');
  });
});

describe('a dead bot must not take the game with it', () => {
  /** A running game whose pump is whatever the test wants to break. */
  function hostedWith(pump) {
    const log = [];
    const host = GameHost.create({
      joinCode: CODE, seed: 42, data, facilitatorPin: PIN, now: () => 1000,
    });
    const session = new PrimarySession({
      host, onChange: () => {}, onStatus: () => {}, onLog: (l) => log.push(l), pump, Peer,
    });
    host.identify({ token: 'tok-a', name: 'Alice' });
    return { host, session, log };
  }

  it('survives a pump that throws outright', () => {
    const { host, session, log } = hostedWith({
      observe() { throw new Error('the bot exploded'); },
      close() {},
    });

    const result = host.submit(host.state.seats.s1,
      { verb: 'claim-role', payload: { roleId: 'cenred' } });
    expect(result.ok).toBe(true);
    expect(host.state.seats.s1.roleId).toBe('cenred');
    expect(session.submit('facilitator:advance-phase').ok).toBe(true);
    expect(host.state.phase.name).not.toBe('lobby');
    expect(log.join('\n')).toContain('the bot exploded');
  });

  it('survives a socket that refuses to be constructed', () => {
    const exploding = class { constructor() { throw new Error('no network'); } };
    const pump = new EventPump({
      url: new URL(SINK), now: () => 1, WebSocketImpl: exploding, onLog: () => {},
    });
    const { host } = hostedWith(pump);

    expect(host.submit(host.state.seats.s1,
      { verb: 'claim-role', payload: { roleId: 'cenred' } }).ok).toBe(true);
    expect(host.state.seats.s1.roleId).toBe('cenred');
  });

  it('survives a runtime with no WebSocket at all', () => {
    const pump = new EventPump({
      url: new URL(SINK), now: () => 1, WebSocketImpl: undefined, onLog: () => {},
    });
    expect(() => pump.observe(spectatorOf(seated()))).not.toThrow();
  });

  it('survives a socket that throws mid-send, and keeps the game going', () => {
    const { pump } = pumped();
    const { host } = hostedWith(pump);
    host.submit(host.state.seats.s1, { verb: 'claim-role', payload: { roleId: 'cenred' } });
    const socket = FakeSocket.made[0];
    socket.open();
    socket.throwOnSend = true;

    expect(host.submit({ id: 'host', kind: 'facilitator', roleId: null },
      { verb: 'facilitator:advance-phase', payload: {} }).ok).toBe(true);
    expect(host.state.phase.name).not.toBe('lobby');
  });

  it('drops what it cannot hold rather than growing without limit', () => {
    const { pump } = pumped();
    const state = seated();
    pump.observe(spectatorOf(state));       // dials; never opened

    // Eighty changes against a socket that never came up.
    for (let i = 0; i < 80; i += 1) {
      const next = structuredClone(state);
      next.phase.turn = i + 2;
      pump.observe(spectatorOf(next));
      state.phase.turn = i + 2;
    }
    FakeSocket.made[0].open();

    const lines = FakeSocket.made[0].lines();
    expect(lines.length).toBeLessThanOrEqual(64);
    // The gap is visible rather than silent: seq does not restart.
    expect(lines[0].seq).toBeGreaterThan(0);
    expect(lines.at(-1).seq).toBe(80);
  });

  it('redials on the next change after the sink goes away, and not before', () => {
    const { pump, tick } = pumped();
    const state = seated();
    pump.observe(spectatorOf(state));
    FakeSocket.made[0].open();
    FakeSocket.made[0].close();
    expect(FakeSocket.made).toHaveLength(1);

    // Inside the retry window: the game moving on must not hammer a dead bot.
    state.phase.turn = 2;
    pump.observe(spectatorOf(state));
    expect(FakeSocket.made).toHaveLength(1);

    tick(6000);
    state.phase.turn = 3;
    pump.observe(spectatorOf(state));
    expect(FakeSocket.made).toHaveLength(2);
  });

  it('lets no rejected POST escape as an unhandled rejection', async () => {
    const rejections = [];
    const watch = (error) => rejections.push(error);
    process.on('unhandledRejection', watch);
    try {
      const { pump, log } = pumped({
        url: 'https://bot.test/raven',
        fetchImpl: () => Promise.reject(new Error('connection refused')),
      });
      pump.observe(spectatorOf(seated()));
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(rejections).toEqual([]);
      expect(log.join('\n')).toContain('sink unreachable');
    } finally {
      process.off('unhandledRejection', watch);
    }
  });

  it('survives a view that makes no sense', () => {
    const { pump, log } = pumped();
    expect(() => pump.observe(null)).not.toThrow();
    expect(() => pump.observe({ get seats() { throw new Error('rotten'); } })).not.toThrow();
    expect(log.join('\n')).toContain('rotten');
  });

  it('goes quiet for good once closed', () => {
    const { pump } = pumped();
    pump.observe(spectatorOf(seated()));
    FakeSocket.made[0].open();
    pump.close();

    const state = seated();
    state.phase.name = 'team';
    expect(pump.observe(spectatorOf(state))).toBe(0);
    expect(FakeSocket.made).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The contract document.
//
// docs/discord-integration.md is implemented against by another repository, so
// a documented example that has drifted from the code is worse than no example
// at all. Every JSON block in it is parsed here and checked against what the
// pump really emits, so the document cannot rot without CI saying so.
// ---------------------------------------------------------------------------

const DOC = await readFile(join(ROOT, 'docs', 'discord-integration.md'), 'utf8');

/** Every JSON line inside a ```json fence, parsed. */
const DOCUMENTED = [...DOC.matchAll(/```json\n([\s\S]*?)```/g)]
  .flatMap((match) => match[1].split('\n'))
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

/** Keys, recursively, with values flattened away — the part that is binding. */
function shapeOf(value) {
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0])] : [];
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shapeOf(value[k])]));
  }
  return 'leaf';
}

function keysDeep(value, out = new Set()) {
  if (Array.isArray(value)) { for (const item of value) keysDeep(item, out); return out; }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) { out.add(key); keysDeep(child, out); }
  }
  return out;
}

/** One of every type, as the pump actually puts it on the wire. */
function everyEventType() {
  const opened = FakeSocket.made.length;
  const { pump } = pumped();
  const state = seated();
  pump.observe(spectatorOf(state));                       // game.opened
  const socket = FakeSocket.made[opened];
  socket.open();

  const step = (change) => { change(state); pump.observe(spectatorOf(state)); };
  step((s) => { s.phase = { turn: 1, name: 'team', endsAt: 60, paused: false, pausedRemainingMs: null }; });
  step((s) => { s.seats.s3 = seat('s3', 'Cerdic', null); });
  step((s) => { s.seats.s3.connected = false; });
  step((s) => { s.seats.s3.connected = true; });
  step((s) => { s.seats.s3.roleId = 'king_alfred'; });
  step((s) => { s.shires.lindsey.stewardRoleId = 'halfdan_ragnarsson'; });
  step((s) => { s.battle.targets = ['lindsey', 'essex']; });

  const byType = new Map();
  for (const event of socket.lines()) if (!byType.has(event.type)) byType.set(event.type, event);
  return byType;
}

describe('docs/discord-integration.md', () => {
  const emitted = everyEventType();

  it('produces every documented example, and documents every produced type', () => {
    expect([...emitted.keys()].sort()).toEqual([...EVENT_TYPES].sort());
    expect([...new Set(DOCUMENTED.map((e) => e.type))].sort()).toEqual([...EVENT_TYPES].sort());
    for (const type of EVENT_TYPES) expect(DOC).toContain(`### \`${type}\``);
  });

  it('shows every example in the envelope the pump writes', () => {
    expect(DOCUMENTED.length).toBeGreaterThanOrEqual(EVENT_TYPES.length);
    for (const example of DOCUMENTED) {
      expect(Object.keys(example)).toEqual(ENVELOPE_KEYS);
      expect(example.v).toBe(PUMP_SCHEMA_VERSION);
    }
    expect(DOC).toContain(`Currently \`${PUMP_SCHEMA_VERSION}\``);
  });

  it('shows every example with the keys the pump really sends', () => {
    for (const example of DOCUMENTED) {
      expect(shapeOf(example)).toEqual(shapeOf(emitted.get(example.type)));
    }
  });

  it('shows no key the pump is not allowed to carry', () => {
    // A documented example is the thing another repository codes against, so a
    // private field appearing in one would be a leak with a specification.
    const forbidden = ['token', 'seatByToken', 'silver', 'food', 'soldiers', 'ships',
      'momentum', 'wounds', 'mercenary', 'tactic', 'rolls', 'declared', 'envoys',
      'concessions', 'facilitatorNotes', 'battleNotes', 'seed', 'rngCursor', 'log',
      'lastSeen', 'brief'];
    for (const example of [...DOCUMENTED, ...emitted.values()]) {
      for (const key of keysDeep(example)) expect(forbidden).not.toContain(key);
    }
  });

  it('gives enable instructions the code actually accepts', () => {
    const shown = [...DOC.matchAll(/host\.html\?(events=[^\s`)]+)/g)].map((m) => m[1]);
    expect(shown.length).toBeGreaterThan(0);
    for (const query of shown) expect(pumpUrlFrom({ search: `?${query}` })).not.toBe(null);
  });
});
