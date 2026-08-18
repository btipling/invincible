import { describe, expect, it } from 'vitest';
import { canAutoContinue } from './harnessCanAutoContinue';

describe('canAutoContinue', () => {
  const rows: Array<{
    name: string;
    inflight: boolean;
    queuedCount: number;
    hasPendingSubmit: boolean;
    want: boolean;
  }> = [
    { name: 'idle empty', inflight: false, queuedCount: 0, hasPendingSubmit: false, want: true },
    { name: 'inflight', inflight: true, queuedCount: 0, hasPendingSubmit: false, want: false },
    { name: 'queued', inflight: false, queuedCount: 1, hasPendingSubmit: false, want: false },
    { name: 'pending submit', inflight: false, queuedCount: 0, hasPendingSubmit: true, want: false },
    { name: 'queued + pending', inflight: false, queuedCount: 2, hasPendingSubmit: true, want: false },
    { name: 'inflight + queued', inflight: true, queuedCount: 3, hasPendingSubmit: false, want: false },
    { name: 'inflight + pending', inflight: true, queuedCount: 0, hasPendingSubmit: true, want: false },
    { name: 'all blocked', inflight: true, queuedCount: 4, hasPendingSubmit: true, want: false },
  ];

  for (const row of rows) {
    it(row.name, () => {
      expect(
        canAutoContinue({
          inflight: row.inflight,
          queuedCount: row.queuedCount,
          hasPendingSubmit: row.hasPendingSubmit,
        }),
      ).toBe(row.want);
    });
  }
});
