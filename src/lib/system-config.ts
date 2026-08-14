/**
 * @file system-config.ts
 * @description Data access layer for System Configuration in the Agentic Innovation Platform.
 *
 * System Configuration is a singleton entity (only one exists with id="global") that controls
 * agent behavior, signal detection settings, and notification preferences.
 *
 * **Key Settings:**
 * - **Agent Mode:** Review-only co-pilot mode for the v0.1 release
 * - **Signal Detection:** Capability gate, sources, relevance threshold
 * - **Notifications:** Email, dashboard, Slack integration
 *
 * **Usage Flow:**
 * 1. Initialize default config on first app load
 * 2. Read config when agents need to make decisions
 * 3. Update config via Settings UI
 * 4. Agents adapt behavior based on current config
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

import { db, removeUndefinedFields } from '@/lib/firebase';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { DEFAULT_SIGNAL_SOURCES } from '@/lib/signal-source-defaults';
import type { SweepConfig, SystemConfiguration } from '@/lib/types';
import { createLogger } from '@/lib/logger';
const log = createLogger('system-config');

/** ID for the singleton configuration document */
const CONFIG_ID = 'global';

/** Collection name for system configuration */
const CONFIG_COLLECTION = 'system-config';

const DEFAULT_SWEEP_CONFIG: SweepConfig = {
  enabled: false,
  maxActionsPerSweep: 10,
};

/** Normalize the release automation switch exactly like the server policy. */
export function normalizeSweepConfig(value: unknown): SweepConfig {
  const sweep = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  const configuredCap = sweep?.maxActionsPerSweep;

  return {
    enabled: sweep?.enabled === true,
    maxActionsPerSweep:
      typeof configuredCap === 'number' && Number.isInteger(configuredCap) && configuredCap >= 1 && configuredCap <= 20
        ? configuredCap
        : DEFAULT_SWEEP_CONFIG.maxActionsPerSweep,
  };
}

function validateSweepConfig(sweepConfig: SweepConfig): void {
  if (typeof sweepConfig.enabled !== 'boolean') {
    throw new Error('Background automation enabled must be a boolean');
  }
  if (
    !Number.isInteger(sweepConfig.maxActionsPerSweep) ||
    sweepConfig.maxActionsPerSweep < 1 ||
    sweepConfig.maxActionsPerSweep > 20
  ) {
    throw new Error('Max actions per sweep must be an integer between 1 and 20');
  }
}

// ============================================================================
// DEFAULT CONFIGURATION
// ============================================================================

/**
 * Default system configuration.
 * Used when initializing the configuration for the first time.
 *
 * **Defaults:**
 * - Agent Mode: Co-pilot (requires human approval)
 * - Background automation: Paused until the operator opts in
 * - Signal Detection: Configured on, but dormant while background automation is paused
 * - Registered free sources enabled; funding, patents, Trends, and SEC stay
 *   off until their required API or fetcher is available
 * - Fetch volume remains bounded by the server-owned per-run source cap
 */
const DEFAULT_CONFIG: SystemConfiguration = {
  id: CONFIG_ID,
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
    // Demo default (0-100 scale). computeKeywordRelevance() (base-fetcher.ts)
    // scores keyword-matched items >= 60 and non-matching API hits ~30 — 50
    // keeps matches while dropping the no-match noise floor, now that
    // fetch-signals.ts actually threads this into BaseFetcher.fetch's filter.
    minRelevanceScore: 50,
    // Canonical defaults live in signal-source-defaults.ts (shared with the
    // Inngest fallbacks and the emulator seed): patents off (PatentsView
    // legacy endpoint retired — see docs/LIMITATIONS.md), funding off
    // (requires paid API), Trends off (no fetcher), and SEC opt-in;
    // papers/news/GitHub/Hacker News are on.
    sources: { ...DEFAULT_SIGNAL_SOURCES },
  },
  linkerAgent: {
    enabled: false,
  },
  sweep: {
    // v0.1 master switch for scheduled producers. Jobs fail closed when this
    // field is missing or the configuration cannot be read.
    ...DEFAULT_SWEEP_CONFIG,
  },
  notifications: {
    email: false, // Future feature
    dashboard: true, // Always enabled
  },
  updatedAt: Date.now(),
};

