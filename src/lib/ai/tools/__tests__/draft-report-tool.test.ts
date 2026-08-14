/**
 * @jest-environment node
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveDesignBrief } from '@/lib/schemas/design-brief';
import { buildEvidenceProvenanceReceipt } from '@/lib/reports/evidence-provenance';

jest.mock('node:fs/promises');
jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('@/lib/firebase-admin', () => ({ db: {} }));
jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(),
  doc: jest.fn(() => ({ id: 'doc-id' })),
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  query: jest.fn(),
  orderBy: jest.fn(),
}));
jest.mock('@/lib/reports', () => ({
  __esModule: true,
  createReport: jest.fn(),
}));
jest.mock('@/lib/html-sanitizer', () => ({
  __esModule: true,
  sanitizeHtml: (html: string) => html,
  sanitizeReportHtml: (html: string) => html,
}));
jest.mock('@/lib/reports/final-export', () => ({
  __esModule: true,
  buildFinalReportExport: jest.fn(async (html: string) => ({
    html: `<!doctype html><html><body>${html}</body></html>`,
    bytes: Buffer.byteLength(`<!doctype html><html><body>${html}</body></html>`, 'utf8'),
    sha256: 'a'.repeat(64),
    cssSha256: 'b'.repeat(64),
  })),
}));

const { executeDraftReport } = require('../report-tools');

describe('executeDraftReport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.REPORT_COMPOSER_MODE;
  });

  afterEach(() => {
    delete process.env.REPORT_COMPOSER_MODE;
  });

  it('writes html under os.tmpdir/impulse-missions/<missionId>/<slotName>.html', async () => {
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

    const result = await executeDraftReport({ slotName: 'main', html: '<p>hi</p>' }, { missionId: 'mission-1' });

    // Drafts write under the OS temp dir (not the project tree) so the Next dev
    // file-watcher can't reload the server mid-mission — see 313f6a68.
    expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining(path.join('impulse-missions', 'mission-1')), {
      recursive: true,
    });
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining(path.join('impulse-missions', 'mission-1', 'main.html')),
      '<p>hi</p>',
      'utf-8'
    );
    expect(result.success).toBe(true);
    expect(result.path).toContain('main.html');
    expect(result.bytesWritten).toBe(9);
  });

  it('rejects when missionId is missing from context', async () => {
    const result = await executeDraftReport({ slotName: 'main', html: '<p>x</p>' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/missionId/);
  });

  it('rejects when slotName is invalid (not kebab-case)', async () => {
    const result = await executeDraftReport({ slotName: 'Main_Slot', html: '<p>x</p>' }, { missionId: 'm1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/slotName/i);
  });

  it('rejects when missionId contains path-traversal segments', async () => {
    const result = await executeDraftReport({ slotName: 'main', html: '<p>x</p>' }, { missionId: '../../etc' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/path escape|invalid/i);
  });

  it('overwrites existing draft (idempotent)', async () => {
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

    await executeDraftReport({ slotName: 'main', html: '<p>v1</p>' }, { missionId: 'm1' });
    await executeDraftReport({ slotName: 'main', html: '<p>v2</p>' }, { missionId: 'm1' });

    expect(fs.writeFile).toHaveBeenCalledTimes(2);
    const path1 = (fs.writeFile as jest.Mock).mock.calls[0][0];
    const path2 = (fs.writeFile as jest.Mock).mock.calls[1][0];
    expect(path1).toBe(path2);
  });

  it('rejects blocks while template mode is off before writing or deleting either sibling', async () => {
    const blocks = JSON.stringify({
      title: 'Valid blocks doc',
      blocks: [
        { type: 'section', label: 'S', title: 'S' },
        { type: 'prose', body: 'x' },
        { type: 'prose', body: 'y' },
      ],
    });

    const result = await executeDraftReport({ slotName: 'main', blocks }, { missionId: 'mission-legacy-1' });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.stringMatching(/template mode is disabled.*html/i),
      })
    );
    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it('binds a rich-executive figure plan to persisted bundle ids before writing', async () => {
    const stored = new Map<string, string>();
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fs.writeFile as jest.Mock).mockImplementation(async (file: string, value: string) => {
      stored.set(String(file), String(value));
    });
    (fs.readFile as jest.Mock).mockImplementation(async (file: string) => {
      const value = stored.get(String(file));
      if (value === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return value;
    });
    (fs.rm as jest.Mock).mockImplementation(async (file: string) => {
      stored.delete(String(file));
    });
    const evidenceBundle = {
      queries: ['q1', 'q2', 'q3'],
      sources: [
        {
          id: 1,
          title: 'Source',
          url: 'https://example.com/source',
          fetched_via: 'exa' as const,
          tool_call_id: 'call-1',
          admiralty: 'A1',
          date_accessed: '2026-08-05',
        },
      ],
      findings: ['A supported finding [1].'],
      unresolved: [],
    };
    const figurePlan = JSON.stringify([
      {
        figureId: 'fig-supported',
        readerQuestion: 'What does the supported evidence show?',
        visualKind: 's-curve',
        findingIds: [1],
        sourceIds: [1],
      },
    ]);
    const result = await executeDraftReport(
      {
        slotName: 'main',
        title: 'Evidence-bound report',
        html:
          '<html><body><p>Supported claim [1].</p>' +
          '<figure data-figure-id="fig-supported"><svg></svg></figure>' +
          '<ol><li id="ref-1">https://example.com/source</li></ol></body></html>',
        figurePlan,
      },
      {
        missionId: 'mission-rich-1',
        userId: 'u',
        slots: [{ name: 'main', intent: 'report' }],
        evidenceBundle,
        evidenceProvenance: buildEvidenceProvenanceReceipt({
          sourceMissionId: 'mission-scout-1',
          bundle: evidenceBundle,
          graphDerivedChecked: 0,
          eligibleGraphSourceIds: [],
          withheldAbsentSourceIds: [],
          withheldUnavailableSourceIds: [],
        }),
        designBrief: { ...resolveDesignBrief('u'), visualAmbition: 'rich-executive' },
      }
    );

    expect(result.success).toBe(true);
    expect(result.figurePlanSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.exportSha256).toBe('a'.repeat(64));
    expect(result.exportRevisionNumber).toBe(0);
    const htmlWrite = (fs.writeFile as jest.Mock).mock.calls.find(([file]) => String(file).endsWith('main.html'));
    expect(htmlWrite?.[1]).toContain('data-source-ids="1"');
    expect(htmlWrite?.[1]).toContain('Evidence: findings F1; sources [1].');
    expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining('main.figure-plan.json'), expect.any(String), 'utf-8');
  });

  it('fails closed before writing when a rich-executive research draft omits figurePlan', async () => {
    const result = await executeDraftReport(
      { slotName: 'main', html: '<html><body>Report</body></html>' },
      {
        missionId: 'mission-rich-2',
        evidenceBundle: {
          queries: ['q1', 'q2', 'q3'],
          sources: [
            {
              id: 1,
              title: 'Source',
              url: 'https://example.com/source',
              fetched_via: 'exa',
              tool_call_id: 'call-1',
              admiralty: 'A1',
              date_accessed: '2026-08-05',
            },
          ],
          findings: ['A supported finding [1].'],
          unresolved: [],
        },
        designBrief: { ...resolveDesignBrief('u'), visualAmbition: 'rich-executive' },
      }
    );
    expect(result).toEqual(expect.objectContaining({ success: false, error: expect.stringMatching(/require figurePlan/) }));
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Adversarial review fix (2026-07-20): one ACTIVE draft per slot — a newer
// html draft deletes the sibling blocks draft (the REVISE flow edits exact
// HTML; a stale blocks file must never shadow it) and vice versa.
// ---------------------------------------------------------------------------
describe('draft supersession (T2.6 fix)', () => {
  const ctx = { missionId: 'mission-supersede-1' };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REPORT_COMPOSER_MODE = 'template';
  });

  afterEach(() => {
    delete process.env.REPORT_COMPOSER_MODE;
  });

  it('an html draft removes the sibling blocks draft', async () => {
    await executeDraftReport({ slotName: 'main', html: '<html><body>revised</body></html>' }, ctx);
    expect(fs.rm).toHaveBeenCalledWith(expect.stringContaining('main.blocks.json'), { force: true });
  });

  it('a blocks draft removes the sibling html draft', async () => {
    const blocks = JSON.stringify({
      title: 'Valid blocks doc',
      blocks: [
        { type: 'section', label: 'S', title: 'S' },
        { type: 'prose', body: 'x' },
        { type: 'prose', body: 'y' },
      ],
    });
    await executeDraftReport({ slotName: 'main', blocks }, ctx);
    expect(fs.rm).toHaveBeenCalledWith(expect.stringContaining('main.html'), { force: true });
  });
});
