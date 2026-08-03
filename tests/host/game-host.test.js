import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadData } from '../helpers/load-data.js';
import { GameHost } from '../../gui/host/game-host.js';
import { Persistence, parseSave, saveFilename } from '../../gui/host/persistence.js';
import { HostPeer } from '../../gui/net/host-peer.js';
import { ConnectionManager } from '../../gui/net/connection-manager.js';
import { peerIdForCode } from '../../gui/net/join-code.js';
import { identify, command, VIEW, RESULT } from '../../gui/net/wire.js';
import { Peer, createBroker, settle } from '../fakes/peerjs-shim.js';

const data = await loadData();
const CODE = 'RAVEN7Z';
const PIN = '424242';

const newHost = (overrides = {}) =>
  GameHost.create({ joinCode: CODE, seed: 42, data, now: () => 1000, ...overrides });

describe('seating', () => {
  it('gives a token a seat, and gives the same token the same seat back', () => {
    const host = newHost();
    const first = host.identify({ token: 'tok-a', name: 'Alice' });
    expect(first.id).toBe('s1');

    // A refresh: same token, new connection, same chair.
    const again = host.identify({ token: 'tok-a', name: 'Alice' });
    expect(again.id).toBe('s1');
    expect(Object.keys(host.state.seats)).toHaveLength(1);
  });

  it('keeps the chair when someone drops', () => {
    const host = newHost();
    host.identify({ token: 'tok-a', name: 'Alice' });
    host.submit(host.state.seats.s1, { verb: 'claim-role', payload: { roleId: 'cenred' } });
    host.disconnect('s1');

    expect(host.state.seats.s1.connected).toBe(false);
    // The role is still theirs, so nobody else can take it out from under them
    // while they are restarting their browser.
    expect(host.state.seats.s1.roleId).toBe('cenred');
    expect(host.vacantRoles()).toContain('cenred');   // ...unless a facilitator says so
  });

  it('promotes a player who turns out to hold the PIN, and takes their role back', () => {
    const host = newHost();
    host.identify({ token: 'tok-a', name: 'Alice' });
    host.submit(host.state.seats.s1, { verb: 'claim-role', payload: { roleId: 'cenred' } });
    const promoted = host.identify({ token: 'tok-a', name: 'Alice', wantsFacilitator: true });

    expect(promoted.kind).toBe('facilitator');
    expect(promoted.roleId).toBe(null);
    expect(host.vacantRoles()).toContain('cenred');
  });

  it('turns away a seventeenth player but never a facilitator', () => {
    const host = newHost();
    for (let i = 0; i < 16; i++) host.identify({ token: `tok-${i}`, name: `p${i}` });
    expect(host.identify({ token: 'tok-late', name: 'Late' })).toBe(null);
    expect(host.identify({ token: 'tok-f', name: 'Umpire', wantsFacilitator: true })).not.toBe(null);
  });

  it('never puts a token in the roster', () => {
    const host = newHost();
    host.identify({ token: 'tok-secret', name: 'Alice' });
    expect(JSON.stringify(host.roster())).not.toContain('tok-secret');
  });
});

describe('the pipeline', () => {
  it('carries a refusal reason back instead of changing anything', () => {
    const host = newHost();
    host.identify({ token: 'tok-a', name: 'Alice' });
    const before = host.state;
    const result = host.submit(host.state.seats.s1, { verb: 'recruit-soldiers', payload: {} });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('maintenance');
    expect(host.state).toBe(before);
  });

  it('keeps seats out of the game history', () => {
    // Seats are who is in the room, not something that happened. Keeping them
    // out of the log is what lets a save be a seed and a history rather than a
    // snapshot of who was connected at the time.
    const host = newHost();
    host.identify({ token: 'tok-a', name: 'Alice' });
    host.submit(host.state.seats.s1, { verb: 'claim-role', payload: { roleId: 'cenred' } });

    expect(host.state.log).toHaveLength(1);
    expect(JSON.stringify(host.state.log)).not.toContain('tok-a');
  });

  it('does not let the reducer clone strand the live seats', () => {
    // `apply` deep-clones, so without carrying the live seat objects across,
    // the transport would go on holding references to seats the host had
    // replaced — and a role claim would appear to work and then vanish.
    const host = newHost();
    const seat = host.identify({ token: 'tok-a', name: 'Alice' });
    host.submit(seat, { verb: 'claim-role', payload: { roleId: 'cenred' } });
    expect(host.state.seats.s1).toBe(seat);
    expect(seat.roleId).toBe('cenred');
  });
});

