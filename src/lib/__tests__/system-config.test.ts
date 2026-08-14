/**
 * Unit Tests for System Configuration Module
 *
 * Tests all configuration management functions including:
 * - Configuration initialization and retrieval
 * - Agent mode updates
 * - Signal detection configuration
 * - Notification preferences
 * - Convenience helper functions
 *
 * @jest-environment node
 */

import type { SystemConfiguration, AgentModeConfig, NotificationConfig, SweepConfig } from '../types';

// Mock firebase with jest.fn() in factory (proper hoisting pattern)
jest.mock('../firebase', () => ({
  db: {},
  removeUndefinedFields: jest.fn((obj: Record<string, unknown>) => {
    const result: Record<string, unknown> = {};
    for (const key in obj) {
      if (obj[key] !== undefined) {
        result[key] = obj[key];
      }
    }
    return result;
  }),
}));

jest.mock('firebase/firestore', () => ({
  __esModule: true,
  doc: jest.fn(() => ({ id: 'global', path: 'system-config/global' })),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  collection: jest.fn(),
}));

// Import mocked modules to get references
import { getDoc, setDoc, updateDoc } from 'firebase/firestore';

// Cast to jest.Mock for type safety
const mockGetDoc = getDoc as jest.Mock;
const mockSetDoc = setDoc as jest.Mock;
const mockUpdateDoc = updateDoc as jest.Mock;

// Pure module (zero imports) — safe to import un-mocked.
import { DEFAULT_SIGNAL_SOURCES } from '../signal-source-defaults';

// Import functions after mocking
import {
  getSystemConfig,
  initializeSystemConfig,
  updateAgentMode,
  updateBackgroundAutomationConfig,
  updateSweepConfig,
  updateNotificationConfig,
  isAutopilotMode,
  getAutoActionThreshold,
  isAutoActionEnabled,
  getEnabledSignalSources,
  resetSignalSourcesToSupportedDefaults,
} from '../system-config';

/**
 * Helper to create a default SystemConfiguration for testing
 */
function createDefaultConfig(): SystemConfiguration {
  return {
    id: 'global',
    agentMode: {
      mode: 'copilot',
      autoActionThreshold: 90,
      autoAddTechnologies: false,
      autoUpdateMaturity: false,
      autoLinkRelationships: false,
      autoImportSignals: false,
    },
    signalDetection: {
      enabled: true,
      minRelevanceScore: 50,
      sources: {
        patents: false, // Legacy PatentsView endpoint retired — disabled by default
        papers: true,
        news: true,
        funding: false,
        github: true,
        trends: false,
        hackernews: true,
        sec: false,
      },
    },
    linkerAgent: {
      enabled: false,
    },
    sweep: { enabled: false, maxActionsPerSweep: 10 },
    notifications: {
      email: false,
      dashboard: true,
      slack: undefined,
    },
    updatedAt: Date.now(),
  };
}

