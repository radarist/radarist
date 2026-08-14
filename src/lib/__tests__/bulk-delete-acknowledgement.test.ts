import { parseBulkDeleteAcknowledgement } from '../bulk-delete-acknowledgement';

describe('parseBulkDeleteAcknowledgement', () => {
  it('returns an exact partial partition and required nonnegative counters', () => {
    expect(
      parseBulkDeleteAcknowledgement(
        {
          success: false,
          deleted: 1,
          failed: ['entity-2'],
          relationsDeleted: 3,
        },
        ['entity-1', 'entity-2'],
        ['relationsDeleted'] as const
      )
    ).toEqual({
      success: false,
      deleted: 1,
      failed: ['entity-2'],
      relationsDeleted: 3,
    });
  });

  it.each([
    [
      'an unknown failed ID',
      { success: false, deleted: 1, failed: ['unknown'], relationsDeleted: 0 },
      ['entity-1', 'entity-2'],
    ],
    [
      'duplicate failed IDs',
      { success: false, deleted: 0, failed: ['entity-2', 'entity-2'], relationsDeleted: 0 },
      ['entity-1', 'entity-2'],
    ],
    [
      'an incomplete count partition',
      { success: true, deleted: 0, failed: [], relationsDeleted: 0 },
      ['entity-1', 'entity-2'],
    ],
    [
      'a contradictory success flag',
      { success: true, deleted: 1, failed: ['entity-2'], relationsDeleted: 0 },
      ['entity-1', 'entity-2'],
    ],
    [
      'a negative deleted count',
      { success: true, deleted: -1, failed: [], relationsDeleted: 0 },
      ['entity-1'],
    ],
    [
      'a negative required count',
      { success: true, deleted: 1, failed: [], relationsDeleted: -1 },
      ['entity-1'],
    ],
    [
      'duplicate requested IDs',
      { success: true, deleted: 2, failed: [], relationsDeleted: 0 },
      ['entity-1', 'entity-1'],
    ],
  ])('rejects %s', (_label, body, requestedIds) => {
    expect(() =>
      parseBulkDeleteAcknowledgement(body, requestedIds, ['relationsDeleted'] as const)
    ).toThrow(/bulk delete/);
  });
});
