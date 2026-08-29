import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MessageKind } from './harnessBridge';
import {
  LOCAL_SAVE_QUOTA_ERROR,
  paintQuotaAfterRebuild,
  pushHostQuotaError,
  tryLocalSave,
  type QuotaWarnFlag,
} from './hostQuotaError';
import { createEmptySession, type SessionStore } from './sessionStore';

function mockBridge() {
  return { pushMessage: vi.fn() };
}

function quotaStore(): SessionStore {
  const err = new Error('The quota has been exceeded.');
  err.name = 'QuotaExceededError';
  return {
    kind: 'localStorage',
    load: () => null,
    save: vi.fn(() => {
      throw err;
    }),
    clear: vi.fn(),
  };
}

describe('pushHostQuotaError', () => {
  it('first call pushes MessageKind.Error with the locked copy', () => {
    const bridge = mockBridge();
    const warned: QuotaWarnFlag = { current: false };
    pushHostQuotaError(bridge, warned);
    expect(bridge.pushMessage).toHaveBeenCalledTimes(1);
    expect(bridge.pushMessage).toHaveBeenCalledWith(MessageKind.Error, LOCAL_SAVE_QUOTA_ERROR);
    expect(warned.current).toBe(true);
  });

  it('second call no-ops until the flag is cleared', () => {
    const bridge = mockBridge();
    const warned: QuotaWarnFlag = { current: false };
    pushHostQuotaError(bridge, warned);
    pushHostQuotaError(bridge, warned);
    expect(bridge.pushMessage).toHaveBeenCalledTimes(1);
    warned.current = false;
    pushHostQuotaError(bridge, warned);
    expect(bridge.pushMessage).toHaveBeenCalledTimes(2);
  });

  it('missing bridge does not set the flag', () => {
    const warned: QuotaWarnFlag = { current: false };
    pushHostQuotaError(null, warned);
    expect(warned.current).toBe(false);
  });

  it('pushMessage throw does not escape and does not set the flag', () => {
    const bridge = {
      pushMessage: vi.fn(() => {
        throw new Error('bridge down');
      }),
    };
    const warned: QuotaWarnFlag = { current: false };
    expect(() => pushHostQuotaError(bridge, warned)).not.toThrow();
    expect(warned.current).toBe(false);
  });
});

describe('tryLocalSave', () => {
  it('successful save clears the once-flag', () => {
    const store: SessionStore = {
      kind: 'memory',
      load: () => null,
      save: vi.fn(),
      clear: vi.fn(),
    };
    const bridge = mockBridge();
    const warned: QuotaWarnFlag = { current: true };
    expect(tryLocalSave(store, createEmptySession('s'), bridge, warned)).toBe(false);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(warned.current).toBe(false);
    expect(bridge.pushMessage).not.toHaveBeenCalled();
  });

  it('quota throw paints once and does not rethrow', () => {
    const store = quotaStore();
    const bridge = mockBridge();
    const warned: QuotaWarnFlag = { current: false };
    expect(() => tryLocalSave(store, createEmptySession('s'), bridge, warned)).not.toThrow();
    expect(bridge.pushMessage).toHaveBeenCalledTimes(1);
    expect(bridge.pushMessage).toHaveBeenCalledWith(MessageKind.Error, LOCAL_SAVE_QUOTA_ERROR);
    expect(() => tryLocalSave(store, createEmptySession('s'), bridge, warned)).not.toThrow();
    expect(bridge.pushMessage).toHaveBeenCalledTimes(1);
  });

  it('paint:false swallows quota without pushing so a later paint can still fire', () => {
    const store = quotaStore();
    const bridge = mockBridge();
    const warned: QuotaWarnFlag = { current: false };
    expect(
      tryLocalSave(store, createEmptySession('s'), bridge, warned, { paint: false }),
    ).toBe(true);
    expect(bridge.pushMessage).not.toHaveBeenCalled();
    expect(warned.current).toBe(false);
    expect(tryLocalSave(store, createEmptySession('s'), bridge, warned)).toBe(true);
    expect(bridge.pushMessage).toHaveBeenCalledTimes(1);
    expect(warned.current).toBe(true);
  });

  it('running snapshot swallows quota without pushing so a later terminal paint can still fire', () => {
    const store = quotaStore();
    const bridge = mockBridge();
    const warned: QuotaWarnFlag = { current: false };
    const running = { ...createEmptySession('s'), turnStatus: 'running' as const };
    expect(tryLocalSave(store, running, bridge, warned)).toBe(true);
    expect(bridge.pushMessage).not.toHaveBeenCalled();
    expect(warned.current).toBe(false);
    const done = { ...createEmptySession('s'), turnStatus: 'completed' as const };
    expect(tryLocalSave(store, done, bridge, warned)).toBe(true);
    expect(bridge.pushMessage).toHaveBeenCalledTimes(1);
    expect(bridge.pushMessage).toHaveBeenCalledWith(MessageKind.Error, LOCAL_SAVE_QUOTA_ERROR);
    expect(warned.current).toBe(true);
  });

  it('non-quota throw is swallowed (save already filters these)', () => {
    const err = new Error('denied');
    err.name = 'SecurityError';
    const store: SessionStore = {
      kind: 'localStorage',
      load: () => null,
      save: vi.fn(() => {
        throw err;
      }),
      clear: vi.fn(),
    };
    const bridge = mockBridge();
    const warned: QuotaWarnFlag = { current: false };
    expect(tryLocalSave(store, createEmptySession('s'), bridge, warned)).toBe(false);
    expect(bridge.pushMessage).not.toHaveBeenCalled();
    expect(warned.current).toBe(false);
  });

  it('missing store is a no-op', () => {
    const bridge = mockBridge();
    const warned: QuotaWarnFlag = { current: false };
    expect(tryLocalSave(null, createEmptySession('s'), bridge, warned)).toBe(false);
    expect(bridge.pushMessage).not.toHaveBeenCalled();
  });
});

