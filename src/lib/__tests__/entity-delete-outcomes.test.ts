import {
  deleteEntitiesWithExactOutcomes,
  orderOrgUnitDeletionIds,
} from '@/lib/entity-delete-outcomes';

describe('deleteEntitiesWithExactOutcomes', () => {
  it('reports successful and failed IDs without rejecting the whole operation', async () => {
    const deleteEntity = jest.fn(async (id: string) => {
      if (id === 'blocked') throw new Error('still referenced');
    });

    await expect(
      deleteEntitiesWithExactOutcomes(['deleted-a', 'blocked', 'deleted-b'], deleteEntity, 2)
    ).resolves.toEqual({
      deletedIds: ['deleted-a', 'deleted-b'],
      failed: [{ id: 'blocked', error: expect.objectContaining({ message: 'still referenced' }) }],
    });
    expect(deleteEntity).toHaveBeenCalledTimes(3);
  });

  it('runs a selected Org Unit hierarchy child-first when concurrency is one', async () => {
    const order = orderOrgUnitDeletionIds(
      ['root', 'child', 'grandchild', 'peer'],
      [
        { id: 'root' },
        { id: 'child', parentId: 'root' },
        { id: 'grandchild', parentId: 'child' },
        { id: 'peer' },
      ]
    );
    const visited: string[] = [];

    const outcome = await deleteEntitiesWithExactOutcomes(
      order,
      async (id) => {
        visited.push(id);
      },
      1
    );

    expect(visited.indexOf('grandchild')).toBeLessThan(visited.indexOf('child'));
    expect(visited.indexOf('child')).toBeLessThan(visited.indexOf('root'));
    expect(outcome.failed).toEqual([]);
    expect(new Set(outcome.deletedIds)).toEqual(new Set(['root', 'child', 'grandchild', 'peer']));
  });
});
