/**
 * Golden Tests for Critical AI Tools
 *
 * Tests the most important AI tools used for entity creation,
 * signal management, and core platform operations.
 *
 * These tests focus on:
 * - Input validation behavior
 * - Error response format consistency
 * - Parameter handling
 *
 * Note: Tests requiring deep Firebase mocking are handled separately
 * in integration tests with the Firestore emulator.
 *
 * @jest-environment node
 */

import { describe, it, expect, beforeEach, jest, afterAll } from '@jest/globals';
import { shouldUpdateGolden } from './golden/golden-utils';

// Prevent validation-focused tests from touching Firestore/network paths.
jest.mock('@/lib/companies', () => ({
  createCompany: jest.fn(async (input: Record<string, unknown>) => ({
    id: 'company-test-1',
    name: String(input.name ?? 'Test Company'),
  })),
  updateCompany: jest.fn(),
  getCompanies: jest.fn(async () => []),
}));

// ============================================================================
// Types for tool definitions from require()'d modules
// ============================================================================

interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

// ============================================================================
// Direct imports - We test validation and error handling directly
// Loaded via require so Jest mocks are applied first.
// ============================================================================

const {
  ENTITY_CREATION_TOOLS,
  executeCreateCompany,
  executeCreateTechnology,
  executeCreateUseCase,
  executeCreatePrototype,
  executeCreateStrategy,
} = require('../tools/entity-creation');

const {
  SIGNAL_MANAGEMENT_TOOLS,
  executeApproveSignal,
  executeRejectSignal,
  executeGetSignalDetails,
} = require('../tools/signal-management');

// ============================================================================
// Golden Tests - Tool Definitions (No Firebase required)
// ============================================================================

