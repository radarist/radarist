/**
 * Tests for lib/auto-linker-utils.ts
 *
 * Client-side utility functions for auto-linker:
 * - createSnapshotFromSuggestion: SuggestedRelation → EntitySnapshot
 */

import { createSnapshotFromSuggestion } from '../auto-linker-utils';
import type { SuggestedRelation } from '../auto-linker-utils';

// ============================================================================
// TEST HELPERS
// ============================================================================

function makeSuggestion(overrides: Partial<SuggestedRelation> = {}): SuggestedRelation {
  return {
    entityType: 'technology',
    entityId: 'entity-123',
    entityName: 'React',
    relationType: 'uses',
    confidence: 85,
    ...overrides,
  };
}

// ============================================================================
// createSnapshotFromSuggestion
// ============================================================================

describe('createSnapshotFromSuggestion', () => {
  it('should map entityType to snapshot type', () => {
    const suggestion = makeSuggestion({ entityType: 'company' });
    const snapshot = createSnapshotFromSuggestion(suggestion);
    expect(snapshot.type).toBe('company');
  });

  it('should map entityId to snapshot id', () => {
    const suggestion = makeSuggestion({ entityId: 'my-entity-id' });
    const snapshot = createSnapshotFromSuggestion(suggestion);
    expect(snapshot.id).toBe('my-entity-id');
  });

  it('should map entityName to snapshot name', () => {
    const suggestion = makeSuggestion({ entityName: 'Datadog' });
    const snapshot = createSnapshotFromSuggestion(suggestion);
    expect(snapshot.name).toBe('Datadog');
  });

  it('should map entityDescription to snapshot description', () => {
    const suggestion = makeSuggestion({ entityDescription: 'A monitoring platform' });
    const snapshot = createSnapshotFromSuggestion(suggestion);
    expect(snapshot.description).toBe('A monitoring platform');
  });

  it('should set description to undefined when entityDescription is not provided', () => {
    const suggestion = makeSuggestion();
    // No entityDescription set
    const snapshot = createSnapshotFromSuggestion(suggestion);
    expect(snapshot.description).toBeUndefined();
  });

  it('should set snapshotAt to a recent timestamp', () => {
    const before = Date.now();
    const snapshot = createSnapshotFromSuggestion(makeSuggestion());
    const after = Date.now();
    expect(snapshot.snapshotAt).toBeGreaterThanOrEqual(before);
    expect(snapshot.snapshotAt).toBeLessThanOrEqual(after);
  });

  it('should return a complete EntitySnapshot shape', () => {
    const suggestion = makeSuggestion({
      entityType: 'signal',
      entityId: 'sig-999',
      entityName: 'AI Signal',
      entityDescription: 'An AI-related signal',
    });
    const snapshot = createSnapshotFromSuggestion(suggestion);

    expect(snapshot).toMatchObject({
      type: 'signal',
      id: 'sig-999',
      name: 'AI Signal',
      description: 'An AI-related signal',
    });
    expect(typeof snapshot.snapshotAt).toBe('number');
  });

  it('should handle all EntityType values', () => {
    const entityTypes: SuggestedRelation['entityType'][] = [
      'technology',
      'company',
      'useCase',
      'strategy',
      'prototype',
      'signal',
      'document',
      'orgUnit',
      'initiative',
      'painPoint',
      'radarPlacement',
    ];

    for (const entityType of entityTypes) {
      const snapshot = createSnapshotFromSuggestion(makeSuggestion({ entityType }));
      expect(snapshot.type).toBe(entityType);
    }
  });

  it('should not include relationType or confidence in snapshot', () => {
    const snapshot = createSnapshotFromSuggestion(makeSuggestion());
    expect(snapshot).not.toHaveProperty('relationType');
    expect(snapshot).not.toHaveProperty('confidence');
  });
});

export {};
