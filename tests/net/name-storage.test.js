// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadSavedName, saveName, forgetName } from '../../gui/net/name-storage.js';

beforeEach(() => { window.localStorage.clear(); });

describe('name-storage', () => {
  it('has nothing to offer before anybody has typed a name', () => {
    expect(loadSavedName()).toBe('');
  });

  it('remembers a name across the call that saved it', () => {
    saveName('Cenred');
    expect(loadSavedName()).toBe('Cenred');
  });

  it('overwrites the previous name rather than keeping both', () => {
    saveName('Cenred');
    saveName('Wenyld');
    expect(loadSavedName()).toBe('Wenyld');
  });

  it('does not save a blank name over a real one', () => {
    saveName('Cenred');
    saveName('');
    expect(loadSavedName()).toBe('Cenred');
  });

  it('degrades to a blank rather than throwing when storage is unavailable', () => {
    const brokenWindow = {
      get localStorage() { throw new Error('storage disabled'); },
    };
    expect(loadSavedName(brokenWindow)).toBe('');
    expect(() => saveName('Cenred', brokenWindow)).not.toThrow();
  });
});

describe('forgetting a name', () => {
  it('removes it, so the next load asks rather than assuming', () => {
    saveName('Cenred');
    forgetName();
    expect(loadSavedName()).toBe('');
  });

  it('is the only way to forget — a blank save never clears one', () => {
    // A blank is what an untouched field gives you, and taking that as
    // "forget me" would lose the name every time somebody tabbed past it.
    saveName('Cenred');
    saveName('');
    expect(loadSavedName()).toBe('Cenred');
    forgetName();
    expect(loadSavedName()).toBe('');
  });

  it('does not throw when storage is unavailable', () => {
    const brokenWindow = { get localStorage() { throw new Error('nope'); } };
    expect(() => forgetName(brokenWindow)).not.toThrow();
  });
});
