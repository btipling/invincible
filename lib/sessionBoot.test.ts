import { describe, expect, it, vi } from 'vitest';
import {
  bootCloudSession,
  decideInitialTarget,
  fallbackAfterGone,
  isServerMintedSessionId,
  readUrlSessionId,
  shouldAdoptBootServer,
  withUrlSessionId,
} from './sessionBoot';
import type {
  CloudCreateResult,
  CloudGetResult,
  CloudListResult,
  CloudPutResult,
  IdSessionRepository,
} from './sessionRepository';
import type { SessionSnapshot } from './sessionStore';

const idA = '11111111-1111-4111-8111-111111111111';
const idB = '22222222-2222-4222-8222-222222222222';
const idY = '33333333-3333-4333-8333-333333333333';

function empty(id: string): SessionSnapshot {
  return { id, updatedAt: 0, messages: [] };
}

function makeRepo(overrides: {
  enabled?: boolean;
  onGet?: (id: string) => Promise<CloudGetResult>;
  onCreate?: () => Promise<CloudCreateResult>;
  onList?: () => Promise<CloudListResult>;
  onPut?: (id: string, s: SessionSnapshot) => void;
  onRemove?: (id: string) => Promise<void>;
} = {}): {
  repo: IdSessionRepository;
  puts: { id: string; snap: SessionSnapshot }[];
  removed: string[];
} {
  const puts: { id: string; snap: SessionSnapshot }[] = [];
  const removed: string[] = [];
  const repo: IdSessionRepository = {
    get enabled() {
      return overrides.enabled ?? true;
    },
    async get(id) {
      return overrides.onGet ? overrides.onGet(id) : { action: 'ok', snapshot: empty(id) };
    },
    put(id, snap) {
      puts.push({ id, snap });
      overrides.onPut?.(id, snap);
    },
    async list() {
      return overrides.onList ? overrides.onList() : { action: 'ok', sessions: [] };
    },
    async create() {
      if (overrides.onCreate) return overrides.onCreate();
      return { action: 'ok', snapshot: empty(idB) };
    },
    async createFirst() {
      return overrides.onCreate ? overrides.onCreate() : { action: 'ok', snapshot: empty(idB) };
    },
    async remove(id) {
      removed.push(id);
      overrides.onRemove?.(id);
    },
  };
  return { repo, puts, removed };
}

describe('url session id helpers', () => {
  it('reads ?s= and detects server-minted vs local sess_ ids', () => {
    expect(readUrlSessionId('/harness?s=abc')).toBe('abc');
    expect(readUrlSessionId('/harness')).toBeNull();
    expect(readUrlSessionId('/harness?s=')).toBeNull();
    expect(isServerMintedSessionId(idA)).toBe(true);
    expect(isServerMintedSessionId('sess_x')).toBe(false);
    expect(isServerMintedSessionId(null)).toBe(false);
  });

  it('withUrlSessionId sets and clears ?s=', () => {
    expect(withUrlSessionId('/harness', idA)).toContain(`s=${idA}`);
    expect(readUrlSessionId(withUrlSessionId('/harness', idA))).toBe(idA);
    expect(readUrlSessionId(withUrlSessionId('/harness?s=abc', null))).toBeNull();
  });
});

describe('decideInitialTarget', () => {
  it('URL pin wins; bound local adopts; fresh local mints; repo disabled → local', () => {
    expect(decideInitialTarget({ urlId: idA, localId: null, repoEnabled: true })).toEqual({
      kind: 'pin',
      id: idA,
    });
    expect(decideInitialTarget({ urlId: null, localId: idA, repoEnabled: true })).toEqual({
      kind: 'adopt',
      id: idA,
    });
    expect(decideInitialTarget({ urlId: null, localId: 'sess_foo', repoEnabled: true })).toEqual({
      kind: 'mint',
    });
    expect(decideInitialTarget({ urlId: null, localId: null, repoEnabled: false })).toEqual({
      kind: 'local',
    });
  });
});

describe('fallbackAfterGone (never blank)', () => {
  it('falls back to a bound local id when it differs', () => {
    expect(fallbackAfterGone(idA, { localId: idB, repoEnabled: true })).toEqual({
      kind: 'adopt',
      id: idB,
    });
  });

  it('mints when there is no other bound local id', () => {
    expect(fallbackAfterGone(idA, { localId: null, repoEnabled: true })).toEqual({
      kind: 'mint',
    });
  });

  it('stays local-only when repo disabled', () => {
    expect(fallbackAfterGone(idA, { localId: 'sess_x', repoEnabled: false })).toEqual({
      kind: 'local',
    });
  });
});

describe('shouldAdoptBootServer (boot-pin LWW guard)', () => {
  const localWithDialogue = (id: string): SessionSnapshot => ({
    id,
    updatedAt: 10,
    messages: [
      { id: 'm1', role: 'user' as const, text: 'hi', at: 1 },
      { id: 'm2', role: 'assistant' as const, text: 'yo', at: 2 },
    ],
  });

  it('rejects the empty mint (updatedAt 0) over newer same-id local dialogue', () => {
    const local = localWithDialogue(idY);
    const serverEmpty = empty(idY); // the still-in-cloud create() blank row
    expect(shouldAdoptBootServer(local, serverEmpty)).toBe(false);
  });

  it('adopts when the server is genuinely newer (same id)', () => {
    const local = localWithDialogue(idY);
    const serverNewer = { ...local, updatedAt: 99, messages: [...local.messages] };
    expect(shouldAdoptBootServer(local, serverNewer)).toBe(true);
  });

  it('always adopts a different id (genuine pin/adopt of another session)', () => {
    const local = localWithDialogue(idY);
    const other = empty(idA);
    expect(shouldAdoptBootServer(local, other)).toBe(true);
  });
});

