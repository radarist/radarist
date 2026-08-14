/**
 * @jest-environment node
 */

// ============================================================================
// Mocks
// ============================================================================

jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(),
  doc: jest.fn(() => ({ id: 'doc-id' })),
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
}));

const mockGetCompanyById = jest.fn();
const mockUpdateCompany = jest.fn();
const mockGetCompanies = jest.fn();
jest.mock('@/lib/companies-admin', () => ({
  __esModule: true,
  adminGetCompanyById: (...args: unknown[]) => mockGetCompanyById(...args),
  adminUpdateCompany: (...args: unknown[]) => mockUpdateCompany(...args),
  adminGetCompanies: (...args: unknown[]) => mockGetCompanies(...args),
}));

const mockCreateNote = jest.fn();
jest.mock('@/lib/company-notes-admin', () => ({
  __esModule: true,
  adminCreateNote: (...args: unknown[]) => mockCreateNote(...args),
}));

const mockGetTechnologies = jest.fn();
jest.mock('@/lib/technology-admin', () => ({
  __esModule: true,
  adminGetTechnologies: (...args: unknown[]) => mockGetTechnologies(...args),
}));

const mockGetUseCases = jest.fn();
jest.mock('@/lib/use-cases-admin', () => ({
  __esModule: true,
  adminGetUseCases: (...args: unknown[]) => mockGetUseCases(...args),
}));

const mockEmitDataRefresh = jest.fn();
jest.mock('@/lib/events/data-refresh', () => ({
  __esModule: true,
  emitDataRefresh: (...args: unknown[]) => mockEmitDataRefresh(...args),
}));

const mockResearchCompanyComprehensive = jest.fn();
const mockRefreshCompanyResearchSection = jest.fn();
jest.mock('@/ai/flows/research-company-comprehensive', () => ({
  __esModule: true,
  researchCompanyComprehensive: (...args: unknown[]) => mockResearchCompanyComprehensive(...args),
  refreshCompanyResearchSection: (...args: unknown[]) => mockRefreshCompanyResearchSection(...args),
}));

const mockDiscoverRelations = jest.fn();
jest.mock('@/ai/flows/discover-relations', () => ({
  __esModule: true,
  discoverRelations: (...args: unknown[]) => mockDiscoverRelations(...args),
}));

// ============================================================================
// Imports
// ============================================================================

import {
  COMPANY_TOOLS,
  executeResearchCompany,
  executeDiscoverCompanyRelations,
  executeAddCompanyNote,
  executeUpdateCompanyResearch,
} from '../company-tools';

// ============================================================================
// Tests
// ============================================================================

