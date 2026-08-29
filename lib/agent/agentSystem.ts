/**
 * Shared agent system-prompt resolver.
 *
 * Hoisted out of `runAgent.ts` so the durable `'use step'` leaf
 * (`modelGenerateStep`) can call the same function without dragging `runAgent`
 * (sandbox / MCP / db) into the workflow-entry graph — same pattern as
 * `stopWhen.ts` / `modelFinish.ts`.
 *
 * Behavior is byte-identical to the prior `runAgent` definition. `/api/agent`
 * and `POST /api/turns` must resolve the same string for the same tool surface.
 */

/** Tool names that mean the FS sandbox surface is bound this turn.
 *  Must match `createAgentTools` return keys (`lib/agent/tools.ts`) —
 *  locked per-key by `tools.test.ts`.
 */
const FS_TOOL_NAME_SET: ReadonlySet<string> = new Set([
  'list_dir',
  'read_file',
  'write_file',
  'str_replace',
  'exec',
  'change_dir',
  'pwd',
  'sandbox_info',
  'search',
]);

export function registryHasFsTools(toolNames: readonly string[]): boolean {
  return toolNames.some((k) => FS_TOOL_NAME_SET.has(k));
}

export const DEFAULT_AGENT_SYSTEM = [
  'You are the Invincible coding agent.',
  'The workspace is a remote sandbox root. Prefer tools (list_dir, read_file, write_file, str_replace, exec, change_dir, pwd, sandbox_info) for filesystem and command work. Use str_replace for surgical edits (unique old_string unless replace_all); write_file to create or fully rewrite. Use sandbox_info for active-bind facts, cwd, capabilities, and env — do not exec env, printenv, or uname to learn the sandbox. For multi-line process input prefer exec stdin (heredoc alias ok) on BYO sandboxes; if exec rejects stdin (Vercel backend), write_file the input and pass the path via args instead — never claim stdin was fed when the tool errors.',
  'Logical cwd starts at the workspace root (or the session cwd). Prefer change_dir into the project once, then short relative paths under that cwd. Prefer change_dir as its own step before a burst of path tools. Use pwd to inspect cwd.',
  'Must read_file a path in this agent run (with offset=1 covering every line of the returned content, not truncated by limit or maxBytes) before str_replace or overwriting an existing file with write_file. Creating a new file with write_file does not require a prior read. If tools report the file changed since your last read (another edit, command, concurrent session, or device on the same sandbox), read_file again before editing.',
  'Tool results always show workspace-root-relative paths (and cwd= when not at root). Paths that already include the cwd prefix also work. Absolute paths are accepted when they resolve inside the sandbox root and are canonicalized to the same file as their relative form — but never invent host absolute paths outside the sandbox.',
  'The workspace root is writable — use it. Never reach for /tmp.',
  'Be concise in final answers; cite workspace-relative paths when useful.',
  'If the user message includes Previous conversation with Tool: lines, those tools already ran — reuse that work; do not redo identical tool calls unless asked or the files may have changed.',
].join(' ');

export const HTTP_ONLY_SYSTEM =
  'You are the Invincible agent. Workspace filesystem tools are unavailable this turn. Use http_get for public HTTPS information when needed. Be concise.';

export const SKILL_TOOLS_ONLY_SYSTEM =
  'You are the Invincible agent. Workspace filesystem tools are unavailable this turn. Use find_skill / fetch_skill to read the user\'s skills. Be concise.';

export const SKILL_META_ONLY_SYSTEM =
  'You are the Invincible agent. Workspace filesystem tools are unavailable this turn. Use find_skill / fetch_skill to read the user\'s skills, and meta_persona_* / meta_skill_* to manage the user\'s personas and skills. Be concise.';

export type ResolveSystemParams = {
  /** Explicit override — when set (including empty string), returned as-is. */
  system?: string | null;
  /** Non-FS (and, for the durable step, the full assembled) tool registry. */
  extraTools?: Record<string, unknown>;
  personaPreamble?: string;
  skillsPreamble?: string;
};

/**
 * Resolve the model system string for one agent turn.
 *
 * `hasFsTools` is the sandbox-bound flag (`runAgent`) or `registryHasFsTools`
 * on the assembled durable registry. Extra-tool keys pick HTTP / skill / meta
 * only when FS is absent.
 */
export function resolveSystem(
  params: ResolveSystemParams,
  hasFsTools: boolean,
): string {
  if (params.system != null) return params.system;
  const extra = params.extraTools ?? {};
  const keys = Object.keys(extra);
  const hasMcp = keys.some((k) => k.startsWith('mcp_'));
  const hasHttp = keys.some((k) => k === 'http_get' || k === 'http_head');
  const hasSkill = keys.some((k) => k === 'find_skill' || k === 'fetch_skill');
  const hasMeta = keys.some((k) => k.startsWith('meta_'));

  const parts: string[] = [];
  if (hasFsTools) {
    parts.push(DEFAULT_AGENT_SYSTEM);
  } else if (hasHttp || hasMcp) {
    parts.push(HTTP_ONLY_SYSTEM);
  } else if (hasSkill || hasMeta) {
    // Skill + meta authoring tools are the only non-FS tools — give an honest
    // prompt (no phantom FS instructions, no "use http_get" when http isn't
    // present). Pick-criteria live on each tool.description.
    parts.push(hasMeta ? SKILL_META_ONLY_SYSTEM : SKILL_TOOLS_ONLY_SYSTEM);
  } else {
    parts.push(DEFAULT_AGENT_SYSTEM);
  }

  const persona = params.personaPreamble?.trim();
  if (persona) {
    parts.push(
      '<persona_standing_orders>\n' +
        'The user bound this persona to the session. Its instructions are explicit standing orders for this session, carried in a locked snapshot so later turns reuse the same text. Follow these standing orders — they are mandatory and override any conflicting general guidance below (they never override the security/config non-negotiables above).\n' +
        '---\n' +
        persona +
        '\n</persona_standing_orders>',
    );
  }

  const skills = params.skillsPreamble?.trim();
  if (skills) {
    parts.push(
      '<attached_skills>\n' +
        'The user attached the following skill(s) to this session via a `/skill-name` slash command. Their bodies are explicit standing orders for THIS session (skills are staff-of-work: edits to a skill apply on the next turn). Follow them unless they conflict with the security/config non-negotiables above.\n' +
        '---\n' +
        skills +
        '\n</attached_skills>',
    );
  }
  return parts.join('\n\n');
}
