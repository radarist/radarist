/**
 * @file lib/__tests__/reports.test.ts
 * @description Unit tests for Report service (TDD)
 *
 * Tests cover:
 * - createReport: validates input, stores doc, generates ID
 * - getReportById: returns report when found, null when not found
 * - listReports: returns sorted array, handles empty state
 * - Validation: rejects empty title, rejects empty html
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { createFirebaseAdminMock, fakeDocSnapshot, fakeQuerySnapshot } from './helpers/firebase-admin-mock';
import { updateReportSchema } from '../schemas/report';

const { adminMock } = createFirebaseAdminMock();

// updateReport / upsertReportBySlot / restoreReportVersion run read-capture-write
// inside db.runTransaction (DISC-014). The shared mock's transaction delegates
// tx.get(ref) → ref.get(), so a report read resolves from `docGet` and the
// version max-number read from the versions subcollection's `subGet`; tx writes
// hit `transactionUpdate` (head swap) and `transactionSet` (version capture).
const { runTransaction, transactionUpdate, transactionSet, subGet, subDocGet } = adminMock;

jest.mock('@/lib/firebase-admin', () => ({ db: adminMock.db }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// Import AFTER mocks are set up
const {
  createReport,
  getReportById,
  getLatestReportByMissionId,
  listReports,
  updateReport,
  restoreReportVersion,
  reportsBelongToOwner,
  deleteReport,
  deleteReports,
} = require('../reports');

// ============================================================================
// Test Data
// ============================================================================

const validReportInput = {
  title: 'Q1 Technology Radar Report',
  html: '<html><body><h1>Report</h1></body></html>',
  createdBy: 'agent' as const,
  agentType: 'creator',
  missionId: 'mission-123',
  entityIds: ['tech-1', 'tech-2'],
  metadata: {
    description: 'Quarterly technology radar overview',
    ogImage: 'https://example.com/og.png',
    dataSnapshotAt: '2026-02-23T10:00:00Z',
  },
};

const storedReport = {
  id: 'report-abc123',
  ...validReportInput,
  createdAt: '2026-02-23T10:00:00.000Z',
};

// ============================================================================
// Tests
// ============================================================================

describe('ReportService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // createReport
  // --------------------------------------------------------------------------
  describe('createReport', () => {
    it('should create a report with correct fields and generated ID', async () => {
      adminMock.set.mockResolvedValue(undefined);

      const result = await createReport(validReportInput);

      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(typeof result.id).toBe('string');
      expect(result.id.length).toBeGreaterThan(0);
      expect(result.title).toBe(validReportInput.title);
      expect(result.html).toBe(validReportInput.html);
      expect(result.createdBy).toBe('agent');
      expect(result.agentType).toBe('creator');
      expect(result.missionId).toBe('mission-123');
      expect(result.entityIds).toEqual(['tech-1', 'tech-2']);
      expect(result.metadata.description).toBe('Quarterly technology radar overview');
      expect(result.createdAt).toBeDefined();
      expect(typeof result.createdAt).toBe('string');

      // Verify setDoc was called
      expect(adminMock.set).toHaveBeenCalledTimes(1);
    });

    it('should create a report with minimal fields (no optional fields)', async () => {
      adminMock.set.mockResolvedValue(undefined);

      const minimalInput = {
        title: 'Minimal Report',
        html: '<p>Hello</p>',
        createdBy: 'user' as const,
        entityIds: [],
        metadata: {
          description: 'A basic report',
          dataSnapshotAt: '2026-02-23T10:00:00Z',
        },
      };

      const result = await createReport(minimalInput);

      expect(result.title).toBe('Minimal Report');
      expect(result.createdBy).toBe('user');
      expect(result.agentType).toBeUndefined();
      expect(result.missionId).toBeUndefined();
      expect(result.entityIds).toEqual([]);
    });

    it('should reject empty title', async () => {
      const invalidInput = {
        ...validReportInput,
        title: '',
      };

      await expect(createReport(invalidInput)).rejects.toThrow();
    });

    it('should reject empty html', async () => {
      const invalidInput = {
        ...validReportInput,
        html: '',
      };

      await expect(createReport(invalidInput)).rejects.toThrow();
    });

    it('should reject invalid createdBy value', async () => {
      const invalidInput = {
        ...validReportInput,
        createdBy: 'robot',
      };

      await expect(createReport(invalidInput)).rejects.toThrow();
    });

    it('should reject title exceeding 200 characters', async () => {
      const invalidInput = {
        ...validReportInput,
        title: 'A'.repeat(201),
      };

      await expect(createReport(invalidInput)).rejects.toThrow();
    });

    it('should reject missing metadata description', async () => {
      const invalidInput = {
        ...validReportInput,
        metadata: {
          ...validReportInput.metadata,
          description: '',
        },
      };

      await expect(createReport(invalidInput)).rejects.toThrow();
    });

    it('should reject invalid ogImage URL', async () => {
      const invalidInput = {
        ...validReportInput,
        metadata: {
          ...validReportInput.metadata,
          ogImage: 'not-a-url',
        },
      };

      await expect(createReport(invalidInput)).rejects.toThrow();
    });

    // H3 — writer-side enforcement of report→mission linkage. Agent-authored
    // reports MUST come from a mission orchestrator turn and therefore must
    // carry a missionId. User-authored reports remain unconstrained.
    it('should reject agent-authored reports without missionId (H3)', async () => {
      const invalidInput = {
        ...validReportInput,
        createdBy: 'agent' as const,
        missionId: undefined,
      };

      await expect(createReport(invalidInput)).rejects.toThrow(/missionId/);
    });

    it('should accept user-authored reports without missionId (H3)', async () => {
      adminMock.set.mockResolvedValue(undefined);

      const validUserInput = {
        ...validReportInput,
        createdBy: 'user' as const,
        missionId: undefined,
      };

      const result = await createReport(validUserInput);
      expect(result).toBeDefined();
      expect(result.createdBy).toBe('user');
      expect(result.missionId).toBeUndefined();
    });

    it('should default entityIds to empty array if not provided', async () => {
      adminMock.set.mockResolvedValue(undefined);

      const inputWithoutEntityIds = {
        title: 'No Entities Report',
        html: '<p>Test</p>',
        createdBy: 'user' as const,
        metadata: {
          description: 'Report without entity IDs',
          dataSnapshotAt: '2026-02-23T10:00:00Z',
        },
      };

      const result = await createReport(inputWithoutEntityIds);
      expect(result.entityIds).toEqual([]);
    });

    // P-B14 trade-off, pinned as INTENTIONAL behavior: titles are plain text,
    // so entities are ALWAYS decoded on write — a user deliberately titling a
    // report with the literal string "&amp;" gets "&" instead. Intentional
    // entity-literals are not preserved (documented in decode-html-entities.ts).
    it('should decode HTML entities in the title on write — even deliberate entity-literals', async () => {
      adminMock.set.mockResolvedValue(undefined);

      const result = await createReport({
        ...validReportInput,
        title: 'Escaping guide: use &amp; for ampersands',
      });

      expect(result.title).toBe('Escaping guide: use & for ampersands');
      const storedData = adminMock.set.mock.calls[0][0];
      expect(storedData.title).toBe('Escaping guide: use & for ampersands');
    });
  });

  // --------------------------------------------------------------------------
  // getReportById
  // --------------------------------------------------------------------------
  describe('getReportById', () => {
    it('should return report when found', async () => {
      adminMock.docGet.mockResolvedValue(fakeDocSnapshot(storedReport, storedReport.id));

      const result = await getReportById('report-abc123');

      expect(result).toBeDefined();
      expect(result!.id).toBe('report-abc123');
      expect(result!.title).toBe('Q1 Technology Radar Report');
      expect(result!.html).toBe('<html><body><h1>Report</h1></body></html>');
      expect(result!.createdBy).toBe('agent');
    });

    it('should return null when report not found', async () => {
      adminMock.docGet.mockResolvedValue(fakeDocSnapshot(null));

      const result = await getReportById('nonexistent-id');
      expect(result).toBeNull();
    });

    it('should call get on the reports collection doc ref', async () => {
      adminMock.docGet.mockResolvedValue(fakeDocSnapshot(null));

      await getReportById('report-xyz');

      expect(adminMock.collection).toHaveBeenCalledWith('reports');
      expect(adminMock.doc).toHaveBeenCalledWith('report-xyz');
    });

    // P-B14 read-boundary decode: docs stored before the writer-side decode
    // shipped carry HTML-entity-encoded titles. getReportById feeds the detail
    // header AND the share page (tab title / OG / JSON-LD / h1), so the decode
    // must happen here — once — not per-consumer.
    it('should decode HTML entities in the title of a pre-fix stored doc', async () => {
      adminMock.docGet.mockResolvedValue(
        fakeDocSnapshot(
          {
            ...storedReport,
            title: 'The Agentic PKG Harness V2 — Architecture, MCP &amp; The Production Reality Check',
          },
          storedReport.id
        )
      );

      const result = await getReportById('report-abc123');

      expect(result!.title).toBe('The Agentic PKG Harness V2 — Architecture, MCP & The Production Reality Check');
    });

    it('should decode single-pass only — stored "&amp;amp;" comes back as "&amp;", not "&"', async () => {
      adminMock.docGet.mockResolvedValue(
        fakeDocSnapshot({ ...storedReport, title: 'Double-escaped: &amp;amp;' }, storedReport.id)
      );

      const result = await getReportById('report-abc123');

      expect(result!.title).toBe('Double-escaped: &amp;');
    });
  });

  // --------------------------------------------------------------------------
  // listReports
  // --------------------------------------------------------------------------
  describe('listReports', () => {
    it('should return array of reports', async () => {
      const reports = [
        { ...storedReport, id: 'report-1', createdAt: '2026-02-23T12:00:00Z' },
        { ...storedReport, id: 'report-2', createdAt: '2026-02-23T10:00:00Z' },
      ];

      adminMock.get.mockResolvedValue(fakeQuerySnapshot(reports));

      const result = await listReports();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('report-1');
      expect(result[1].id).toBe('report-2');
    });

    it('should return empty array when no reports exist', async () => {
      adminMock.get.mockResolvedValue(fakeQuerySnapshot([]));

      const result = await listReports();

      expect(result).toEqual([]);
      expect(result).toHaveLength(0);
    });

    it('should use orderBy for createdAt desc ordering', async () => {
      adminMock.get.mockResolvedValue(fakeQuerySnapshot([]));

      await listReports();

      expect(adminMock.collection).toHaveBeenCalled();
      expect(adminMock.orderBy).toHaveBeenCalledWith('createdAt', 'desc');
    });

    // REPORT-001: the catalog lists final published artifacts only — a
    // design-failing `needs-review` draft is withheld. Missing status →
    // published (back-compat with every pre-REPORT-001 report).
    it('excludes needs-review drafts but keeps published and legacy (unstamped) reports', async () => {
      const reports = [
        { ...storedReport, id: 'published-report', reviewStatus: 'published' },
        { ...storedReport, id: 'needs-review-report', reviewStatus: 'needs-review' },
        { ...storedReport, id: 'legacy-report' }, // no reviewStatus → published (back-compat)
      ];
      adminMock.get.mockResolvedValue(fakeQuerySnapshot(reports));

      const result = await listReports();

      const ids = result.map((r: { id: string }) => r.id);
      expect(ids).toEqual(['published-report', 'legacy-report']);
      expect(ids).not.toContain('needs-review-report');
    });

    // T2-21: the list payload must not carry the (potentially megabyte-scale)
    // html/previousHtml bodies — list UIs render metadata only; the detail
    // path (getReportById) serves full content.
    it('should strip html and previousHtml from list items but keep every other field', async () => {
      const reports = [
        {
          ...storedReport,
          id: 'report-1',
          previousHtml: '<p>old version</p>',
          slotName: 'main-report',
          shared: true,
          updatedAt: '2026-06-01T00:00:00Z',
          ownerId: 'user-1',
        },
      ];
      adminMock.get.mockResolvedValue(fakeQuerySnapshot(reports));

      const result = await listReports();

      expect(result).toHaveLength(1);
      expect(result[0]).not.toHaveProperty('html');
      expect(result[0]).not.toHaveProperty('previousHtml');
      // Everything else survives the projection.
      expect(result[0]).toMatchObject({
        id: 'report-1',
        title: storedReport.title,
        createdBy: 'agent',
        agentType: 'creator',
        missionId: 'mission-123',
        slotName: 'main-report',
        shared: true,
        updatedAt: '2026-06-01T00:00:00Z',
        ownerId: 'user-1',
        entityIds: ['tech-1', 'tech-2'],
      });
      expect(result[0].metadata.description).toBe(storedReport.metadata.description);
    });

    // P-B14 read-boundary decode: listReports feeds the reports table, the
    // agent log's linked-report chip, and client-side search + sort in
    // useReportsPage — all of which must see the decoded plain-text title so
    // display, searching "&", and sort order agree.
    it('should decode HTML entities in titles of pre-fix stored docs', async () => {
      const reports = [
        { ...storedReport, id: 'report-1', title: 'MCP &amp; The Production Reality Check' },
        { ...storedReport, id: 'report-2', title: 'Clean Title' },
      ];
      adminMock.get.mockResolvedValue(fakeQuerySnapshot(reports));

      const result = await listReports();

      expect(result[0].title).toBe('MCP & The Production Reality Check');
      expect(result[1].title).toBe('Clean Title');
    });
  });

  // --------------------------------------------------------------------------
  // getLatestReportByMissionId (mission-result salvage path)
  // --------------------------------------------------------------------------
  describe('getLatestReportByMissionId', () => {
    it('returns the most-recently-created report for the mission', async () => {
      const reports = [
        { ...storedReport, id: 'report-old', createdAt: '2026-02-23T10:00:00Z' },
        { ...storedReport, id: 'report-new', createdAt: '2026-02-23T12:00:00Z' },
      ];
      adminMock.get.mockResolvedValue(fakeQuerySnapshot(reports));

      const result = await getLatestReportByMissionId('mission-123');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('report-new'); // newest by createdAt, not query order
      expect(adminMock.where).toHaveBeenCalledWith('missionId', '==', 'mission-123');
    });

    it('returns null when no report matches the mission', async () => {
      adminMock.get.mockResolvedValue(fakeQuerySnapshot([]));
      expect(await getLatestReportByMissionId('mission-none')).toBeNull();
    });

    it('returns null (never throws) when the query fails — it runs on a recovery path', async () => {
      adminMock.get.mockRejectedValue(new Error('firestore unavailable'));
      await expect(getLatestReportByMissionId('mission-x')).resolves.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // updateReportSchema validation
  // --------------------------------------------------------------------------
  describe('updateReportSchema', () => {
    it('should accept valid partial update with title only', () => {
      const result = updateReportSchema.safeParse({ title: 'New Title' });
      expect(result.success).toBe(true);
    });

    it('should accept valid partial update with shared only', () => {
      const result = updateReportSchema.safeParse({ shared: true });
      expect(result.success).toBe(true);
    });

    it('should accept valid partial update with html only', () => {
      const result = updateReportSchema.safeParse({ html: '<h1>Updated</h1>' });
      expect(result.success).toBe(true);
    });

    it('should reject empty title', () => {
      const result = updateReportSchema.safeParse({ title: '' });
      expect(result.success).toBe(false);
    });

    it('should reject empty html', () => {
      const result = updateReportSchema.safeParse({ html: '' });
      expect(result.success).toBe(false);
    });

    it('should accept empty object (no changes)', () => {
      const result = updateReportSchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // updateReport
  // --------------------------------------------------------------------------
  describe('updateReport', () => {
    it('should call getDoc to verify report exists', async () => {
      adminMock.docGet.mockResolvedValue(
        fakeDocSnapshot({
          id: 'report-1',
          title: 'Old Title',
          html: '<p>old</p>',
          createdAt: '2026-01-01',
          createdBy: 'agent',
          shared: false,
          entityIds: [],
          metadata: { description: 'desc', dataSnapshotAt: '2026-01-01' },
        })
      );
      adminMock.update.mockResolvedValue(undefined);
      await updateReport('report-1', { title: 'New Title' });
      expect(adminMock.docGet).toHaveBeenCalled();
    });

    it('should throw if report not found', async () => {
      adminMock.docGet.mockResolvedValue(fakeDocSnapshot(null));
      await expect(updateReport('nonexistent', { title: 'x' })).rejects.toThrow('Report not found');
    });

    it('should call updateDoc with validated fields and updatedAt', async () => {
      adminMock.docGet.mockResolvedValue(
        fakeDocSnapshot({
          id: 'report-1',
          title: 'Old',
          html: '<p>old</p>',
          createdAt: '2026-01-01',
          createdBy: 'agent',
          shared: false,
          entityIds: [],
          metadata: { description: 'desc', dataSnapshotAt: '2026-01-01' },
        })
      );
      adminMock.update.mockResolvedValue(undefined);
      await updateReport('report-1', { title: 'Updated', shared: true });
      expect(transactionUpdate).toHaveBeenCalled();
      const updateCall = transactionUpdate.mock.calls[0][1];
      expect(updateCall.title).toBe('Updated');
      expect(updateCall.shared).toBe(true);
      expect(updateCall.updatedAt).toBeDefined();
    });

    it('should return the merged report', async () => {
      const existing = {
        id: 'report-1',
        title: 'Old',
        html: '<p>old</p>',
        createdAt: '2026-01-01',
        createdBy: 'agent',
        shared: false,
        entityIds: [],
        metadata: { description: 'desc', dataSnapshotAt: '2026-01-01' },
      };
      adminMock.docGet.mockResolvedValue(fakeDocSnapshot(existing));
      adminMock.update.mockResolvedValue(undefined);
      const result = await updateReport('report-1', { title: 'New' });
      expect(result.title).toBe('New');
      expect(result.html).toBe('<p>old</p>');
    });

    it('should reject invalid update input', async () => {
      await expect(updateReport('report-1', { title: '' })).rejects.toThrow();
    });

    // Regression: a description-only metadata update previously replaced the
    // whole metadata map, erasing dataSnapshotAt (set at insert) and ogImage.
    it('should write metadata.description as a dotted path so dataSnapshotAt/ogImage survive', async () => {
      const existing = {
        id: 'report-1',
        title: 'Old',
        html: '<p>old</p>',
        createdAt: '2026-01-01',
        createdBy: 'agent',
        shared: false,
        entityIds: [],
        metadata: {
          description: 'old desc',
          dataSnapshotAt: '2026-01-01T00:00:00Z',
          ogImage: 'https://example.com/og.png',
        },
      };
      adminMock.docGet.mockResolvedValue(fakeDocSnapshot(existing));
      adminMock.update.mockResolvedValue(undefined);

      const result = await updateReport('report-1', { metadata: { description: 'new desc' } });

      const updateCall = transactionUpdate.mock.calls[0][1];
      expect(updateCall['metadata.description']).toBe('new desc');
      // The whole-map write is the clobber bug — it must not come back.
      expect(updateCall).not.toHaveProperty('metadata');
      // Merged return keeps the untouched metadata fields.
      expect(result.metadata.description).toBe('new desc');
      expect(result.metadata.dataSnapshotAt).toBe('2026-01-01T00:00:00Z');
      expect(result.metadata.ogImage).toBe('https://example.com/og.png');
    });

    it('should back up the outgoing html as previousHtml when html is updated', async () => {
      adminMock.docGet.mockResolvedValue(
        fakeDocSnapshot({
          id: 'report-1',
          title: 'Old',
          html: '<p>old</p>',
          createdAt: '2026-01-01',
          createdBy: 'agent',
          shared: false,
          entityIds: [],
          metadata: { description: 'desc', dataSnapshotAt: '2026-01-01' },
        })
      );
      adminMock.update.mockResolvedValue(undefined);

      await updateReport('report-1', { html: '<p>new</p>' });

      const updateCall = transactionUpdate.mock.calls[0][1];
      expect(updateCall.html).toBe('<p>new</p>');
      expect(updateCall.previousHtml).toBe('<p>old</p>');
    });

    it('should not write previousHtml when html is not part of the update', async () => {
      adminMock.docGet.mockResolvedValue(
        fakeDocSnapshot({
          id: 'report-1',
          title: 'Old',
          html: '<p>old</p>',
          createdAt: '2026-01-01',
          createdBy: 'agent',
          shared: false,
          entityIds: [],
          metadata: { description: 'desc', dataSnapshotAt: '2026-01-01' },
        })
      );
      adminMock.update.mockResolvedValue(undefined);

      await updateReport('report-1', { title: 'New Title' });

      const updateCall = transactionUpdate.mock.calls[0][1];
      expect(updateCall).not.toHaveProperty('previousHtml');
    });

    it('should NOT overwrite previousHtml on an idempotent same-value html write', async () => {
      // MISSION-002: the regression restore writes the original html back to
      // every snapshotted slot, including ones the revision never touched. When
      // the incoming html already equals the stored html, the one-step undo
      // buffer (which may hold a genuine earlier draft) must be preserved.
      adminMock.docGet.mockResolvedValue(
        fakeDocSnapshot({
          id: 'report-1',
          title: 'Same',
          html: '<p>identical</p>',
          previousHtml: '<p>a real earlier draft</p>',
          createdAt: '2026-01-01',
          createdBy: 'agent',
          shared: false,
          entityIds: [],
          metadata: { description: 'desc', dataSnapshotAt: '2026-01-01' },
        })
      );
      adminMock.update.mockResolvedValue(undefined);

      await updateReport('report-1', { html: '<p>identical</p>' });

      const updateCall = transactionUpdate.mock.calls[0][1];
      expect(updateCall.html).toBe('<p>identical</p>');
      // The undo buffer is untouched — no self-copy clobber.
      expect(updateCall).not.toHaveProperty('previousHtml');
    });

    // DISC-014 — version capture is atomic with the head swap.
    it('captures the outgoing html as a history version stamped with savedBy when html changes', async () => {
      adminMock.docGet.mockResolvedValue(
        fakeDocSnapshot({
          id: 'report-1',
          title: 'Old',
          html: '<p>old</p>',
          createdAt: '2026-01-01',
          createdBy: 'agent',
          shared: false,
          entityIds: [],
          metadata: { description: 'desc', dataSnapshotAt: '2026-01-01' },
        })
      );
      subGet.mockResolvedValue({ empty: true, docs: [] });

      await updateReport('report-1', { html: '<p>new</p>' }, { savedBy: 'agent:curator' });

      // The version write and the head swap both go through the transaction.
      expect(transactionSet).toHaveBeenCalledTimes(1);
      const versionDoc = transactionSet.mock.calls[0][1];
      expect(versionDoc).toMatchObject({
        versionNumber: 1,
        html: '<p>old</p>', // the outgoing (superseded) head
        savedBy: 'agent:curator',
        reason: 'edit',
      });
    });

    it('captures NO version on a metadata-only edit (html unchanged)', async () => {
      adminMock.docGet.mockResolvedValue(
        fakeDocSnapshot({
          id: 'report-1',
          title: 'Old',
          html: '<p>old</p>',
          createdAt: '2026-01-01',
          createdBy: 'agent',
          shared: false,
          entityIds: [],
          metadata: { description: 'desc', dataSnapshotAt: '2026-01-01' },
        })
      );

      await updateReport('report-1', { title: 'New Title' }, { savedBy: 'user:u1' });

      expect(transactionSet).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // restoreReportVersion
  // --------------------------------------------------------------------------
  describe('restoreReportVersion', () => {
    const editedReport = {
      id: 'report-1',
      title: 'Report',
      html: '<p>edited</p>',
      previousHtml: '<p>original</p>',
      createdAt: '2026-01-01',
      createdBy: 'agent',
      shared: false,
      entityIds: [],
      metadata: { description: 'desc', dataSnapshotAt: '2026-01-01' },
    };

    it('runs the read-capture-write inside a single admin-SDK transaction (no direct-ref write)', async () => {
      adminMock.docGet.mockResolvedValue(fakeDocSnapshot(editedReport));
      subGet.mockResolvedValue({ empty: true, docs: [] });

      await restoreReportVersion('report-1');

      expect(runTransaction).toHaveBeenCalledTimes(1);
      // The head swap goes through the transaction, never a direct doc ref (a
      // non-transactional regression would hit adminMock.update instead).
      expect(transactionUpdate).toHaveBeenCalledTimes(1);
      expect(adminMock.update).not.toHaveBeenCalled();
    });

    it('should swap html and previousHtml (restore is reversible) and bump updatedAt', async () => {
      adminMock.docGet.mockResolvedValue(fakeDocSnapshot(editedReport));
      subGet.mockResolvedValue({ empty: true, docs: [] });

      const result = await restoreReportVersion('report-1');

      // tx.update(ref, fields) — fields is the second arg.
      const updateCall = transactionUpdate.mock.calls[0][1];
      expect(updateCall.html).toBe('<p>original</p>');
      expect(updateCall.previousHtml).toBe('<p>edited</p>');
      expect(updateCall.updatedAt).toBeDefined();
      expect(result.html).toBe('<p>original</p>');
    });

    // DISC-014: restore ALSO snapshots the outgoing head into history so the
    // pre-restore state is never lost, even on the legacy previousHtml swap.
    it('snapshots the current head into version history on a legacy-buffer restore', async () => {
      adminMock.docGet.mockResolvedValue(fakeDocSnapshot(editedReport));
      subGet.mockResolvedValue({ empty: true, docs: [] });

      await restoreReportVersion('report-1', { savedBy: 'user:u1' });

      expect(transactionSet).toHaveBeenCalled();
      const versionDoc = transactionSet.mock.calls.at(-1)?.[1];
      expect(versionDoc.html).toBe('<p>edited</p>'); // the outgoing head
      expect(versionDoc.savedBy).toBe('user:u1');
      expect(versionDoc.reason).toBe('restore');
    });

    // DISC-014: point-in-time restore to a specific stored version.
    it('restores a specific version by id and keeps the outgoing head as the backup', async () => {
      adminMock.docGet.mockResolvedValue(fakeDocSnapshot(editedReport));
      subGet.mockResolvedValue({ empty: false, docs: [{ data: () => ({ versionNumber: 3 }) }] });
      subDocGet.mockResolvedValue({ exists: true, id: 'v-abc', data: () => ({ html: '<p>point-in-time</p>' }) });

      const result = await restoreReportVersion('report-1', { versionId: 'v-abc', savedBy: 'user:u1' });

      const updateCall = transactionUpdate.mock.calls[0][1];
      expect(updateCall.html).toBe('<p>point-in-time</p>');
      expect(updateCall.previousHtml).toBe('<p>edited</p>');
      expect(result.html).toBe('<p>point-in-time</p>');

      // The point-in-time branch must ALSO snapshot the current head into history
      // (the core no-data-loss invariant), not only the legacy-swap branch — a
      // regression that skips capture when versionId is set would drop the
      // pre-restore head from the append-only history. Assert it explicitly.
      expect(transactionSet).toHaveBeenCalled();
      const versionDoc = transactionSet.mock.calls.at(-1)?.[1];
      expect(versionDoc.html).toBe('<p>edited</p>'); // the outgoing head
      expect(versionDoc.versionNumber).toBe(4); // appended after the current max (3)
      expect(versionDoc.savedBy).toBe('user:u1');
      expect(versionDoc.reason).toBe('restore');
    });

    it('throws Version not found when the requested versionId does not resolve', async () => {
      adminMock.docGet.mockResolvedValue(fakeDocSnapshot(editedReport));
      subDocGet.mockResolvedValue({ exists: false, data: () => null });
      await expect(restoreReportVersion('report-1', { versionId: 'missing' })).rejects.toThrow('Version not found');
      expect(transactionUpdate).not.toHaveBeenCalled();
    });

    it('should throw Report not found when the report does not exist', async () => {
      adminMock.docGet.mockResolvedValue(fakeDocSnapshot(null));
      await expect(restoreReportVersion('nonexistent')).rejects.toThrow('Report not found');
      expect(transactionUpdate).not.toHaveBeenCalled();
    });

    it('should throw No previous version available when there is no backup', async () => {
      const { previousHtml: _previousHtml, ...withoutBackup } = editedReport;
      adminMock.docGet.mockResolvedValue(fakeDocSnapshot(withoutBackup));
      await expect(restoreReportVersion('report-1')).rejects.toThrow('No previous version available');
      expect(transactionUpdate).not.toHaveBeenCalled();
    });

    it('should propagate transaction failures (e.g. commit errors)', async () => {
      runTransaction.mockRejectedValueOnce(new Error('Firestore error'));
      await expect(restoreReportVersion('report-1')).rejects.toThrow('Firestore error');
    });
  });

  // --------------------------------------------------------------------------
  // reportsBelongToOwner
  // --------------------------------------------------------------------------
  describe('reportsBelongToOwner', () => {
    it('returns true only when every report exists and belongs to the requested user', async () => {
      adminMock.docGet
        .mockResolvedValueOnce(fakeDocSnapshot({ ownerId: 'user-1' }, 'report-1'))
        .mockResolvedValueOnce(fakeDocSnapshot({ ownerId: 'user-1' }, 'report-2'));

      await expect(reportsBelongToOwner(['report-1', 'report-2'], 'user-1')).resolves.toBe(true);
      expect(adminMock.doc).toHaveBeenNthCalledWith(1, 'report-1');
      expect(adminMock.doc).toHaveBeenNthCalledWith(2, 'report-2');
    });

    it.each([
      ['missing', null],
      ['other owner', { ownerId: 'user-2' }],
    ])('returns false for a %s report without mutating anything', async (_case, report) => {
      adminMock.docGet.mockResolvedValueOnce(fakeDocSnapshot(report));

      await expect(reportsBelongToOwner(['report-1'], 'user-1')).resolves.toBe(false);
      expect(adminMock.recursiveDelete).not.toHaveBeenCalled();
    });

    it('fails closed for empty IDs or owner context', async () => {
      await expect(reportsBelongToOwner([], 'user-1')).resolves.toBe(false);
      await expect(reportsBelongToOwner(['report-1'], '')).resolves.toBe(false);
      expect(adminMock.docGet).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // deleteReport
  // --------------------------------------------------------------------------
  describe('deleteReport', () => {
    it('should recursively delete the report and its version history', async () => {
      await deleteReport('report-1');
      expect(adminMock.doc).toHaveBeenCalledWith('report-1');
      expect(adminMock.recursiveDelete).toHaveBeenCalledTimes(1);
      expect(adminMock.recursiveDelete).toHaveBeenCalledWith(adminMock.doc.mock.results[0].value);
    });

    it('should propagate Firestore errors', async () => {
      adminMock.recursiveDelete.mockRejectedValueOnce(new Error('Firestore error'));
      await expect(deleteReport('report-1')).rejects.toThrow('Firestore error');
    });
  });

  // --------------------------------------------------------------------------
  // deleteReports (bulk)
  // --------------------------------------------------------------------------
  describe('deleteReports', () => {
    it('should recursively delete multiple reports and their version history', async () => {
      await deleteReports(['report-1', 'report-2', 'report-3']);
      expect(adminMock.recursiveDelete).toHaveBeenCalledTimes(3);
    });

    it('deduplicates ids before launching recursive deletes', async () => {
      await deleteReports(['report-1', 'report-1', 'report-2']);
      expect(adminMock.recursiveDelete).toHaveBeenCalledTimes(2);
      expect(adminMock.doc).toHaveBeenNthCalledWith(1, 'report-1');
      expect(adminMock.doc).toHaveBeenNthCalledWith(2, 'report-2');
    });

    it('should handle empty array', async () => {
      await deleteReports([]);
      expect(adminMock.recursiveDelete).not.toHaveBeenCalled();
    });
  });
});
