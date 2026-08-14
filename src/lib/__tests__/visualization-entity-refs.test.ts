/**
 * @jest-environment node
 */

/**
 * Read-time resolution of visualization entity references (AI-025).
 *
 * Contract under test:
 *  - live typed Firestore name wins (renames render live),
 *  - deleted entities and Firestore outages retain the stored snapshot name,
 *  - references that never resolved anywhere surface as neutral 'unresolved',
 *  - lookups are bounded exact typed doc reads — no cross-collection fan-out,
 *  - 'unknown'-typed references are never fetched,
 *  - malformed legacy snapshots are normalized in memory first.
 */

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

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { resolveVisualizationEntityReferences } from '../visualization-entity-refs';

type FakeRef = { collection: string; id: string; path: string };

/** getAll answers from a `${collection}/${id}` → doc-data map; everything else "does not exist". */
function primeFirestore(docs: Record<string, Record<string, unknown>>) {
  mockFirestoreGetAll.mockImplementation(async (...refs: FakeRef[]) =>
    refs.map((ref) => ({
      id: ref.id,
      exists: ref.path in docs,
      data: () => docs[ref.path],
    }))
  );
}

describe('resolveVisualizationEntityReferences', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    primeFirestore({});
  });

  it('prefers the live typed Firestore name so renames render live', async () => {
    primeFirestore({ 'technologies/tech-1': { name: 'React 19' } });

    const resolved = await resolveVisualizationEntityReferences({
      entities: [{ id: 'tech-1', name: 'React', type: 'technology' }],
      description: 'stack',
    });

    expect(resolved).toEqual([{ id: 'tech-1', type: 'technology', name: 'React 19', resolution: 'live' }]);
  });

  it('retains the stored snapshot name when the entity was deleted', async () => {
    primeFirestore({});

    const resolved = await resolveVisualizationEntityReferences({
      entities: [{ id: 'company-gone', name: 'Acme Corp', type: 'company' }],
      description: '',
    });

    expect(resolved).toEqual([{ id: 'company-gone', type: 'company', name: 'Acme Corp', resolution: 'snapshot' }]);
  });

  it('retains stored names on a Firestore outage instead of throwing', async () => {
    mockFirestoreGetAll.mockRejectedValue(new Error('UNAVAILABLE'));

    const resolved = await resolveVisualizationEntityReferences({
      entities: [
        { id: 'tech-1', name: 'React', type: 'technology' },
        { id: 'sig-1', name: 'LLM budget signal', type: 'signal' },
      ],
      description: '',
    });

    expect(resolved.map((r) => r.resolution)).toEqual(['snapshot', 'snapshot']);
    expect(resolved.map((r) => r.name)).toEqual(['React', 'LLM budget signal']);
  });

  it('returns a neutral unresolved reference when neither live nor stored name exists', async () => {
    primeFirestore({});

    const resolved = await resolveVisualizationEntityReferences({
      entities: [{ id: 'mystery-1', name: '', type: 'technology' }],
      description: '',
    });

    expect(resolved).toEqual([{ id: 'mystery-1', type: 'technology', name: null, resolution: 'unresolved' }]);
  });

  it('never fetches unknown-typed references', async () => {
    primeFirestore({});

    const resolved = await resolveVisualizationEntityReferences({
      entities: [
        { id: 'legacy-1', name: 'Stored Label', type: 'unknown' },
        { id: 'legacy-2', name: '', type: 'unknown' },
      ],
      description: '',
    });

    expect(mockFirestoreGetAll).not.toHaveBeenCalled();
    expect(resolved).toEqual([
      { id: 'legacy-1', type: 'unknown', name: 'Stored Label', resolution: 'snapshot' },
      { id: 'legacy-2', type: 'unknown', name: null, resolution: 'unresolved' },
    ]);
  });

  it('issues bounded exact typed reads only — no cross-collection fan-out', async () => {
    primeFirestore({ 'technologies/tech-1': { name: 'React' }, 'signals/sig-1': { title: 'Signal title' } });

    await resolveVisualizationEntityReferences({
      entities: [
        { id: 'tech-1', name: '', type: 'technology' },
        { id: 'sig-1', name: '', type: 'signal' },
      ],
      description: '',
    });

    expect(mockFirestoreGetAll).toHaveBeenCalledTimes(1);
    const paths = mockFirestoreGetAll.mock.calls.flat().map((ref: FakeRef) => ref.path);
    expect(paths.sort()).toEqual(['signals/sig-1', 'technologies/tech-1']);
  });

  it('reads title-named entity types through their title field', async () => {
    primeFirestore({ 'use-cases/uc-1': { title: 'Forecast demand' } });

    const resolved = await resolveVisualizationEntityReferences({
      entities: [{ id: 'uc-1', name: 'Old use case', type: 'useCase' }],
      description: '',
    });

    expect(resolved[0]).toEqual({ id: 'uc-1', type: 'useCase', name: 'Forecast demand', resolution: 'live' });
  });

  it('treats a live doc with a blank name as deleted and falls back to the snapshot', async () => {
    primeFirestore({ 'technologies/tech-1': { name: '   ' } });

    const resolved = await resolveVisualizationEntityReferences({
      entities: [{ id: 'tech-1', name: 'React', type: 'technology' }],
      description: '',
    });

    expect(resolved[0]).toEqual({ id: 'tech-1', type: 'technology', name: 'React', resolution: 'snapshot' });
  });

  it('clips an oversized live name to the contract bound', async () => {
    primeFirestore({ 'technologies/tech-1': { name: 'x'.repeat(500) } });

    const resolved = await resolveVisualizationEntityReferences({
      entities: [{ id: 'tech-1', name: 'React', type: 'technology' }],
      description: '',
    });

    expect(resolved[0].resolution).toBe('live');
    expect(resolved[0].name).toHaveLength(200);
  });

  it('normalizes malformed legacy snapshots in memory before resolving', async () => {
    primeFirestore({ 'technologies/tech-1': { name: 'React' } });

    const resolved = await resolveVisualizationEntityReferences({
      entities: [
        { id: 'tech-1', name: 'Old', type: 'technology' },
        { id: 'tech-1', name: 'Duplicate', type: 'technology' },
        { id: 'legacy-viz', name: 'Legacy Entity', type: '' },
        { id: '', name: 'dropped', type: 'technology' },
        'garbage',
      ],
      description: 'x',
    });

    expect(resolved).toEqual([
      { id: 'tech-1', type: 'technology', name: 'React', resolution: 'live' },
      { id: 'legacy-viz', type: 'unknown', name: 'Legacy Entity', resolution: 'snapshot' },
    ]);
  });

  it('resolves an entirely absent snapshot to an empty reference list without reads', async () => {
    const resolved = await resolveVisualizationEntityReferences(undefined);

    expect(resolved).toEqual([]);
    expect(mockFirestoreGetAll).not.toHaveBeenCalled();
  });
});
