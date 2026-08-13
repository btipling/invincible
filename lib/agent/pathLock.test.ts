import { describe, expect, it } from 'vitest';
import { PathLock, defaultPathLock, lockKey } from './pathLock';

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

  it('keeps the chain alive when the only queued waiter aborts (no concurrent entry)', async () => {
    // Reproduces the reviewer's Major on #481: holder in `fn`, abort the *only*
    // waiter (the tail), then a *new* arriver must NOT enter `fn` until the
    // holder returns. Previously the abort deleted the tail, so the new arriver
    // saw `prev = resolve()` and started inside the holder's critical section.
    const lock = new PathLock();
    const gate = deferred<void>();
    const order: number[] = [];
    let thirdStarted = false;

    const first = lock.withPathLock('k', async () => {
      order.push(1);
      await gate.promise;
      order.push(3);
      return 'first';
    });
    await tick(); // first holds the lock

    const controller = new AbortController();
    const second = lock.withPathLock(
      'k',
      async () => 'second',
      controller.signal,
    );
    await tick(); // second is the sole waiter queued behind first

    controller.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });

    // A new arriver after the abort must stay blocked while first holds the lock.
    const third = lock.withPathLock('k', async () => {
      thirdStarted = true;
      return 'third';
    });
    await tick();
    expect(thirdStarted).toBe(false); // must NOT enter until first returns

    gate.resolve();
    expect(await first).toBe('first');
    expect(await third).toBe('third');
    expect(thirdStarted).toBe(true);
    // Serialized: first enters (1), first tails (3), then third runs — never
    // interleaved inside first's critical section.
    expect(order).toEqual([1, 3]);
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

  it('lockKey namespaces by root: same path under different roots do not serialize', async () => {
    const lock = new PathLock();
    const started: string[] = [];
    const running: string[] = [];
    const gate = deferred<void>();
    const keyA = lockKey('/workspace/tenant-a', 'README.md');
    const keyB = lockKey('/workspace/tenant-b', 'README.md');
    expect(keyA).not.toBe(keyB);

    const pa = lock.withPathLock(keyA, async () => {
      started.push('a');
      running.push('a');
      await gate.promise;
      running.splice(running.indexOf('a'), 1);
      return 'a';
    });
    const pb = lock.withPathLock(keyB, async () => {
      started.push('b');
      running.push('b');
      await gate.promise;
      running.splice(running.indexOf('b'), 1);
      return 'b';
    });
    await tick();
    // Distinct roots → the same relative path runs concurrently (no HoL block).
    expect(started.sort()).toEqual(['a', 'b']);
    expect(running.length).toBe(2);
    await gate.resolve();
    await Promise.all([pa, pb]);
  });

  it('lockKey collapses null/empty root to a stable fallback domain', async () => {
    expect(lockKey(null, 'x')).toBe('<no-root>::x');
    expect(lockKey('', 'x')).toBe('<no-root>::x');
    expect(lockKey(undefined, 'x')).toBe('<no-root>::x');
  });
});
