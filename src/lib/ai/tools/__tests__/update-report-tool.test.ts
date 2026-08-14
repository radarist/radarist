/**
 * @jest-environment node
 *
 * Regression guard for the AI-Assistant report-edit break: executeUpdateReport's
 * editInstruction path rewrites the WHOLE report HTML in one Gemini call. It used
 * the default 8192-token output cap, which truncated any real report (~69KB) →
 * the content-loss guard then rejected the edit. The fix sizes the output budget
 * to the report and preserves the brand page-theme block.
 */

export {}; // mark as a module so top-level test mocks don't collide in tsc's global scope

const mockGet = jest.fn();
const mockUpdate = jest.fn();
const mockDoc = jest.fn(() => ({ get: mockGet, update: mockUpdate }));

jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('@/lib/firebase-admin', () => ({
  __esModule: true,
  db: { collection: jest.fn(() => ({ doc: mockDoc })) },
}));
jest.mock('firebase/firestore', () => ({ __esModule: true }));
// DISC-014: executeUpdateReport delegates its write to reports.ts updateReport
// (transactional version capture lives there), so the write is asserted on the
// mocked updateReport, not a direct db.update.
jest.mock('@/lib/reports', () => ({
  __esModule: true,
  upsertReportBySlot: jest.fn(),
  updateReport: jest.fn(),
  restoreReportVersion: jest.fn(),
  getReportOwnedBy: jest.fn(),
  listReportsOwnedBy: jest.fn(),
  // Real pure derivation — the executor reports the persisted state through it.
  reportLifecycleState: jest.requireActual('@/lib/schemas/report').reportLifecycleState,
}));
jest.mock('@/lib/html-sanitizer', () => ({
  __esModule: true,
  sanitizeHtml: (s: string) => s,
  sanitizeReportHtml: (s: string) => s,
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const mockGenerateContent = jest.fn();
jest.mock('@/lib/ai/client', () => ({
  __esModule: true,
  generateContent: (...args: unknown[]) => mockGenerateContent(...args),
}));
jest.mock('@/lib/ai/model-config', () => ({ __esModule: true, geminiProModel: () => 'gemini-3.1-pro-preview' }));

const { executeUpdateReport } = require('../report-tools');
const { updateReport: mockUpdateReport, getReportOwnedBy: mockGetReportOwnedBy } = jest.requireMock('@/lib/reports');

// A realistic report: 4 sections, ~40KB — far over the old 8192-token default.
const HEADINGS = '<h1>Title</h1>\n<h2>One</h2>\n<h2>Two</h2>\n<h2>Three</h2>';
const CURRENT_HTML = `<!doctype html><html><head><style data-design-pass="page-theme">:root{--bg:#fff;--ink:#222}</style></head><body>${HEADINGS}${'<p>Body paragraph text. </p>'.repeat(1500)}</body></html>`;
const EXPECTED_CAP = Math.min(65536, Math.max(16384, Math.ceil(CURRENT_HTML.length / 2)));

beforeEach(() => {
  jest.clearAllMocks();
  // SEC-009: the executor's owner preflight + edit source both come from the
  // service boundary read, not a direct Firestore read.
  mockGetReportOwnedBy.mockResolvedValue({ id: 'report-x', ownerId: 'u1', html: CURRENT_HTML });
});

const CTX = { userId: 'u1' };

describe('executeUpdateReport — editInstruction path', () => {
  it('sizes the output-token budget to the report (not the 8192 default that truncated)', async () => {
    // Model returns the full doc with all sections + the requested addition.
    mockGenerateContent.mockResolvedValue(
      CURRENT_HTML.replace('<h2>Three</h2>', '<h2>Three</h2>\n<h2>Added</h2><p>new</p>')
    );

    const res = await executeUpdateReport({ reportId: 'report-x', editInstruction: 'add a summary section' }, CTX);

    expect(res.success).toBe(true);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    const opts = mockGenerateContent.mock.calls[0][1] as { maxOutputTokens?: number };
    expect(opts.maxOutputTokens).toBe(EXPECTED_CAP);
    expect(opts.maxOutputTokens! > 8192).toBe(true); // the truncating default is gone
    // DISC-014: the write is delegated to reports.ts updateReport with the html
    // and the acting user as savedBy (so the edit is captured into history).
    expect(mockUpdateReport).toHaveBeenCalledWith('report-x', expect.objectContaining({ html: expect.any(String) }), {
      savedBy: 'user:u1',
      requireOwnerId: 'u1',
    });
  });

  it('instructs the model to preserve the brand page-theme block + :root variables', async () => {
    mockGenerateContent.mockResolvedValue(CURRENT_HTML);

    await executeUpdateReport({ reportId: 'report-x', editInstruction: 'tighten the wording' }, CTX);

    const prompt = mockGenerateContent.mock.calls[0][0] as string;
    expect(prompt).toMatch(/data-design-pass="page-theme"/);
    expect(prompt).toMatch(/:root CSS variables/i);
  });

  it('still rejects a genuinely truncated/lost-content rewrite (guard intact)', async () => {
    // Model returns a stub that lost almost all content.
    mockGenerateContent.mockResolvedValue('<!doctype html><html><body><h1>Title</h1></body></html>');

    await expect(executeUpdateReport({ reportId: 'report-x', editInstruction: 'add a section' }, CTX)).rejects.toThrow(
      /content was lost|rejected/i
    );
    expect(mockUpdateReport).not.toHaveBeenCalled(); // original report untouched
  });
});

describe('executeUpdateReport — description path', () => {
  // The tool now hands a structured `metadata: { description }` to reports.ts
  // updateReport, which owns the dotted-path/whole-map-clobber protection (proven
  // in reports.test.ts). Here we assert the delegation carries the right shape.
  it('delegates a metadata-only description edit to updateReport with savedBy', async () => {
    const res = await executeUpdateReport({ reportId: 'report-x', description: 'fresh description' }, CTX);

    expect(res.success).toBe(true);
    expect(mockGenerateContent).not.toHaveBeenCalled(); // no AI edit involved
    expect(mockUpdateReport).toHaveBeenCalledWith(
      'report-x',
      { metadata: { description: 'fresh description' } },
      { savedBy: 'user:u1', requireOwnerId: 'u1' }
    );
  });
});
