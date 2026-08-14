/**
 * @file lib/events/data-refresh.ts
 * @description Global event system for triggering data refreshes across the app.
 *
 * When the AI Assistant or any background process modifies data,
 * it can emit events that pages listen to for automatic refresh.
 *
 * @example
 * // In AI tool after creating an entity:
 * emitDataRefresh('companies');
 *
 * // In a page component:
 * useDataRefreshListener(['companies'], () => {
 *   loadCompanies();
 * });
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('events/data-refresh');

export type EntityTypeForRefresh =
  | 'companies'
  | 'technologies'
  | 'useCases'
  | 'prototypes'
  | 'strategies'
  | 'signals'
  | 'relations'
  | 'orgUnits'
  | 'initiatives'
  | 'painPoints'
  | 'documents'
  | 'reports'
  | 'radars'
  | 'radarPlacements'
  | 'all';

interface DataRefreshEvent {
  entityTypes: EntityTypeForRefresh[];
  timestamp: number;
  source?: string;
}

// Custom event name
const DATA_REFRESH_EVENT = 'radarist:data-refresh';

/**
 * Emit a data refresh event for specific entity types.
 * Pages listening to these entity types will automatically refresh.
 *
 * @param entityTypes - Entity types that were modified
 * @param source - Optional source identifier (e.g., 'ai-assistant', 'manual')
 */
export function emitDataRefresh(
  entityTypes: EntityTypeForRefresh | EntityTypeForRefresh[],
  source?: string
): void {
  const types = Array.isArray(entityTypes) ? entityTypes : [entityTypes];

  const event = new CustomEvent<DataRefreshEvent>(DATA_REFRESH_EVENT, {
    detail: {
      entityTypes: types,
      timestamp: Date.now(),
      source,
    },
  });

  if (typeof window !== 'undefined') {
    window.dispatchEvent(event);
    log.debug('Emitted refresh', { types, source });
  }
}

/**
 * Subscribe to data refresh events.
 *
 * @param callback - Function to call when a refresh event matches
 * @returns Cleanup function to unsubscribe
 */
export function subscribeToDataRefresh(
  callback: (event: DataRefreshEvent) => void
): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const handler = (e: Event) => {
    const customEvent = e as CustomEvent<DataRefreshEvent>;
    callback(customEvent.detail);
  };

  window.addEventListener(DATA_REFRESH_EVENT, handler);

  return () => {
    window.removeEventListener(DATA_REFRESH_EVENT, handler);
  };
}

/**
 * Check if a refresh event matches specific entity types.
 *
 * @param event - The refresh event
 * @param watchTypes - Entity types to check for
 * @returns true if the event matches any of the watched types
 */
export function matchesEntityTypes(
  event: DataRefreshEvent,
  watchTypes: EntityTypeForRefresh[]
): boolean {
  // 'all' matches everything
  if (event.entityTypes.includes('all')) {
    return true;
  }

  // Check if any watched type is in the event
  return watchTypes.some(type => event.entityTypes.includes(type));
}
