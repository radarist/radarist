/**
 * @jest-environment node
 *
 * Tests for signals-autopilot-admin — the narrow T1.3 admin-SDK helper used
 * by the expand-signal autopilot path. Mocks `@/lib/firebase-admin` with the
 * shared `createFirebaseAdminMock()` helper so the helper's reads/writes can
 * be inspected without touching real Firestore.
 */

import { createFirebaseAdminMock } from '@/lib/__tests__/helpers/firebase-admin-mock';

const { adminMock } = createFirebaseAdminMock();
jest.mock('@/lib/firebase-admin', () => ({ db: adminMock.db }));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

// `require` (not `import`) so the SUT loads AFTER `adminMock` is initialized.
// `import` hoists above the `const` and the jest.mock factory then references
// `adminMock` while it's still in the temporal dead zone.
const { autoApproveAndImportTechnology } = require('../signals-autopilot-admin');
const { signalAutoApplyFingerprint } = require('../signals/auto-apply-policy');

describe('autoApproveAndImportTechnology', () => {
  const signalData = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 'sig-1',
      title: 'Quantum Routing',
      description: 'Sub-microsecond packet routing on photonic hardware.',
      source: 'Original publication',
      url: 'https://original.example/quantum-routing',
      status: 'Validated',
      metadata: { agentId: 'scout-v1' },
      expandedContent: {
        entityProfile: {
          type: 'technology',
          summary: 'Photonic packet-routing technology.',
          keyFacts: ['Sub-microsecond routing'],
          recentDevelopments: ['New benchmark'],
        },
        sources: [
          { title: 'Independent source', url: 'https://evidence.example/quantum', verdict: 'confirming' },
        ],
        expandedAt: 1_700_000_000_000,
        expansionModel: 'test-model',
        expansionDuration: 50,
      },
      trustScore: {
        overall: 90,
        breakdown: { sourceReliability: 90, dataCompleteness: 90, corroboration: 90, aiConfidence: 90 },
        factors: ['grounded'],
      },
      ...overrides,
    }) as any;

  const signalSnapshot = (overrides: Record<string, unknown> = {}) => ({
    exists: true,
    data: () => signalData(overrides),
  });

  const authorizationFor = (overrides: Record<string, unknown> = {}) => ({
    expansionFingerprint: signalAutoApplyFingerprint(signalData(overrides)),
    threshold: 85,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    adminMock.transactionGet.mockReset();
    adminMock.transactionGet
      .mockResolvedValueOnce(signalSnapshot())
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ empty: true, docs: [] });
    adminMock.transactionSet.mockResolvedValue(undefined);
    adminMock.transactionUpdate.mockResolvedValue(undefined);
  });

  it('returns a deterministic technology entityId + entityType', async () => {
    const result = await autoApproveAndImportTechnology('sig-1', authorizationFor());
    expect(result.entityType).toBe('technology');
    expect(result.entityId).toMatch(/^tech-signal-[a-f0-9]{24}$/);
  });

  it('atomically approves and imports the signal in one transaction', async () => {
    await autoApproveAndImportTechnology('sig-1', authorizationFor());

    expect(adminMock.runTransaction).toHaveBeenCalledTimes(1);
    expect(adminMock.update).not.toHaveBeenCalled();
    expect(adminMock.set).not.toHaveBeenCalled();
    expect(adminMock.transactionUpdate).toHaveBeenCalledTimes(1);
    const update = adminMock.transactionUpdate.mock.calls[0][1];
    expect(update).toMatchObject({
      status: 'Imported',
      importedAs: expect.objectContaining({ type: 'technology' }),
    });
    expect(typeof update.reviewedAt).toBe('number');
    expect(typeof update.processedAt).toBe('number');
  });

  it('creates a technology doc with the signal title as the name', async () => {
    await autoApproveAndImportTechnology('sig-1', authorizationFor());

    expect(adminMock.transactionSet).toHaveBeenCalledTimes(1);
    const techDoc = adminMock.transactionSet.mock.calls[0][1];
    expect(techDoc).toMatchObject({
      name: 'Quantum Routing',
      slug: 'quantum-routing',
      description: 'Sub-microsecond packet routing on photonic hardware.',
      createdBy: 'scout-v1',
    });
    expect(techDoc.id).toMatch(/^tech-signal-/);
    expect(typeof techDoc.createdAt).toBe('number');
  });

  it('falls back to a default createdBy when signal has no agentId', async () => {
    adminMock.transactionGet.mockReset();
    adminMock.transactionGet
      .mockResolvedValueOnce(signalSnapshot({ metadata: undefined, title: 'X', description: '' }))
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ empty: true, docs: [] });
    const overrides = { metadata: undefined, title: 'X', description: '' };
    await autoApproveAndImportTechnology('sig-1', authorizationFor(overrides));
    const techDoc = adminMock.transactionSet.mock.calls[0][1];
    expect(techDoc.createdBy).toBe('signal-autopilot');
  });

  it('throws when the signal does not exist', async () => {
    adminMock.transactionGet.mockReset().mockResolvedValueOnce({ exists: false });
    await expect(autoApproveAndImportTechnology('missing-signal', authorizationFor())).rejects.toThrow(/Signal not found/);
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
    expect(adminMock.transactionUpdate).not.toHaveBeenCalled();
  });

  it('returns an existing completed import without writing again', async () => {
    adminMock.transactionGet.mockReset();
    adminMock.transactionGet
      .mockResolvedValueOnce(
        signalSnapshot({ importedAs: { type: 'technology', id: 'tech-existing' }, status: 'Imported' })
      )
      .mockResolvedValueOnce({ exists: true });

    await expect(autoApproveAndImportTechnology('sig-1', authorizationFor())).resolves.toEqual({
      entityId: 'tech-existing',
      entityType: 'technology',
    });
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
    expect(adminMock.transactionUpdate).not.toHaveBeenCalled();
  });

  it('repairs a legacy imported link whose technology document is missing atomically', async () => {
    const overrides = {
      importedAs: { type: 'technology', id: 'tech-existing' },
      status: 'Imported',
    };
    adminMock.transactionGet.mockReset();
    adminMock.transactionGet
      .mockResolvedValueOnce(signalSnapshot(overrides))
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ empty: true, docs: [] });

    const result = await autoApproveAndImportTechnology('sig-1', authorizationFor(overrides));

    expect(result.entityId).toBe('tech-existing');
    expect(adminMock.transactionSet.mock.calls[0][1]).toMatchObject({ id: 'tech-existing' });
    expect(adminMock.transactionUpdate.mock.calls[0][1]).toMatchObject({
      importedAs: { type: 'technology', id: 'tech-existing' },
    });
  });

  it('repairs an existing import link whose signal status never reached Imported', async () => {
    adminMock.transactionGet.mockReset();
    adminMock.transactionGet
      .mockResolvedValueOnce(
        signalSnapshot({ importedAs: { type: 'technology', id: 'tech-existing' }, status: 'Approved' })
      )
      .mockResolvedValueOnce({ exists: true });

    const overrides = { importedAs: { type: 'technology', id: 'tech-existing' }, status: 'Approved' };
    await autoApproveAndImportTechnology('sig-1', authorizationFor(overrides));

    expect(adminMock.transactionSet).not.toHaveBeenCalled();
    expect(adminMock.transactionUpdate.mock.calls[0][1]).toMatchObject({
      status: 'Imported',
      importedAs: { type: 'technology', id: 'tech-existing' },
    });
  });

  it('refuses to overwrite a signal imported as another entity type', async () => {
    adminMock.transactionGet.mockReset().mockResolvedValueOnce(
      signalSnapshot({ importedAs: { type: 'company', id: 'company-1' }, status: 'Imported' })
    );

    await expect(autoApproveAndImportTechnology('sig-1', authorizationFor())).rejects.toThrow(
      'already imported as company'
    );
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
    expect(adminMock.transactionUpdate).not.toHaveBeenCalled();
  });

  it.each(['Rejected', 'Archived'])('does not overwrite a concurrent %s decision', async (status) => {
    adminMock.transactionGet.mockReset().mockResolvedValueOnce(signalSnapshot({ status }));

    await expect(
      autoApproveAndImportTechnology('sig-1', authorizationFor())
    ).rejects.toThrow(`is ${status} and cannot be auto-applied`);
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
    expect(adminMock.transactionUpdate).not.toHaveBeenCalled();
  });

  it('rejects a stale expansion fingerprint inside the transaction', async () => {
    adminMock.transactionGet.mockReset().mockResolvedValueOnce(
      signalSnapshot({
        trustScore: {
          overall: 60,
          breakdown: { sourceReliability: 60, dataCompleteness: 60, corroboration: 20, aiConfidence: 60 },
          factors: ['changed'],
        },
      })
    );

    await expect(
      autoApproveAndImportTechnology('sig-1', authorizationFor())
    ).rejects.toThrow('changed after its auto-apply decision');
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
    expect(adminMock.transactionUpdate).not.toHaveBeenCalled();
  });

  it('rechecks corroboration instead of trusting a high persisted score', async () => {
    const overrides = {
      expandedContent: {
        ...signalData().expandedContent,
        sources: [],
      },
    };
    adminMock.transactionGet.mockReset().mockResolvedValueOnce(signalSnapshot(overrides));

    await expect(
      autoApproveAndImportTechnology('sig-1', authorizationFor(overrides))
    ).rejects.toThrow('insufficient-confirming-sources');
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
    expect(adminMock.transactionUpdate).not.toHaveBeenCalled();
  });

  it('rechecks that the persisted expansion represents a Technology', async () => {
    const overrides = {
      expandedContent: {
        ...signalData().expandedContent,
        entityProfile: { ...signalData().expandedContent.entityProfile, type: 'company' },
      },
    };
    adminMock.transactionGet.mockReset().mockResolvedValueOnce(signalSnapshot(overrides));

    await expect(
      autoApproveAndImportTechnology('sig-1', authorizationFor(overrides))
    ).rejects.toThrow('unsupported-entity-type');
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
    expect(adminMock.transactionUpdate).not.toHaveBeenCalled();
  });

  it('uses the same deterministic ID across retried invocations', async () => {
    const first = await autoApproveAndImportTechnology('sig-1', authorizationFor());
    adminMock.transactionGet.mockReset();
    adminMock.transactionGet
      .mockResolvedValueOnce(signalSnapshot())
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ empty: true, docs: [] });

    const second = await autoApproveAndImportTechnology('sig-1', authorizationFor());

    expect(second.entityId).toBe(first.entityId);
  });

  it('fails closed when the materialized Technology slug would be empty', async () => {
    const overrides = { title: '先端技術' };
    adminMock.transactionGet.mockReset();
    adminMock.transactionGet
      .mockResolvedValueOnce(signalSnapshot(overrides))
      .mockResolvedValueOnce({ exists: false });

    await expect(
      autoApproveAndImportTechnology('sig-1', authorizationFor(overrides))
    ).rejects.toThrow();
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
    expect(adminMock.transactionUpdate).not.toHaveBeenCalled();
  });

  it('fails closed when another Technology already owns the generated slug', async () => {
    adminMock.transactionGet.mockReset();
    adminMock.transactionGet
      .mockResolvedValueOnce(signalSnapshot())
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ empty: false, docs: [{ id: 'tech-other' }] });

    await expect(
      autoApproveAndImportTechnology('sig-1', authorizationFor())
    ).rejects.toThrow('A technology with slug "quantum-routing" already exists');
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
    expect(adminMock.transactionUpdate).not.toHaveBeenCalled();
  });
});