// ============================================================================
// CRUD OPERATIONS
// ============================================================================

/**
 * Fetches the global system configuration.
 * If configuration doesn't exist, creates it with default values.
 *
 * **Note:** This is the primary method for accessing configuration.
 * Always use this instead of direct Firestore queries.
 *
 * @returns Promise resolving to the SystemConfiguration object
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * const config = await getSystemConfig();
 * console.log(`Agent mode: ${config.agentMode.mode}`);
 * console.log(`Signal detection: ${config.signalDetection.enabled ? 'ON' : 'OFF'}`);
 *
 * // Use config to determine agent behavior
 * if (config.agentMode.mode === "autopilot" && score >= config.agentMode.autoActionThreshold) {
 *   await autoImportTechnology(signal);
 * } else {
 *   await queueForReview(signal);
 * }
 * ```
 */
export async function getSystemConfig(): Promise<SystemConfiguration> {
  try {
    const docRef = doc(db, CONFIG_COLLECTION, CONFIG_ID);
    const docSnap = await getDoc(docRef);

    if (docSnap.exists()) {
      const config = docSnap.data() as SystemConfiguration;
      return {
        ...config,
        sweep: normalizeSweepConfig(config.sweep),
        ...(config.linkerAgent
          ? { linkerAgent: { ...config.linkerAgent, enabled: config.linkerAgent.enabled === true } }
          : {}),
      };
    } else {
      // Config doesn't exist, initialize with defaults
      log.info('System configuration not found, initializing with defaults...');
      return await initializeSystemConfig();
    }
  } catch (error) {
    log.error('Error fetching system configuration', error instanceof Error ? error : new Error(String(error)));
    throw new Error('Failed to fetch system configuration');
  }
}

/**
 * Initializes the system configuration with default values.
 * Called automatically by `getSystemConfig()` if config doesn't exist.
 *
 * **Note:** This should only be called once, typically on first app load.
 *
 * @returns Promise resolving to the newly created SystemConfiguration object
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * // Manually initialize (usually not needed)
 * const config = await initializeSystemConfig();
 * console.log("System configuration initialized");
 * ```
 */
export async function initializeSystemConfig(): Promise<SystemConfiguration> {
  try {
    const config = {
      ...DEFAULT_CONFIG,
      updatedAt: Date.now(),
    };

    // Uses setDoc directly (not entity-factory) — singleton config document with fixed ID.
    await setDoc(doc(db, CONFIG_COLLECTION, CONFIG_ID), config);

    log.info('Successfully initialized system configuration with defaults');
    return config;
  } catch (error) {
    log.error('Error initializing system configuration', error instanceof Error ? error : new Error(String(error)));
    throw new Error('Failed to initialize system configuration');
  }
}

/**
 * Updates the entire system configuration.
 * Automatically updates the updatedAt timestamp.
 *
 * **Warning:** This replaces the entire configuration object.
 * For partial updates, use specific update functions (updateAgentMode, etc.)
 *
 * @param updates - The configuration updates (id and updatedAt are excluded)
 * @returns Promise that resolves when the update is complete
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * // Full configuration update (not recommended)
 * await updateSystemConfig({
 *   agentMode: { /* ... *\/ },
 *   signalDetection: { /* ... *\/ },
 *   notifications: { /* ... *\/ }
 * });
 * ```
 */
export async function updateSystemConfig(updates: Omit<SystemConfiguration, 'id' | 'updatedAt'>): Promise<void> {
  try {
    const docRef = doc(db, CONFIG_COLLECTION, CONFIG_ID);

    // Remove undefined values before updating Firestore (Firestore doesn't accept undefined)
    const cleanedUpdates = removeUndefinedFields({
      ...updates,
      updatedAt: Date.now(),
    });
    await updateDoc(docRef, cleanedUpdates);

    log.info('Successfully updated system configuration');
  } catch (error) {
    log.error('Error updating system configuration', error instanceof Error ? error : new Error(String(error)));
    throw new Error('Failed to update system configuration');
  }
}

// ============================================================================
// SPECIFIC UPDATE FUNCTIONS
// ============================================================================

