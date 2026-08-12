/**
 * Unit tests for the DI connection resolver (phase 1 — #440).
 * Proves the three `withConnection` paths: injected `db`, injected `connect`
 * provider, and explicit missing-wiring error (module never constructs).
 */
import { describe, expect, it, vi } from 'vitest';
import { withConnection, type TenancyConnection } from './withConnection';

describe('withConnection', () => {
  it('uses the injected db handle directly (no connect, no close)', async () => {
    const db = { id: 'db-handle' };
    const fn = vi.fn(async (d: unknown) => `ran:${(d as { id: string }).id}`);
    const out = await withConnection({ db: db as never }, fn);
    expect(out).toBe('ran:db-handle');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(db);
  });

  it('calls the connect provider and closes the connection after fn', async () => {
    const conn: TenancyConnection = {
      db: { id: 'conn-db' } as never,
      close: vi.fn(async () => {}),
    };
    const connect = vi.fn(async () => conn);
    const fn = vi.fn(async (d: unknown) => `ran:${(d as { id: string }).id}`);

    const out = await withConnection({ connect }, fn);
    expect(out).toBe('ran:conn-db');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(conn.db);
    expect(conn.close).toHaveBeenCalledTimes(1);
  });

  it('closes the connect-provided connection even when fn throws', async () => {
    const conn: TenancyConnection = {
      db: { id: 'x' } as never,
      close: vi.fn(async () => {}),
    };
    const boom = new Error('boom');
    await expect(
      withConnection({ connect: async () => conn }, async () => {
        throw boom;
      }),
    ).rejects.toThrow('boom');
    expect(conn.close).toHaveBeenCalledTimes(1);
  });

  it('throws an explicit wiring error when neither db nor connect is provided', async () => {
    await expect(withConnection({}, async () => 'x')).rejects.toThrow(
      /missing dependency: provide db or connect/,
    );
  });
});
