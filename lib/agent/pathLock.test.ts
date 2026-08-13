import { describe, expect, it } from 'vitest';
import { PathLock, defaultPathLock } from './pathLock';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('PathLock', () => {
  it('is single-flight per path: concurrent same-path calls serialize', async () => {
    const lock = new PathLock();
    const order: number[] = [];
    const gate = deferred<void>();

    const first = lock.withPathLock('a.txt', async () => {
      order.push(1);
      await gate.promise; // hold the lock open
      order.push(3);
      return 'first';
    });
    await tick(); // first is now inside fn, holding the lock

    const secondStarted: boolean[] = [];
    const second = lock.withPathLock('a.txt', async () => {
      secondStarted.push(true);
      return 'second';
    });
    await tick();
    // Second must NOT have started while first is still holding the lock.
    expect(secondStarted).toEqual([]);

    gate.resolve();
    expect(await first).toBe('first');
    expect(await second).toBe('second');

    // Serialized: 1 (first enter), then first's tail 3, then second runs.
    expect(order).toEqual([1, 3]);
  });

  it('re-arms after each settle (same path usable again)', async () => {
    const lock = new PathLock();
    expect(await lock.withPathLock('p', async () => 'a')).toBe('a');
    expect(await lock.withPathLock('p', async () => 'b')).toBe('b');
    expect(await lock.withPathLock('p', async () => 'c')).toBe('c');
  });

  it('does not serialize across different paths', async () => {
    const lock = new PathLock();
    const started: string[] = [];
    const running: string[] = [];
    const aGate = deferred<void>();
    const bGate = deferred<void>();

    const pa = lock.withPathLock('a', async () => {
      started.push('a');
      running.push('a');
      await aGate.promise;
      running.splice(running.indexOf('a'), 1);
      return 'a';
    });
    const pb = lock.withPathLock('b', async () => {
      started.push('b');
      running.push('b');
      await bGate.promise;
      running.splice(running.indexOf('b'), 1);
      return 'b';
    });
    await tick();
    // Both are inside their fns concurrently (independent paths).
    expect(started.sort()).toEqual(['a', 'b']);
    await aGate.resolve();
    await bGate.resolve();
    await Promise.all([pa, pb]);
  });

  it('propagates a rejection from fn and releases the slot', async () => {
    const lock = new PathLock();
    const err = new Error('boom');
    const first = lock.withPathLock('x', async () => {
      throw err;
    });
    await expect(first).rejects.toThrow('boom');
    // The slot is released after a rejection — a later call can run.
    expect(await lock.withPathLock('x', async () => 'ok')).toBe('ok');
  });

  it('abort while queued fails closed and releases the slot for the next waiter', async () => {
    const lock = new PathLock();
    const gate = deferred<void>();
    let firstRan = false;
    let thirdRan = false;

    const first = lock.withPathLock('k', async () => {
      firstRan = true;
      await gate.promise;
      return 'first';
    });
    await tick(); // first holds the lock

    const controller = new AbortController();
    const second = lock.withPathLock(
      'k',
      async () => 'second',
      controller.signal,
    );
    const third = lock.withPathLock('k', async () => {
      thirdRan = true;
      return 'third';
    });
    await tick();

    // Second is queued behind first; abort it while queued.
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });

    // Release first; third (queued, not aborted) must proceed.
    gate.resolve();
    expect(await first).toBe('first');
    expect(await third).toBe('third');
    expect(firstRan).toBe(true);
    expect(thirdRan).toBe(true);
  });

  it('does not release the slot while fn is running even if signal aborts mid-run', async () => {
    const lock = new PathLock();
    const controller = new AbortController();
    const gate = deferred<void>();
    let started = false;

    const p = lock.withPathLock(
      'm',
      async () => {
        started = true;
        await gate.promise;
        return 'mid';
      },
      controller.signal,
    );
    await tick();
    // fn started and holds the lock; abort must NOT cut the slot early.
    controller.abort();
    const thirdStarted: boolean[] = [];
    const after = lock.withPathLock('m', async () => {
      thirdStarted.push(true);
      return 'after';
    });
    await tick();
    expect(thirdStarted).toEqual([]); // still blocked by running fn
    gate.resolve();
    expect(await p).toBe('mid');
    expect(await after).toBe('after');
  });

  it('defaultPathLock exposes a usable instance', async () => {
    expect(await defaultPathLock.withPathLock('q', async () => 1)).toBe(1);
    expect(await defaultPathLock.withPathLock('q', async () => 2)).toBe(2);
  });
});