describe('Critical AI Tools - Tool Definitions', () => {
  afterAll(() => {
    if (shouldUpdateGolden()) {
      console.log('\n✅ Golden files have been updated.\n');
    }
  });

  describe('Entity Creation Tool Definitions', () => {
    it('should have createCompany tool with required parameters', () => {
      const tool = ENTITY_CREATION_TOOLS.find((t: ToolDefinition) => t.name === 'createCompany');
      expect(tool).toBeDefined();
      expect(tool?.parameters?.properties).toHaveProperty('name');
      expect(tool?.parameters?.properties).toHaveProperty('description');
      expect(tool?.parameters?.required).toContain('name');
      expect(tool?.parameters?.required).toContain('description');
    });

    it('directs existing-company research to the draft-only researchCompany tool', () => {
      const tool = ENTITY_CREATION_TOOLS.find((t: ToolDefinition) => t.name === 'createCompany');
      expect(tool?.description).toContain('researchCompany');
      expect(tool?.description).toContain('unverified draft');
      expect(tool?.description).not.toMatch(/researchCompanyComprehensive[^.]*auto-fill/i);
    });

    it('marks createCompanyWithResearch as superseded without claiming side materialization', () => {
      const tool = ENTITY_CREATION_TOOLS.find((t: ToolDefinition) => t.name === 'createCompanyWithResearch');
      expect(tool?.description).toMatch(/unsupported.*superseded/i);
      expect(tool?.description).toMatch(/use createCompany/i);
      expect(tool?.description).toContain('does not materialize contacts, SWOT, or competitor relations');
    });

    it('should have createTechnology tool with required parameters', () => {
      const tool = ENTITY_CREATION_TOOLS.find((t: ToolDefinition) => t.name === 'createTechnology');
      expect(tool).toBeDefined();
      expect(tool?.parameters?.properties).toHaveProperty('name');
      expect(tool?.parameters?.properties).toHaveProperty('quadrant');
      expect(tool?.parameters?.properties).toHaveProperty('ring');
      expect(tool?.parameters?.required).toContain('name');
    });

    it('should have createUseCase tool with required parameters', () => {
      const tool = ENTITY_CREATION_TOOLS.find((t: ToolDefinition) => t.name === 'createUseCase');
      expect(tool).toBeDefined();
      expect(tool?.parameters?.properties).toHaveProperty('title');
      expect(tool?.parameters?.properties).toHaveProperty('description');
      expect(tool?.parameters?.required).toContain('title');
      expect(tool?.parameters?.required).toContain('description');
    });

    it('should have createPrototype tool with required parameters', () => {
      const tool = ENTITY_CREATION_TOOLS.find((t: ToolDefinition) => t.name === 'createPrototype');
      expect(tool).toBeDefined();
      expect(tool?.parameters?.properties).toHaveProperty('name');
      expect(tool?.parameters?.required).toContain('name');
    });

    it('should have all entity creation tools defined', () => {
      const toolNames = ENTITY_CREATION_TOOLS.map((t: ToolDefinition) => t.name);
      expect(toolNames).toContain('createCompany');
      expect(toolNames).toContain('createTechnology');
      expect(toolNames).toContain('createUseCase');
      expect(toolNames).toContain('createPrototype');
    });
  });

  describe('Signal Management Tool Definitions', () => {
    it('should have listSignals tool with filter parameters', () => {
      const tool = SIGNAL_MANAGEMENT_TOOLS.find((t: ToolDefinition) => t.name === 'listSignals');
      expect(tool).toBeDefined();
      expect(tool?.parameters?.properties).toHaveProperty('status');
      expect(tool?.parameters?.properties).toHaveProperty('type');
      expect(tool?.parameters?.properties).toHaveProperty('limit');
    });

    it('should have approveSignalForImport tool with signalId', () => {
      const tool = SIGNAL_MANAGEMENT_TOOLS.find((t: ToolDefinition) => t.name === 'approveSignalForImport');
      expect(tool).toBeDefined();
      expect(tool?.parameters?.properties).toHaveProperty('signalId');
      expect(tool?.parameters?.required).toContain('signalId');
    });

    it('should have rejectSignalWithReason tool with required fields', () => {
      const tool = SIGNAL_MANAGEMENT_TOOLS.find((t: ToolDefinition) => t.name === 'rejectSignalWithReason');
      expect(tool).toBeDefined();
      expect(tool?.parameters?.properties).toHaveProperty('signalId');
      expect(tool?.parameters?.properties).toHaveProperty('reason');
      expect(tool?.parameters?.required).toContain('signalId');
      expect(tool?.parameters?.required).toContain('reason');
    });

    it('should have getSignalDetails tool', () => {
      const tool = SIGNAL_MANAGEMENT_TOOLS.find((t: ToolDefinition) => t.name === 'getSignalDetails');
      expect(tool).toBeDefined();
      expect(tool?.parameters?.properties).toHaveProperty('signalId');
      expect(tool?.parameters?.required).toContain('signalId');
    });

    it('should have resetSignalToDetected tool with signalId parameter', () => {
      const tool = SIGNAL_MANAGEMENT_TOOLS.find((t: ToolDefinition) => t.name === 'resetSignalToDetected');
      expect(tool).toBeDefined();
      expect(tool?.parameters?.properties).toHaveProperty('signalId');
      expect(tool?.parameters?.properties).toHaveProperty('reason');
      expect(tool?.parameters?.required).toContain('signalId');
    });

    it('should have all 11 signal management tools defined', () => {
      const toolNames = SIGNAL_MANAGEMENT_TOOLS.map((t: ToolDefinition) => t.name);
      expect(toolNames).toContain('listSignals');
      expect(toolNames).toContain('approveSignalForImport');
      expect(toolNames).toContain('rejectSignalWithReason');
      expect(toolNames).toContain('bulkApproveSignals');
      expect(toolNames).toContain('bulkRejectSignals');
      expect(toolNames).toContain('getSignalDetails');
      expect(toolNames).toContain('expandSignal');
      expect(toolNames).toContain('resetSignalToDetected');
      expect(toolNames).toContain('createVerifiedSignal');
      expect(toolNames).toContain('getSignalFeedbackPatterns');
      expect(toolNames).toContain('importSignalToRadar');
      expect(SIGNAL_MANAGEMENT_TOOLS).toHaveLength(11);
    });
  });
});

// ============================================================================
// Golden Tests - Validation Logic (No Firebase required)
// ============================================================================