describe('projections', () => {
  it('gives a player their own brief and nobody else’s resources', () => {
    const host = newHost();
    const alice = host.identify({ token: 'tok-a', name: 'Alice' });
    host.submit(alice, { verb: 'claim-role', payload: { roleId: 'king_alfred' } });

    const seen = host.viewFor(alice);
    expect(seen.brief.goals.length).toBeGreaterThan(0);
    expect(seen.roles.king_alfred.silver).toBe(4);
    expect(seen.roles.guthrum_the_old.silver).toBeUndefined();
  });

  it('gives a facilitator everything', () => {
    const host = newHost();
    const umpire = host.identify({ token: 'tok-f', name: 'F', wantsFacilitator: true });
    const seen = host.viewFor(umpire);
    expect(seen.roles.guthrum_the_old.silver).toBe(8);
    expect(seen.seed).toBe(42);
  });
});

describe('saving and restoring', () => {
  it('round-trips a game through a save', () => {
    const host = newHost();
    const alice = host.identify({ token: 'tok-a', name: 'Alice' });
    host.submit(alice, { verb: 'claim-role', payload: { roleId: 'king_alfred' } });
    const umpire = host.identify({ token: 'tok-f', name: 'F', wantsFacilitator: true });
    host.submit(umpire, { verb: 'facilitator:advance-phase', payload: {} });

    const { host: restored, refused } = GameHost.restore({ save: host.save(), data });
    expect(refused).toEqual([]);
    expect(restored.state.phase.name).toBe('team');
    expect(restored.state.log).toHaveLength(2);
  });

  it('reports what a save could no longer do rather than swallowing it', () => {
    // A log that stops replaying means the rules moved under a save. A
    // facilitator about to run a game on it should hear that before the
    // players arrive, not during.
    const host = newHost();
    const save = host.save();
    save.log = [...save.log, {
      seq: 1, ts: 0, seatId: 's1', roleId: 'king_alfred',
      verb: 'recruit-soldiers', payload: {}, rngCursorBefore: 0, override: false,
    }];
    const { refused } = GameHost.restore({ save, data });
    expect(refused).toHaveLength(1);
    expect(refused[0].verb).toBe('recruit-soldiers');
  });

  it('keeps the facilitator PIN across a restart', () => {
    // Minting a fresh PIN on every host restart would lock out the
    // co-facilitator, who is on another machine and has no way to learn the
    // new one except by being told — at exactly the moment everyone is busy
    // working out what just happened.
    const host = GameHost.create({ joinCode: CODE, seed: 42, data, facilitatorPin: '424242' });
    const { host: restored } = GameHost.restore({ save: host.save(), data });
    expect(restored.facilitatorPin).toBe('424242');
  });

  it('leaves the PIN unset for a save made before PINs were kept', () => {
    // So the host can tell the difference and mint one, rather than running
    // with no facilitator access at all.
    const save = GameHost.create({ joinCode: CODE, seed: 1, data }).save();
    delete save.facilitatorPin;
    expect(GameHost.restore({ save, data }).host.facilitatorPin).toBe(null);
  });

  it('names a download so the files sort by when they were taken', () => {
    const host = newHost();
    expect(saveFilename(host.state)).toBe('raven-RAVEN7Z-t01-lobby.json');
  });

  it('refuses a file that is not a save, and says which way it is wrong', () => {
    expect(parseSave('not json')).toMatchObject({ ok: false });
    expect(parseSave('{"seed":1,"log":[]}').reason).toContain('join code');
    expect(parseSave('{"joinCode":"X","log":[]}').reason).toContain('seed');
    expect(parseSave('{"joinCode":"X","seed":1}').reason).toContain('history');
    expect(parseSave(JSON.stringify(newHost().save())).ok).toBe(true);
  });
});

describe('autosave', () => {
  /** Just enough Storage to be a Storage. */
  function fakeStorage() {
    const map = new Map();
    return {
      map,
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => map.set(k, v),
      removeItem: (k) => map.delete(k),
      key: (i) => [...map.keys()][i] ?? null,
      get length() { return map.size; },
    };
  }

  beforeEach(() => vi.useFakeTimers());

  it('collapses a burst of changes into one write', () => {
    const storage = fakeStorage();
    const persistence = new Persistence({ storage });
    const host = newHost();
    for (let i = 0; i < 5; i++) persistence.schedule(host.save());
    expect(storage.map.size).toBe(0);
    vi.advanceTimersByTime(300);
    expect(storage.map.size).toBe(1);
    vi.useRealTimers();
  });

  it('survives a full quota rather than taking the game down with it', () => {
    // The downloadable save is still there, so a failed autosave is a warning
    // to show the facilitator, not an exception to throw mid-game.
    const errors = [];
    const persistence = new Persistence({
      storage: { setItem() { throw new Error('QuotaExceededError'); }, getItem: () => null, key: () => null, length: 0 },
      onError: (e) => errors.push(e),
    });
    expect(persistence.write(newHost().save())).toBe(false);
    expect(errors).toHaveLength(1);
    expect(persistence.lastError).toBeTruthy();
    vi.useRealTimers();
  });

  it('works with no storage at all, as in a private window', () => {
    const persistence = new Persistence({ storage: null });
    expect(persistence.write(newHost().save())).toBe(false);
    expect(persistence.read(CODE)).toBe(null);
    expect(persistence.list()).toEqual([]);
    vi.useRealTimers();
  });

  it('lists games newest first and skips a corrupt entry', () => {
    const storage = fakeStorage();
    const persistence = new Persistence({ storage });
    persistence.write({ joinCode: 'AAAAAAA', seed: 1, log: [], savedAt: 100 });
    persistence.write({ joinCode: 'BBBBBBB', seed: 2, log: [], savedAt: 900 });
    storage.setItem('rbo:save:BROKEN', '{{{');
    expect(persistence.list().map((s) => s.joinCode)).toEqual(['BBBBBBB', 'AAAAAAA']);
    vi.useRealTimers();
  });
});

