/**
 * Unit Tests for Technology Adapters
 *
 * Tests the adapter functions that bridge between the legacy RadarEntry model
 * and the new decoupled Technology/RadarPlacement model.
 *
 * These are pure functions that can be tested without mocking Firestore.
 *
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals';
import type { Technology, RadarPlacement, TechnologyWithPlacement, RadarEntry, TechnologyCategory } from '../types';
import {
  toRadarEntry,
  technologyWithPlacementToRadarEntry,
  toRadarEntries,
  toTechnologyWithRadar,
  fromRadarEntry,
  hashStringToNumber,
  slugify,
  inferCategoryFromQuadrantName,
  createTechnologyLookupMap,
  createRadarEntryToTechnologyMap,
  isTechnologyWithPlacement,
  isRadarEntry,
} from '../technology-adapters';

// Shared mock radar with canonical 4-quadrant config + stable ids.
// Adapter functions take `radar: Pick<RadarData, 'quadrants'>` and use it to
// denormalize `quadrantName` onto view types.
const MOCK_RADAR = {
  quadrants: [
    { id: 'q_techniques', name: 'Techniques', order: 0 },
    { id: 'q_tools', name: 'Tools', order: 1 },
    { id: 'q_platforms', name: 'Platforms', order: 2 },
    { id: 'q_languages_frameworks', name: 'Languages & Frameworks', order: 3 },
  ],
};

// ============================================================================
// TEST DATA HELPERS
// ============================================================================

/**
 * Helper to create a mock Technology for testing
 */
function createMockTechnology(overrides?: Partial<Technology>): Technology {
  return {
    id: 'tech-123',
    name: 'React',
    slug: 'react',
    description: 'A JavaScript library for building user interfaces',
    category: 'framework' as TechnologyCategory,
    tags: ['frontend', 'javascript', 'ui'],
    websiteUrl: 'https://react.dev',
    githubUrl: 'https://github.com/facebook/react',
    documentationUrl: 'https://react.dev/docs',
    linkedCompanies: ['company-meta'],
    linkedUseCases: ['usecase-web-apps'],
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now(),
    createdBy: 'user-123',
    ...overrides,
  };
}

/**
 * Helper to create a mock RadarPlacement for testing
 */
function createMockPlacement(overrides?: Partial<RadarPlacement>): RadarPlacement {
  return {
    id: 'placement-123',
    technologyId: 'tech-123',
    radarId: 'radar-1',
    quadrantId: 'q_languages_frameworks',
    ring: 'Adopt',
    rationale: 'Mature framework with strong team expertise',
    x: 0.5,
    y: 0.5,
    status: 'Stable',
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now(),
    placedBy: 'user-123',
    ...overrides,
  };
}

/**
 * Helper to create a mock TechnologyWithPlacement
 */
function createMockTechnologyWithPlacement(
  techOverrides?: Partial<Technology>,
  placementOverrides?: Partial<RadarPlacement>
): TechnologyWithPlacement {
  const tech = createMockTechnology(techOverrides);
  const placement = createMockPlacement(placementOverrides);
  return {
    ...tech,
    placement,
  };
}

/**
 * Helper to create a mock legacy RadarEntry
 */
function createMockRadarEntry(overrides?: Partial<RadarEntry>): RadarEntry {
  return {
    id: 42,
    name: 'React',
    description: 'A JavaScript library for building user interfaces',
    quadrantId: 'q_languages_frameworks',
    quadrantName: 'Languages & Frameworks',
    ring: 'Adopt',
    status: 'Stable',
    tags: ['frontend', 'javascript', 'ui'],
    linkedUseCases: ['usecase-web-apps'],
    costToPrototype: 30,
    history: [
      { date: '2024-01-01', ring: 'Trial', status: 'Trending' },
      { date: '2024-06-01', ring: 'Adopt', status: 'Stable' },
    ],
    ...overrides,
  };
}

// ============================================================================
// TRANSFORM: New Model → Legacy Model
// ============================================================================

