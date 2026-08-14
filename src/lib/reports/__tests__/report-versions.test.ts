/**
 * @file lib/reports/__tests__/report-versions.test.ts
 * @jest-environment node
 *
 * DISC-014 — version-capture staging + history reads.
 */

// --- db mock for the read helpers (subcollection chain) --------------------
// jest.mock factories are hoisted above const declarations, so the chain is
// built inside the factory and its leaf spies exposed on the db object.
jest.mock('@/lib/firebase-admin', () => {
  const listGet = jest.fn();
  const versionDocGet = jest.fn();
  const selectChain = { get: listGet };
  const versionsColMock: Record<string, jest.Mock> = {
    orderBy: jest.fn(() => versionsColMock),
    select: jest.fn(() => selectChain),
    doc: jest.fn(() => ({ get: versionDocGet })),
  };
  const reportDocMock = { collection: jest.fn(() => versionsColMock) };
  const reportsColMock = { doc: jest.fn(() => reportDocMock) };
  const db = {
    collection: jest.fn(() => reportsColMock),
    __spies: { listGet, versionDocGet, versionsColMock },
  };
  return { db };
});
jest.mock('@/lib/firestore-deadline', () => ({ withDeadline: (p: Promise<unknown>) => p }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { db } from '@/lib/firebase-admin';
import {
  stageVersionCapture,
  listReportVersions,
  getReportVersion,
  UNKNOWN_SAVER,
  reportSaver,
  type StagedVersionWrite,
} from '../report-versions';

const spies = (db as unknown as { __spies: { listGet: jest.Mock; versionDocGet: jest.Mock; versionsColMock: Record<string, jest.Mock> } }).__spies;
const listGet = spies.listGet;
const versionDocGet = spies.versionDocGet;
const versionsColMock = spies.versionsColMock;

// --- fakes for stageVersionCapture (takes tx + reportRef directly) ---------

function fakeReportRef() {
  let docCounter = 0;
  const versionsCol: Record<string, jest.Mock> = {
    orderBy: jest.fn(() => versionsCol),
    limit: jest.fn(() => versionsCol),
    doc: jest.fn(() => ({ id: `v-${++docCounter}` })),
  };
  const reportRef = { collection: jest.fn(() => versionsCol) };
  return { reportRef, versionsCol };
}

function fakeTx(maxSnap: { empty: boolean; docs: Array<{ data: () => { versionNumber: number } }> }) {
  return {
    get: jest.fn(async () => maxSnap),
    set: jest.fn(),
    update: jest.fn(),
  };
}

const emptyMax = { empty: true, docs: [] as Array<{ data: () => { versionNumber: number } }> };
const maxAt = (n: number) => ({ empty: false, docs: [{ data: () => ({ versionNumber: n }) }] });

describe('stageVersionCapture (DISC-014)', () => {
  it('first snapshot with a legacy previousHtml folds it as v1 and appends the outgoing html as v2', async () => {
    const { reportRef } = fakeReportRef();
    const tx = fakeTx(emptyMax);

    const writes = await stageVersionCapture(tx as never, reportRef as never, { html: 'B', previousHtml: 'A' }, {
      savedBy: reportSaver.user('u1'),
      reason: 'revision',
    });

    expect(writes).toHaveLength(2);
    // v1 = the folded legacy buffer — oldest, attributed unknown.
    expect(writes[0].data).toMatchObject({
      versionNumber: 1,
      html: 'A',
      htmlLength: 1,
      savedBy: UNKNOWN_SAVER,
      reason: 'legacy-previous',
    });
    // v2 = the outgoing head — attributed to the current saver + reason.
    expect(writes[1].data).toMatchObject({
      versionNumber: 2,
      html: 'B',
      htmlLength: 1,
      savedBy: 'user:u1',
      reason: 'revision',
    });
  });

  it('first snapshot with no legacy buffer captures only the outgoing html as v1', async () => {
    const { reportRef } = fakeReportRef();
    const tx = fakeTx(emptyMax);

    const writes = await stageVersionCapture(tx as never, reportRef as never, { html: 'HEAD' }, {
      savedBy: reportSaver.agent('creator'),
    });

    expect(writes).toHaveLength(1);
    expect(writes[0].data).toMatchObject({ versionNumber: 1, html: 'HEAD', savedBy: 'agent:creator' });
    expect(writes[0].data).not.toHaveProperty('reason');
  });

  it('subsequent snapshots number monotonically from the current max and never re-fold the legacy buffer', async () => {
    const { reportRef } = fakeReportRef();
    const tx = fakeTx(maxAt(5));

    // previousHtml is still present but history is non-empty → it must NOT be folded again.
    const writes = await stageVersionCapture(tx as never, reportRef as never, { html: 'HEAD6', previousHtml: 'STALE' }, {
      savedBy: reportSaver.user('u2'),
      reason: 'restore',
    });

    expect(writes).toHaveLength(1);
    expect(writes[0].data).toMatchObject({ versionNumber: 6, html: 'HEAD6', savedBy: 'user:u2', reason: 'restore' });
    expect(writes.some((w: StagedVersionWrite) => w.data.html === 'STALE')).toBe(false);
  });

  it('reads the HIGHEST existing version to number the next one (orderBy desc, limit 1)', async () => {
    // Guards strict monotonicity: the max-read must fetch the top of history, not
    // the bottom. A regression to orderBy(...,'asc') would read the lowest version,
    // mint a duplicate number, and break the never-lost-history invariant — this
    // assertion fails on that mutation even though the fake tx returns a fixed snap.
    const { reportRef, versionsCol } = fakeReportRef();
    const tx = fakeTx(maxAt(9));

    const writes = await stageVersionCapture(tx as never, reportRef as never, { html: 'HEAD10' }, {
      savedBy: reportSaver.user('u3'),
    });

    expect(versionsCol.orderBy).toHaveBeenCalledWith('versionNumber', 'desc');
    expect(versionsCol.limit).toHaveBeenCalledWith(1);
    // …and the number is derived as max + 1, not a fixed or bottom-of-history value.
    expect(writes[0].data).toMatchObject({ versionNumber: 10, html: 'HEAD10' });
  });

  it('defaults savedBy to unknown when the caller does not attribute the save', async () => {
    const { reportRef } = fakeReportRef();
    const tx = fakeTx(emptyMax);

    const writes = await stageVersionCapture(tx as never, reportRef as never, { html: 'X' }, {});

    expect(writes[0].data.savedBy).toBe(UNKNOWN_SAVER);
  });

  it('captures nothing when there is no outgoing html and no legacy buffer', async () => {
    const { reportRef } = fakeReportRef();
    const tx = fakeTx(emptyMax);

    const writes = await stageVersionCapture(tx as never, reportRef as never, {}, { savedBy: 'user:u1' });

    expect(writes).toHaveLength(0);
  });
});

describe('listReportVersions (DISC-014)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('projects metadata only (never selects html), orders newest-first, and maps each row', async () => {
    listGet.mockResolvedValue({
      docs: [
        {
          id: 'v-2',
          data: () => ({ versionNumber: 2, createdAt: '2026-07-14T02:00:00Z', savedBy: 'user:u1', htmlLength: 1200, reason: 'revision' }),
        },
        {
          id: 'v-1',
          data: () => ({ versionNumber: 1, createdAt: '2026-07-14T01:00:00Z', savedBy: 'unknown', htmlLength: 900 }),
        },
      ],
    });

    const versions = await listReportVersions('report-1');

    expect(versionsColMock.orderBy).toHaveBeenCalledWith('versionNumber', 'desc');
    // The html body must never be requested for the list surface.
    expect(versionsColMock.select).toHaveBeenCalledWith('versionNumber', 'createdAt', 'savedBy', 'reason', 'htmlLength');
    expect(versionsColMock.select.mock.calls[0]).not.toContain('html');
    expect(versions).toEqual([
      { versionId: 'v-2', versionNumber: 2, createdAt: '2026-07-14T02:00:00Z', savedBy: 'user:u1', htmlLength: 1200, reason: 'revision' },
      { versionId: 'v-1', versionNumber: 1, createdAt: '2026-07-14T01:00:00Z', savedBy: 'unknown', htmlLength: 900 },
    ]);
    expect(versions[1]).not.toHaveProperty('reason');
    expect(versions[0]).not.toHaveProperty('html');
  });

  it('throws on read failure rather than masking it as an empty history', async () => {
    listGet.mockRejectedValue(new Error('firestore down'));
    await expect(listReportVersions('report-1')).rejects.toThrow('firestore down');
  });
});

