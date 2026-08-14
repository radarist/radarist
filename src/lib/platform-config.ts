/**
 * @file lib/platform-config.ts
 * @description Platform configuration management
 *
 * Stores and retrieves global platform settings from Firestore.
 * Configuration is stored in a single document: settings/platform
 *
 * **Configuration Options:**
 * - archiveRetentionDays: How long to keep archived signals (default: 90)
 * - autoArchiveRejectedDays: Reserved legacy value; no runtime consumer
 * - Other platform-wide settings
 *
 * @author Radarist Team
 * @created 2025-12-04
 */

import { db } from '@/lib/firebase';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { createLogger } from '@/lib/logger';
import {
    createDefaultPlatformConfig,
    normalizePlatformConfig,
    validatePlatformConfigUpdates,
    type PlatformConfig,
    type PlatformConfigUpdates,
} from '@/lib/platform-config-schema';
const log = createLogger('platform-config');

export type { PlatformConfig } from '@/lib/platform-config-schema';

/**
 * Document path for platform config
 */
const CONFIG_DOC_PATH = 'settings/platform';

/**
 * Get platform configuration from Firestore.
 * Returns default values if no config exists.
 *
 * @returns Promise resolving to PlatformConfig
 *
 * @example
 * ```typescript
 * const config = await getPlatformConfig();
 * console.log(`Retention: ${config.archiveRetentionDays} days`);
 * ```
 */
export async function getPlatformConfig(): Promise<PlatformConfig> {
    try {
        const docRef = doc(db, CONFIG_DOC_PATH);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
            return normalizePlatformConfig(docSnap.data());
        }

        // Return defaults if no config exists
        return createDefaultPlatformConfig();
    } catch (error) {
        log.error('Error fetching config', error instanceof Error ? error : new Error(String(error)));
        // Return defaults on error
        return createDefaultPlatformConfig();
    }
}

/**
 * Update platform configuration.
 * Creates the config document if it doesn't exist.
 *
 * @param updates - Partial config updates
 * @param updatedBy - Optional identifier for who made the change
 * @returns Promise that resolves when update is complete
 *
 * @example
 * ```typescript
 * await updatePlatformConfig({
 *     archiveRetentionDays: 60,
 * }, 'admin@company.com');
 * ```
 */
export async function updatePlatformConfig(
    updates: PlatformConfigUpdates,
    updatedBy?: string
): Promise<void> {
    validatePlatformConfigUpdates(updates);

    try {
        const docRef = doc(db, CONFIG_DOC_PATH);
        const docSnap = await getDoc(docRef);

        const updateData = {
            ...updates,
            updatedAt: Date.now(),
            ...(updatedBy && { updatedBy }),
        };

        if (docSnap.exists()) {
            await updateDoc(docRef, updateData);
        } else {
            // Create with defaults + updates
            await setDoc(docRef, {
                ...createDefaultPlatformConfig(),
                ...updateData,
            });
        }

        log.info('Configuration updated', { updates });
    } catch (error) {
        log.error('Error updating config', error instanceof Error ? error : new Error(String(error)));
        throw new Error(`Failed to update platform config: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Reset platform configuration to defaults.
 *
 * @param updatedBy - Optional identifier for who made the change
 * @returns Promise that resolves when reset is complete
 */
export async function resetPlatformConfig(updatedBy?: string): Promise<void> {
    try {
        const docRef = doc(db, CONFIG_DOC_PATH);
        await setDoc(docRef, {
            ...createDefaultPlatformConfig(),
            updatedAt: Date.now(),
            ...(updatedBy && { updatedBy }),
        });

        log.info('Configuration reset to defaults');
    } catch (error) {
        log.error('Error resetting config', error instanceof Error ? error : new Error(String(error)));
        throw new Error(`Failed to reset platform config: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}