/**
 * Updates the agent mode configuration.
 * Controls agent autonomy and auto-action behavior.
 *
 * @param agentModeConfig - The new agent mode configuration
 * @returns Promise that resolves when the update is complete
 * @throws Error if Firestore operation fails or validation fails
 *
 * @example
 * ```typescript
 * // Switch to autopilot mode
 * await updateAgentMode({
 *   mode: "autopilot",
 *   autoActionThreshold: 90,
 *   autoAddTechnologies: true,
 *   autoUpdateMaturity: true,
 *   autoLinkRelationships: true,
 *   autoImportSignals: true
 * });
 *
 * // Switch to co-pilot mode (safer)
 * await updateAgentMode({
 *   mode: "copilot",
 *   autoActionThreshold: 90,
 *   autoAddTechnologies: false,
 *   autoUpdateMaturity: false,
 *   autoLinkRelationships: false,
 *   autoImportSignals: false
 * });
 *
 * // Custom configuration: Autopilot for high-confidence only
 * await updateAgentMode({
 *   mode: "autopilot",
 *   autoActionThreshold: 95, // Very high threshold
 *   autoAddTechnologies: true,
 *   autoUpdateMaturity: false,
 *   autoLinkRelationships: true,
 *   autoImportSignals: true
 * });
 * ```
 */
