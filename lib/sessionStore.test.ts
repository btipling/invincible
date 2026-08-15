import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalStorageSessionStore,
  MemorySessionStore,
  appendMessage,
  createEmptySession,
  formatPromptWithHistory,
  makeMessage,
  sanitizeAttachedSlugs,
  sanitizeSessionCwd,
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

  it('folds user/assistant/tool lines and errors for continuity', () => {
    const history = [
      makeMessage('system', 'read_file · ✓ ok · src/a.ts · 10 lines · 100 B'),
      makeMessage('user', 'ping'),
      makeMessage('assistant', 'pong'),
      makeMessage('error', 'Request cancelled.'),
    ];
    const out = formatPromptWithHistory(history, 'again');
    expect(out).toContain('User: ping');
    expect(out).toContain('Assistant: pong');
    expect(out).toContain('User: again');
    // Tool lines must fold so continue does not re-run prior work
    expect(out).toContain('Tool: read_file · ✓ ok · src/a.ts');
    expect(out).toContain('Error: Request cancelled.');
    expect(out).toMatch(/do not repeat/i);
  });

  it('keeps tool history when only system lines exist after user', () => {
    const history = [
      makeMessage('user', 'explore'),
      makeMessage('system', 'list_dir · ✓ ok · .: 3 entries'),
      makeMessage('system', 'read_file · ✓ ok · README.md · 20 lines · 400 B'),
    ];
    const out = formatPromptWithHistory(history, 'continue');
    expect(out).toContain('Tool: list_dir');
    expect(out).toContain('Tool: read_file');
    expect(out).toContain('User: continue');
  });
});

describe('session cwd', () => {
  /** Minimal localStorage stand-in for node vitest (environment: 'node'). */
  function installMemoryLocalStorage() {
    const map = new Map<string, string>();
    const ls = {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => {
        map.set(k, String(v));
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
      clear: () => {
        map.clear();
      },
    };
    vi.stubGlobal('localStorage', ls);
    return ls;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips cwd on MemorySessionStore', () => {
    const store = new MemorySessionStore();
    const s: ReturnType<typeof createEmptySession> = {
      ...appendMessage(createEmptySession('c'), 'user', 'hi'),
      cwd: 'invincible',
    };
    store.save(s);
    expect(store.load()?.cwd).toBe('invincible');
  });

  it('createEmptySession has no cwd', () => {
    const s = createEmptySession();
    expect(s.cwd).toBeUndefined();
  });

  it('appendMessage preserves cwd', () => {
    const base = { ...createEmptySession('x'), cwd: 'proj' };
    const s = appendMessage(base, 'user', 'a');
    expect(s.cwd).toBe('proj');
  });

  it('sanitizeSessionCwd drops non-string, empty, absolute, control chars', () => {
    expect(sanitizeSessionCwd(undefined)).toBeUndefined();
    expect(sanitizeSessionCwd(42)).toBeUndefined();
    expect(sanitizeSessionCwd('')).toBeUndefined();
    expect(sanitizeSessionCwd('   ')).toBeUndefined();
    expect(sanitizeSessionCwd('/etc')).toBeUndefined();
    expect(sanitizeSessionCwd('C:\\Windows')).toBeUndefined();
    expect(sanitizeSessionCwd('foo\u0000bar')).toBeUndefined();
    expect(sanitizeSessionCwd('  invincible/sub  ')).toBe('invincible/sub');
  });

  it('LocalStorage load drops non-string and poisoned cwd', () => {
    installMemoryLocalStorage();
    const key = 'test-cwd-key';
    localStorage.setItem(
      key,
      JSON.stringify({
        id: 's',
        messages: [],
        updatedAt: 1,
        cwd: 42,
      }),
    );
    const store = new LocalStorageSessionStore(key);
    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.cwd).toBeUndefined();

    localStorage.setItem(
      key,
      JSON.stringify({
        id: 's',
        messages: [],
        updatedAt: 1,
        cwd: '/etc',
      }),
    );
    expect(store.load()?.cwd).toBeUndefined();

    store.save({ id: 's2', messages: [], updatedAt: 2, cwd: 'ok' });
    expect(store.load()?.cwd).toBe('ok');
    store.clear();
    expect(store.load()).toBeNull();
  });

  it('Memory clear drops cwd', () => {
    const store = new MemorySessionStore();
    store.save({ ...createEmptySession('z'), cwd: 'x' });
    store.clear();
    expect(store.load()).toBeNull();
  });
});

