import { describe, expect, it, vi } from 'vitest';
import { MessageKind } from './harnessBridge';
import {
  LOCAL_SAVE_QUOTA_ERROR,
  pushHostQuotaError,
  tryLocalSave,
  type QuotaWarnFlag,
} from './hostQuotaError';
import { createEmptySession, type SessionStore } from './sessionStore';

function mockBridge() {
  return { pushMessage: vi.fn() };
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
    tryLocalSave(store, createEmptySession('s'), bridge, warned);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(warned.current).toBe(false);
    expect(bridge.pushMessage).not.toHaveBeenCalled();
  });

  it('quota throw paints once and does not rethrow', () => {
    const err = new Error('The quota has been exceeded.');
    err.name = 'QuotaExceededError';
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
    expect(() => tryLocalSave(store, createEmptySession('s'), bridge, warned)).not.toThrow();
    expect(bridge.pushMessage).toHaveBeenCalledTimes(1);
    expect(bridge.pushMessage).toHaveBeenCalledWith(MessageKind.Error, LOCAL_SAVE_QUOTA_ERROR);
    expect(() => tryLocalSave(store, createEmptySession('s'), bridge, warned)).not.toThrow();
    expect(bridge.pushMessage).toHaveBeenCalledTimes(1);
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
    expect(() => tryLocalSave(store, createEmptySession('s'), bridge, warned)).not.toThrow();
    expect(bridge.pushMessage).not.toHaveBeenCalled();
    expect(warned.current).toBe(false);
  });

  it('missing store is a no-op', () => {
    const bridge = mockBridge();
    const warned: QuotaWarnFlag = { current: false };
    tryLocalSave(null, createEmptySession('s'), bridge, warned);
    expect(bridge.pushMessage).not.toHaveBeenCalled();
  });
});
