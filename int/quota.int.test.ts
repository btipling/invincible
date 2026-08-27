import { afterEach, describe, expect, it } from 'vitest';
import { LocalStorageSessionStore, makeMessage, type SessionSnapshot } from '../lib/sessionStore';

class BoundedStorage implements Storage {
  private readonly data = new Map<string, string>();
  constructor(private readonly maxChars: number) {}
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    if (value.length > this.maxChars) {
      const err = new Error('The quota has been exceeded.');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.data.set(key, value);
  }
}

const small: SessionSnapshot = {
  id: 'session-1',
  updatedAt: 1,
  messages: [makeMessage('user', 'hi'), makeMessage('assistant', 'yo')],
  turnStatus: 'completed',
};

const runningTurn2: SessionSnapshot = {
  id: 'session-1',
  updatedAt: 2,
  messages: [
    makeMessage('user', 'hi'),
    makeMessage('assistant', 'yo'),
    makeMessage('user', 'turn-2 user ' + 'x'.repeat(200)),
  ],
  turnStatus: 'running',
  turnRunId: 'wr_0000_2a3b4c5d6e7f',
};

describe('int quota (#859 row 5 silent localStorage)', () => {
  afterEach(() => {
    // @ts-expect-error test polyfill
    delete globalThis.localStorage;
  });

  function storeWithCap(): LocalStorageSessionStore {
    const cap = JSON.stringify(small).length + 10;
    globalThis.localStorage = new BoundedStorage(cap);
    const store = new LocalStorageSessionStore();
    store.save(small);
    return store;
  }

  it('truncated remainder after a failed running save is the previous snapshot', () => {
    const store = storeWithCap();
    try {
      store.save(runningTurn2);
    } catch {
      /* product may throw; remainder still must not look like a successful running save */
    }
    const loaded = store.load();
    expect(loaded?.turnStatus).toBe('completed');
    expect(loaded?.messages.some((m) => m.text.includes('turn-2 user'))).toBe(false);
  });

  it.fails('#859 row 5: quota failure is not silent', () => {
    const store = storeWithCap();
    expect(() => store.save(runningTurn2)).toThrow();
  });
});
