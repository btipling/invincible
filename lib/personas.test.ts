import { describe, expect, it } from 'vitest';
import { personaLabel, personaPickerState } from './personas';

describe('personaPickerState', () => {
  it('derives defaultId from a single isDefault and sorts by name', () => {
    const state = personaPickerState([
      { id: 'b', name: 'Bravo', slug: 'bravo', isDefault: false },
      { id: 'a', name: 'Alpha', slug: 'alpha', isDefault: true },
      { id: 'c', name: 'Charlie', slug: 'charlie', isDefault: false },
    ]);
    expect(state.options.map((o) => o.id)).toEqual(['a', 'b', 'c']);
    expect(state.defaultId).toBe('a');
    expect(state.hasPersonas).toBe(true);
  });

  it('null defaultId when no isDefault is set', () => {
    const state = personaPickerState([
      { id: 'x', name: 'X', slug: 'x', isDefault: false },
    ]);
    expect(state.defaultId).toBeNull();
    expect(state.hasPersonas).toBe(true);
  });

  it('empty list → no personas, null default', () => {
    const state = personaPickerState([]);
    expect(state.options).toEqual([]);
    expect(state.defaultId).toBeNull();
    expect(state.hasPersonas).toBe(false);
  });

  it('never exposes a body field on any projection', () => {
    const summaries = [{ id: 's', name: 'S', slug: 's', isDefault: true }];
    const state = personaPickerState(summaries);
    for (const o of [...state.options, ...summaries]) {
      expect('body' in (o as Record<string, unknown>)).toBe(false);
    }
  });

  it('personaLabel prefers a name and falls back to slug', () => {
    expect(personaLabel({ id: '1', name: '  FE  ', slug: 'fe', isDefault: false })).toBe('FE');
    expect(personaLabel({ id: '2', name: '', slug: 'fe', isDefault: false })).toBe('fe');
    expect(personaLabel({ id: '3', name: ' ', slug: '', isDefault: false })).toBe(
      'Unnamed persona',
    );
  });
});
