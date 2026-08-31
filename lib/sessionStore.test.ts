import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalStorageSessionStore,
  MemorySessionStore,
  appendMessage,
  createEmptySession,
  formatPromptWithHistory,
  isQuotaExceededError,
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

  it('folds Turn ended error lines so the next model sees the cap', () => {
    const history = [
      makeMessage('user', 'do the thing'),
      makeMessage('assistant', 'working'),
      makeMessage('error', 'Turn ended · error · step budget exhausted'),
    ];
    const out = formatPromptWithHistory(history, 'Continue the current turn');
    expect(out).toContain('Error: Turn ended · error · step budget exhausted');
    expect(out).toContain('User: Continue the current turn');
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

describe('selectedModel local sanitize (plan #616)', () => {
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

  it('LocalStorage load keeps a valid selectedModel id; drop-to-unset on poison', () => {
    installMemoryLocalStorage();
    const key = 'test-model-key';
    // Valid printable-ASCII catalog id round-trips.
    localStorage.setItem(
      key,
      JSON.stringify({ id: 's', messages: [], updatedAt: 1, selectedModel: 'anthropic/claude-a' }),
    );
    const store = new LocalStorageSessionStore(key);
    expect(store.load()?.selectedModel).toBe('anthropic/claude-a');

    // Poisoned values (non-string / over-length / non-printable) → undefined (drop-to-unset),
    // so a bad local pick can never pin a ghost model on reload.
    const poisoned = ['has space', 'x'.repeat(200), 42, 'with\u0007ctl'];
    for (const bad of poisoned) {
      localStorage.setItem(
        key,
        JSON.stringify({ id: 's', messages: [], updatedAt: 1, selectedModel: bad }),
      );
      const loaded = store.load();
      expect(loaded).not.toBeNull();
      expect(loaded?.selectedModel).toBeUndefined();
    }
  });

  it('MemorySessionStore round-trips selectedModel', () => {
    const store = new MemorySessionStore();
    store.save({ ...createEmptySession('z'), selectedModel: 'openai/gpt-a' });
    expect(store.load()?.selectedModel).toBe('openai/gpt-a');
  });

  it('createEmptySession omits selectedModel', () => {
    expect(createEmptySession().selectedModel).toBeUndefined();
  });
});

describe('reasoningEffort local sanitize (plan #898)', () => {
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

  it('LocalStorage load keeps a valid token; drop-to-unset on poison', () => {
    installMemoryLocalStorage();
    const key = 'test-effort-key';
    localStorage.setItem(
      key,
      JSON.stringify({ id: 's', messages: [], updatedAt: 1, reasoningEffort: 'high' }),
    );
    const store = new LocalStorageSessionStore(key);
    expect(store.load()?.reasoningEffort).toBe('high');

    const poisoned = ['has space', 'x'.repeat(33), 42, 'with\u0007ctl'];
    for (const bad of poisoned) {
      localStorage.setItem(
        key,
        JSON.stringify({ id: 's', messages: [], updatedAt: 1, reasoningEffort: bad }),
      );
      const loaded = store.load();
      expect(loaded).not.toBeNull();
      expect(loaded?.reasoningEffort).toBeUndefined();
    }
  });

  it('MemorySessionStore round-trips reasoningEffort including max', () => {
    const store = new MemorySessionStore();
    store.save({ ...createEmptySession('z'), reasoningEffort: 'max' });
    expect(store.load()?.reasoningEffort).toBe('max');
  });

  it('createEmptySession omits reasoningEffort', () => {
    expect(createEmptySession().reasoningEffort).toBeUndefined();
  });
});

describe('backend-agents A1–A3 — turn-carrier local mirror sanitize', () => {
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

  it('LocalStorage load keeps valid turnRunId/turnStatus/turnStreamCursor; drop-to-unset on poison (mirror of reserved meta)', () => {
    installMemoryLocalStorage();
    const key = 'test-turn-carriers-key';
    localStorage.setItem(
      key,
      JSON.stringify({
        id: 's',
        messages: [],
        updatedAt: 1,
        turnRunId: 'run_abc_123',
        turnStatus: 'running',
        turnStreamCursor: 7,
      }),
    );
    const store = new LocalStorageSessionStore(key);
    expect(store.load()?.turnRunId).toBe('run_abc_123');
    expect(store.load()?.turnStatus).toBe('running');
    expect(store.load()?.turnStreamCursor).toBe(7);

    // `completed` is a first-class terminal member — preserved (C15 409 stays live-only).
    localStorage.setItem(
      key,
      JSON.stringify({ id: 's', messages: [], updatedAt: 1, turnStatus: 'completed' }),
    );
    expect(store.load()?.turnStatus).toBe('completed');

    // `turnStreamCursor=0` is valid — preserved (non-vacuous).
    localStorage.setItem(
      key,
      JSON.stringify({ id: 's', messages: [], updatedAt: 1, turnStreamCursor: 0 }),
    );
    expect(store.load()?.turnStreamCursor).toBe(0);

    // Poisoned values drop to unset (never a sticky local mirror).
    localStorage.setItem(
      key,
      JSON.stringify({
        id: 's',
        messages: [],
        updatedAt: 1,
        turnRunId: 'not opaque!',
        turnStatus: 'RUNNING',
        turnStreamCursor: -1,
      }),
    );
    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.turnRunId).toBeUndefined();
    expect(loaded?.turnStatus).toBeUndefined();
    expect(loaded?.turnStreamCursor).toBeUndefined();
  });

  it('MemorySessionStore round-trips the three turn carriers', () => {
    const store = new MemorySessionStore();
    store.save({
      ...createEmptySession('z'),
      turnRunId: 'run_1',
      turnStatus: 'completed',
      turnStreamCursor: 3,
    });
    const loaded = store.load();
    expect(loaded?.turnRunId).toBe('run_1');
    expect(loaded?.turnStatus).toBe('completed');
    expect(loaded?.turnStreamCursor).toBe(3);
  });

  it('createEmptySession omits all three turn carriers', () => {
    const s = createEmptySession();
    expect(s.turnRunId).toBeUndefined();
    expect(s.turnStatus).toBeUndefined();
    expect(s.turnStreamCursor).toBeUndefined();
  });
});

describe('isQuotaExceededError', () => {
  it('is true for QuotaExceededError name', () => {
    const err = new Error('The quota has been exceeded.');
    err.name = 'QuotaExceededError';
    expect(isQuotaExceededError(err)).toBe(true);
  });

  it('is true for code 22 and 1014 even without the name', () => {
    expect(isQuotaExceededError({ code: 22 })).toBe(true);
    expect(isQuotaExceededError({ code: 1014 })).toBe(true);
  });

  it('is false for SecurityError and unrelated values', () => {
    const err = new Error('denied');
    err.name = 'SecurityError';
    expect(isQuotaExceededError(err)).toBe(false);
    expect(isQuotaExceededError({ name: 'SecurityError', code: 18 })).toBe(false);
    expect(isQuotaExceededError(null)).toBe(false);
    expect(isQuotaExceededError('quota')).toBe(false);
  });
});

describe('LocalStorageSessionStore.save quota policy', () => {
  afterEach(() => {
    // @ts-expect-error test polyfill
    delete globalThis.localStorage;
  });

  function installStorage(setItem: (key: string, value: string) => void) {
    const data = new Map<string, string>();
    globalThis.localStorage = {
      get length() {
        return data.size;
      },
      clear: () => data.clear(),
      getItem: (key: string) => data.get(key) ?? null,
      key: (index: number) => [...data.keys()][index] ?? null,
      removeItem: (key: string) => {
        data.delete(key);
      },
      setItem: (key: string, value: string) => {
        setItem(key, value);
        data.set(key, value);
      },
    };
    return data;
  }

  it('throws on QuotaExceededError and leaves the previous snapshot', () => {
    const data = installStorage((_key, value) => {
      if (value.includes('turn-2 user')) {
        const err = new Error('The quota has been exceeded.');
        err.name = 'QuotaExceededError';
        throw err;
      }
    });
    const store = new LocalStorageSessionStore('k');
    const small = appendMessage(createEmptySession('a'), 'user', 'hi');
    store.save(small);
    const running = {
      ...createEmptySession('a'),
      messages: [
        ...small.messages,
        makeMessage('user', 'turn-2 user ' + 'x'.repeat(200)),
      ],
      turnStatus: 'running' as const,
    };
    expect(() => store.save(running)).toThrow();
    expect(store.load()?.messages.some((m) => m.text.includes('turn-2 user'))).toBe(false);
    expect(data.get('k')).toBe(JSON.stringify(small));
  });

  it('swallows SecurityError', () => {
    installStorage(() => {
      const err = new Error('denied');
      err.name = 'SecurityError';
      throw err;
    });
    const store = new LocalStorageSessionStore('k');
    expect(() => store.save(createEmptySession('z'))).not.toThrow();
    expect(store.load()).toBeNull();
  });
});

