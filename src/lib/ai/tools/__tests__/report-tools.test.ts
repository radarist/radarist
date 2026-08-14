/**
 * @jest-environment node
 */

// ============================================================================
// Mocks
// ============================================================================

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
  upsertReportBySlot: jest.fn(),
}));

jest.mock('@/lib/html-sanitizer', () => ({
  __esModule: true,
  sanitizeHtml: jest.fn(),
}));

const { sanitizeHtml: mockSanitizeHtml } = jest.requireMock('@/lib/html-sanitizer');

// ============================================================================
// Imports
// ============================================================================

import { REPORT_TOOLS } from '../report-tools';

// ============================================================================
// Tests
// ============================================================================

describe('Report Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: sanitizeHtml returns the input
    mockSanitizeHtml.mockImplementation((html: string) => html);
  });

  // --------------------------------------------------------------------------
  // Phase C — createAndSaveReport alias removed
  // --------------------------------------------------------------------------
  describe('createAndSaveReport (Phase C — removed)', () => {
    it('is no longer exported as a tool declaration', () => {
      expect(REPORT_TOOLS.find((t) => t.name === 'createAndSaveReport')).toBeUndefined();
    });

    it('returns "unknown tool" when called via executeTool', async () => {
      const { executeTool } = require('../../tools');
      const result = await executeTool({ name: 'createAndSaveReport', args: {} }, { userId: 'u1' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/unknown tool|not registered/i);
    });
  });

  describe('deleteReport declaration', () => {
    it('documents the exact-phrase human gate and explicit machine confirmation', () => {
      const declaration = REPORT_TOOLS.find((tool) => tool.name === 'deleteReport');

      expect(declaration?.description).toMatch(/exact action-bound confirmation phrase/i);
      expect(declaration?.description).toMatch(/confirmed=true/i);
      expect(declaration?.parameters?.properties).toHaveProperty('confirmed');
      expect(declaration?.parameters?.required).toEqual(['reportId']);
    });
  });

  describe('draftReport mode contract', () => {
    it('states that legacy HTML is the default and blocks require an explicit template-mode instruction', () => {
      const declaration = REPORT_TOOLS.find((tool) => tool.name === 'draftReport');
      const html = declaration?.parameters?.properties?.html;
      const blocks = declaration?.parameters?.properties?.blocks;
      const figurePlan = declaration?.parameters?.properties?.figurePlan;

      expect(declaration?.description).toMatch(/legacy html is the default/i);
      expect(html?.description).toMatch(/required when template mode is off/i);
      expect(blocks?.description).toMatch(/only when.*report authoring mode.*template/i);
      expect(blocks?.description).toMatch(/rejected/i);
      expect(figurePlan?.description).toMatch(/findingIds.*sourceIds/i);
      expect(figurePlan?.description).toMatch(/persisted filtered research bundle/i);
      expect(figurePlan?.description).toMatch(/battle acceptance only/i);
      expect(declaration?.parameters?.required).toEqual(['slotName', 'html']);
    });

    it('requires only slotName when template mode is explicitly enabled', () => {
      const previousMode = process.env.REPORT_COMPOSER_MODE;

      try {
        process.env.REPORT_COMPOSER_MODE = 'template';
        jest.isolateModules(() => {
          const { REPORT_TOOLS: templateReportTools } = require('../report-tools');
          const declaration = templateReportTools.find(
            (tool: { name: string }) => tool.name === 'draftReport'
          );

          expect(declaration?.parameters?.required).toEqual(['slotName']);
        });
      } finally {
        if (previousMode === undefined) {
          delete process.env.REPORT_COMPOSER_MODE;
        } else {
          process.env.REPORT_COMPOSER_MODE = previousMode;
        }
      }
    });
  });
});