describe('Technology Adapters - New to Legacy', () => {
  describe('toRadarEntry()', () => {
    it('should transform Technology + RadarPlacement to RadarEntry', () => {
      const technology = createMockTechnology();
      const placement = createMockPlacement();

      const result = toRadarEntry(technology, placement, MOCK_RADAR);

      expect(result.name).toBe('React');
      expect(result.description).toBe('A JavaScript library for building user interfaces');
      expect(result.quadrantName).toBe('Languages & Frameworks');
      expect(result.ring).toBe('Adopt');
      expect(result.status).toBe('Stable');
      expect(result.tags).toEqual(['frontend', 'javascript', 'ui']);
      expect(typeof result.id).toBe('number');
    });

    it('should generate consistent numeric ID from technology ID', () => {
      const technology = createMockTechnology({ id: 'tech-abc-123' });
      const placement = createMockPlacement();

      const result1 = toRadarEntry(technology, placement, MOCK_RADAR);
      const result2 = toRadarEntry(technology, placement, MOCK_RADAR);

      expect(result1.id).toBe(result2.id);
    });

    it('should pass through coordinates', () => {
      const technology = createMockTechnology();
      const placement = createMockPlacement({ x: 0.75, y: 0.25 });

      const result = toRadarEntry(technology, placement, MOCK_RADAR);

      expect(result.x).toBe(0.75);
      expect(result.y).toBe(0.25);
    });

    it('should create history from movedFrom data', () => {
      const technology = createMockTechnology();
      const placement = createMockPlacement({
        movedFrom: 'Trial',
        movedAt: Date.now() - 86400000,
      });

      const result = toRadarEntry(technology, placement, MOCK_RADAR);

      expect(result.history).toHaveLength(1);
      expect(result.history![0].ring).toBe('Trial');
    });

    it('should default status to Stable when not set', () => {
      const technology = createMockTechnology();
      const placement = createMockPlacement({ status: undefined });

      const result = toRadarEntry(technology, placement, MOCK_RADAR);

      expect(result.status).toBe('Stable');
    });

    it('resolves a legacy quadrant name case-insensitively without trimming it', () => {
      const technology = createMockTechnology();
      const byName = {
        ...createMockPlacement({ quadrantId: '' }),
        quadrant: 'tOoLs',
      } as RadarPlacement;
      const spacedName = {
        ...createMockPlacement({ quadrantId: '' }),
        quadrant: ' Tools ',
      } as RadarPlacement;

      const resolved = toRadarEntry(technology, byName, MOCK_RADAR);
      const fallback = toRadarEntry(technology, spacedName, MOCK_RADAR);

      expect(resolved.quadrantId).toBe('q_tools');
      expect(resolved.quadrantName).toBe('Tools');
      expect(fallback.quadrantId).toBe('q_techniques');
      expect(fallback.quadrantName).toBe('Techniques');
    });

    it('should preserve linkedUseCases', () => {
      const technology = createMockTechnology({
        linkedUseCases: ['uc-1', 'uc-2', 'uc-3'],
      });
      const placement = createMockPlacement();

      const result = toRadarEntry(technology, placement, MOCK_RADAR);

      expect(result.linkedUseCases).toEqual(['uc-1', 'uc-2', 'uc-3']);
    });
  });

  describe('technologyWithPlacementToRadarEntry()', () => {
    it('should transform TechnologyWithPlacement to RadarEntry', () => {
      const twp = createMockTechnologyWithPlacement();

      const result = technologyWithPlacementToRadarEntry(twp, MOCK_RADAR);

      expect(result.name).toBe('React');
      expect(result.quadrantName).toBe('Languages & Frameworks');
      expect(result.ring).toBe('Adopt');
      expect(typeof result.id).toBe('number');
    });

    it('should extract all technology fields correctly', () => {
      const twp = createMockTechnologyWithPlacement(
        {
          id: 'tech-vue',
          name: 'Vue.js',
          slug: 'vue-js',
          description: 'Progressive JavaScript framework',
          category: 'framework',
          tags: ['frontend', 'javascript'],
          linkedUseCases: ['uc-spa'],
        },
        {
          quadrantId: 'q_languages_frameworks',
          ring: 'Trial',
          status: 'Trending',
        }
      );

      const result = technologyWithPlacementToRadarEntry(twp, MOCK_RADAR);

      expect(result.name).toBe('Vue.js');
      expect(result.description).toBe('Progressive JavaScript framework');
      expect(result.tags).toEqual(['frontend', 'javascript']);
      expect(result.ring).toBe('Trial');
      expect(result.status).toBe('Trending');
    });
  });

  describe('toRadarEntries()', () => {
    it('should transform array of TechnologyWithPlacements', () => {
      const technologies = [
        createMockTechnologyWithPlacement({ id: 'tech-1', name: 'React' }),
        createMockTechnologyWithPlacement({ id: 'tech-2', name: 'Vue' }),
        createMockTechnologyWithPlacement({ id: 'tech-3', name: 'Angular' }),
      ];

      const result = toRadarEntries(technologies, MOCK_RADAR);

      expect(result).toHaveLength(3);
      expect(result[0].name).toBe('React');
      expect(result[1].name).toBe('Vue');
      expect(result[2].name).toBe('Angular');
    });

    it('should handle empty array', () => {
      const result = toRadarEntries([], MOCK_RADAR);

      expect(result).toHaveLength(0);
    });
  });

  describe('toTechnologyWithRadar()', () => {
    it('should transform TechnologyWithPlacement for library view', () => {
      const twp = createMockTechnologyWithPlacement();

      const result = toTechnologyWithRadar(twp, 'My Company Radar', MOCK_RADAR);

      expect(result.name).toBe('React');
      expect(result.radarName).toBe('My Company Radar');
      expect(result.radarId).toBe('radar-1');
      expect(result.quadrantName).toBe('Languages & Frameworks');
      expect(result.ring).toBe('Adopt');
      expect(typeof result.id).toBe('number');
    });

    it('should include all required fields', () => {
      const twp = createMockTechnologyWithPlacement({ tags: ['a', 'b', 'c'] }, { status: 'Trending' });

      const result = toTechnologyWithRadar(twp, 'Test Radar', MOCK_RADAR);

      expect(result.tags).toEqual(['a', 'b', 'c']);
      expect(result.status).toBe('Trending');
      expect(result.costToPrototype).toBe(50); // Default value
      expect(result.history).toEqual([]); // Default empty
    });
  });
});

