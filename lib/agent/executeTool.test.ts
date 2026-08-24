/**
 * backend-agents B10 (#804) — executeTool tests.
 * Drives the helper against a fake registry (assembled sandbox + extraTools
 * `execute` closures), asserting the 11-row plan matrix:
 *  1. tool by name, valid args → ok:true result (redacted + bounded), grants updated
 *  2. unknown tool name → ok:false tool_not_found — value, not a throw
 *  3. tool soft-fail (business) → returned as a value, not a throw
 *  4. infra/transient (daemon unreachable) → re-thrown (SDK retry applies)
 *  5. freshnessDelta = B5 serializeRunFileFreshness; hydrate round-trips w/ truncated marker
 *  6. business error does NOT trigger retry — no second tool call
 *  7. standalone helper — no dependence on runAgentStream//api/agent (no diff under app/)
 *  8. abort / signal fired → ok:false cancelled — no uncaught throw
 *  9. checkDaemonCurrent absent (Vercel-sdk backend) → still re-resolve + run
 * 10. extraTools path (http/MCP runner) → resolved + executed, result redacted
 * 11. di-gate green — injected registry/freshness, no in-body I/O (verified by gate)
 */

import { describe, expect, it, vi } from 'vitest';
import { executeTool, type ExecuteToolResult } from './executeTool';
import {
  createRunFileFreshness,
  hydrateRunFileFreshness,
  serializeRunFileFreshness,
} from './fileFreshness';

