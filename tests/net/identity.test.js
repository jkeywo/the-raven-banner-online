import { describe, it, expect, beforeEach } from 'vitest';
import {
  mintJoinCode, isValidJoinCode, normaliseJoinCode, peerIdForCode,
  codeFromLocation, playerLink, mintFacilitatorPin, CODE_ALPHABET, PROTOCOL,
} from '../../gui/net/join-code.js';
import {
  decideToken, pruneRegistry, isClaimedByOtherTab, mintToken,
} from '../../gui/net/session-token.js';
import { nextBackoffDelay } from '../../gui/net/backoff.js';
import { sendCommand, nextSeq, __resetSequence } from '../../gui/net/command-gateway.js';
import { identify, command, parse, encode, COMMAND } from '../../gui/net/wire.js';

/** Deterministic stand-in for Math.random. */
const cycle = (values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe('join codes', () => {
  it('mints codes that validate, over many draws', () => {
    const random = cycle([0.01, 0.37, 0.62, 0.19, 0.88, 0.44, 0.71, 0.05]);
    for (let i = 0; i < 200; i++) {
      const code = mintJoinCode(random);
      expect(code, code).toHaveLength(7);
      expect(isValidJoinCode(code), code).toBe(true);
    }
  });

  it('leaves out the characters people mishear', () => {
    // O/0 and I/1 cost a minute every time a code is read out over voice.
    for (const c of ['O', '0', 'I', '1']) expect(CODE_ALPHABET).not.toContain(c);
  });

  it('catches a typo and a transposition', () => {
    const code = mintJoinCode(cycle([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]));
    const swapped = code[1] + code[0] + code.slice(2);
    expect(isValidJoinCode(code)).toBe(true);
    expect(isValidJoinCode(swapped)).toBe(false);
    expect(isValidJoinCode(`${code.slice(0, 5)}Z${code[6]}`)).toBe(false);
  });

  it('tidies what someone types without guessing at what they meant', () => {
    // Case and spacing only: what was typed is what gets validated.
    expect(normaliseJoinCode(' raven 7z ')).toBe('RAVEN7Z');
    expect(normaliseJoinCode('raven-7z')).toBe('RAVEN7Z');
    // A code containing O was misheard. Silently turning it into some other
    // letter could produce a different code that is also valid, and send them
    // confidently into the wrong game.
    expect(isValidJoinCode(normaliseJoinCode('ROVEN7Q'))).toBe(false);
  });

  it('derives the host address from the code, and versions it', () => {
    expect(peerIdForCode('RAVEN7Z')).toBe(`${PROTOCOL}-raven7z`);
    // The prefix is what stops a stale client reaching a host that has changed
    // the wire format — a clean failure to connect beats a silent disagreement.
    expect(peerIdForCode('RAVEN7Z').startsWith('rbo1-')).toBe(true);
  });

  it('reads a code out of a link, and refuses a broken one', () => {
    expect(isValidJoinCode('RAVEN7Z')).toBe(true);   // the check character is Z, not Q
    expect(codeFromLocation({ hash: '#RAVEN7Z' })).toBe('RAVEN7Z');
    expect(codeFromLocation({ hash: '#RAVEN7Q' })).toBe(null);
    expect(codeFromLocation({ hash: '#NOPE' })).toBe(null);
    expect(codeFromLocation({})).toBe(null);
  });

  it('builds a player link that points away from the host page', () => {
    const link = playerLink(
      { origin: 'https://example.test', pathname: '/rb/host.html' }, 'RAVEN7Z');
    expect(link).toBe('https://example.test/rb/index.html#RAVEN7Z');
  });

  it('mints a six-digit facilitator PIN', () => {
    const pin = mintFacilitatorPin(() => 0.5);
    expect(pin).toMatch(/^\d{6}$/);
  });
});

describe('seat tokens', () => {
  it('reuses this tab’s own token on a reload', () => {
    expect(decideToken({
      tabToken: 'mine', tabTokenClaimed: false, sharedToken: 'shared',
      sharedClaimed: false, freshToken: 'fresh',
    })).toEqual({ token: 'mine', storeAsTab: false, storeAsShared: false });
  });

  it('adopts the persistent token when no other tab holds it', () => {
    // The single-laptop case: a full browser restart still lands in the same
    // chair.
    expect(decideToken({
      tabToken: null, sharedToken: 'shared', sharedClaimed: false, freshToken: 'fresh',
    })).toEqual({ token: 'shared', storeAsTab: true, storeAsShared: false });
  });

  it('mints a new token for a second tab rather than clobbering the first', () => {
    // Without this, two consoles on one laptop share an identity, the host
    // routes everything to whichever spoke last, and the other becomes a
    // ghost whose taps succeed and show nothing.
    expect(decideToken({
      tabToken: null, sharedToken: 'shared', sharedClaimed: true, freshToken: 'fresh',
    })).toEqual({ token: 'fresh', storeAsTab: true, storeAsShared: false });
  });

  it('seeds the persistent slot only when it is empty', () => {
    expect(decideToken({
      tabToken: null, sharedToken: null, sharedClaimed: false, freshToken: 'fresh',
    })).toEqual({ token: 'fresh', storeAsTab: true, storeAsShared: true });
  });

  it('keeps a reloading tab’s token even when the registry still lists it', () => {
    // The tab's own heartbeat is what makes it look claimed; a reload must not
    // be mistaken for a rival.
    expect(decideToken({
      tabToken: 'mine', tabTokenClaimed: true, isReload: true,
      sharedToken: 's', sharedClaimed: false, freshToken: 'fresh',
    }).token).toBe('mine');
  });

  it('expires registry entries rather than relying on cleanup', () => {
    // Mobile browsers do not reliably run unload handlers, so liveness has to
    // time out on its own.
    const registry = { a: { token: 'x', ts: 1000 }, b: { token: 'y', ts: 9000 } };
    expect(Object.keys(pruneRegistry(registry, 10_000, 6000))).toEqual(['b']);
    expect(isClaimedByOtherTab(registry, 'x', 'me', 10_000, 6000)).toBe(false);
    expect(isClaimedByOtherTab(registry, 'y', 'me', 10_000, 6000)).toBe(true);
    expect(isClaimedByOtherTab(registry, 'y', 'b', 10_000, 6000)).toBe(false);
  });

  it('mints 32 hex characters', () => {
    const token = mintToken((array) => array.fill(0xab));
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('backoff', () => {
  it('doubles and then holds at the cap', () => {
    expect([0, 1, 2, 3].map((n) => nextBackoffDelay(n))).toEqual([100, 200, 400, 800]);
    expect(nextBackoffDelay(50)).toBe(30_000);
    // A negative attempt should not produce a sub-millisecond hot loop.
    expect(nextBackoffDelay(-5)).toBe(100);
  });
});

describe('the wire', () => {
  it('refuses to build a malformed command', () => {
    expect(() => command('', {}, 1)).toThrow(/verb/);
    expect(() => command('trade', {}, 'one')).toThrow(/sequence/);
    expect(() => identify({ token: '', name: 'x' })).toThrow(/token/);
  });

  it('returns null for junk rather than throwing at the receiver', () => {
    expect(parse('not json')).toBe(null);
    expect(parse('{"no":"type"}')).toBe(null);
    expect(parse(encode(command('trade', { give: 'food' }, 3)))).toMatchObject({ type: COMMAND });
  });
});

describe('the command gateway', () => {
  beforeEach(__resetSequence);

  it('numbers commands monotonically', () => {
    const transport = { send: () => true };
    const a = sendCommand('trade', { give: 'food' }, transport);
    const b = sendCommand('trade', { give: 'food' }, transport);
    expect(a.envelope.data.seq).toBe(1);
    expect(b.envelope.data.seq).toBe(2);
    expect(a.sent && b.sent).toBe(true);
  });

  it('never restarts the count, so a resend stays a duplicate', () => {
    // The host drops anything at or below the last sequence from a seat. If
    // the client restarted numbering on reconnect, a replayed command would
    // look new and be applied twice.
    sendCommand('trade', {}, { send: () => true });
    const before = nextSeq();
    sendCommand('trade', {}, { send: () => false });
    expect(nextSeq()).toBeGreaterThan(before);
  });

  it('still hands back the envelope when there is nowhere to send it', () => {
    // A console needs something to show as pending between a drop and a
    // reconnect, rather than the press appearing to do nothing.
    const { envelope, sent } = sendCommand('trade', { give: 'food' });
    expect(sent).toBe(false);
    expect(envelope.data.verb).toBe('trade');
  });
});