export async function updateAgentMode(agentModeConfig: SystemConfiguration['agentMode']): Promise<void> {
  try {
    // Validate threshold
    if (agentModeConfig.autoActionThreshold < 0 || agentModeConfig.autoActionThreshold > 100) {
      throw new Error('Auto-action threshold must be between 0 and 100');
    }

    const docRef = doc(db, CONFIG_COLLECTION, CONFIG_ID);

    await updateDoc(docRef, {
      agentMode: agentModeConfig,
      updatedAt: Date.now(),
    });

    log.info('Agent mode updated', { mode: agentModeConfig.mode });
  } catch (error) {
    log.error('Error updating agent mode', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to update agent mode: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Updates background automation configuration.
 * `enabled` is the v0.1 master switch for scheduled signal, linker,
 * discovery, and impulse producers. `maxActionsPerSweep` bounds impulse work.
 *
 * Jobs read this config live via the admin SDK, so changes take effect on the
 * next scheduled run without a restart.
 *
 * @param sweepConfig - The new sweep configuration
 * @returns Promise that resolves when the update is complete
 * @throws Error if Firestore operation fails or validation fails
 *
 * @example
 * ```typescript
 * // Pause the scheduled sweep
 * await updateSweepConfig({ enabled: false, maxActionsPerSweep: 10 });
 *
 * // Re-enable with a tighter per-cycle action cap
 * await updateSweepConfig({ enabled: true, maxActionsPerSweep: 5 });
 * ```
 */
export async function updateSweepConfig(sweepConfig: NonNullable<SystemConfiguration['sweep']>): Promise<void> {
  try {
    validateSweepConfig(sweepConfig);

    const docRef = doc(db, CONFIG_COLLECTION, CONFIG_ID);

    await updateDoc(docRef, {
      sweep: sweepConfig,
      updatedAt: Date.now(),
    });

    log.info('Sweep configuration updated', {
      enabled: sweepConfig.enabled,
      maxActionsPerSweep: sweepConfig.maxActionsPerSweep,
    });
  } catch (error) {
    log.error('Error updating sweep config', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to update sweep config: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/** Persist the master policy, Impulse cap, and Linker capability atomically. */
export async function updateBackgroundAutomationConfig(
  sweepConfig: NonNullable<SystemConfiguration['sweep']>,
  linkerEnabled: boolean
): Promise<void> {
  try {
    validateSweepConfig(sweepConfig);
    if (typeof linkerEnabled !== 'boolean') {
      throw new Error('Linker enabled must be a boolean');
    }

    const docRef = doc(db, CONFIG_COLLECTION, CONFIG_ID);
    await updateDoc(docRef, {
      sweep: sweepConfig,
      'linkerAgent.enabled': linkerEnabled,
      updatedAt: Date.now(),
    });

    log.info('Background automation configuration updated', {
      enabled: sweepConfig.enabled,
      maxActionsPerSweep: sweepConfig.maxActionsPerSweep,
      linkerEnabled,
    });
  } catch (error) {
    log.error('Error updating background automation config', error instanceof Error ? error : new Error(String(error)));
    throw new Error(
      `Failed to update background automation config: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Updates the notification configuration.
 * Controls how users are notified of agent activities.
 *
 * @param notificationConfig - The new notification configuration
 * @returns Promise that resolves when the update is complete
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * // Enable email notifications (future feature)
 * await updateNotificationConfig({
 *   email: true,
 *   dashboard: true,
 *   slack: "https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
 * });
 *
 * // Dashboard-only notifications
 * await updateNotificationConfig({
 *   email: false,
 *   dashboard: true
 * });
 * ```
 */
export async function updateNotificationConfig(
  notificationConfig: SystemConfiguration['notifications']
): Promise<void> {
  try {
    const docRef = doc(db, CONFIG_COLLECTION, CONFIG_ID);

    await updateDoc(docRef, {
      notifications: notificationConfig,
      updatedAt: Date.now(),
    });

    log.info('Notification configuration updated');
  } catch (error) {
    log.error('Error updating notification config', error instanceof Error ? error : new Error(String(error)));
    throw new Error('Failed to update notification config');
  }
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Checks if the system is in autopilot mode.
 * Convenience function for agent decision-making.
 *
 * @returns Promise resolving to true if in autopilot mode, false otherwise
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * if (await isAutopilotMode()) {
 *   console.log("System running in autonomous mode");
 *   // Agents can make automatic decisions
 * } else {
 *   console.log("System running in co-pilot mode");
 *   // All decisions require human approval
 * }
 * ```
 */
export async function isAutopilotMode(): Promise<boolean> {
  const config = await getSystemConfig();
  return config.agentMode.mode === 'autopilot';
}

/**
 * Checks if signal detection is currently enabled.
 * Convenience function for background job scheduling.
 *
 * @returns Promise resolving to true if signal detection is enabled, false otherwise
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * if (await isSignalDetectionEnabled()) {
 *   console.log("Running signal detection job...");
 *   await runSignalDetection();
 * } else {
 *   console.log("Signal detection is disabled, skipping...");
 * }
 * ```
 */
export async function isSignalDetectionEnabled(): Promise<boolean> {
  const config = await getSystemConfig();
  return config.signalDetection.enabled;
}

/**
 * Gets the auto-action threshold.
 * Convenience function for agent decision-making.
 *
 * @returns Promise resolving to the threshold percentage (0-100)
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * const threshold = await getAutoActionThreshold();
 * const score = calculateRelevanceScore(signal);
 *
 * if (score >= threshold) {
 *   console.log(`Score ${score}% >= threshold ${threshold}%, auto-importing...`);
 *   await autoImportSignal(signal);
 * } else {
 *   console.log(`Score ${score}% < threshold ${threshold}%, queuing for review...`);
 *   await queueSignalForReview(signal);
 * }
 * ```
 */
export async function getAutoActionThreshold(): Promise<number> {
  const config = await getSystemConfig();
  return config.agentMode.autoActionThreshold;
}

/**
 * Checks if a specific auto-action is enabled.
 * Convenience function for agent decision-making.
 *
 * @param action - The auto-action to check
 * @returns Promise resolving to true if the action is enabled in autopilot mode, false otherwise
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * if (await isAutoActionEnabled("autoAddTechnologies")) {
 *   console.log("Auto-add technologies is enabled");
 *   await autoAddTechnology(signal);
 * } else {
 *   console.log("Auto-add technologies is disabled, requesting approval");
 *   await requestApprovalForTechnology(signal);
 * }
 * ```
 */
export async function isAutoActionEnabled(action: keyof SystemConfiguration['agentMode']): Promise<boolean> {
  const config = await getSystemConfig();
  return config.agentMode.mode === 'autopilot' && (config.agentMode[action] as boolean) === true;
}

/**
 * Gets enabled signal sources.
 * Convenience function for signal detection pipeline.
 *
 * @returns Promise resolving to an array of enabled source names
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * const enabledSources = await getEnabledSignalSources();
 * console.log(`Monitoring sources: ${enabledSources.join(", ")}`);
 * // Output: "Monitoring sources: patents, papers, github, trends"
 *
 * // Use to run only enabled fetchers
 * for (const source of enabledSources) {
 *   await runFetcherForSource(source);
 * }
 * ```
 */
export async function getEnabledSignalSources(): Promise<string[]> {
  const config = await getSystemConfig();
  return Object.entries(config.signalDetection.sources)
    .filter(([_, enabled]) => enabled)
    .map(([source, _]) => source);
}

// ============================================================================
// RESET FUNCTIONS
// ============================================================================

/**
 * Resets the system configuration to default values.
 *
 * **WARNING:** This will overwrite all configuration settings.
 * Use with caution. Typically only needed for troubleshooting or testing.
 *
 * @returns Promise that resolves when the reset is complete
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * // Reset to defaults (use with caution)
 * await resetSystemConfig();
 * console.log("System configuration reset to defaults");
 * ```
 */
/**
 * Resets ONLY the signal-source enablement map to the supported defaults
 * (SETTINGS-003). This is the guarded, idempotent reset the operator runs to
 * clear legacy `patents`/`funding`/`trends` flags that an upgraded store can
 * still carry — the ones Settings marks unavailable — before enabling the
 * Background Automation master. It targets the nested `signalDetection.sources`
 * field only, so the master switch, relevance threshold, and every other
 * configuration slice are left untouched. Writing the same defaults twice is a
 * no-op, so it is safe to run repeatedly.
 *
 * @throws Error if the Firestore update fails
 */
export async function resetSignalSourcesToSupportedDefaults(): Promise<void> {
  try {
    const docRef = doc(db, CONFIG_COLLECTION, CONFIG_ID);
    await updateDoc(docRef, {
      'signalDetection.sources': { ...DEFAULT_SIGNAL_SOURCES },
      updatedAt: Date.now(),
    });
    log.info('Signal sources reset to supported defaults');
  } catch (error) {
    log.error('Error resetting signal sources', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to reset signal sources: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function resetSystemConfig(): Promise<void> {
  try {
    const config = {
      ...DEFAULT_CONFIG,
      updatedAt: Date.now(),
    };

    // Uses setDoc directly (not entity-factory) — singleton config document with fixed ID.
    await setDoc(doc(db, CONFIG_COLLECTION, CONFIG_ID), config);

    log.info('System configuration reset to defaults');
  } catch (error) {
    log.error('Error resetting system configuration', error instanceof Error ? error : new Error(String(error)));
    throw new Error('Failed to reset system configuration');
  }
}

/**
 * Exports the current system configuration as JSON.
 * Useful for backup or migration purposes.
 *
 * @returns Promise resolving to the configuration as a JSON string
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * const configBackup = await exportSystemConfig();
 * console.log("Configuration backup:", configBackup);
 * // Save to file or send to external system
 * ```
 */
export async function exportSystemConfig(): Promise<string> {
  const config = await getSystemConfig();
  return JSON.stringify(config, null, 2);
}

/**
 * Imports system configuration from JSON.
 * Useful for restoring from backup or migrating settings.
 *
 * **Note:** This replaces the entire configuration.
 *
 * @param configJson - The configuration as a JSON string
 * @returns Promise that resolves when the import is complete
 * @throws Error if JSON is invalid or Firestore operation fails
 *
 * @example
 * ```typescript
 * const backupJson = '{ "id": "global", "agentMode": { ... }, ... }';
 * await importSystemConfig(backupJson);
 * console.log("Configuration imported successfully");
 * ```
 */
export async function importSystemConfig(configJson: string): Promise<void> {
  try {
    const config = JSON.parse(configJson) as SystemConfiguration;

    // Ensure id is "global"
    config.id = CONFIG_ID;
    config.updatedAt = Date.now();

    // Uses setDoc directly (not entity-factory) — singleton config document with fixed ID.
    await setDoc(doc(db, CONFIG_COLLECTION, CONFIG_ID), config);

    log.info('System configuration imported successfully');
  } catch (error) {
    log.error('Error importing system configuration', error instanceof Error ? error : new Error(String(error)));
    throw new Error(
      `Failed to import system configuration: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