describe('bootCloudSession', () => {
  it('mints the first session when local is unbound (fresh)', async () => {
    const { repo } = makeRepo();
    const onMint = vi.fn();
    const onUrl = vi.fn();
    const result = await bootCloudSession({
      repo,
      urlId: null,
      localId: 'sess_fresh',
      onMint,
      onUrlUpdate: onUrl,
    });
    expect(result).toEqual({ kind: 'minted', id: idB });
    expect(onMint).toHaveBeenCalledWith(empty(idB), idB);
    expect(onUrl).toHaveBeenCalledWith(idB);
  });

  it('pins ?s= and adopts the server session', async () => {
    const { repo } = makeRepo({
      onGet: async (id) => ({
        action: 'ok',
        snapshot: { ...empty(id), messages: [{ id: 'm', role: 'user' as const, text: 'hi', at: 1 }] },
      }),
    });
    const onAdopt = vi.fn();
    const result = await bootCloudSession({
      repo,
      urlId: idA,
      localId: 'sess_fresh',
      onAdopt,
    });
    expect(result).toEqual({ kind: 'used', id: idA });
    expect(onAdopt).toHaveBeenCalled();
  });

  it('?s= gone (404) and no bound local → mints (never blank)', async () => {
    const { repo } = makeRepo({
      onGet: async (id) =>
        id === idA ? { action: 'notfound' } : { action: 'ok', snapshot: empty(id) },
    });
    const onMint = vi.fn();
    const result = await bootCloudSession({
      repo,
      urlId: idA,
      localId: null,
      onMint,
    });
    expect(result).toEqual({ kind: 'minted', id: idB });
    expect(onMint).toHaveBeenCalled();
  });

  it('mid-turn (deferred) mint does NOT pin ?s= to the empty row yet', async () => {
    const { repo } = makeRepo();
    const onMint = vi.fn(() => 'deferred' as const);
    const onUrl = vi.fn();
    const result = await bootCloudSession({
      repo,
      urlId: null,
      localId: 'sess_fresh',
      onMint,
      onUrlUpdate: onUrl,
    });
    expect(result).toEqual({ kind: 'minted', id: idB });
    expect(onMint).toHaveBeenCalledWith(empty(idB), idB);
    // Adversarial re-review #430: a deferred mint must NOT replaceState(?s=Y) before the
    // host has bound the id — otherwise a reload would pin the empty minted row and wipe
    // the local first-turn transcript on boot.
    expect(onUrl).not.toHaveBeenCalled();
  });

  it('?s= gone (404) → mint is also deferred (never pins the fresh row)', async () => {
    const { repo } = makeRepo({
      onGet: async () => ({ action: 'notfound' }),
    });
    const onMint = vi.fn(() => 'deferred' as const);
    const onUrl = vi.fn();
    const result = await bootCloudSession({
      repo,
      urlId: idA,
      localId: null,
      onMint,
      onUrlUpdate: onUrl,
    });
    expect(result).toEqual({ kind: 'minted', id: idB });
    expect(onUrl).not.toHaveBeenCalled();
  });

  it('bound mint DOES update the URL by default', async () => {
    const { repo } = makeRepo();
    const onUrl = vi.fn();
    const result = await bootCloudSession({
      repo,
      urlId: null,
      localId: 'sess_fresh',
      onUrlUpdate: onUrl,
    });
    expect(result).toEqual({ kind: 'minted', id: idB });
    expect(onUrl).toHaveBeenCalledWith(idB);
  });

  it('?s= gone (404) falls back to a bound local id when present', async () => {
    const { repo } = makeRepo({
      onGet: async (id) => {
        if (id === idB) {
          return {
            action: 'ok',
            snapshot: {
              ...empty(idB),
              messages: [{ id: 'm', role: 'user' as const, text: 'local', at: 1 }],
            },
          };
        }
        return { action: 'notfound' };
      },
    });
    const onAdopt = vi.fn();
    const onUrl = vi.fn();
    const result = await bootCloudSession({
      repo,
      urlId: idA,
      localId: idB,
      onAdopt,
      onUrlUpdate: onUrl,
    });
    expect(result).toEqual({ kind: 'used', id: idB });
    expect(onUrl).toHaveBeenCalledWith(idB);
  });

  it('repo disabled → local-only and clears stale ?s=', async () => {
    const { repo } = makeRepo({ enabled: false });
    const onUrl = vi.fn();
    const result = await bootCloudSession({
      repo,
      urlId: idA,
      localId: idB,
      onUrlUpdate: onUrl,
    });
    expect(result).toEqual({ kind: 'local', id: idB });
    expect(onUrl).toHaveBeenCalledWith(null);
  });

  it('adopts a bound local id on refresh (no URL)', async () => {
    const { repo } = makeRepo({
      onGet: async (id) => ({ action: 'ok', snapshot: empty(id) }),
    });
    const onAdopt = vi.fn();
    const result = await bootCloudSession({
      repo,
      urlId: null,
      localId: idA,
      onAdopt,
    });
    expect(result).toEqual({ kind: 'used', id: idA });
  });
});