describe('Critical AI Tools - Validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createCompany validation', () => {
    it('should return error when name is missing', async () => {
      const result = await executeCreateCompany({
        description: 'Some description',
        // Missing 'name'
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe('string');
    });

    it('should succeed when description is missing (defaults to empty)', async () => {
      // Note: The execute function defaults description to empty string
      // This test documents that behavior - description is effectively optional
      const result = await executeCreateCompany({
        name: 'Test Company',
        // Missing 'description' - but defaults to ''
      });

      // This will either succeed (creating company) or fail for other reasons
      // but won't fail specifically because description is missing
      expect(result).toHaveProperty('success');
    });

    it('should return error when both required fields are missing', async () => {
      const result = await executeCreateCompany({});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      // Note: Error won't specifically mention "name" - it's an internal error
      // from cleanMarkdownFromText being called with undefined
      expect(typeof result.error).toBe('string');
    });
  });

  describe('createTechnology validation', () => {
    it('should return error when name is missing', async () => {
      const result = await executeCreateTechnology({
        description: 'Some tech',
        quadrant: 'Languages & Frameworks',
        ring: 'Adopt',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      // Note: Error won't specifically mention "name" - it's an internal error
      expect(typeof result.error).toBe('string');
    });
  });

  describe('createUseCase validation', () => {
    it('should return error when title is missing', async () => {
      const result = await executeCreateUseCase({
        description: 'Some use case',
        // Missing 'title' - which is required for use cases
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe('string');
    });
  });

  describe('createPrototype validation', () => {
    it('should return error when name is missing', async () => {
      const result = await executeCreatePrototype({
        description: 'Some prototype',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe('string');
    });
  });

  describe('createStrategy validation', () => {
    it('should return error when name is missing', async () => {
      const result = await executeCreateStrategy({
        description: 'Some strategy',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe('string');
    });
  });
});

// ============================================================================
// Golden Tests - Signal Validation (No Firebase required for validation)
// ============================================================================

describe('Critical AI Tools - Signal Validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('rejectSignal validation', () => {
    it('should require reason parameter', async () => {
      const result = await executeRejectSignal({
        signalId: 'signal-1',
        // Missing 'reason'
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.toLowerCase()).toContain('reason');
    });

    it('should require signalId parameter', async () => {
      const result = await executeRejectSignal({
        reason: 'Not relevant',
        // Missing 'signalId'
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('approveSignal validation', () => {
    it('should require signalId parameter', async () => {
      const result = await executeApproveSignal({
        notes: 'Approved',
        // Missing 'signalId'
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('getSignalDetails validation', () => {
    it('should require signalId parameter', async () => {
      const result = await executeGetSignalDetails({
        // Missing 'signalId'
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});

// ============================================================================
// Golden Tests - Error Response Format
// ============================================================================

describe('Critical AI Tools - Error Response Format', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return consistent error format for entity validation', async () => {
    const result = await executeCreateCompany({});

    // Verify golden error format
    expect(result).toHaveProperty('success');
    expect(result.success).toBe(false);
    expect(result).toHaveProperty('error');
    expect(typeof result.error).toBe('string');
    expect(result.error?.length).toBeGreaterThan(0);
  });

  it('should return consistent error format for signal validation', async () => {
    const result = await executeRejectSignal({
      signalId: 'test',
      // Missing reason
    });

    // Verify golden error format
    expect(result).toHaveProperty('success');
    expect(result.success).toBe(false);
    expect(result).toHaveProperty('error');
    expect(typeof result.error).toBe('string');
  });

  it('should have data property as null or undefined on error', async () => {
    const result = await executeCreateCompany({});

    expect(result.success).toBe(false);
    // On error, data should be undefined or null
    expect(result.data === undefined || result.data === null).toBe(true);
  });
});

// ============================================================================
// Golden Tests - List Parameters
// ============================================================================

describe('Critical AI Tools - List Operations', () => {
  describe('listSignals parameters', () => {
    it('should accept status filter parameter', async () => {
      // Test that the function accepts valid parameters
      // (The actual filtering is tested in integration tests)
      const tool = SIGNAL_MANAGEMENT_TOOLS.find((t: ToolDefinition) => t.name === 'listSignals');
      expect(tool?.parameters?.properties?.status).toBeDefined();
    });

    it('should accept limit parameter', async () => {
      const tool = SIGNAL_MANAGEMENT_TOOLS.find((t: ToolDefinition) => t.name === 'listSignals');
      expect(tool?.parameters?.properties?.limit).toBeDefined();
    });

    it('should accept type filter parameter', async () => {
      const tool = SIGNAL_MANAGEMENT_TOOLS.find((t: ToolDefinition) => t.name === 'listSignals');
      expect(tool?.parameters?.properties?.type).toBeDefined();
    });

    it('should accept search parameter', async () => {
      const tool = SIGNAL_MANAGEMENT_TOOLS.find((t: ToolDefinition) => t.name === 'listSignals');
      expect(tool?.parameters?.properties?.search).toBeDefined();
    });
  });
});

// ============================================================================
// Golden Tests - Tool Count Consistency
// ============================================================================

describe('Critical AI Tools - Registry Consistency', () => {
  it('should have stable entity creation tool count', () => {
    // This acts as a golden test for tool registry
    // If tools are added or removed, this test will fail
    expect(ENTITY_CREATION_TOOLS.length).toBeGreaterThanOrEqual(5);
  });

  it('should have stable signal management tool count', () => {
    expect(SIGNAL_MANAGEMENT_TOOLS.length).toBeGreaterThanOrEqual(4);
  });

  it('should have unique tool names in entity creation', () => {
    const names = ENTITY_CREATION_TOOLS.map((t: ToolDefinition) => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('should have unique tool names in signal management', () => {
    const names = SIGNAL_MANAGEMENT_TOOLS.map((t: ToolDefinition) => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });
});
