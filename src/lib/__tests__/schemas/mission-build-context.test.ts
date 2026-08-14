import { buildContextManifestSchema, buildContextRefsSchema } from '@/lib/schemas/mission-build';
import { resolveBuildContext, type ContextResolvers } from '@/lib/build-mission-context';

const noResolvers: ContextResolvers = {
  getEntity: async () => null,
  getReport: async () => null,
  getDocument: async () => null,
  getSignal: async () => null,
  getDocumentText: async () => '',
};

describe('buildContextManifestSchema', () => {
  it('accepts a manifest produced by the resolver (resolver output is always schema-valid)', async () => {
    const manifest = await resolveBuildContext(
      'user-1',
      [
        { kind: 'entity', entityType: 'companies', id: 'c1' },
        { kind: 'report', id: 'rMissing' },
      ],
      {
        ...noResolvers,
        getEntity: async (_type, id) => ({ id, name: 'Acme', description: 'robotics' }),
      }
    );
    const parsed = buildContextManifestSchema.parse(manifest);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].ownership).toBe('shared');
    expect(parsed.omitted[0].reason).toBe('not-found');
    expect(parsed.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a manifest with a malformed digest', () => {
    expect(() =>
      buildContextManifestSchema.parse({
        version: 1,
        items: [],
        omitted: [],
        totalBytes: 0,
        counts: { requested: 0, resolved: 0, omitted: 0 },
        digest: 'not-a-real-hash',
      })
    ).toThrow();
  });

  it('rejects an unknown omission reason', () => {
    expect(() =>
      buildContextManifestSchema.parse({
        version: 1,
        items: [],
        omitted: [{ kind: 'report', refId: 'r1', reason: 'because-i-said-so' }],
        totalBytes: 0,
        counts: { requested: 1, resolved: 0, omitted: 1 },
        digest: 'a'.repeat(64),
      })
    ).toThrow();
  });

  it('bounds every caller-controlled manifest field and collection', async () => {
    const manifest = await resolveBuildContext('user-1', [{ kind: 'entity', entityType: 'companies', id: 'c1' }], {
      ...noResolvers,
      getEntity: async (_type, id) => ({ id, name: 'Acme', description: 'robotics' }),
    });

    expect(() =>
      buildContextManifestSchema.parse({
        ...manifest,
        items: manifest.items.map((item) => ({ ...item, title: 'x'.repeat(257) })),
      })
    ).toThrow();
    expect(() =>
      buildContextManifestSchema.parse({
        ...manifest,
        items: manifest.items.map((item) => ({
          ...item,
          provenance: { ...item.provenance, sources: Array(11).fill('https://example.com') },
        })),
      })
    ).toThrow();
    expect(() => buildContextManifestSchema.parse({ ...manifest, unexpected: 'field' })).toThrow();
  });
});

describe('buildContextRefsSchema (API input validation — BUILD-036)', () => {
  it('accepts a valid ref array', () => {
    const parsed = buildContextRefsSchema.parse([
      { kind: 'entity', entityType: 'companies', id: 'c1' },
      { kind: 'report', id: 'r1' },
    ]);
    expect(parsed).toHaveLength(2);
  });

  it('rejects an unknown kind, a null element, and a non-array', () => {
    expect(() => buildContextRefsSchema.parse([{ kind: 'secrets', id: 'x' }])).toThrow();
    expect(() => buildContextRefsSchema.parse([null])).toThrow();
    expect(() => buildContextRefsSchema.parse('nope')).toThrow();
  });

  it('requires entityType only for entity refs and rejects path-like ids', () => {
    expect(() => buildContextRefsSchema.parse([{ kind: 'entity', id: 'c1' }])).toThrow();
    expect(() => buildContextRefsSchema.parse([{ kind: 'report', id: 'r1', entityType: 'companies' }])).toThrow();
    expect(() => buildContextRefsSchema.parse([{ kind: 'document', id: '../secret' }])).toThrow();
  });

  it('bounds the ref count at the input layer', () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ kind: 'report', id: `r${i}` }));
    expect(() => buildContextRefsSchema.parse(many)).toThrow();
  });
});