// ============================================================================
// TRANSFORM: Legacy Model → New Model
// ============================================================================

describe('Technology Adapters - Legacy to New', () => {
  describe('fromRadarEntry()', () => {
    it('should transform RadarEntry to new model format', () => {
      const entry = createMockRadarEntry();

      const result = fromRadarEntry(entry, 'radar-1', 'user-123', MOCK_RADAR);

      expect(result.technology.name).toBe('React');
      expect(result.technology.description).toBe('A JavaScript library for building user interfaces');
      expect(result.technology.slug).toBe('react');
      expect(result.technology.tags).toEqual(['frontend', 'javascript', 'ui']);
      expect(result.technology.createdBy).toBe('user-123');

      expect(result.placement.radarId).toBe('radar-1');
      expect(result.placement.quadrantId).toBe('q_languages_frameworks');
      expect(result.placement.ring).toBe('Adopt');
      expect(result.placement.status).toBe('Stable');
      expect(result.placement.placedBy).toBe('user-123');
    });

    it('should handle entry without tags', () => {
      const entry = createMockRadarEntry({ tags: undefined });

      const result = fromRadarEntry(entry, 'radar-1', 'user-123', MOCK_RADAR);

      expect(result.technology.tags).toEqual([]);
    });

    it('should preserve linkedUseCases', () => {
      const entry = createMockRadarEntry({
        linkedUseCases: ['uc-1', 'uc-2'],
      });

      const result = fromRadarEntry(entry, 'radar-1', 'user-123', MOCK_RADAR);

      expect(result.technology.linkedUseCases).toEqual(['uc-1', 'uc-2']);
    });
  });
});

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