describe('System Configuration Module', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    jest.clearAllMocks();
  });

  describe('getSystemConfig()', () => {
    it('should return existing configuration when it exists', async () => {
      const mockConfig = createDefaultConfig();
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => mockConfig,
      });

      const result = await getSystemConfig();

      expect(result).toEqual(mockConfig);
      expect(mockGetDoc).toHaveBeenCalledTimes(1);
    });

    it('should initialize default configuration when none exists', async () => {
      mockGetDoc.mockResolvedValueOnce({
        exists: () => false,
      });

      mockSetDoc.mockResolvedValueOnce(undefined);

      const result = await getSystemConfig();

      expect(mockSetDoc).toHaveBeenCalledTimes(1);
      expect(result.id).toBe('global');
      expect(result.agentMode.mode).toBe('copilot');
      expect(result.signalDetection.enabled).toBe(true);
      expect(result.sweep).toEqual({ enabled: false, maxActionsPerSweep: 10 });
    });

    it('should handle errors gracefully', async () => {
      mockGetDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getSystemConfig()).rejects.toThrow('Failed to fetch system configuration');
    });

    it('normalizes malformed automation values to the paused server policy', async () => {
      const malformed = createDefaultConfig() as unknown as Record<string, unknown>;
      malformed.sweep = { enabled: 'true', maxActionsPerSweep: 999 };
      malformed.linkerAgent = { ...(malformed.linkerAgent as object), enabled: 'true' };
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => malformed });

      const result = await getSystemConfig();

      expect(result.sweep).toEqual({ enabled: false, maxActionsPerSweep: 10 });
      expect(result.linkerAgent?.enabled).toBe(false);
    });
  });

  describe('initializeSystemConfig()', () => {
    it('should create default configuration with correct structure', async () => {
      mockSetDoc.mockResolvedValueOnce(undefined);

      const result = await initializeSystemConfig();

      expect(result.id).toBe('global');
      expect(result.agentMode.mode).toBe('copilot');
      expect(result.agentMode.autoActionThreshold).toBe(90);
      expect(result.signalDetection.enabled).toBe(true);
      expect(result.signalDetection.minRelevanceScore).toBe(50);
      expect(result.notifications.dashboard).toBe(true);
      expect(mockSetDoc).toHaveBeenCalledTimes(1);
    });

    it('should set correct default values for agent mode', async () => {
      mockSetDoc.mockResolvedValueOnce(undefined);

      const result = await initializeSystemConfig();

      expect(result.agentMode).toEqual({
        mode: 'copilot',
        autoActionThreshold: 90,
        autoAddTechnologies: false,
        autoUpdateMaturity: false,
        autoLinkRelationships: false,
        autoImportSignals: false,
      });
    });

    it('should set correct default values for signal detection', async () => {
      mockSetDoc.mockResolvedValueOnce(undefined);

      const result = await initializeSystemConfig();

      expect(result.signalDetection).toMatchObject({
        enabled: true,
        minRelevanceScore: 50,
      });
      expect(result.signalDetection.sources.papers).toBe(true);
      expect(result.signalDetection.sources.github).toBe(true);
      expect(result.signalDetection.sources.news).toBe(true);
    });

    it('should use the shared canonical signal-source defaults (signal-source-defaults.ts)', async () => {
      mockSetDoc.mockResolvedValueOnce(undefined);

      const result = await initializeSystemConfig();

      // DEFAULT_CONFIG.signalDetection.sources must deep-equal the shared
      // constant — the single source of truth also consumed by the
      // fetch-signals / daily-pipeline fallbacks and the emulator seed.
      expect(result.signalDetection.sources).toEqual(DEFAULT_SIGNAL_SOURCES);

      const persisted = mockSetDoc.mock.calls[0][1] as SystemConfiguration;
      expect(persisted.signalDetection.sources).toEqual(DEFAULT_SIGNAL_SOURCES);
    });

    it('should disable the patents source by default (PatentsView legacy endpoint retired)', async () => {
      mockSetDoc.mockResolvedValueOnce(undefined);

      const result = await initializeSystemConfig();

      // The legacy api.patentsview.org endpoint 301-redirects to an HTML page,
      // so fresh installs must not run the dead fetcher. See docs/LIMITATIONS.md.
      expect(result.signalDetection.sources.patents).toBe(false);

      // The persisted document must match what the function returned.
      const persisted = mockSetDoc.mock.calls[0][1] as SystemConfiguration;
      expect(persisted.signalDetection.sources.patents).toBe(false);
    });

    it('should never write undefined field values (Firestore setDoc rejects them)', async () => {
      mockSetDoc.mockResolvedValueOnce(undefined);

      await initializeSystemConfig();

      // Regression guard: DEFAULT_CONFIG once carried
      // `autoApproveThreshold: undefined`, which made the very first
      // initializeSystemConfig() call throw "Unsupported field value:
      // undefined" and broke the dashboard on fresh demo seeds. Optional
      // fields must be omitted, not set to undefined.
      const persisted = mockSetDoc.mock.calls[0][1] as Record<string, unknown>;
      const undefinedPaths: string[] = [];
      const walk = (value: unknown, path: string): void => {
        if (value === undefined) {
          undefinedPaths.push(path);
          return;
        }
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            walk(child, path ? `${path}.${key}` : key);
          }
        }
      };
      walk(persisted, '');
      expect(undefinedPaths).toEqual([]);
    });
  });

  describe('sweep defaults', () => {
    it('should initialize background automation paused with a 10-action cap', async () => {
      mockSetDoc.mockResolvedValueOnce(undefined);

      const result = await initializeSystemConfig();

      expect(result.sweep).toEqual({ enabled: false, maxActionsPerSweep: 10 });
    });
  });

  describe('updateAgentMode()', () => {
    it('should update agent mode configuration successfully', async () => {
      const newAgentMode: AgentModeConfig = {
        mode: 'autopilot',
        autoActionThreshold: 85,
        autoAddTechnologies: true,
        autoUpdateMaturity: true,
        autoLinkRelationships: false,
        autoImportSignals: true,
      };

      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updateAgentMode(newAgentMode);

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      expect(mockUpdateDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          agentMode: newAgentMode,
        })
      );
    });

    it('should update timestamp when updating agent mode', async () => {
      const newAgentMode: AgentModeConfig = {
        mode: 'copilot',
        autoActionThreshold: 90,
        autoAddTechnologies: false,
        autoUpdateMaturity: false,
        autoLinkRelationships: false,
        autoImportSignals: false,
      };

      mockUpdateDoc.mockResolvedValueOnce(undefined);

      const beforeTime = Date.now();
      await updateAgentMode(newAgentMode);
      const afterTime = Date.now();

      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.updatedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(updateCall.updatedAt).toBeLessThanOrEqual(afterTime);
    });

    it('should handle update errors gracefully', async () => {
      const newAgentMode: AgentModeConfig = {
        mode: 'autopilot',
        autoActionThreshold: 85,
        autoAddTechnologies: true,
        autoUpdateMaturity: false,
        autoLinkRelationships: false,
        autoImportSignals: false,
      };

      mockUpdateDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(updateAgentMode(newAgentMode)).rejects.toThrow('Failed to update agent mode');
    });
  });

  describe('resetSignalSourcesToSupportedDefaults (SETTINGS-003)', () => {
    it('writes only the signalDetection.sources map to the supported defaults', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await resetSignalSourcesToSupportedDefaults();

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall['signalDetection.sources']).toEqual(DEFAULT_SIGNAL_SOURCES);
      // A nested dot-path leaves the rest of signalDetection (enabled/threshold) untouched.
      expect(updateCall).not.toHaveProperty('signalDetection');
    });

    it('is idempotent — the same defaults are written on every call', async () => {
      mockUpdateDoc.mockResolvedValue(undefined);

      await resetSignalSourcesToSupportedDefaults();
      await resetSignalSourcesToSupportedDefaults();

      const first = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      const second = mockUpdateDoc.mock.calls[1][1] as Record<string, unknown>;
      expect(first['signalDetection.sources']).toEqual(second['signalDetection.sources']);
      expect(first['signalDetection.sources']).toEqual(DEFAULT_SIGNAL_SOURCES);
    });

    it('disables every unavailable source (patents/funding/trends off)', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await resetSignalSourcesToSupportedDefaults();

      const written = (mockUpdateDoc.mock.calls[0][1] as Record<string, Record<string, boolean>>)[
        'signalDetection.sources'
      ];
      expect(written.patents).toBe(false);
      expect(written.funding).toBe(false);
      expect(written.trends).toBe(false);
    });

    it('stamps updatedAt and surfaces a failure as a wrapped error', async () => {
      mockUpdateDoc.mockRejectedValueOnce(new Error('Firestore down'));
      await expect(resetSignalSourcesToSupportedDefaults()).rejects.toThrow(/reset signal sources/i);
    });
  });

  describe('updateSweepConfig()', () => {
    it('should round-trip sweep configuration through the config doc', async () => {
      const newSweepConfig: SweepConfig = {
        enabled: false,
        maxActionsPerSweep: 5,
      };

      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updateSweepConfig(newSweepConfig);

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      expect(mockUpdateDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          sweep: newSweepConfig,
        })
      );

      // Round-trip: a subsequent read returns the persisted sweep values.
      const persisted = createDefaultConfig();
      persisted.sweep = newSweepConfig;
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => persisted,
      });

      const result = await getSystemConfig();

      expect(result.sweep).toEqual({ enabled: false, maxActionsPerSweep: 5 });
    });

    it('should update timestamp when updating sweep config', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      const beforeTime = Date.now();
      await updateSweepConfig({ enabled: true, maxActionsPerSweep: 10 });
      const afterTime = Date.now();

      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.updatedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(updateCall.updatedAt).toBeLessThanOrEqual(afterTime);
    });

    it('should reject maxActionsPerSweep outside the 1-20 range or non-integers', async () => {
      await expect(updateSweepConfig({ enabled: true, maxActionsPerSweep: 0 })).rejects.toThrow(
        'Failed to update sweep config'
      );
      await expect(updateSweepConfig({ enabled: true, maxActionsPerSweep: 21 })).rejects.toThrow(
        'Failed to update sweep config'
      );
      await expect(updateSweepConfig({ enabled: true, maxActionsPerSweep: 2.5 })).rejects.toThrow(
        'Failed to update sweep config'
      );
      expect(mockUpdateDoc).not.toHaveBeenCalled();
    });

    it('should reject a non-boolean enabled value at the write boundary', async () => {
      await expect(
        updateSweepConfig({ enabled: 'true' as unknown as boolean, maxActionsPerSweep: 10 })
      ).rejects.toThrow('Failed to update sweep config');
      expect(mockUpdateDoc).not.toHaveBeenCalled();
    });

    it('should handle update errors gracefully', async () => {
      mockUpdateDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(updateSweepConfig({ enabled: true, maxActionsPerSweep: 10 })).rejects.toThrow(
        'Failed to update sweep config'
      );
    });
  });

  describe('updateBackgroundAutomationConfig()', () => {
    it('atomically persists the sweep and Linker capability gates', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updateBackgroundAutomationConfig({ enabled: true, maxActionsPerSweep: 4 }, true);

      expect(mockUpdateDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          sweep: { enabled: true, maxActionsPerSweep: 4 },
          'linkerAgent.enabled': true,
        })
      );
    });

    it('rejects malformed capability values before Firestore is called', async () => {
      await expect(
        updateBackgroundAutomationConfig({ enabled: true, maxActionsPerSweep: 4 }, 'true' as unknown as boolean)
      ).rejects.toThrow('Failed to update background automation config');
      expect(mockUpdateDoc).not.toHaveBeenCalled();
    });
  });

  describe('updateNotificationConfig()', () => {
    it('should update notification configuration successfully', async () => {
      const newNotifConfig: NotificationConfig = {
        email: true,
        dashboard: true,
        slack: 'https://hooks.slack.com/services/TEST/WEBHOOK/URL',
      };

      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updateNotificationConfig(newNotifConfig);

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      expect(mockUpdateDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          notifications: newNotifConfig,
        })
      );
    });

    it('should handle optional slack webhook', async () => {
      const newNotifConfig: NotificationConfig = {
        email: false,
        dashboard: true,
        slack: undefined,
      };

      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updateNotificationConfig(newNotifConfig);

      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      const notifications = updateCall.notifications as NotificationConfig;
      expect(notifications.slack).toBeUndefined();
    });
  });

  describe('Helper Functions', () => {
    describe('isAutopilotMode()', () => {
      it('should return true when mode is autopilot', async () => {
        const mockConfig = createDefaultConfig();
        mockConfig.agentMode.mode = 'autopilot';
        mockGetDoc.mockResolvedValueOnce({
          exists: () => true,
          data: () => mockConfig,
        });

        const result = await isAutopilotMode();

        expect(result).toBe(true);
      });

      it('should return false when mode is copilot', async () => {
        const mockConfig = createDefaultConfig();
        mockConfig.agentMode.mode = 'copilot';
        mockGetDoc.mockResolvedValueOnce({
          exists: () => true,
          data: () => mockConfig,
        });

        const result = await isAutopilotMode();

        expect(result).toBe(false);
      });
    });

    describe('getAutoActionThreshold()', () => {
      it('should return the configured threshold', async () => {
        const mockConfig = createDefaultConfig();
        mockConfig.agentMode.autoActionThreshold = 85;
        mockGetDoc.mockResolvedValueOnce({
          exists: () => true,
          data: () => mockConfig,
        });

        const result = await getAutoActionThreshold();

        expect(result).toBe(85);
      });
    });

    describe('isAutoActionEnabled()', () => {
      it('should return true when in autopilot mode and specific action is enabled', async () => {
        const mockConfig = createDefaultConfig();
        mockConfig.agentMode.mode = 'autopilot';
        mockConfig.agentMode.autoImportSignals = true;
        mockGetDoc.mockResolvedValueOnce({
          exists: () => true,
          data: () => mockConfig,
        });

        const result = await isAutoActionEnabled('autoImportSignals');

        expect(result).toBe(true);
      });

      it('should return false when in copilot mode even if action is enabled', async () => {
        const mockConfig = createDefaultConfig();
        mockConfig.agentMode.mode = 'copilot';
        mockConfig.agentMode.autoImportSignals = true;
        mockGetDoc.mockResolvedValueOnce({
          exists: () => true,
          data: () => mockConfig,
        });

        const result = await isAutoActionEnabled('autoImportSignals');

        expect(result).toBe(false);
      });

      it('should return false when specific action is disabled', async () => {
        const mockConfig = createDefaultConfig();
        mockConfig.agentMode.mode = 'autopilot';
        mockConfig.agentMode.autoAddTechnologies = false;
        mockGetDoc.mockResolvedValueOnce({
          exists: () => true,
          data: () => mockConfig,
        });

        const result = await isAutoActionEnabled('autoAddTechnologies');

        expect(result).toBe(false);
      });
    });

    describe('getEnabledSignalSources()', () => {
      it('should return enabled sources', async () => {
        const mockConfig = createDefaultConfig();
        mockConfig.signalDetection.sources.patents = true;
        mockConfig.signalDetection.sources.papers = true;
        mockConfig.signalDetection.sources.funding = false;
        mockGetDoc.mockResolvedValueOnce({
          exists: () => true,
          data: () => mockConfig,
        });

        const result = await getEnabledSignalSources();

        expect(result).toContain('patents');
        expect(result).toContain('papers');
        expect(result).not.toContain('funding');
      });

      it('should return empty array when all sources disabled', async () => {
        const mockConfig = createDefaultConfig();
        Object.keys(mockConfig.signalDetection.sources).forEach((key) => {
          mockConfig.signalDetection.sources[key as keyof typeof mockConfig.signalDetection.sources] = false;
        });
        mockGetDoc.mockResolvedValueOnce({
          exists: () => true,
          data: () => mockConfig,
        });

        const result = await getEnabledSignalSources();

        expect(result).toEqual([]);
      });
    });
  });

  describe('Edge Cases and Validation', () => {
    it('should handle concurrent updates correctly', async () => {
      const agentMode1: AgentModeConfig = {
        mode: 'autopilot',
        autoActionThreshold: 85,
        autoAddTechnologies: true,
        autoUpdateMaturity: false,
        autoLinkRelationships: false,
        autoImportSignals: false,
      };

      const agentMode2: AgentModeConfig = {
        mode: 'copilot',
        autoActionThreshold: 90,
        autoAddTechnologies: false,
        autoUpdateMaturity: false,
        autoLinkRelationships: false,
        autoImportSignals: false,
      };

      mockUpdateDoc.mockResolvedValue(undefined);

      await Promise.all([updateAgentMode(agentMode1), updateAgentMode(agentMode2)]);

      expect(mockUpdateDoc).toHaveBeenCalledTimes(2);
    });

    it('should preserve existing configuration when partial update fails', async () => {
      const mockConfig = createDefaultConfig();
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => mockConfig,
      });

      const newAgentMode: AgentModeConfig = {
        mode: 'autopilot',
        autoActionThreshold: 85,
        autoAddTechnologies: true,
        autoUpdateMaturity: false,
        autoLinkRelationships: false,
        autoImportSignals: false,
      };

      mockUpdateDoc.mockRejectedValueOnce(new Error('Network error'));

      await expect(updateAgentMode(newAgentMode)).rejects.toThrow();

      // Verify original config is still accessible
      const config = await getSystemConfig();
      expect(config.agentMode.mode).toBe('copilot');
    });

    it('should validate threshold bounds (0-100)', async () => {
      const agentMode: AgentModeConfig = {
        mode: 'autopilot',
        autoActionThreshold: 95,
        autoAddTechnologies: true,
        autoUpdateMaturity: false,
        autoLinkRelationships: false,
        autoImportSignals: false,
      };

      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updateAgentMode(agentMode);

      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      const agentModeResult = updateCall.agentMode as AgentModeConfig;
      expect(agentModeResult.autoActionThreshold).toBeGreaterThanOrEqual(0);
      expect(agentModeResult.autoActionThreshold).toBeLessThanOrEqual(100);
    });
  });
});
