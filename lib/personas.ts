/**
 * Client-safe persona picker projection (phase 2 #487).
 *
 * Pure — imports nothing from the tenancy/DB layer, so it is safe for the DOM
 * bundle. It consumes the summary shape `GET /api/personas` returns
 * (`{ id, name, slug, isDefault }` per row) and derives the picker options +
 * the single default id. It receives summaries only and NEVER a persona body
 * (bodies stay server-side; Phase 3 resolves them by id for injection).
 */
export type PersonaOption = {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
};

export type PersonaPickerState = {
  /** Owned personas, sorted by display name. */
  options: PersonaOption[];
  /** Id of the single default (null when none). Derived from `isDefault`. */
  defaultId: string | null;
  hasPersonas: boolean;
};

/**
 * Exact-Partial write helper (used by tests/stores); never ships a body.
 */
export function personaPickerState(
  summaries: readonly PersonaOption[],
): PersonaPickerState {
  const options = [...summaries].sort((a, b) => a.name.localeCompare(b.name));
  const defaultId = options.find((o) => o.isDefault)?.id ?? null;
  return { options, defaultId, hasPersonas: options.length > 0 };
}

/** Display name for a persona in list/picker chrome (falls back to slug). */
export function personaLabel(option: PersonaOption): string {
  const name = option.name?.trim();
  if (name) return name;
  return option.slug || 'Unnamed persona';
}
