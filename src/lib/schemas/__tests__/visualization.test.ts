import {
  createVisualizationSchema,
  normalizeVisualizationDataSnapshot,
  MAX_VISUALIZATION_ENTITY_REFS,
  MAX_VISUALIZATION_ENTITY_ID_LENGTH,
  MAX_VISUALIZATION_ENTITY_NAME_LENGTH,
  MAX_VISUALIZATION_DATA_DESCRIPTION_LENGTH,
  VISUALIZATION_ENTITY_TYPES,
} from '../visualization';

const base = {
  title: 'Architecture Flow',
  prompt: 'render the auth flow',
  refinedPrompt: 'render the auth flow',
  imageUrl: 'https://storage.example.com/diagrams/u1/x.svg',
  thumbnailUrl: 'https://storage.example.com/diagrams/u1/x.svg',
  style: 'professional' as const,
  dataSnapshot: { entities: [], description: 'flowchart diagram' },
  createdBy: 'user-1',
  userId: 'user-1',
  metadata: { model: 'super-graph', width: 0, height: 0, sizeBytes: 512 },
};

describe('createVisualizationSchema mimeType', () => {
  it('accepts image/svg+xml (so rendered diagrams can be saved as visualizations)', () => {
    const result = createVisualizationSchema.safeParse({ ...base, mimeType: 'image/svg+xml' });
    expect(result.success).toBe(true);
  });

  it('still accepts the raster image types', () => {
    expect(createVisualizationSchema.safeParse({ ...base, mimeType: 'image/png' }).success).toBe(true);
    expect(createVisualizationSchema.safeParse({ ...base, mimeType: 'image/jpeg' }).success).toBe(true);
  });

  it('rejects an unsupported mime type', () => {
    expect(createVisualizationSchema.safeParse({ ...base, mimeType: 'image/gif' }).success).toBe(false);
  });

  it('does not accept a caller-selected internal storage cleanup path', () => {
    const result = createVisualizationSchema.parse({
      ...base,
      mimeType: 'image/png',
      storageObjectPath: 'visualizations/another-user/private-object',
    });

    expect(result).not.toHaveProperty('storageObjectPath');
  });
});

const withSnapshot = (dataSnapshot: unknown) => ({ ...base, mimeType: 'image/png', dataSnapshot });

const entity = (overrides: Record<string, unknown> = {}) => ({
  id: 'tech-1',
  name: 'React',
  type: 'technology',
  ...overrides,
});

describe('createVisualizationSchema bounded entity-snapshot contract', () => {
  it('accepts a snapshot at every documented bound', () => {
    const result = createVisualizationSchema.safeParse(
      withSnapshot({
        entities: Array.from({ length: MAX_VISUALIZATION_ENTITY_REFS }, (_, i) =>
          entity({
            id: `tech-${i}`.padEnd(MAX_VISUALIZATION_ENTITY_ID_LENGTH, 'x'),
            name: 'n'.repeat(MAX_VISUALIZATION_ENTITY_NAME_LENGTH),
          })
        ),
        description: 'd'.repeat(MAX_VISUALIZATION_DATA_DESCRIPTION_LENGTH),
      })
    );
    expect(result.success).toBe(true);
  });

  it('rejects more than 50 entity references', () => {
    const result = createVisualizationSchema.safeParse(
      withSnapshot({
        entities: Array.from({ length: MAX_VISUALIZATION_ENTITY_REFS + 1 }, (_, i) => entity({ id: `tech-${i}` })),
        description: 'too many',
      })
    );
    expect(result.success).toBe(false);
  });

  it('rejects duplicate entity ids (references must be unique)', () => {
    const result = createVisualizationSchema.safeParse(
      withSnapshot({ entities: [entity(), entity({ name: 'React again' })], description: 'dupes' })
    );
    expect(result.success).toBe(false);
  });

  it('rejects an empty or oversized entity id', () => {
    expect(
      createVisualizationSchema.safeParse(withSnapshot({ entities: [entity({ id: '' })], description: 'x' })).success
    ).toBe(false);
    expect(
      createVisualizationSchema.safeParse(
        withSnapshot({
          entities: [entity({ id: 'i'.repeat(MAX_VISUALIZATION_ENTITY_ID_LENGTH + 1) })],
          description: 'x',
        })
      ).success
    ).toBe(false);
  });

  it('rejects an oversized entity name', () => {
    const result = createVisualizationSchema.safeParse(
      withSnapshot({
        entities: [entity({ name: 'n'.repeat(MAX_VISUALIZATION_ENTITY_NAME_LENGTH + 1) })],
        description: 'x',
      })
    );
    expect(result.success).toBe(false);
  });

  it('accepts each canonical entity type plus unknown', () => {
    for (const type of [...VISUALIZATION_ENTITY_TYPES, 'unknown']) {
      const result = createVisualizationSchema.safeParse(
        withSnapshot({ entities: [entity({ type })], description: 'x' })
      );
      expect(result.success).toBe(true);
    }
  });

  it('rejects non-canonical entity types, including the legacy empty string', () => {
    for (const type of ['', 'robot', 'radarPlacement', 'TECHNOLOGY']) {
      const result = createVisualizationSchema.safeParse(
        withSnapshot({ entities: [entity({ type })], description: 'x' })
      );
      expect(result.success).toBe(false);
    }
  });

  it('rejects an oversized description', () => {
    const result = createVisualizationSchema.safeParse(
      withSnapshot({ entities: [], description: 'd'.repeat(MAX_VISUALIZATION_DATA_DESCRIPTION_LENGTH + 1) })
    );
    expect(result.success).toBe(false);
  });

  it('persists only id/name/type — extra entity fields are stripped (privacy)', () => {
    const result = createVisualizationSchema.parse(
      withSnapshot({
        entities: [entity({ description: 'internal notes', status: 'confidential', ownerEmail: 'a@b.c' })],
        description: 'x',
      })
    );
    expect(result.dataSnapshot.entities[0]).toEqual({ id: 'tech-1', name: 'React', type: 'technology' });
  });
});