describe('paintQuotaAfterRebuild', () => {
  it('paints after a wiped once-flag when quota fired', () => {
    const bridge = mockBridge();
    const warned: QuotaWarnFlag = { current: true };
    paintQuotaAfterRebuild(bridge, warned, true);
    expect(bridge.pushMessage).toHaveBeenCalledTimes(1);
    expect(bridge.pushMessage).toHaveBeenCalledWith(MessageKind.Error, LOCAL_SAVE_QUOTA_ERROR);
    expect(warned.current).toBe(true);
  });

  it('no-ops when quota did not fire (does not clear a live flag)', () => {
    const bridge = mockBridge();
    const warned: QuotaWarnFlag = { current: true };
    paintQuotaAfterRebuild(bridge, warned, false);
    expect(bridge.pushMessage).not.toHaveBeenCalled();
    expect(warned.current).toBe(true);
  });

  it('does not paint a running snapshot so a later terminal persist can', () => {
    const store = quotaStore();
    const bridge = mockBridge();
    const warned: QuotaWarnFlag = { current: false };
    const running = { ...createEmptySession('s'), turnStatus: 'running' as const };
    expect(tryLocalSave(store, running, bridge, warned, { paint: false })).toBe(true);
    paintQuotaAfterRebuild(bridge, warned, true, running);
    expect(bridge.pushMessage).not.toHaveBeenCalled();
    expect(warned.current).toBe(false);
    const done = { ...createEmptySession('s'), turnStatus: 'completed' as const };
    expect(tryLocalSave(store, done, bridge, warned)).toBe(true);
    expect(bridge.pushMessage).toHaveBeenCalledTimes(1);
  });
});

describe('HarnessHost wiring lock — quota save (#870)', () => {
  const src = readFileSync(
    resolve(import.meta.dirname, '..', 'app/harness/HarnessHost.tsx'),
    'utf-8',
  );

  it('three local writes go through tryLocalSave, never storeRef.save', () => {
    expect(src).not.toMatch(/storeRef\.current\?\.save\(/);
    expect(src).toContain(
      'tryLocalSave(storeRef.current, next, bridgeRef.current, localSaveQuotaWarnedRef',
    );
    expect(src).toContain(
      'tryLocalSave(storeRef.current, empty, bridge, localSaveQuotaWarnedRef, {',
    );
  });

  it('onSessionPatch persistTurn does not paint the quota Error row', () => {
    expect(src).toContain('onSessionPatch: (s) => persistTurn(s, false)');
  });

  it('post-turn persistTurn does not paint while the durable turn is still running', () => {
    expect(src).toContain("persistTurn(folded, folded.turnStatus !== 'running')");
    expect(src).toContain("persistTurn(next, next.turnStatus !== 'running')");
  });

  it('adopt and Clear rebuild the ring before painting quota', () => {
    expect(src).toContain('writeLocalSession(s, { paintQuota: false })');
    expect(src).toContain('writeLocalSession(empty, { paintQuota: false })');
    expect(src).toContain('paintQuotaAfterRebuild(');
  });
});
