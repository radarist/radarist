import type { QuadrantConfig } from '@/lib/types';
import { ensureQuadrantConfigs, reconcileQuadrantConfigs } from '@/lib/types';
import { prepareQuadrantConfigsForWrite } from '@/lib/radars-shared';

describe('prepareQuadrantConfigsForWrite', () => {
  it('omits only an absent optional description and preserves an explicit empty description', () => {
    const configs: QuadrantConfig[] = [
      { id: 'q-absent', name: 'Absent', order: 0, description: undefined },
      { id: 'q-empty', name: 'Empty', order: 1, description: '' },
      {
        id: 'q-described',
        name: 'Described',
        order: 2,
        description: 'Scope',
        ignored: 'not-canonical',
      } as QuadrantConfig & { ignored: string },
    ];

    const prepared = prepareQuadrantConfigsForWrite(configs);

    expect(prepared).toEqual([
      { id: 'q-absent', name: 'Absent', order: 0 },
      { id: 'q-empty', name: 'Empty', order: 1, description: '' },
      { id: 'q-described', name: 'Described', order: 2, description: 'Scope' },
    ]);
    expect(Object.prototype.hasOwnProperty.call(prepared[0], 'description')).toBe(false);
    expect(prepared.every((config) => !Object.prototype.hasOwnProperty.call(config, 'ignored'))).toBe(true);
  });

  it.each([
    ['missing id', { id: undefined, name: 'Name', order: 0 }, /id/i],
    ['missing name', { id: 'q-1', name: undefined, order: 0 }, /name/i],
    ['missing order', { id: 'q-1', name: 'Name', order: undefined }, /order/i],
    ['fractional order', { id: 'q-1', name: 'Name', order: 0.5 }, /order/i],
    ['invalid description', { id: 'q-1', name: 'Name', order: 0, description: null }, /description/i],
  ])('rejects %s instead of stripping an invalid value', (_label, config, message) => {
    expect(() => prepareQuadrantConfigsForWrite([config as unknown as QuadrantConfig])).toThrow(message);
  });
});

describe('quadrant config construction', () => {
  it('does not materialize an absent description while normalizing or reconciling', () => {
    const existing = ensureQuadrantConfigs(
      [{ id: 'q-1', name: 'Existing', order: 0, description: undefined }],
      (name) => name
    );
    const reconciled = reconcileQuadrantConfigs(existing, [{ id: 'q-1', name: 'Renamed' }, { name: 'New' }], (name) =>
      name.toLowerCase()
    );

    expect(existing).toEqual([{ id: 'q-1', name: 'Existing', order: 0 }]);
    expect(reconciled.errors).toEqual([]);
    expect(reconciled.next).toEqual([
      { id: 'q-1', name: 'Renamed', order: 0 },
      { id: 'new', name: 'New', order: 1 },
    ]);
    expect(reconciled.next.every((config) => !Object.prototype.hasOwnProperty.call(config, 'description'))).toBe(true);
  });
});