describe('normalizeVisualizationDataSnapshot (in-memory legacy repair — no migration)', () => {
  it('normalizes a missing snapshot to the empty bounded shape', () => {
    expect(normalizeVisualizationDataSnapshot(undefined)).toEqual({ entities: [], description: '' });
    expect(normalizeVisualizationDataSnapshot(null)).toEqual({ entities: [], description: '' });
    expect(normalizeVisualizationDataSnapshot('legacy-string')).toEqual({ entities: [], description: '' });
  });

  it('passes a valid canonical snapshot through unchanged', () => {
    const snapshot = { entities: [entity()], description: 'clean' };
    expect(normalizeVisualizationDataSnapshot(snapshot)).toEqual(snapshot);
  });

  it('normalizes a non-array entities field to an empty list', () => {
    expect(normalizeVisualizationDataSnapshot({ entities: 'oops', description: 'x' })).toEqual({
      entities: [],
      description: 'x',
    });
  });

  it('drops entries without a usable id and coerces malformed names', () => {
    const result = normalizeVisualizationDataSnapshot({
      entities: [
        entity(),
        { id: '', name: 'no id', type: 'technology' },
        { id: '   ', name: 'blank id', type: 'technology' },
        { id: 42, name: 'numeric id', type: 'technology' },
        { id: 'tech-2', name: 12345, type: 'technology' },
        'not-an-object',
      ],
      description: 'x',
    });
    expect(result.entities).toEqual([
      { id: 'tech-1', name: 'React', type: 'technology' },
      { id: 'tech-2', name: '', type: 'technology' },
    ]);
  });

  it('maps legacy empty and unrecognized types to unknown', () => {
    const result = normalizeVisualizationDataSnapshot({
      entities: [entity({ id: 'a', type: '' }), entity({ id: 'b', type: 'robot' }), entity({ id: 'c', type: 7 })],
      description: 'x',
    });
    expect(result.entities.map((e) => e.type)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('clips oversized ids are dropped, oversized names and descriptions are clipped', () => {
    const result = normalizeVisualizationDataSnapshot({
      entities: [
        entity({ id: 'i'.repeat(MAX_VISUALIZATION_ENTITY_ID_LENGTH + 1) }),
        entity({ id: 'tech-2', name: 'n'.repeat(MAX_VISUALIZATION_ENTITY_NAME_LENGTH + 50) }),
      ],
      description: 'd'.repeat(MAX_VISUALIZATION_DATA_DESCRIPTION_LENGTH + 50),
    });
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].id).toBe('tech-2');
    expect(result.entities[0].name).toHaveLength(MAX_VISUALIZATION_ENTITY_NAME_LENGTH);
    expect(result.description).toHaveLength(MAX_VISUALIZATION_DATA_DESCRIPTION_LENGTH);
  });

  it('strips extra entity fields in memory (privacy)', () => {
    const result = normalizeVisualizationDataSnapshot({
      entities: [entity({ status: 'secret', notes: 'internal' })],
      description: 'x',
    });
    expect(result.entities[0]).toEqual({ id: 'tech-1', name: 'React', type: 'technology' });
  });

  it('deduplicates by id keeping the first occurrence and caps at 50 references', () => {
    const result = normalizeVisualizationDataSnapshot({
      entities: [
        entity({ name: 'First' }),
        entity({ name: 'Second' }),
        ...Array.from({ length: MAX_VISUALIZATION_ENTITY_REFS + 10 }, (_, i) => entity({ id: `extra-${i}` })),
      ],
      description: 'x',
    });
    expect(result.entities).toHaveLength(MAX_VISUALIZATION_ENTITY_REFS);
    expect(result.entities[0]).toEqual({ id: 'tech-1', name: 'First', type: 'technology' });
    expect(result.entities.filter((e) => e.id === 'tech-1')).toHaveLength(1);
  });

  it('trims whitespace-padded legacy ids so live lookups can match', () => {
    const result = normalizeVisualizationDataSnapshot({
      entities: [entity({ id: '  tech-9  ' })],
      description: 'x',
    });
    expect(result.entities[0].id).toBe('tech-9');
  });
});
