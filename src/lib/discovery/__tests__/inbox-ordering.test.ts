/**
 * @jest-environment node
 */
import { orderByUncertaintyFirst, applyInboxOrder } from '../inbox-ordering';

type Item = { id: string; confidence: number; createdAt: number };

describe('orderByUncertaintyFirst', () => {
  it('orders by distance-from-50 ascending, tie-break createdAt desc', () => {
    const items: Item[] = [
      { id: 'a', confidence: 95, createdAt: 1 },
      { id: 'b', confidence: 52, createdAt: 4 },
      { id: 'c', confidence: 10, createdAt: 2 },
      { id: 'd', confidence: 48, createdAt: 3 },
    ];
    expect(orderByUncertaintyFirst(items).map((i) => i.confidence)).toEqual([52, 48, 10, 95]);
  });

  it('returns [] for empty input and does not mutate the source', () => {
    const src: Item[] = [{ id: 'x', confidence: 50, createdAt: 1 }];
    const before = [...src];
    expect(orderByUncertaintyFirst([])).toEqual([]);
    orderByUncertaintyFirst(src);
    expect(src).toEqual(before);
  });
});

describe('applyInboxOrder', () => {
  const items: Item[] = [
    { id: 'a', confidence: 95, createdAt: 1 },
    { id: 'b', confidence: 52, createdAt: 4 },
    { id: 'c', confidence: 10, createdAt: 2 },
  ];

  it('defaults to recency (createdAt desc) — back-compat', () => {
    expect(applyInboxOrder(items).map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });

  it('orders near-50 first under "uncertainty"', () => {
    expect(applyInboxOrder(items, 'uncertainty').map((i) => i.confidence)).toEqual([52, 10, 95]);
  });
});
