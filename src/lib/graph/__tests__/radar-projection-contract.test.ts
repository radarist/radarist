import { buildRadarGraphProjectionProperties } from '../radar-projection-contract';

describe('Radar graph projection contract', () => {
  it('maps the authoritative Radar document to the exact Neo4j property shape', () => {
    expect(
      buildRadarGraphProjectionProperties({
        id: 'radar-1',
        name: 'AI Radar',
        slug: 'ai-radar',
        description: 'Reviewed source',
        quadrants: [
          { id: 'q-2', name: 'Assess', order: 2 },
          { id: 'q-1', name: 'Adopt', order: 1 },
        ],
        entries: [],
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_100_000,
      })
    ).toEqual({
      id: 'radar-1',
      name: 'AI Radar',
      slug: 'ai-radar',
      description: 'Reviewed source',
      ringSystem: 'Standard',
      quadrantIds: ['q-2', 'q-1'],
      quadrantNames: ['Assess', 'Adopt'],
      quadrantCount: 2,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
    });
  });

  it('uses the same timestamp and null defaults as the graph writer', () => {
    const timestamp = { toMillis: () => 1_700_000_000_000 };
    expect(
      buildRadarGraphProjectionProperties({
        id: 'radar-2',
        name: 'Defaulted Radar',
        quadrants: [{ id: 'q-1', name: 'Adopt', order: 0 }],
        entries: [],
        createdAt: timestamp as never,
      })
    ).toMatchObject({
      slug: null,
      description: null,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
  });
});
