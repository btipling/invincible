import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_STREAM_CONTENT_TYPE } from '../../../../../lib/agent/agentStream';
import { TURNS_FIXTURE_SSE } from '../../../../../lib/workflows/turnsFixtureEvents';

/**
 * backend-agents B spike (plan #787): unit tests for the resumable GET
 * /api/turns/:runId/stream. Mocks `workflow/api` (`getRun`) — no real run here.
 *
 * Reconnect proof (DoD rows 6+7): POST → capture `runId`; abort the HTTP client
 * (simulated); the run independently reaches `completed` (client abort ≠
 * cancel — the #710 core); then GET resumes from `startIndex=0` (full history)
 * and a MID index (partial tail) and the emitted SSE sequence matches what the
 * fixture wrote. Resume semantics are asserted against the mocked
 * `getReadable({ startIndex })` contract (plan #787 test section).
 */

const ROUTE_SOURCE = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');

/** A `getReadable({ startIndex })` mock slicing the fixture chunks from that index. */
function sseReadableFrom(startIndex: number): ReadableStream<Uint8Array> {
  const chunks = TURNS_FIXTURE_SSE.slice(startIndex).map((s) => new TextEncoder().encode(s));
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
}

describe('GET /api/turns/:runId/stream?startIndex=', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock('workflow/api');
    vi.doUnmock('../../../../../lib/tenancy/session');
  });

  function mockSession(
    result:
      | { ok: true; user: { id: string; email?: string } }
      | { ok: false; response: Response },
  ) {
    vi.doMock('../../../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => result),
    }));
  }

  /** Mock `getRun` — a found run reports `completed` and slices the fixture chunks. */
  function mockFoundRun() {
    vi.doMock('workflow/api', () => ({
      getRun: vi.fn((runId: string) => ({
        runId,
        exists: Promise.resolve(true),
        status: Promise.resolve('completed'),
        getReadable: vi.fn((opts?: { startIndex?: number }) =>
          sseReadableFrom(opts?.startIndex ?? 0),
        ),
      })),
    }));
  }

  function mockNotFoundRun() {
    vi.doMock('workflow/api', () => ({
      getRun: vi.fn(() => ({
        exists: Promise.resolve(false),
        status: Promise.resolve('failed'),
      })),
    }));
  }

  async function readEvents(res: Response): Promise<unknown[]> {
    const text = await res.text();
    return text
      .split('\n\n')
      .filter((block) => block.startsWith('data: '))
      .map((block) => JSON.parse(block.slice('data: '.length)));
  }

  describe('auth + guard rails (DoD rows 1/2)', () => {
    it('unauthenticated → 401', async () => {
      vi.resetModules();
      mockSession({
        ok: false,
        response: Response.json({ error: 'Authentication required.' }, { status: 401 }),
      });
      mockFoundRun();
      const { GET } = await import('./route');
      const res = await GET(new Request('https://x/api/turns/w/stream'), {
        params: Promise.resolve({ runId: 'w' }),
      });
      expect(res.status).toBe(401);
    });

    it('missing runId → 400', async () => {
      vi.resetModules();
      mockSession({ ok: true, user: { id: 'u1' } });
      mockFoundRun();
      const { GET } = await import('./route');
      const res = await GET(new Request('https://x/api/turns//stream'), {
        params: Promise.resolve({ runId: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('unknown run (exists:false) → 404', async () => {
      vi.resetModules();
      mockSession({ ok: true, user: { id: 'u1' } });
      mockNotFoundRun();
      const { GET } = await import('./route');
      const res = await GET(new Request('https://x/api/turns/nope/stream'), {
        params: Promise.resolve({ runId: 'nope' }),
      });
      expect(res.status).toBe(404);
    });

    it('getRun throws (Workflows disabled) → 503 fail-closed', async () => {
      vi.resetModules();
      mockSession({ ok: true, user: { id: 'u1' } });
      vi.doMock('workflow/api', () => ({
        getRun: () => {
          throw new Error('Workflow feature is not enabled for this project.');
        },
      }));
      const { GET } = await import('./route');
      const res = await GET(new Request('https://x/api/turns/w/stream'), {
        params: Promise.resolve({ runId: 'w' }),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toMatch(/Vercel Workflows turns spike failed/i);
    });
  });

  describe('reconnect proof (DoD rows 6+7)', () => {
    it('startIndex=0 replays the FULL fixture event history', async () => {
      vi.resetModules();
      mockSession({ ok: true, user: { id: 'u1' } });
      mockFoundRun();
      const { GET } = await import('./route');
      const res = await GET(
        new Request('https://x/api/turns/w/stream?startIndex=0'),
        { params: Promise.resolve({ runId: 'w' }) },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain(AGENT_STREAM_CONTENT_TYPE);
      const events = await readEvents(res);
      expect(events).toHaveLength(TURNS_FIXTURE_SSE.length);
      expect(events.map((e) => (e as { type: string }).type)).toEqual([
        'text_delta',
        'reasoning_delta',
        'tool_start',
        'tool_result',
        'usage',
        'done',
      ]);
    });

    it('a MID startIndex resumes the TAIL of the history (not from the head)', async () => {
      vi.resetModules();
      mockSession({ ok: true, user: { id: 'u1' } });
      mockFoundRun();
      const { GET } = await import('./route');
      const MID = 3; // tool_result index in TURNS_FIXTURE_SSE
      const res = await GET(
        new Request(`https://x/api/turns/w/stream?startIndex=${MID}`),
        { params: Promise.resolve({ runId: 'w' }) },
      );
      expect(res.status).toBe(200);
      const events = await readEvents(res);
      expect(events.map((e) => (e as { type: string }).type)).toEqual([
        'tool_result',
        'usage',
        'done',
      ]);
    });

    it('run stays completed after a client abort (abort ≠ cancel — the #710 core)', async () => {
      vi.resetModules();
      mockSession({ ok: true, user: { id: 'u1' } });
      const runId = 'turns_run_1';
      let runStatus: 'running' | 'completed' = 'running';
      const cancel = vi.fn(async () => undefined);

      // ONE shared run: start() (POST) returns it and getRun(runId) (GET)
      // resolves to it — exposing a LIVE status the test can poll + a `cancel`
      // spy. The `completed` transition is DRIVEN BY THE WORKFLOW'S OWN return
      // value (the mocked `turnsFixtureWorkflow` resolves `{status:'completed'}`
      // when it finishes, and POST's `start` awaits it), NOT by the test
      // assigning `status` — so the status expectation is load-bearing on the
      // workflow completing, never a test self-write. The load-bearing
      // abort≠cancel proof is the `cancel` spy: a later change that cancels the
      // Workflow on HTTP abort does NOT await `start`, so the run stays
      // `running` and this test now fails on the status poll.
      const mockWorkflow = {
        turnsFixtureWorkflow: vi.fn(async () => {
          runStatus = 'completed';
          return { status: 'completed' } as const;
        }),
      };
      vi.doMock('../../../../../lib/workflows/turnsFixtureWorkflow', () => mockWorkflow);
      const mockRun = {
        runId,
        readable: sseReadableFrom(0),
        exists: Promise.resolve(true),
        get status() {
          return Promise.resolve(runStatus);
        },
        cancel,
        getReadable: (opts?: { startIndex?: number }) =>
          sseReadableFrom(opts?.startIndex ?? 0),
      };
      vi.doMock('workflow/api', () => ({
        start: vi.fn(async () => {
          await mockWorkflow.turnsFixtureWorkflow();
          return mockRun;
        }),
        getRun: vi.fn(() => mockRun),
      }));

      const { POST } = await import('../../route');
      const { GET } = await import('./route');

      // Step 1 — POST starts the run; the workflow completing DRIVES the run to
      // `completed` (the status poll reads `getRun(...).status`, never a test
      // write).
      const postRes = await POST(
        new Request('https://x/api/turns', { headers: { accept: 'application/json' } }),
      );
      expect(postRes.status).toBe(200);
      const body = (await postRes.json()) as { runId: string };
      expect(body.runId).toBe(runId);
      expect(await mockRun.status).toBe('completed');

      // Step 2 — client connects, then aborts by cancelling the stream reader.
      const res = await GET(new Request(`https://x/api/turns/${runId}/stream`), {
        params: Promise.resolve({ runId }),
      });
      const reader = res.body?.getReader();
      await reader?.read();
      await reader?.cancel();

      // Step 3 — poll getRun status (bounded): the run is STILL completed — the
      // HTTP abort never cancelled it — and cancel was never invoked.
      expect(await mockRun.status).toBe('completed');
      expect(cancel).not.toHaveBeenCalled();

      // Step 4 — a later reconnect from the tail still works.
      const res2 = await GET(
        new Request(`https://x/api/turns/${runId}/stream?startIndex=4`),
        { params: Promise.resolve({ runId }) },
      );
      const events = await readEvents(res2);
      expect(events.map((e) => (e as { type: string }).type)).toEqual(['usage', 'done']);
      expect(cancel).not.toHaveBeenCalled();
    });
  });

  describe('stream headers match docs/agent-stream.md (DoD row 8)', () => {
    it('returns the agent SSE Content-Type + no-cache headers', async () => {
      vi.resetModules();
      mockSession({ ok: true, user: { id: 'u1' } });
      mockFoundRun();
      const { GET } = await import('./route');
      const res = await GET(new Request('https://x/api/turns/w/stream'), {
        params: Promise.resolve({ runId: 'w' }),
      });
      expect(res.headers.get('content-type')).toContain(AGENT_STREAM_CONTENT_TYPE);
      expect(res.headers.get('cache-control')).toContain('no-cache');
      expect(res.headers.get('x-accel-buffering')).toBe('no');
    });
  });

  describe('fail-closed no-/api/agent fallback', () => {
    it('route has no tab-owned /api/agent fallback path', () => {
      // The route MAY import the event contract (`lib/agent/agentStream` for
      // AGENT_STREAM_CONTENT_TYPE — plan #787 reuses it). The fallback ban is on
      // the PRODUCTION turn-owner ROUTE `app/api/agent` and any dynamic fetch.
      const importSpecifiers = [
        ...ROUTE_SOURCE.matchAll(/(?:from\s+|import\()['"]([^'"]+)['"]/g),
      ].map((m) => m[1]);
      expect(
        importSpecifiers.some(
          (s) => /app\/api\/agent/.test(s) || /\.\.?\/agent(?:\/|["']|$)/.test(s),
        ),
      ).toBe(false);
      expect(ROUTE_SOURCE).toContain('status: 503');
      expect(ROUTE_SOURCE).not.toMatch(/fetch\(\s*[`"']/);
    });
  });
});