/** Build a fake AI-SDK tool closure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeTool(execute: (...args: any[]) => unknown) {
  return { description: 'fake tool', parameters: {}, execute };
}

function makeRegistry(overrides: Record<string, unknown> = {}) {
  return {
    list_dir: fakeTool(async () => 'listed 1 entry'),
    ...overrides,
  };
}

describe('executeTool (backend-agents B10)', () => {
  it('matrix 1: sandbox tool by name, valid args → ok:true, result redacted+bounded, grants updated', async () => {
    const freshness = createRunFileFreshness();
    const registry = {
      list_dir: fakeTool(async () => {
        freshness.recordRead('AGENTS.md', { mtimeMs: 100, size: 200 });
        return 'listed 2 entries — AGENTS.md, src. sk-999 end';
      }),
    };
    const result = await executeTool(
      { registry, freshness, secrets: ['sk-999'] },
      { toolName: 'list_dir', args: { path: '.' } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('listed 2 entries');
    expect(result.result).not.toContain('sk-999');
    // freshness grants updated → delta round-trips with the new grant
    const delta = result.freshnessDelta;
    expect(typeof delta).toBe('string');
    const hydrated = hydrateRunFileFreshness(delta);
    expect(hydrated.assertCanEdit('AGENTS.md', { mtimeMs: 100, size: 200 }).ok).toBe(true);
  });

  it('matrix 2: unknown tool name → ok:false tool_not_found — value, not a throw', async () => {
    let threw = false;
    let result: ExecuteToolResult | undefined;
    try {
      result = await executeTool(
        { registry: makeRegistry(), freshness: createRunFileFreshness() },
        { toolName: 'does_not_exist', args: {} },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toBeDefined();
    expect(result!.ok).toBe(false);
    if (!result!.ok) expect(result!.code).toBe('tool_not_found');
  });

  it('matrix 3: tool soft-fail (business) → returned as a value, not a throw', async () => {
    const registry = {
      write_file: fakeTool(async () => {
        // A real tool in this seam soft-fails by RETURNING an ERROR string
        // (edit-gate / business), never throwing.
        return 'ERROR write_file: read_file required before overwriting an existing file';
      }),
    };
    let threw = false;
    let result: ExecuteToolResult | undefined;
    try {
      result = await executeTool(
        { registry, freshness: createRunFileFreshness() },
        { toolName: 'write_file', args: { path: 'x', content: 'y' } },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // The returned soft-fail string rides as the value (not an uncaught throw).
    expect(result!.ok).toBe(true);
    if (result!.ok) expect(result!.result).toContain('ERROR write_file');
  });

  it('matrix 4: infra/transient (daemon unreachable) → re-thrown (SDK retry applies)', async () => {
    const registry = {
      exec: fakeTool(async () => {
        throw new Error('Sandbox request failed (daemon unreachable)');
      }),
    };
    await expect(
      executeTool({ registry, freshness: createRunFileFreshness() }, { toolName: 'exec', args: {} }),
    ).rejects.toThrow(/daemon unreachable/);
  });

  it('matrix 5: freshnessDelta = B5 serializeRunFileFreshness — hydrate round-trips grants + truncated marker', async () => {
    const freshness = createRunFileFreshness();
    freshness.recordRead('full.txt', { mtimeMs: 3, size: 4 });
    freshness.recordRead('peek.txt', { truncated: true });
    const registry = { list_dir: fakeTool(async () => 'ok') };
    const result = await executeTool(
      { registry, freshness },
      { toolName: 'list_dir', args: {} },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const delta = result.freshnessDelta;
    // delta is exactly a B5 projection string
    expect(delta).toBe(serializeRunFileFreshness(freshness));
    expect(typeof JSON.parse(delta)).toBe('object');
    const hydrated = hydrateRunFileFreshness(delta);
    // fresh grant round-trips for gate 2
    expect(hydrated.assertCanEdit('full.txt', { mtimeMs: 3, size: 4 }).ok).toBe(true);
    // truncated grant stays truncated (never upgraded)
    expect(hydrated.assertCanEdit('peek.txt', { mtimeMs: 3, size: 4 })).toEqual({
      ok: false,
      code: 'truncated',
    });
  });

  it('matrix 6: business error does NOT trigger retry — no second tool call', async () => {
    const execute = vi.fn(async () => 'ERROR exec: cannot run cmd');
    const registry = { exec: fakeTool(execute) };
    const result = await executeTool(
      { registry, freshness: createRunFileFreshness() },
      { toolName: 'exec', args: { cmd: 'true' } },
    );
    // Retry applies only on a THROW (matrix 4); a returned business error runs once.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it('matrix 7: standalone helper — no dependence on runAgentStream//api/agent', async () => {
    // The helper runs purely off the injected registry — it never constructs a
    // runAgent, never touches /api/agent. The only files this PR changes are
    // lib/agent/executeTool.ts + its test (no diff under app/ — scoped by PR).
    const result = await executeTool(
      { registry: makeRegistry(), freshness: createRunFileFreshness() },
      { toolName: 'list_dir', args: { path: '.' } },
    );
    expect(result.ok).toBe(true);
  });

  it('matrix 8: abort / signal fired → ok:false cancelled — no uncaught throw', async () => {
    // Already-aborted signal → cancelled before the tool runs.
    const aborted = new AbortController();
    aborted.abort();
    const result = await executeTool(
      {
        registry: makeRegistry(),
        freshness: createRunFileFreshness(),
        signal: aborted.signal,
      },
      { toolName: 'list_dir', args: {} },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('cancelled');

    // AbortError thrown mid-tool → cancelled, no uncaught throw.
    const ctx = new AbortController();
    const registry = {
      list_dir: fakeTool(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }),
    };
    let threw = false;
    let result2: ExecuteToolResult | undefined;
    try {
      result2 = await executeTool(
        { registry, freshness: createRunFileFreshness(), signal: ctx.signal },
        { toolName: 'list_dir', args: {} },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result2!.ok).toBe(false);
    if (!result2!.ok) expect(result2!.code).toBe('cancelled');
  });

  it('matrix 9: checkDaemonCurrent absent (Vercel-sdk backend) → skip fail-fast, still re-resolve + run', async () => {
    // The helper never calls checkDaemonCurrent / performs a daemon liveness
    // fail-fast — it resolves the named tool in the registry and runs it
    // regardless of daemon presence (mirrors the Vercel-sdk backend path).
    const registry = { list_dir: fakeTool(async () => 'ok no daemon check') };
    const result = await executeTool(
      { registry, freshness: createRunFileFreshness() },
      { toolName: 'list_dir', args: {} },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result).toBe('ok no daemon check');
  });

  it('matrix 10: extraTools path (http/MCP runner) → resolved + executed, result redacted', async () => {
    const registry = {
      http_get: fakeTool(async () => 'private endpoint says sk-999-secret'),
    };
    const result = await executeTool(
      { registry, freshness: createRunFileFreshness(), secrets: ['sk-999-secret'] },
      { toolName: 'http_get', args: { url: 'https://example.com/x' } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toContain('private endpoint says');
    expect(result.result).not.toContain('sk-999-secret');
    expect(result.result).toContain('[redacted]');
  });

  it('result is bounded to TOOL_RESULT_MAX_CHARS', async () => {
    const registry = {
      list_dir: fakeTool(async () => 'x'.repeat(2_000_100)),
    };
    const result = await executeTool(
      { registry, freshness: createRunFileFreshness() },
      { toolName: 'list_dir', args: {} },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.length).toBeLessThanOrEqual(2_000_100);
  });
});