describe('a host that goes away mid-game', () => {
  beforeEach(() => createBroker());

  it('comes back to the same room code, and everyone reconnects into their seats', async () => {
    // The riskiest thing in the whole build, exercised before anything is
    // stacked on top of it: the tab holding the only copy of the game is
    // refreshed while people are playing.
    vi.useFakeTimers();
    const storage = new Map();
    const persistence = new Persistence({
      storage: {
        getItem: (k) => storage.get(k) ?? null,
        setItem: (k, v) => storage.set(k, v),
        removeItem: (k) => storage.delete(k),
        key: (i) => [...storage.keys()][i] ?? null,
        get length() { return storage.size; },
      },
    });

    /** Stand up a host tab over the transport. */
    const openHostTab = (host) => {
      const peer = new HostPeer({
        joinCode: CODE,
        facilitatorPin: PIN,
        Peer,
        onIdentify: (args) => host.identify(args),
        onCommand: (seat, cmd) => host.submit(seat, cmd),
        viewFor: (seat) => host.viewFor(seat),
      });
      host._onChange = () => { persistence.write(host.save()); peer.broadcast(); };
      peer.start();
      return peer;
    };

    let host = newHost({ now: () => 1000 });
    let peer = openHostTab(host);
    await settle();

    // Two players join and claim roles.
    const clients = ['tok-a', 'tok-b'].map((token, i) => {
      const received = [];
      const manager = new ConnectionManager({ Peer });
      manager.connect(peerIdForCode(CODE), {
        onData: (m) => received.push(m),
        getIdent: () => identify({ token, name: `p${i}` }),
      });
      return { token, manager, received };
    });
    await settle();

    clients[0].manager.send(command('claim-role', { roleId: 'king_alfred' }, 1));
    clients[1].manager.send(command('claim-role', { roleId: 'guthrum_the_old' }, 1));
    await settle();
    expect(host.state.seats.s1.roleId).toBe('king_alfred');
    expect(host.state.seats.s2.roleId).toBe('guthrum_the_old');
    expect(storage.size).toBe(1);

    // --- the facilitator's tab dies -----------------------------------------
    peer.stop();
    await settle();
    for (const c of clients) c.received.length = 0;

    // --- and reopens, restoring from what was autosaved ----------------------
    const save = persistence.read(CODE);
    expect(save).not.toBe(null);
    const restored = GameHost.restore({ save, data, now: () => 2000 });
    expect(restored.refused).toEqual([]);
    host = restored.host;
    peer = openHostTab(host);
    await settle();

    // Nobody pressed anything: the clients were already retrying the address
    // derived from the join code, and the host reclaimed it.
    await vi.advanceTimersByTimeAsync(1000);
    await settle();

    expect(peer.connections.size).toBe(2);
    // Same tokens, so the same seats, so the same roles.
    expect(host.state.seats.s1.roleId).toBe('king_alfred');
    expect(host.state.seats.s2.roleId).toBe('guthrum_the_old');
    const alfred = clients[0].received.filter((m) => m.type === VIEW).at(-1);
    expect(alfred.data.viewer.roleId).toBe('king_alfred');
    expect(alfred.data.brief.goals.length).toBeGreaterThan(0);

    // And the game carries on from where it was.
    clients[0].manager.send(command('claim-role', { roleId: 'cenred' }, 2));
    await settle();
    expect(host.state.seats.s1.roleId).toBe('cenred');
    const answers = clients[0].received.filter((m) => m.type === RESULT);
    expect(answers.at(-1).data.ok).toBe(true);

    peer.stop();
    vi.useRealTimers();
  });
});