describe('getReportVersion (DISC-014)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the full version including html when it exists', async () => {
    versionDocGet.mockResolvedValue({
      exists: true,
      id: 'v-3',
      data: () => ({ versionNumber: 3, html: '<h1>v3</h1>', htmlLength: 11, createdAt: '2026-07-14T03:00:00Z', savedBy: 'agent:creator', reason: 'restore' }),
    });

    const version = await getReportVersion('report-1', 'v-3');

    expect(version).toEqual({
      versionId: 'v-3',
      versionNumber: 3,
      html: '<h1>v3</h1>',
      htmlLength: 11,
      createdAt: '2026-07-14T03:00:00Z',
      savedBy: 'agent:creator',
      reason: 'restore',
    });
  });

  it('returns null when the version does not exist', async () => {
    versionDocGet.mockResolvedValue({ exists: false, id: 'missing', data: () => null });
    await expect(getReportVersion('report-1', 'missing')).resolves.toBeNull();
  });
});

// ============================================================================
// REPORT-004 — immutable pre-revision capture + consecutive-duplicate dedupe
// ============================================================================

describe('REPORT-004 pre-revision capture', () => {
  const { stageVersionCapture } = require('../report-versions');

  it('stageVersionCapture skips appending when the newest stored version already holds the outgoing html', async () => {
    const tx = {
      get: jest.fn().mockResolvedValue({
        empty: false,
        docs: [{ id: 'ver-7', data: () => ({ versionNumber: 7, html: '<p>same</p>' }) }],
      }),
    };
    const reportRef = { collection: jest.fn(() => ({ orderBy: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis() })) };

    const writes = await stageVersionCapture(
      tx as never,
      reportRef as never,
      { html: '<p>same</p>' },
      { savedBy: 'agent:creator', reason: 'revision' }
    );

    expect(writes).toEqual([]);
  });

  it('stageVersionCapture still appends when the outgoing html differs from the newest version', async () => {
    const newDocRef = { id: 'ver-new' };
    const versionsCol = {
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      doc: jest.fn(() => newDocRef),
    };
    const tx = {
      get: jest.fn().mockResolvedValue({
        empty: false,
        docs: [{ id: 'ver-7', data: () => ({ versionNumber: 7, html: '<p>old</p>' }) }],
      }),
    };
    const reportRef = { collection: jest.fn(() => versionsCol) };

    const writes = await stageVersionCapture(
      tx as never,
      reportRef as never,
      { html: '<p>new head</p>' },
      { savedBy: 'agent:creator', reason: 'revision' }
    );

    expect(writes).toHaveLength(1);
    expect(writes[0].data).toMatchObject({ versionNumber: 8, html: '<p>new head</p>', savedBy: 'agent:creator' });
  });


});
