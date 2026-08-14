/**
 * @jest-environment node
 */

jest.mock('@/lib/ai/image-client', () => ({
  __esModule: true,
  generateInfographic: jest.fn(),
}));

jest.mock('@/lib/visualizations', () => ({
  __esModule: true,
  createVisualization: jest.fn().mockResolvedValue({
    id: 'viz-1',
    title: 'Test',
  }),
  buildLearnedStyleFragment: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/storage', () => ({
  __esModule: true,
  deleteStoredImage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/graph/traversal', () => ({
  __esModule: true,
  getEntities: jest.fn().mockResolvedValue([]),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockGenerateInfographic = jest.requireMock('@/lib/ai/image-client').generateInfographic;
const mockCreateVisualization = jest.requireMock('@/lib/visualizations').createVisualization;
const mockBuildLearnedStyleFragment = jest.requireMock('@/lib/visualizations').buildLearnedStyleFragment;
const mockDeleteStoredImage = jest.requireMock('@/lib/storage').deleteStoredImage;
const mockGetEntities = jest.requireMock('@/lib/graph/traversal').getEntities;
const mockFirestoreGetAll = jest.fn();
const mockFirestoreCollection = jest.fn((collection: string) => ({
  doc: (id: string) => ({ collection, id, path: `${collection}/${id}` }),
}));

jest.mock('@/lib/firebase-admin', () => ({
  __esModule: true,
  db: {
    collection: (...args: unknown[]) => mockFirestoreCollection(...(args as [string])),
    getAll: (...args: unknown[]) => mockFirestoreGetAll(...args),
  },
}));

import { VISUALIZATION_TOOLS } from '../visualization-tools';
import { executeGenerateInfographic, executeGenerateVisualization } from '../visualization-tools';

describe('visualization-tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateVisualization.mockResolvedValue({ id: 'viz-1', title: 'Test' });
    mockBuildLearnedStyleFragment.mockResolvedValue(undefined);
    mockDeleteStoredImage.mockResolvedValue(undefined);
    mockGetEntities.mockResolvedValue([]);
    mockFirestoreGetAll.mockImplementation(async (...refs: Array<{ id: string }>) =>
      refs.map((ref) => ({ id: ref.id, exists: false, data: () => undefined }))
    );
  });

  describe('tool declarations', () => {
    it('should export VISUALIZATION_TOOLS array with both tools', () => {
      expect(Array.isArray(VISUALIZATION_TOOLS)).toBe(true);
      const names = VISUALIZATION_TOOLS.map((t) => t.name);
      expect(names).toContain('generateInfographic');
      expect(names).toContain('generateVisualization');
    });

    it('declares typed entityRefs and does not force callers through untyped entityIds', () => {
      const generateVisualization = VISUALIZATION_TOOLS.find((t) => t.name === 'generateVisualization');
      const properties = generateVisualization?.parameters?.properties as Record<string, { type?: unknown }>;
      expect(properties.entityRefs).toBeDefined();
      expect(properties.entityIds).toBeDefined();
      const required = generateVisualization?.parameters?.required ?? [];
      expect(required).not.toContain('entityIds');
      expect(required).toEqual(expect.arrayContaining(['prompt', 'title', 'dataDescription']));
    });
  });

  describe('executeGenerateInfographic', () => {
    it('should generate image and return URL', async () => {
      mockGenerateInfographic.mockResolvedValue({
        success: true,
        url: 'https://storage.example.com/infographic.png',
      });

      const result = await executeGenerateInfographic({
        prompt: 'Show top 5 technologies',
        style: 'professional',
      });

      expect(result.success).toBe(true);
      expect(result.imageUrl).toBe('https://storage.example.com/infographic.png');
      // Should NOT save to visualizations collection
      expect(mockCreateVisualization).not.toHaveBeenCalled();
    });

    it('should return error when generation fails', async () => {
      mockGenerateInfographic.mockResolvedValue({
        success: false,
        url: null,
        error: 'Quota exceeded',
      });

      const result = await executeGenerateInfographic({
        prompt: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Quota exceeded');
    });

    it('should use infographics path prefix', async () => {
      mockGenerateInfographic.mockResolvedValue({
        success: true,
        url: 'https://example.com/img.png',
      });

      await executeGenerateInfographic({ prompt: 'test', style: 'minimal' }, 'user-1');

      expect(mockGenerateInfographic).toHaveBeenCalledWith(
        expect.objectContaining({
          pathPrefix: 'infographics',
          userId: 'user-1',
        })
      );
    });

    it('should forward referenceImage when provided (regenerate-in-style)', async () => {
      mockGenerateInfographic.mockResolvedValue({
        success: true,
        url: 'https://example.com/img.png',
      });
      const ref = { data: 'AAAA', mimeType: 'image/png' };

      await executeGenerateInfographic({ prompt: 'bars' }, 'u1', ref);

      expect(mockGenerateInfographic.mock.calls[0][0]).toMatchObject({ referenceImage: ref });
    });

    it('should omit referenceImage when none is provided', async () => {
      mockGenerateInfographic.mockResolvedValue({
        success: true,
        url: 'https://example.com/img.png',
      });

      await executeGenerateInfographic({ prompt: 'bars' }, 'u1');

      expect(mockGenerateInfographic.mock.calls[0][0].referenceImage).toBeUndefined();
    });

    it('injects the learned-style fragment into generation when present', async () => {
      mockBuildLearnedStyleFragment.mockResolvedValueOnce(
        'Match the visual language of these previously liked designs: "Growth Curve" (professional)'
      );
      mockGenerateInfographic.mockResolvedValue({ success: true, url: 'https://example.com/img.png' });

      await executeGenerateInfographic({ prompt: 'bars' }, 'u1');

      expect(mockGenerateInfographic.mock.calls[0][0].brandStyle).toContain('Growth Curve');
    });

    it('generates cleanly when fragment lookup fails', async () => {
      mockBuildLearnedStyleFragment.mockRejectedValueOnce(new Error('Firestore unavailable'));
      mockGenerateInfographic.mockResolvedValue({ success: true, url: 'https://example.com/img.png' });

      const result = await executeGenerateInfographic({ prompt: 'bars' }, 'u1');

      expect(result.success).toBe(true);
      expect(mockGenerateInfographic.mock.calls[0][0].brandStyle).toBeUndefined();
    });
  });

  describe('executeGenerateVisualization', () => {
    it('returns the persisted record identity and exact navigation link, separate from storage identity', async () => {
      mockGenerateInfographic.mockResolvedValue({
        success: true,
        url: 'https://storage.example.com/viz.png',
        mimeType: 'image/png',
        width: 1376,
        height: 768,
        sizeBytes: 523568,
      });
      mockGetEntities.mockResolvedValue([
        {
          id: 'tech-1',
          labels: ['Entity', 'Technology'],
          properties: { id: 'tech-1', name: 'Quantum Annealing' },
        },
        {
          id: 'tech-2',
          labels: ['Entity', 'Technology'],
          properties: { id: 'tech-2', name: 'Quantum Sensing' },
        },
      ]);
      mockCreateVisualization.mockResolvedValue({ id: 'viz-firestore-123', title: 'TRL Comparison' });

      const result = await executeGenerateVisualization(
        {
          prompt: 'Compare TRL scores',
          title: 'TRL Comparison',
          style: 'professional',
          aspectRatio: '16:9',
          entityIds: ['tech-1', 'tech-2'],
          dataDescription: '5 technologies',
        },
        'user-1'
      );

      expect(result.success).toBe(true);
      expect(result.imageUrl).toBe('https://storage.example.com/viz.png');
      expect(result.visualizationId).toBe('viz-firestore-123');
      expect(result.url).toBe('/infographics/viz-firestore-123');
      expect(mockCreateVisualization).toHaveBeenCalledTimes(1);
      const generationInput = mockGenerateInfographic.mock.calls[0][0];
      const createInput = mockCreateVisualization.mock.calls[0][0];
      expect(generationInput.filename).toMatch(/^visualization-asset-/);
      expect(createInput.storageObjectPath).toBe(`visualizations/user-1/${generationInput.filename}`);
      expect(result.visualizationId).not.toBe(generationInput.filename);
      expect(mockCreateVisualization).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'TRL Comparison',
          style: 'professional',
          userId: 'user-1',
          dataSnapshot: {
            entities: [
              { id: 'tech-1', name: 'Quantum Annealing', type: 'technology' },
              { id: 'tech-2', name: 'Quantum Sensing', type: 'technology' },
            ],
            description: '5 technologies',
          },
          metadata: {
            model: 'gemini-3-pro-image',
            width: 1376,
            height: 768,
            sizeBytes: 523568,
          },
        })
      );
      expect(mockFirestoreGetAll).not.toHaveBeenCalled();
    });

    it('saves an untyped id as an exact-ID unknown reference when the graph lookup fails', async () => {
      mockGenerateInfographic.mockResolvedValue({
        success: true,
        url: 'https://storage.example.com/viz.png',
        mimeType: 'image/png',
        sizeBytes: 42,
      });
      mockGetEntities.mockRejectedValue(new Error('Neo4j unavailable'));

      const result = await executeGenerateVisualization(
        {
          prompt: 'Compare TRL scores',
          title: 'TRL Comparison',
          style: 'professional',
          aspectRatio: '16:9',
          entityIds: ['tech-1'],
          dataDescription: 'One technology',
        },
        'user-1'
      );

      expect(result.success).toBe(true);
      expect(mockCreateVisualization).toHaveBeenCalledWith(
        expect.objectContaining({
          dataSnapshot: {
            entities: [{ id: 'tech-1', name: '', type: 'unknown' }],
            description: 'One technology',
          },
          metadata: expect.objectContaining({ width: 0, height: 0, sizeBytes: 42 }),
        })
      );
      // Untyped ids must not trigger a cross-collection Firestore fan-out.
      expect(mockFirestoreGetAll).not.toHaveBeenCalled();
    });

    it('captures typed references through exact typed Firestore reads — no cross-collection fan-out', async () => {
      mockGenerateInfographic.mockResolvedValue({
        success: true,
        url: 'https://storage.example.com/viz.png',
        mimeType: 'image/png',
      });
      mockFirestoreGetAll.mockImplementation(async (...refs: Array<{ collection: string; id: string }>) =>
        refs.map((ref) => ({
          id: ref.id,
          exists: true,
          data: () =>
            ref.collection === 'technologies' ? { name: 'Firestore Tech' } : { title: 'Molecule replacement needed' },
        }))
      );

      await executeGenerateVisualization(
        {
          prompt: 'Compare entities',
          title: 'Entity Map',
          style: 'professional',
          aspectRatio: '16:9',
          entityRefs: [
            { id: 'tech-1', type: 'technology' },
            { id: 'painpoint-1', type: 'painPoint' },
          ],
          dataDescription: 'Two entities',
        },
        'user-1'
      );

      expect(mockCreateVisualization.mock.calls[0][0].dataSnapshot.entities).toEqual([
        { id: 'tech-1', name: 'Firestore Tech', type: 'technology' },
        { id: 'painpoint-1', name: 'Molecule replacement needed', type: 'painPoint' },
      ]);
      // Every reference is read exactly once, in its own typed collection only.
      const firestorePaths = mockFirestoreGetAll.mock.calls.flat().map((ref) => ref.path);
      expect(firestorePaths.sort()).toEqual(['painPoints/painpoint-1', 'technologies/tech-1']);
      // Typed Firestore capture resolved everything — the graph is not consulted.
      expect(mockGetEntities).not.toHaveBeenCalled();
    });

    it('falls back to the graph for a typed reference missing from Firestore', async () => {
      mockGenerateInfographic.mockResolvedValue({
        success: true,
        url: 'https://storage.example.com/viz.png',
        mimeType: 'image/png',
      });
      mockGetEntities.mockResolvedValue([
        { id: 'tech-gone', labels: ['Entity', 'Technology'], properties: { id: 'tech-gone', name: 'Graph Tech' } },
      ]);

      await executeGenerateVisualization(
        {
          prompt: 'Compare entities',
          title: 'Entity Map',
          style: 'professional',
          aspectRatio: '16:9',
          entityRefs: [{ id: 'tech-gone', type: 'technology' }],
          dataDescription: 'One entity',
        },
        'user-1'
      );

      expect(mockGetEntities).toHaveBeenCalledWith(['tech-gone']);
      expect(mockCreateVisualization.mock.calls[0][0].dataSnapshot.entities).toEqual([
        { id: 'tech-gone', name: 'Graph Tech', type: 'technology' },
      ]);
    });

    it('retains the claimed type with an empty name when Firestore and graph both miss (capture outage self-heal)', async () => {
      mockGenerateInfographic.mockResolvedValue({
        success: true,
        url: 'https://storage.example.com/viz.png',
        mimeType: 'image/png',
      });
      mockFirestoreGetAll.mockRejectedValue(new Error('UNAVAILABLE'));
      mockGetEntities.mockRejectedValue(new Error('Neo4j unavailable'));

      await executeGenerateVisualization(
        {
          prompt: 'Show pain point',
          title: 'Pain Point',
          style: 'professional',
          aspectRatio: '16:9',
          entityRefs: [{ id: 'painpoint-1', type: 'painPoint' }],
          dataDescription: 'One pain point',
        },
        'user-1'
      );

      expect(mockCreateVisualization.mock.calls[0][0].dataSnapshot.entities).toEqual([
        { id: 'painpoint-1', name: '', type: 'painPoint' },
      ]);
    });

    it('deduplicates references across entityRefs and entityIds by id', async () => {
      mockGenerateInfographic.mockResolvedValue({
        success: true,
        url: 'https://storage.example.com/viz.png',
        mimeType: 'image/png',
      });
      mockFirestoreGetAll.mockImplementation(async (...refs: Array<{ collection: string; id: string }>) =>
        refs.map((ref) => ({ id: ref.id, exists: true, data: () => ({ name: 'Firestore Tech' }) }))
      );

      await executeGenerateVisualization(
        {
          prompt: 'Compare entities',
          title: 'Entity Map',
          style: 'professional',
          aspectRatio: '16:9',
          entityRefs: [{ id: 'tech-1', type: 'technology' }],
          entityIds: ['tech-1', 'tech-1'],
          dataDescription: 'One entity, referenced three times',
        },
        'user-1'
      );

      expect(mockCreateVisualization.mock.calls[0][0].dataSnapshot.entities).toEqual([
        { id: 'tech-1', name: 'Firestore Tech', type: 'technology' },
      ]);
    });

    it('rejects an entity id containing "/" before generating an image', async () => {
      const result = await executeGenerateVisualization(
        {
          prompt: 'Show pain point',
          title: 'Pain Point',
          style: 'professional',
          aspectRatio: '16:9',
          entityIds: ['invalid/id', 'painpoint-1'],
          dataDescription: 'One pain point',
        },
        'user-1'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('/');
      expect(mockGenerateInfographic).not.toHaveBeenCalled();
      expect(mockCreateVisualization).not.toHaveBeenCalled();
    });

    it('rejects conflicting types claimed for the same entity id before generating an image', async () => {
      const result = await executeGenerateVisualization(
        {
          prompt: 'Compare entities',
          title: 'Entity Map',
          style: 'professional',
          aspectRatio: '16:9',
          entityRefs: [
            { id: 'thing-1', type: 'technology' },
            { id: 'thing-1', type: 'company' },
          ],
          dataDescription: 'Ambiguous reference',
        },
        'user-1'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('thing-1');
      expect(mockGenerateInfographic).not.toHaveBeenCalled();
    });

    it('rejects a non-canonical entity type before generating an image', async () => {
      const result = await executeGenerateVisualization(
        {
          prompt: 'Compare entities',
          title: 'Entity Map',
          style: 'professional',
          aspectRatio: '16:9',
          entityRefs: [{ id: 'thing-1', type: 'robot' }],
          dataDescription: 'Bad type',
        },
        'user-1'
      );

      expect(result.success).toBe(false);
      expect(mockGenerateInfographic).not.toHaveBeenCalled();
    });

    it('rejects an oversized entity id and a non-string entity id before generating an image', async () => {
      const oversized = await executeGenerateVisualization(
        {
          prompt: 'p',
          title: 't',
          style: 'professional',
          aspectRatio: '16:9',
          entityIds: ['i'.repeat(257)],
          dataDescription: 'd',
        },
        'user-1'
      );
      expect(oversized.success).toBe(false);

      const nonString = await executeGenerateVisualization(
        {
          prompt: 'p',
          title: 't',
          style: 'professional',
          aspectRatio: '16:9',
          entityIds: [42],
          dataDescription: 'd',
        },
        'user-1'
      );
      expect(nonString.success).toBe(false);
      expect(mockGenerateInfographic).not.toHaveBeenCalled();
    });

    it('rejects an oversized data description before generating an image', async () => {
      const result = await executeGenerateVisualization(
        {
          prompt: 'p',
          title: 't',
          style: 'professional',
          aspectRatio: '16:9',
          entityIds: [],
          dataDescription: 'd'.repeat(1001),
        },
        'user-1'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('1000');
      expect(mockGenerateInfographic).not.toHaveBeenCalled();
    });

    it('rejects an oversized title before generating an image', async () => {
      const result = await executeGenerateVisualization(
        {
          prompt: 'p',
          title: 't'.repeat(201),
          style: 'professional',
          aspectRatio: '16:9',
          entityIds: [],
          dataDescription: 'd',
        },
        'user-1'
      );

      expect(result.success).toBe(false);
      expect(mockGenerateInfographic).not.toHaveBeenCalled();
    });

    it('should require userId', async () => {
      const result = await executeGenerateVisualization({
        prompt: 'test',
        title: 'test',
        style: 'professional',
        aspectRatio: '1:1',
        entityIds: [],
        dataDescription: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('authenticated user');
    });

    it('rejects an oversized entity snapshot request before generating an image', async () => {
      const result = await executeGenerateVisualization(
        {
          prompt: 'test',
          title: 'test',
          style: 'professional',
          aspectRatio: '1:1',
          entityIds: Array.from({ length: 51 }, (_, index) => `tech-${index}`),
          dataDescription: 'test',
        },
        'user-1'
      );

      expect(result).toEqual({
        success: false,
        error: 'generateVisualization accepts at most 50 unique entity references',
      });
      expect(mockGenerateInfographic).not.toHaveBeenCalled();
      expect(mockCreateVisualization).not.toHaveBeenCalled();
    });

    it('accepts 51 raw ids that deduplicate to at most 50 unique references', async () => {
      mockGenerateInfographic.mockResolvedValue({
        success: true,
        url: 'https://storage.example.com/viz.png',
        mimeType: 'image/png',
      });
      mockGetEntities.mockResolvedValue([]);

      const result = await executeGenerateVisualization(
        {
          prompt: 'test',
          title: 'test',
          style: 'professional',
          aspectRatio: '1:1',
          entityIds: [...Array.from({ length: 50 }, (_, index) => `tech-${index}`), 'tech-0'],
          dataDescription: 'test',
        },
        'user-1'
      );

      expect(result.success).toBe(true);
      expect(mockCreateVisualization.mock.calls[0][0].dataSnapshot.entities).toHaveLength(50);
    });

    it('should use visualizations path prefix', async () => {
      mockGenerateInfographic.mockResolvedValue({
        success: true,
        url: 'https://example.com/viz.png',
        mimeType: 'image/png',
      });

      await executeGenerateVisualization(
        {
          prompt: 'test',
          title: 'test',
          style: 'minimal',
          aspectRatio: '1:1',
          entityIds: [],
          dataDescription: 'test',
        },
        'user-1'
      );

      expect(mockGenerateInfographic).toHaveBeenCalledWith(
        expect.objectContaining({
          pathPrefix: 'visualizations',
        })
      );
    });

    it('should forward referenceImage when provided (regenerate-in-style)', async () => {
      mockGenerateInfographic.mockResolvedValue({
        success: true,
        url: 'https://storage.example.com/viz.png',
        mimeType: 'image/png',
      });
      const ref = { data: 'AAAA', mimeType: 'image/png' };

      await executeGenerateVisualization(
        { prompt: 'bars', title: 't', style: 'professional', aspectRatio: '16:9', entityIds: [], dataDescription: 'd' },
        'u1',
        ref
      );

      expect(mockGenerateInfographic.mock.calls[0][0]).toMatchObject({ referenceImage: ref });
    });

    it('should omit referenceImage when none is provided', async () => {
      mockGenerateInfographic.mockResolvedValue({
        success: true,
        url: 'https://storage.example.com/viz.png',
        mimeType: 'image/png',
      });

      await executeGenerateVisualization(
        { prompt: 'bars', title: 't', style: 'professional', aspectRatio: '16:9', entityIds: [], dataDescription: 'd' },
        'u1'
      );

      expect(mockGenerateInfographic.mock.calls[0][0].referenceImage).toBeUndefined();
    });

    it('injects the learned-style fragment into generation when present', async () => {
      mockBuildLearnedStyleFragment.mockResolvedValueOnce(
        'Match the visual language of these previously liked designs: "Growth Curve" (professional)'
      );
      mockGenerateInfographic.mockResolvedValue({
        success: true,
        url: 'https://storage.example.com/viz.png',
        mimeType: 'image/png',
      });

      await executeGenerateVisualization(
        { prompt: 'bars', title: 't', style: 'professional', aspectRatio: '16:9', entityIds: [], dataDescription: 'd' },
        'u1'
      );

      expect(mockGenerateInfographic.mock.calls[0][0].brandStyle).toContain('Growth Curve');
    });

    it('persists appliedStyleFragment on the created visualization doc', async () => {
      mockBuildLearnedStyleFragment.mockResolvedValueOnce(
        'Match the visual language of these previously liked designs: "Growth Curve" (professional)'
      );
      mockGenerateInfographic.mockResolvedValue({
        success: true,
        url: 'https://storage.example.com/viz.png',
        mimeType: 'image/png',
      });

      await executeGenerateVisualization(
        { prompt: 'bars', title: 't', style: 'professional', aspectRatio: '16:9', entityIds: [], dataDescription: 'd' },
        'u1'
      );

      expect(mockCreateVisualization).toHaveBeenCalledWith(
        expect.objectContaining({
          appliedStyleFragment: expect.stringContaining('Growth Curve'),
        })
      );
    });

    it('does not set appliedStyleFragment on the doc when there is no fragment', async () => {
      mockBuildLearnedStyleFragment.mockResolvedValueOnce(undefined);
      mockGenerateInfographic.mockResolvedValue({
        success: true,
        url: 'https://storage.example.com/viz.png',
        mimeType: 'image/png',
      });

      await executeGenerateVisualization(
        { prompt: 'bars', title: 't', style: 'professional', aspectRatio: '16:9', entityIds: [], dataDescription: 'd' },
        'u1'
      );

      const call = mockCreateVisualization.mock.calls[0][0];
      expect('appliedStyleFragment' in call).toBe(false);
    });

    it('generates cleanly when fragment lookup fails', async () => {
      mockBuildLearnedStyleFragment.mockRejectedValueOnce(new Error('Firestore unavailable'));
      mockGenerateInfographic.mockResolvedValue({
        success: true,
        url: 'https://storage.example.com/viz.png',
        mimeType: 'image/png',
      });

      const result = await executeGenerateVisualization(
        { prompt: 'bars', title: 't', style: 'professional', aspectRatio: '16:9', entityIds: [], dataDescription: 'd' },
        'u1'
      );

      expect(result.success).toBe(true);
      expect(mockGenerateInfographic.mock.calls[0][0].brandStyle).toBeUndefined();
    });

    it('fails closed and cleans up the storage object when Firestore persistence fails', async () => {
      mockGenerateInfographic.mockResolvedValue({
        success: true,
        url: 'https://example.com/viz.png',
        mimeType: 'image/png',
      });
      mockCreateVisualization.mockRejectedValue(new Error('Firestore down'));

      const result = await executeGenerateVisualization(
        {
          prompt: 'test',
          title: 'test',
          style: 'professional',
          aspectRatio: '16:9',
          entityIds: [],
          dataDescription: 'test',
        },
        'user-1'
      );

      expect(result.success).toBe(false);
      expect(result.imageUrl).toBeUndefined();
      expect(result.visualizationId).toBeUndefined();
      expect(result.url).toBeUndefined();
      expect(result.error).toContain('save failed');
      const filename = mockGenerateInfographic.mock.calls[0][0].filename;
      expect(mockDeleteStoredImage).toHaveBeenCalledWith(`visualizations/user-1/${filename}`);
    });

    it('rejects an unsupported generated media type without persisting a record', async () => {
      mockGenerateInfographic.mockResolvedValue({
        success: true,
        url: 'https://example.com/viz.webp',
        mimeType: 'image/webp',
      });

      const result = await executeGenerateVisualization(
        {
          prompt: 'test',
          title: 'test',
          style: 'professional',
          aspectRatio: '16:9',
          entityIds: [],
          dataDescription: 'test',
        },
        'user-1'
      );

      expect(result).toEqual(
        expect.objectContaining({ success: false, error: expect.stringContaining('unsupported media type') })
      );
      expect(mockCreateVisualization).not.toHaveBeenCalled();
      expect(mockDeleteStoredImage).toHaveBeenCalledTimes(1);
    });
  });
});