describe('Company Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // executeResearchCompany
  // --------------------------------------------------------------------------
  describe('executeResearchCompany', () => {
    const mockCompany = {
      id: 'c1',
      name: 'Acme Corp',
      website: 'https://acme.com',
      description: 'A tech company',
      research: null,
    };

    it('should perform full research and save to company', async () => {
      mockGetCompanyById.mockResolvedValue(mockCompany);
      const mockResearch = {
        executiveSummary: { overview: 'Great company' },
        lastResearched: Date.now(),
      };
      mockResearchCompanyComprehensive.mockResolvedValue(mockResearch);
      mockUpdateCompany.mockResolvedValue(undefined);

      const result = await executeResearchCompany({ companyId: 'c1' });

      expect(result.success).toBe(true);
      expect(result.data?.companyId).toBe('c1');
      expect(result.data?.companyName).toBe('Acme Corp');
      expect(result.data?.savedToCompany).toBe(true);
      expect(result.data?.researchStatus).toBe('draft');
      expect(result.data?.sourceReviewRequired).toBe(true);
      expect(result.data?.citationsVerified).toBe(false);
      expect(mockUpdateCompany).toHaveBeenCalledWith('c1', { research: mockResearch });
      expect(mockResearchCompanyComprehensive).toHaveBeenCalledWith({
        name: 'Acme Corp',
        website: 'https://acme.com',
        description: 'A tech company',
      });
    });

    it('should research specific sections only', async () => {
      mockGetCompanyById.mockResolvedValue(mockCompany);
      const partialResearch = { financialsAndTraction: { totalFunding: '$50M' } };
      mockRefreshCompanyResearchSection.mockResolvedValue(partialResearch);
      mockUpdateCompany.mockResolvedValue(undefined);

      const result = await executeResearchCompany({
        companyId: 'c1',
        sections: ['financialsAndTraction'],
      });

      expect(result.success).toBe(true);
      expect(mockRefreshCompanyResearchSection).toHaveBeenCalled();
      expect(mockResearchCompanyComprehensive).not.toHaveBeenCalled();
    });

    it('should filter invalid sections', async () => {
      mockGetCompanyById.mockResolvedValue(mockCompany);
      mockRefreshCompanyResearchSection.mockResolvedValue({});
      mockUpdateCompany.mockResolvedValue(undefined);

      await executeResearchCompany({
        companyId: 'c1',
        sections: ['executiveSummary', 'invalidSection'],
      });

      expect(mockRefreshCompanyResearchSection).toHaveBeenCalledWith(expect.any(Object), ['executiveSummary']);
    });

    it('should not save when saveToCompany is false', async () => {
      mockGetCompanyById.mockResolvedValue(mockCompany);
      mockResearchCompanyComprehensive.mockResolvedValue({ lastResearched: Date.now() });

      const result = await executeResearchCompany({
        companyId: 'c1',
        saveToCompany: false,
      });

      expect(result.success).toBe(true);
      expect(result.data?.savedToCompany).toBe(false);
      expect(mockUpdateCompany).not.toHaveBeenCalled();
    });

    it('should return error for non-existent company', async () => {
      mockGetCompanyById.mockResolvedValue(null);

      const result = await executeResearchCompany({ companyId: 'missing' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should handle research errors gracefully', async () => {
      mockGetCompanyById.mockResolvedValue(mockCompany);
      mockResearchCompanyComprehensive.mockRejectedValue(new Error('AI service down'));

      const result = await executeResearchCompany({ companyId: 'c1' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('AI service down');
    });
  });

  it('declares researchCompany as an unverified draft tool, not profile auto-fill', () => {
    const declaration = COMPANY_TOOLS.find((tool) => tool.name === 'researchCompany');
    expect(declaration?.description).toMatch(/AI draft/i);
    expect(declaration?.description).toMatch(/source review required/i);
    expect(declaration?.description).not.toMatch(/auto-populates the company profile/i);
  });

  // --------------------------------------------------------------------------
  // executeDiscoverCompanyRelations
  // --------------------------------------------------------------------------
  describe('executeDiscoverCompanyRelations', () => {
    const mockCompany = {
      id: 'c1',
      name: 'Acme Corp',
      description: 'AI platform',
    };

    it('should discover relations across all entity types', async () => {
      mockGetCompanyById.mockResolvedValue(mockCompany);
      mockGetCompanies.mockResolvedValue([{ id: 'c2', name: 'CompetitorCo', description: 'Competitor' }]);
      mockGetTechnologies.mockResolvedValue([{ id: 'tech-1', name: 'React', description: 'UI lib' }]);
      mockGetUseCases.mockResolvedValue([{ id: 'uc-1', title: 'Analytics', description: 'Data analytics' }]);
      mockDiscoverRelations.mockResolvedValue({
        suggestions: [
          {
            targetEntity: { id: 'c2', name: 'CompetitorCo', type: 'company' },
            relationType: 'competes_with',
            confidence: 0.8,
            reasoning: 'Both are AI platforms',
          },
        ],
      });

      const result = await executeDiscoverCompanyRelations({ companyId: 'c1' });

      expect(result.success).toBe(true);
      expect(result.data?.suggestions).toHaveLength(1);
      expect(result.data?.candidateCount).toBe(3);
    });

    it('should filter by target types', async () => {
      mockGetCompanyById.mockResolvedValue(mockCompany);
      mockGetTechnologies.mockResolvedValue([{ id: 'tech-1', name: 'React', description: 'UI lib' }]);
      mockDiscoverRelations.mockResolvedValue({ suggestions: [] });

      const result = await executeDiscoverCompanyRelations({
        companyId: 'c1',
        targetTypes: ['technology'],
      });

      expect(result.success).toBe(true);
      expect(mockGetCompanies).not.toHaveBeenCalled();
      expect(mockGetUseCases).not.toHaveBeenCalled();
    });

    it('should exclude the source company from candidates', async () => {
      mockGetCompanyById.mockResolvedValue(mockCompany);
      mockGetCompanies.mockResolvedValue([
        { id: 'c1', name: 'Acme Corp', description: 'Self' },
        { id: 'c2', name: 'Other', description: 'Other company' },
      ]);
      mockDiscoverRelations.mockResolvedValue({ suggestions: [] });

      const result = await executeDiscoverCompanyRelations({
        companyId: 'c1',
        targetTypes: ['company'],
      });

      expect(result.data?.candidateCount).toBe(1);
    });

    it('should return empty suggestions when no candidates', async () => {
      mockGetCompanyById.mockResolvedValue(mockCompany);
      mockGetCompanies.mockResolvedValue([{ id: 'c1', name: 'Acme Corp' }]);

      const result = await executeDiscoverCompanyRelations({
        companyId: 'c1',
        targetTypes: ['company'],
      });

      expect(result.success).toBe(true);
      expect(result.data?.suggestions).toEqual([]);
      expect(result.data?.candidateCount).toBe(0);
      expect(mockDiscoverRelations).not.toHaveBeenCalled();
    });

    it('should return error for non-existent company', async () => {
      mockGetCompanyById.mockResolvedValue(null);

      const result = await executeDiscoverCompanyRelations({ companyId: 'missing' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should handle AI errors gracefully', async () => {
      mockGetCompanyById.mockResolvedValue(mockCompany);
      mockGetCompanies.mockRejectedValue(new Error('DB error'));

      const result = await executeDiscoverCompanyRelations({ companyId: 'c1' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('DB error');
    });
  });

  // --------------------------------------------------------------------------
  // executeAddCompanyNote
  // --------------------------------------------------------------------------
  describe('executeAddCompanyNote', () => {
    it('should add a meeting note', async () => {
      mockGetCompanyById.mockResolvedValue({ id: 'c1', name: 'Acme Corp' });
      mockCreateNote.mockResolvedValue({
        id: 'note-1',
        type: 'Meeting',
        createdAt: 1700000000000,
      });

      const result = await executeAddCompanyNote({
        companyId: 'c1',
        content: 'Met with CEO to discuss partnership',
        type: 'Meeting',
      });

      expect(result.success).toBe(true);
      expect(result.data?.noteId).toBe('note-1');
      expect(result.data?.type).toBe('Meeting');
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('companies', 'ai-assistant');
    });

    it('should reject invalid note type', async () => {
      const result = await executeAddCompanyNote({
        companyId: 'c1',
        content: 'test',
        type: 'InvalidType',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid note type');
    });

    it('should return error for non-existent company', async () => {
      mockGetCompanyById.mockResolvedValue(null);

      const result = await executeAddCompanyNote({
        companyId: 'missing',
        content: 'test',
        type: 'General',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should handle note creation errors', async () => {
      mockGetCompanyById.mockResolvedValue({ id: 'c1', name: 'Acme Corp' });
      mockCreateNote.mockRejectedValue(new Error('Write error'));

      const result = await executeAddCompanyNote({
        companyId: 'c1',
        content: 'test',
        type: 'Email',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Write error');
    });
  });

  // --------------------------------------------------------------------------
  // executeUpdateCompanyResearch
  // --------------------------------------------------------------------------
  describe('executeUpdateCompanyResearch', () => {
    const mockCompany = {
      id: 'c1',
      name: 'Acme Corp',
      website: 'https://acme.com',
      description: 'Tech co',
      research: {
        executiveSummary: { overview: 'Old data' },
        lastResearched: 1700000000000,
      },
    };

    it('should refresh specified sections', async () => {
      mockGetCompanyById.mockResolvedValue(mockCompany);
      mockRefreshCompanyResearchSection.mockResolvedValue({
        financialsAndTraction: { totalFunding: '$100M' },
      });
      mockUpdateCompany.mockResolvedValue(undefined);

      const result = await executeUpdateCompanyResearch({
        companyId: 'c1',
        sections: ['financialsAndTraction'],
      });

      expect(result.success).toBe(true);
      expect(result.data?.updatedSections).toEqual(['financialsAndTraction']);
      expect(result.data?.lastResearched).toBeDefined();
      expect(result.data).toEqual(
        expect.objectContaining({
          researchStatus: 'draft',
          sourceReviewRequired: true,
          citationsVerified: false,
        })
      );
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('companies', 'ai-assistant');
    });

    it('should reject when no sections provided', async () => {
      const result = await executeUpdateCompanyResearch({
        companyId: 'c1',
        sections: [],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('least one section');
    });

    it('should reject invalid section names', async () => {
      const result = await executeUpdateCompanyResearch({
        companyId: 'c1',
        sections: ['bogusSection'],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid sections');
    });

    it('should return error for non-existent company', async () => {
      mockGetCompanyById.mockResolvedValue(null);

      const result = await executeUpdateCompanyResearch({
        companyId: 'missing',
        sections: ['executiveSummary'],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should handle refresh errors', async () => {
      mockGetCompanyById.mockResolvedValue(mockCompany);
      mockRefreshCompanyResearchSection.mockRejectedValue(new Error('AI quota exceeded'));

      const result = await executeUpdateCompanyResearch({
        companyId: 'c1',
        sections: ['executiveSummary'],
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('AI quota exceeded');
    });
  });
});
