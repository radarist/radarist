/**
 * Unit Tests for MCP Permissions
 *
 * Tests permission mapping and checking for MCP tools.
 *
 * @jest-environment node
 */

import {
  getToolPermissions,
  canExecuteTool,
  getAccessibleTools,
  categorizeToolsByPermission,
  describeToolPermissions,
  isMissionBoundTool,
  missionBoundToolGuidance,
  MISSION_BOUND_TOOLS,
  TOOL_PERMISSIONS,
} from '../permissions';

describe('MCP Permissions', () => {
  describe('getToolPermissions', () => {
    it('should return correct permissions for mapped tools', () => {
      // Read tools
      expect(getToolPermissions('listSignals')).toEqual(['read']);
      expect(getToolPermissions('searchDocuments')).toEqual(['read']);
      expect(getToolPermissions('researchCompanyComprehensive')).toEqual(['read']);

      // Write tools
      expect(getToolPermissions('createCompany')).toEqual(['write']);
      expect(getToolPermissions('updateDecoupledTechnology')).toEqual(['write']);

      // Delete tools
      expect(getToolPermissions('deleteEntity')).toEqual(['delete']);
      expect(getToolPermissions('deleteRadar')).toEqual(['delete']);

      // Signal tools
      expect(getToolPermissions('approveSignalForImport')).toEqual(['signals']);
      expect(getToolPermissions('rejectSignalWithReason')).toEqual(['signals']);

      // Admin tools
      expect(getToolPermissions('triggerPipeline')).toEqual(['admin']);
    });

    // AUDIT-002. This test previously asserted the OPPOSITE — that an unmapped
    // tool defaults to ['read'] — which is the defect, written down and pinned.
    // Forgetting to map a tool must not silently publish it to every read-only
    // key; that is how `recordKnowledgeGap` (a Neo4j write) became callable with
    // a read-only key. An omission has to fail closed.
    it('fails closed for unmapped tools — an omission is a locked door, not a read grant', () => {
      expect(getToolPermissions('unknownTool')).toEqual(['admin']);
      expect(getToolPermissions('nonExistentTool')).toEqual(['admin']);
    });

    it.each(['constructor', 'toString', '__proto__'])('fails closed for inherited object key %s', (toolName) => {
      expect(getToolPermissions(toolName)).toEqual(['admin']);
      expect(canExecuteTool(['read'], toolName)).toBe(false);
    });

    it('should return multiple permissions for tools that require them', () => {
      expect(getToolPermissions('researchTechnologyComprehensive')).toEqual(['read', 'write']);
      expect(getToolPermissions('discoverCompanyRelations')).toEqual(['read', 'write']);
    });
  });

  describe('canExecuteTool', () => {
    it('should allow tool execution with matching permissions', () => {
      expect(canExecuteTool(['read'], 'listSignals')).toBe(true);
      expect(canExecuteTool(['write'], 'createCompany')).toBe(true);
      expect(canExecuteTool(['delete'], 'deleteEntity')).toBe(true);
      expect(canExecuteTool(['signals'], 'approveSignalForImport')).toBe(true);
    });

    it('should deny tool execution without matching permissions', () => {
      expect(canExecuteTool(['read'], 'createCompany')).toBe(false);
      expect(canExecuteTool(['write'], 'deleteEntity')).toBe(false);
      expect(canExecuteTool(['read'], 'approveSignalForImport')).toBe(false);
    });

    it('should allow admin to execute any tool', () => {
      expect(canExecuteTool(['admin'], 'listSignals')).toBe(true);
      expect(canExecuteTool(['admin'], 'createCompany')).toBe(true);
      expect(canExecuteTool(['admin'], 'deleteEntity')).toBe(true);
      expect(canExecuteTool(['admin'], 'approveSignalForImport')).toBe(true);
      expect(canExecuteTool(['admin'], 'triggerPipeline')).toBe(true);
    });

    it('should require all permissions for multi-permission tools', () => {
      // researchTechnologyComprehensive requires ['read', 'write']
      expect(canExecuteTool(['read', 'write'], 'researchTechnologyComprehensive')).toBe(true);
      expect(canExecuteTool(['read'], 'researchTechnologyComprehensive')).toBe(false);
      expect(canExecuteTool(['write'], 'researchTechnologyComprehensive')).toBe(false);
    });

    it('should allow execution with superset of required permissions', () => {
      expect(canExecuteTool(['read', 'write', 'delete', 'signals'], 'createCompany')).toBe(true);
    });
  });

  describe('getAccessibleTools', () => {
    it('should filter tools based on permissions', () => {
      const tools = ['listSignals', 'createCompany', 'deleteEntity', 'approveSignalForImport'];

      expect(getAccessibleTools(['read'], tools)).toEqual(['listSignals']);
      expect(getAccessibleTools(['write'], tools)).toEqual(['createCompany']);
      expect(getAccessibleTools(['delete'], tools)).toEqual(['deleteEntity']);
      expect(getAccessibleTools(['signals'], tools)).toEqual(['approveSignalForImport']);
    });

    it('should return all tools for admin', () => {
      const tools = ['listSignals', 'createCompany', 'deleteEntity', 'approveSignalForImport'];
      expect(getAccessibleTools(['admin'], tools)).toEqual(tools);
    });

    it('should return multiple tools with combined permissions', () => {
      const tools = ['listSignals', 'createCompany', 'deleteEntity'];
      expect(getAccessibleTools(['read', 'write'], tools)).toEqual(['listSignals', 'createCompany']);
    });

    it('should return empty array for no matching permissions', () => {
      const tools = ['createCompany', 'deleteEntity'];
      expect(getAccessibleTools(['read'], tools)).toEqual([]);
    });
  });

  describe('categorizeToolsByPermission', () => {
    it('should categorize all mapped tools', () => {
      const categories = categorizeToolsByPermission();

      // Check that categories exist
      expect(categories.read).toBeDefined();
      expect(categories.write).toBeDefined();
      expect(categories.delete).toBeDefined();
      expect(categories.signals).toBeDefined();
      expect(categories.admin).toBeDefined();

      // Check specific tools are in correct categories
      expect(categories.read).toContain('listSignals');
      expect(categories.write).toContain('createCompany');
      expect(categories.delete).toContain('deleteEntity');
      expect(categories.signals).toContain('approveSignalForImport');
      expect(categories.admin).toContain('triggerPipeline');
    });

    it('should include tools in multiple categories if they require multiple permissions', () => {
      const categories = categorizeToolsByPermission();

      // researchTechnologyComprehensive requires ['read', 'write']
      expect(categories.read).toContain('researchTechnologyComprehensive');
      expect(categories.write).toContain('researchTechnologyComprehensive');
    });
  });

  describe('describeToolPermissions', () => {
    it('should describe single permission requirements', () => {
      expect(describeToolPermissions('listSignals')).toBe('Requires: read data');
      expect(describeToolPermissions('createCompany')).toBe('Requires: create/modify data');
      expect(describeToolPermissions('deleteEntity')).toBe('Requires: delete data');
      expect(describeToolPermissions('approveSignalForImport')).toBe('Requires: manage signals');
    });

    it('should describe admin requirement', () => {
      expect(describeToolPermissions('triggerPipeline')).toBe('Requires admin access');
    });

    it('should describe multiple permission requirements', () => {
      const desc = describeToolPermissions('researchTechnologyComprehensive');
      expect(desc).toContain('read data');
      expect(desc).toContain('create/modify data');
    });
  });

  describe('TOOL_PERMISSIONS constant', () => {
    it('should have permissions defined for common tools', () => {
      // Web research tools
      expect(TOOL_PERMISSIONS['webSearch']).toBeDefined();
      expect(TOOL_PERMISSIONS['webScrape']).toBeDefined();

      // Entity creation tools
      expect(TOOL_PERMISSIONS['createCompany']).toBeDefined();
      expect(TOOL_PERMISSIONS['createTechnology']).toBeDefined();

      // Signal management tools
      expect(TOOL_PERMISSIONS['listSignals']).toBeDefined();
      expect(TOOL_PERMISSIONS['approveSignalForImport']).toBeDefined();

      // Graph tools
      expect(TOOL_PERMISSIONS['queryGraph']).toBeDefined();

      // Pipeline tools
      expect(TOOL_PERMISSIONS['triggerPipeline']).toBeDefined();
    });
  });

  describe('Tool-Permission Parity', () => {
    it('should have matching permission names for actual signal tools', () => {
      expect(TOOL_PERMISSIONS).toHaveProperty('createSignalManual');
      expect(TOOL_PERMISSIONS).toHaveProperty('approveSignalForImport');
      expect(TOOL_PERMISSIONS).toHaveProperty('rejectSignalWithReason');
      expect(TOOL_PERMISSIONS).toHaveProperty('resetSignalToDetected');
      // Old names should NOT exist
      expect(TOOL_PERMISSIONS).not.toHaveProperty('createSignal');
      expect(TOOL_PERMISSIONS).not.toHaveProperty('approveSignal');
      expect(TOOL_PERMISSIONS).not.toHaveProperty('rejectSignal');
    });

    it('should have permissions for verified tools', () => {
      expect(TOOL_PERMISSIONS).toHaveProperty('createVerifiedSignal');
      expect(TOOL_PERMISSIONS['createVerifiedSignal']).toEqual(['write']);
      expect(TOOL_PERMISSIONS).toHaveProperty('proposeVerifiedRelation');
      expect(TOOL_PERMISSIONS['proposeVerifiedRelation']).toEqual(['write']);
    });
  });

  describe('Async Dispatch Tools (write-class, explicit entries)', () => {
    it('startMission and createResearchDocument are explicitly mapped as write', () => {
      // Explicit entries — never rely on the default-read fallback for tools
      // that dispatch token-spending background jobs.
      expect(TOOL_PERMISSIONS['startMission']).toEqual(['write']);
      expect(TOOL_PERMISSIONS['createResearchDocument']).toEqual(['write']);
    });

    it('a read-only key cannot start a mission or research job', () => {
      expect(canExecuteTool(['read'], 'startMission')).toBe(false);
      expect(canExecuteTool(['read'], 'createResearchDocument')).toBe(false);
    });

    it('a write key can dispatch async jobs', () => {
      expect(canExecuteTool(['write'], 'startMission')).toBe(true);
      expect(canExecuteTool(['write'], 'createResearchDocument')).toBe(true);
    });

    it('mission status/list tools remain read', () => {
      expect(TOOL_PERMISSIONS['getMissionStatus']).toEqual(['read']);
      expect(TOOL_PERMISSIONS['listUserMissions']).toEqual(['read']);
      expect(canExecuteTool(['read'], 'getMissionStatus')).toBe(true);
      expect(canExecuteTool(['read'], 'listUserMissions')).toBe(true);
    });

    it('report tools are explicitly mapped', () => {
      expect(TOOL_PERMISSIONS['draftReport']).toEqual(['write']);
      expect(TOOL_PERMISSIONS['publishReport']).toEqual(['write']);
      expect(TOOL_PERMISSIONS['listReports']).toEqual(['read']);
      expect(TOOL_PERMISSIONS['getReportById']).toEqual(['read']);
      expect(TOOL_PERMISSIONS['updateReport']).toEqual(['write']);
      expect(TOOL_PERMISSIONS['restoreReport']).toEqual(['write']);
      expect(TOOL_PERMISSIONS['deleteReport']).toEqual(['delete']);
    });

    it('visualization tools are write-class', () => {
      expect(TOOL_PERMISSIONS['generateInfographic']).toEqual(['write']);
      expect(TOOL_PERMISSIONS['generateVisualization']).toEqual(['write']);
      expect(canExecuteTool(['read'], 'generateVisualization')).toBe(false);
    });
  });

  describe('Mission-Bound Tools', () => {
    it('registers exactly draftReport, publishReport, and draftDocument', () => {
      expect([...MISSION_BOUND_TOOLS].sort()).toEqual(['draftDocument', 'draftReport', 'publishReport']);
    });

    it('isMissionBoundTool identifies mission-only tools', () => {
      expect(isMissionBoundTool('draftReport')).toBe(true);
      expect(isMissionBoundTool('publishReport')).toBe(true);
      expect(isMissionBoundTool('draftDocument')).toBe(true);
      expect(isMissionBoundTool('startMission')).toBe(false);
      expect(isMissionBoundTool('listReports')).toBe(false);
    });

    it('guidance message is self-remediating (names the tool and startMission)', () => {
      const msg = missionBoundToolGuidance('draftReport');
      expect(msg).toContain('draftReport');
      expect(msg).toContain('only works inside a mission');
      expect(msg).toContain('startMission');
      expect(msg).toContain('creator');
    });
  });
});
