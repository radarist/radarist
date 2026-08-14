/**
 * @jest-environment node
 */
import { dedupeBeforeTriage } from '../discovery-dedup';

type C = { entityId: string; entityName?: string; degree?: number };

describe('dedupeBeforeTriage', () => {
  it('collapses exact-normalized-name duplicates to one canonical + records the collapse', () => {
    const pool: C[] = [
      { entityId: 't1', entityName: 'Vector DB', degree: 2 },
      { entityId: 't2', entityName: 'vector  db', degree: 5 }, // same normalized name, higher degree
      { entityId: 't3', entityName: 'Graph DB', degree: 1 },
    ];
    const { kept, collapsed } = dedupeBeforeTriage(pool);
    // Canonical = higher degree (t2). t3 is distinct.
    expect(kept.map((c) => c.entityId).sort()).toEqual(['t2', 't3']);
    expect(collapsed).toEqual([{ canonicalId: 't2', droppedId: 't1' }]);
  });

  it('passes a duplicate-free pool through unchanged with no collapses', () => {
    const pool: C[] = [
      { entityId: 'a', entityName: 'Alpha' },
      { entityId: 'b', entityName: 'Beta' },
    ];
    const { kept, collapsed } = dedupeBeforeTriage(pool);
    expect(kept).toEqual(pool);
    expect(collapsed).toEqual([]);
  });

  it('breaks ties lexically by id when degree is equal', () => {
    const pool: C[] = [
      { entityId: 'z', entityName: 'Same', degree: 1 },
      { entityId: 'a', entityName: 'same', degree: 1 },
    ];
    const { kept } = dedupeBeforeTriage(pool);
    expect(kept.map((c) => c.entityId)).toEqual(['a']); // lexically-smallest id wins
  });

  it('is a no-op on an empty pool', () => {
    expect(dedupeBeforeTriage([])).toEqual({ kept: [], collapsed: [] });
  });
});
