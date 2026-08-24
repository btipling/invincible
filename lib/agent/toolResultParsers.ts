/**
 * Pure, dependency-free parsers for tool RESULT TEXT (backend-agents B13 /
 * adversarial round-2 L1).
 *
 * Extracted from `agentStream.ts` so the directive-free turn-loop core
 * (`turnWorkflow.ts` closure) can derive cwd / activeSandboxId from THIS run's
 * tool rows at persist time WITHOUT importing `agentStream.ts`'s closure (which
 * drags in `mapProviderUsage`, `flattenToolResultText`, `redact`, …). This file
 * statically imports NOTHING, so the `'use workflow'` entry importing `turnLoop`
 * (which imports this) stays inside the B11 static-graph lock.
 *
 * Semantics are byte-identical to the prior definitions in `agentStream.ts`,
 * which re-exports these for back-compat (host stream path + JSON-path parsers).
 */

/**
 * Extract the confirmed workspace-relative cwd from the RAW `change_dir` tool
 * result, only from a strict success marker. The tool emits
 * `change_dir <path>: ok cwd=<path>` on success and `ERROR change_dir: …` on
 * failure; any other shape → `undefined`. This is the structured carrier used to
 * attach the typed `tool_result.changeDirCwd` (stream) and `ToolTraceEntry.cwd`
 * (JSON) so host persistence never depends on the truncated display summary
 * (adversarial review #470 Major).
 */
export function changeDirSuccessCwd(raw: string | undefined): string | undefined {
  const t = (raw ?? '').trim();
  if (!t || /^ERROR\b/i.test(t)) return undefined;
  const m = t.match(/^change_dir\s+(\S+):\s*ok\s+cwd=(\S+)\s*$/i);
  if (!m) return undefined;
  return m[2];
}

/**
 * Parse a successful `meta_sandbox_switch` tool RESULT TEXT to the switched-to
 * id. The tool emits `switched active sandbox to id=<id> tools=[...]` only on a
 * persisted write; `undefined` on ERROR / any other shape.
 */
export function metaSandboxSwitchActiveId(
  raw: string | undefined,
): string | undefined {
  const t = (raw ?? '').trim();
  if (!t || /^ERROR\b/i.test(t)) return undefined;
  const m = t.match(/^switched active sandbox to id=(\S+)\s+tools=/i);
  if (!m) return undefined;
  return m[1];
}
