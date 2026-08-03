import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalStorageSessionStore,
  MemorySessionStore,
  appendMessage,
  createEmptySession,
  formatPromptWithHistory,
  makeMessage,
} from './sessionStore';

describe('createEmptySession / appendMessage', () => {
  it('starts empty and appends with ids', () => {
    let s = createEmptySession('fixed');
    expect(s.id).toBe('fixed');
    expect(s.messages).toHaveLength(0);
    s = appendMessage(s, 'user', 'hi');
    s = appendMessage(s, 'assistant', 'hello');
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(s.messages[0]!.text).toBe('hi');
    expect(s.messages[0]!.id).toMatch(/^m_/);
  });
});

describe('MemorySessionStore', () => {
  it('round-trips save/load/clear', () => {
    const store = new MemorySessionStore();
    expect(store.load()).toBeNull();
    const s = appendMessage(createEmptySession('a'), 'user', 'x');
    store.save(s);
    const loaded = store.load();
    expect(loaded?.messages[0]?.text).toBe('x');
    // clone isolation
    loaded!.messages[0]!.text = 'mutated';
    expect(store.load()?.messages[0]?.text).toBe('x');
    store.clear();
    expect(store.load()).toBeNull();
  });
});

describe('LocalStorageSessionStore', () => {
  afterEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  it('persists when localStorage exists', () => {
    // vitest node has no localStorage by default — skip soft if missing
    if (typeof localStorage === 'undefined') {
      // jsdom not installed; verify class still constructs
      const store = new LocalStorageSessionStore('t');
      expect(store.kind).toBe('localStorage');
      expect(store.load()).toBeNull();
      return;
    }
    const store = new LocalStorageSessionStore('test-key');
    store.save(appendMessage(createEmptySession('b'), 'assistant', 'pong'));
    expect(store.load()?.messages[0]?.text).toBe('pong');
    store.clear();
    expect(store.load()).toBeNull();
  });
});

describe('formatPromptWithHistory', () => {
  it('returns bare prompt when no history', () => {
    expect(formatPromptWithHistory([], 'hello')).toBe('hello');
  });

  it('folds recent user/assistant turns', () => {
    const history = [
      makeMessage('system', 'ignore me'),
      makeMessage('user', 'ping'),
      makeMessage('assistant', 'pong'),
      makeMessage('error', 'nope'),
    ];
    const out = formatPromptWithHistory(history, 'again');
    expect(out).toContain('User: ping');
    expect(out).toContain('Assistant: pong');
    expect(out).toContain('User: again');
    expect(out).not.toContain('ignore me');
    expect(out).not.toContain('nope');
  });
});