describe('Technology Adapters - Utility Functions', () => {
  describe('hashStringToNumber()', () => {
    it('should generate consistent hash for same string', () => {
      const hash1 = hashStringToNumber('tech-abc-123');
      const hash2 = hashStringToNumber('tech-abc-123');

      expect(hash1).toBe(hash2);
    });

    it('should generate different hashes for different strings', () => {
      const hash1 = hashStringToNumber('tech-abc');
      const hash2 = hashStringToNumber('tech-xyz');

      expect(hash1).not.toBe(hash2);
    });

    it('should return non-negative numbers', () => {
      const testStrings = ['abc', '123', 'test-string', '', 'a'];

      testStrings.forEach((str) => {
        expect(hashStringToNumber(str)).toBeGreaterThanOrEqual(0);
      });
    });

    it('should handle empty string', () => {
      const hash = hashStringToNumber('');

      expect(typeof hash).toBe('number');
      expect(hash).toBeGreaterThanOrEqual(0);
    });
  });

  describe('slugify()', () => {
    it('should convert to lowercase', () => {
      expect(slugify('REACT')).toBe('react');
      expect(slugify('VueJS')).toBe('vuejs');
    });

    it('should replace spaces with hyphens', () => {
      expect(slugify('React Native')).toBe('react-native');
      expect(slugify('Next.js App Router')).toBe('next-js-app-router');
    });

    it('should remove special characters', () => {
      expect(slugify('C++')).toBe('c');
      expect(slugify('React@18')).toBe('react-18');
      expect(slugify('Node.js')).toBe('node-js');
    });

    it('should remove leading/trailing hyphens', () => {
      expect(slugify('--react--')).toBe('react');
      expect(slugify('  vue  ')).toBe('vue');
    });

    it('should handle empty string', () => {
      expect(slugify('')).toBe('');
    });
  });

  describe('inferCategoryFromQuadrantName()', () => {
    it('should map known quadrants to categories', () => {
      expect(inferCategoryFromQuadrantName('Languages & Frameworks')).toBe('framework');
      expect(inferCategoryFromQuadrantName('Tools')).toBe('tool');
      expect(inferCategoryFromQuadrantName('Platforms')).toBe('platform');
      expect(inferCategoryFromQuadrantName('Techniques')).toBe('methodology');
      expect(inferCategoryFromQuadrantName('Infrastructure')).toBe('infrastructure');
      expect(inferCategoryFromQuadrantName('Services')).toBe('service');
      expect(inferCategoryFromQuadrantName('Libraries')).toBe('library');
    });

    it('should return undefined for unknown quadrants', () => {
      expect(inferCategoryFromQuadrantName('Unknown')).toBeUndefined();
      expect(inferCategoryFromQuadrantName('Custom Quadrant')).toBeUndefined();
    });
  });

  describe('createTechnologyLookupMap()', () => {
    it('should create map from technology ID to TechnologyWithPlacement', () => {
      const technologies = [
        createMockTechnologyWithPlacement({ id: 'tech-1' }),
        createMockTechnologyWithPlacement({ id: 'tech-2' }),
        createMockTechnologyWithPlacement({ id: 'tech-3' }),
      ];

      const result = createTechnologyLookupMap(technologies);

      expect(result.size).toBe(3);
      expect(result.get('tech-1')).toBeDefined();
      expect(result.get('tech-2')).toBeDefined();
      expect(result.get('tech-3')).toBeDefined();
      expect(result.get('nonexistent')).toBeUndefined();
    });

    it('should handle empty array', () => {
      const result = createTechnologyLookupMap([]);

      expect(result.size).toBe(0);
    });
  });

  describe('createRadarEntryToTechnologyMap()', () => {
    it('should create map from numeric entry ID to technology ID', () => {
      const technologies = [
        createMockTechnologyWithPlacement({ id: 'tech-abc' }),
        createMockTechnologyWithPlacement({ id: 'tech-xyz' }),
      ];

      const result = createRadarEntryToTechnologyMap(technologies);

      expect(result.size).toBe(2);

      // Get the hashed IDs
      const hashAbc = hashStringToNumber('tech-abc');
      const hashXyz = hashStringToNumber('tech-xyz');

      expect(result.get(hashAbc)).toBe('tech-abc');
      expect(result.get(hashXyz)).toBe('tech-xyz');
    });
  });
});