describe('attachedSlugs local sanitize (review #526 re-run 3 residual)', () => {
  function installMemoryLocalStorage() {
    const map = new Map<string, string>();
    const ls = {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => {
        map.set(k, String(v));
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
      clear: () => {
        map.clear();
      },
    };
    vi.stubGlobal('localStorage', ls);
    return ls;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sanitizeAttachedSlugs keeps valid slugs, drops poison + dupes (ordered)', () => {
    expect(sanitizeAttachedSlugs(['create-plan', 'Bad Slug', 'create-plan', 'ok_1'])).toEqual([
      'create-plan',
      'ok_1',
    ]);
    expect(sanitizeAttachedSlugs(['ok'])).toEqual(['ok']);
    expect(sanitizeAttachedSlugs([])).toEqual([]);
    expect(sanitizeAttachedSlugs(undefined)).toBeUndefined();
    expect(sanitizeAttachedSlugs('nope')).toBeUndefined();
    expect(sanitizeAttachedSlugs([42])).toEqual([]);
  });

  it('LocalStorage load drops a poisoned attachedSlugs array (never mirrored raw)', () => {
    installMemoryLocalStorage();
    const key = 'test-slugs-key';
    localStorage.setItem(
      key,
      JSON.stringify({
        id: 's',
        messages: [],
        updatedAt: 1,
        attachedSlugs: ['Bad Slug', 'ok', 42],
      }),
    );
    const store = new LocalStorageSessionStore(key);
    const loaded = store.load();
    expect(loaded).not.toBeNull();
    // Invalid entries dropped; valid slug kept (not spread raw).
    expect(loaded?.attachedSlugs).toEqual(['ok']);

    // Non-array poison → sanitized to undefined (field dropped entirely).
    localStorage.setItem(
      key,
      JSON.stringify({ id: 's', messages: [], updatedAt: 1, attachedSlugs: 'Bogus Slug' }),
    );
    const loadedPoison = store.load();
    expect(loadedPoison?.attachedSlugs).toBeUndefined();
  });
});

describe('session usage local sanitize (plan #539 / #327)', () => {
  function installMemoryLocalStorage() {
    const map = new Map<string, string>();
    const ls = {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => {
        map.set(k, String(v));
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
      clear: () => {
        map.clear();
      },
    };
    vi.stubGlobal('localStorage', ls);
    return ls;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('LocalStorage load keeps a valid provider usage summary', () => {
    installMemoryLocalStorage();
    const key = 'test-usage-key';
    localStorage.setItem(
      key,
      JSON.stringify({
        id: 's',
        messages: [],
        updatedAt: 1,
        usage: { source: 'provider', prompt: 50, completion: 20, total: 70 },
      }),
    );
    const store = new LocalStorageSessionStore(key);
    expect(store.load()?.usage).toEqual({
      source: 'provider',
      prompt: 50,
      completion: 20,
      total: 70,
    });
  });

  it('LocalStorage load drops a poisoned / non-provider usage (never paints a lie)', () => {
    installMemoryLocalStorage();
    const key = 'test-usage-key';
    // Non-provider source → sanitized to undefined (field dropped → slot hides).
    localStorage.setItem(
      key,
      JSON.stringify({
        id: 's',
        messages: [],
        updatedAt: 1,
        usage: { source: 'estimated', prompt: 9000 },
      }),
    );
    const store = new LocalStorageSessionStore(key);
    expect(store.load()?.usage).toBeUndefined();

    // Absurd clamped counts over the byte cap → omitted (undefined).
    localStorage.setItem(
      key,
      JSON.stringify({
        id: 's',
        messages: [],
        updatedAt: 1,
        usage: {
          source: 'provider',
          prompt: 1e15,
          completion: 1e15,
          total: 1e15,
          cached: 1e15,
        },
      }),
    );
    expect(store.load()?.usage).toBeUndefined();

    // String / missing source → undefined.
    localStorage.setItem(
      key,
      JSON.stringify({ id: 's', messages: [], updatedAt: 1, usage: 'provider' }),
    );
    expect(store.load()?.usage).toBeUndefined();
  });

  it('Memory/Save round-trips usage', () => {
    const store = new MemorySessionStore();
    store.save({
      ...createEmptySession('x'),
      usage: { source: 'provider', prompt: 3, completion: 1 },
    });
    expect(store.load()?.usage).toEqual({
      source: 'provider',
      prompt: 3,
      completion: 1,
    });
  });
});

