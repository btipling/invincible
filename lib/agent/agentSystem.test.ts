import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_SYSTEM,
  HTTP_ONLY_SYSTEM,
  SKILL_META_ONLY_SYSTEM,
  SKILL_TOOLS_ONLY_SYSTEM,
  registryHasFsTools,
  resolveSystem,
} from './agentSystem';

describe('registryHasFsTools', () => {
  it('is true for any FS sandbox tool name', () => {
    expect(registryHasFsTools(['list_dir'])).toBe(true);
    expect(registryHasFsTools(['find_skill', 'read_file'])).toBe(true);
    expect(registryHasFsTools(['search'])).toBe(true);
    expect(registryHasFsTools(['sandbox_info'])).toBe(true);
  });

  it('is false when the registry is HTTP / skill / meta only', () => {
    expect(registryHasFsTools([])).toBe(false);
    expect(registryHasFsTools(['http_get', 'find_skill', 'meta_persona_list'])).toBe(
      false,
    );
  });
});

describe('resolveSystem', () => {
  it('uses DEFAULT_AGENT_SYSTEM when FS tools are bound', () => {
    expect(
      resolveSystem({ extraTools: { find_skill: {} } }, true),
    ).toBe(DEFAULT_AGENT_SYSTEM);
  });

  it('uses HTTP_ONLY_SYSTEM when HTTP/MCP is the non-FS surface', () => {
    expect(resolveSystem({ extraTools: { http_get: {} } }, false)).toBe(
      HTTP_ONLY_SYSTEM,
    );
    expect(
      resolveSystem({ extraTools: { mcp_exa__web_search: {} } }, false),
    ).toBe(HTTP_ONLY_SYSTEM);
  });

  it('uses SKILL_TOOLS_ONLY_SYSTEM when skills are the only non-FS tools', () => {
    expect(
      resolveSystem(
        { extraTools: { find_skill: {}, fetch_skill: {} } },
        false,
      ),
    ).toBe(SKILL_TOOLS_ONLY_SYSTEM);
  });

  it('uses SKILL_META_ONLY_SYSTEM when meta_* is present without FS', () => {
    expect(
      resolveSystem({ extraTools: { meta_persona_list: {} } }, false),
    ).toBe(SKILL_META_ONLY_SYSTEM);
  });

  it('falls back to DEFAULT_AGENT_SYSTEM when nothing is classified', () => {
    expect(resolveSystem({}, false)).toBe(DEFAULT_AGENT_SYSTEM);
  });

  it('returns an explicit system override as-is', () => {
    expect(resolveSystem({ system: 'custom' }, true)).toBe('custom');
  });

  it('wraps a persona preamble in <persona_standing_orders>', () => {
    const system = resolveSystem({ personaPreamble: 'Always use tabs.' }, true);
    expect(system.startsWith(DEFAULT_AGENT_SYSTEM)).toBe(true);
    expect(system).toContain('<persona_standing_orders>');
    expect(system).toContain('Always use tabs.');
    expect(system.endsWith('Always use tabs.\n</persona_standing_orders>')).toBe(
      true,
    );
  });

  it('wraps a skills preamble in <attached_skills> after the persona (catalog semantics)', () => {
    const system = resolveSystem(
      {
        personaPreamble: 'Always use tabs.',
        skillsPreamble: '`create-plan` — Create plan: writes a plan.',
      },
      true,
    );
    const personaAt = system.indexOf('<persona_standing_orders>');
    const skillsAt = system.indexOf('<attached_skills>');
    expect(personaAt).toBeGreaterThan(-1);
    expect(skillsAt).toBeGreaterThan(personaAt);
    expect(system).toContain('`create-plan` — Create plan: writes a plan.');
  });

  it('the <attached_skills> intro copy is catalog (fetch-on-demand) semantics, covering sticky ∪ always-on', () => {
    const system = resolveSystem(
      { skillsPreamble: '`create-plan` — Create plan.' },
      true,
    );
    // Copy covers the whole catalog set (sticky ∪ always-on) — it must NOT
    // claim every listed skill was attached via a `/skill-name` slash command
    // (always-on skills auto-attach and were never slash-attached).
    expect(system).toContain('Their BODIES ARE NOT INJECTED');
    expect(system).toContain('fetch_skill');
    expect(system).toContain('find_skill');
    // No slash-command misattribution of the whole set.
    expect(system).not.toContain('via a `/skill-name` slash command');
  });

  it('drops empty/whitespace persona and skills preambles', () => {
    const system = resolveSystem(
      { personaPreamble: '   ', skillsPreamble: '\n' },
      true,
    );
    expect(system).toBe(DEFAULT_AGENT_SYSTEM);
    expect(system).not.toContain('<persona_standing_orders>');
    expect(system).not.toContain('<attached_skills>');
  });
});