// ============================================================================
// TYPE GUARDS
// ============================================================================

describe('Technology Adapters - Type Guards', () => {
  describe('isTechnologyWithPlacement()', () => {
    it('should return true for valid TechnologyWithPlacement', () => {
      const twp = createMockTechnologyWithPlacement();

      expect(isTechnologyWithPlacement(twp)).toBe(true);
    });

    it('should return false for plain Technology without placement', () => {
      const tech = createMockTechnology();

      expect(isTechnologyWithPlacement(tech)).toBe(false);
    });

    it('should return false for null/undefined', () => {
      expect(isTechnologyWithPlacement(null)).toBe(false);
      expect(isTechnologyWithPlacement(undefined)).toBe(false);
    });

    it('should return false for non-objects', () => {
      expect(isTechnologyWithPlacement('string')).toBe(false);
      expect(isTechnologyWithPlacement(123)).toBe(false);
      expect(isTechnologyWithPlacement([])).toBe(false);
    });

    it('should return false when placement is not an object', () => {
      const invalid = {
        ...createMockTechnology(),
        placement: 'not-an-object',
      };

      expect(isTechnologyWithPlacement(invalid)).toBe(false);
    });
  });

  describe('isRadarEntry()', () => {
    it('should return true for valid RadarEntry', () => {
      const entry = createMockRadarEntry();

      expect(isRadarEntry(entry)).toBe(true);
    });

    it('should return false when id is not a number', () => {
      const invalid = {
        ...createMockRadarEntry(),
        id: 'string-id',
      };

      expect(isRadarEntry(invalid)).toBe(false);
    });

    it('should return false for TechnologyWithPlacement', () => {
      const twp = createMockTechnologyWithPlacement();

      // TechnologyWithPlacement has string id, not number
      expect(isRadarEntry(twp)).toBe(false);
    });

    it('should return false for null/undefined', () => {
      expect(isRadarEntry(null)).toBe(false);
      expect(isRadarEntry(undefined)).toBe(false);
    });

    it('should return false for objects missing required fields', () => {
      expect(isRadarEntry({ id: 1 })).toBe(false);
      expect(isRadarEntry({ id: 1, name: 'test' })).toBe(false);
      expect(isRadarEntry({ id: 1, name: 'test', quadrant: 'Q1' })).toBe(false);
    });

    it('should return true when all required fields present', () => {
      const minimal = {
        id: 1,
        name: 'Test',
        quadrantId: 'q_tools',
        ring: 'Adopt',
      };

      expect(isRadarEntry(minimal)).toBe(true);
    });
  });
});

// ============================================================================
// EDGE CASES
// ============================================================================

describe('Technology Adapters - Edge Cases', () => {
  it('should handle technology with no optional fields', () => {
    const tech: Technology = {
      id: 'tech-minimal',
      name: 'Minimal',
      slug: 'minimal',
      description: 'Minimal tech',
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: 'user-1',
    };
    const placement = createMockPlacement({ technologyId: 'tech-minimal' });

    const result = toRadarEntry(tech, placement, MOCK_RADAR);

    expect(result.name).toBe('Minimal');
    expect(result.linkedUseCases).toEqual([]);
  });

  it('should handle placement with no coordinates', () => {
    const tech = createMockTechnology();
    const placement = createMockPlacement({ x: undefined, y: undefined });

    const result = toRadarEntry(tech, placement, MOCK_RADAR);

    expect(result.x).toBeUndefined();
    expect(result.y).toBeUndefined();
  });

  it('should handle unicode in names', () => {
    const tech = createMockTechnology({ name: '日本語テスト' });
    const placement = createMockPlacement();

    const result = toRadarEntry(tech, placement, MOCK_RADAR);

    expect(result.name).toBe('日本語テスト');
  });

  it('should handle very long descriptions', () => {
    const longDescription = 'A'.repeat(10000);
    const tech = createMockTechnology({ description: longDescription });
    const placement = createMockPlacement();

    const result = toRadarEntry(tech, placement, MOCK_RADAR);

    expect(result.description).toBe(longDescription);
  });
});
