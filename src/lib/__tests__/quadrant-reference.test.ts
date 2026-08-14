/**
 * @jest-environment node
 */

import { resolveQuadrantReference, type QuadrantConfig } from '@/lib/types';

const quadrants: QuadrantConfig[] = [
  { id: 'q_tools', name: 'Tools', order: 0 },
  { id: 'q_platforms', name: 'Cloud Platforms', order: 1 },
];

describe('resolveQuadrantReference', () => {
  it('resolves a stable id exactly and a display-name alias case-insensitively', () => {
    expect(resolveQuadrantReference({ quadrants }, 'q_tools')).toBe(quadrants[0]);
    expect(resolveQuadrantReference({ quadrants }, 'tOoLs')).toBe(quadrants[0]);
    expect(resolveQuadrantReference({ quadrants }, 'Q_TOOLS')).toBeUndefined();
  });

  it('accepts the minimal canonical id/name shape without requiring presentation fields', () => {
    const minimal = { id: 'q_minimal', name: 'Minimal' };

    expect(
      resolveQuadrantReference({ quadrants: [minimal] as unknown as QuadrantConfig[] }, 'q_minimal')
    ).toBe(minimal);
  });

  it('keeps name whitespace significant for AI tool compatibility', () => {
    expect(resolveQuadrantReference({ quadrants }, ' Tools ')).toBeUndefined();

    const spaced: QuadrantConfig = { id: 'q_spaced', name: '  Tools  ', order: 0 };
    expect(resolveQuadrantReference({ quadrants: [spaced] }, '  tools  ')).toBe(spaced);
  });

  it('returns undefined for unknown, missing, and legacy references', () => {
    expect(resolveQuadrantReference({ quadrants }, 'Unknown')).toBeUndefined();
    expect(resolveQuadrantReference({ quadrants }, undefined as unknown as string)).toBeUndefined();
    expect(
      resolveQuadrantReference(
        { quadrants: ['Tools', { name: 'Tools' }] as unknown as QuadrantConfig[] },
        'Tools'
      )
    ).toBeUndefined();
  });

  it.each([
    ['missing name', { id: 'q_tools' }, 'q_tools'],
    ['non-string name', { id: 'q_tools', name: 42 }, 'q_tools'],
    ['non-string id', { id: 42, name: 'Tools' }, 'Tools'],
    ['empty id', { id: '', name: 'Tools' }, 'Tools'],
    ['whitespace-only id', { id: '   ', name: 'Tools' }, 'Tools'],
    ['empty name', { id: 'q_tools', name: '' }, 'q_tools'],
    ['whitespace-only name', { id: 'q_tools', name: '   ' }, 'q_tools'],
  ])('rejects a malformed config with %s', (_label, malformed, reference) => {
    expect(
      resolveQuadrantReference({ quadrants: [malformed] as unknown as QuadrantConfig[] }, reference)
    ).toBeUndefined();
  });

  it('defaults to id-first when one quadrant name collides with another quadrant id', () => {
    const idTarget: QuadrantConfig = { id: 'collision', name: 'ID target', order: 0 };
    const nameTarget: QuadrantConfig = { id: 'q_name_target', name: 'collision', order: 1 };

    expect(resolveQuadrantReference({ quadrants: [nameTarget, idTarget] }, 'collision')).toBe(idTarget);
    expect(
      resolveQuadrantReference({ quadrants: [nameTarget, idTarget] }, 'collision', { precedence: 'name-first' })
    ).toBe(nameTarget);
  });

  it('supports id-only and name-only fields without cross-fallback', () => {
    expect(resolveQuadrantReference({ quadrants }, 'Tools', { matchBy: 'id' })).toBeUndefined();
    expect(resolveQuadrantReference({ quadrants }, 'q_tools', { matchBy: 'name' })).toBeUndefined();
    expect(resolveQuadrantReference({ quadrants }, 'q_tools', { matchBy: 'id' })).toBe(quadrants[0]);
    expect(resolveQuadrantReference({ quadrants }, 'TOOLS', { matchBy: 'name' })).toBe(quadrants[0]);
  });
});
