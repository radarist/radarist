/**
 * @file refresh-relation-snapshots.test.ts
 * @description Tests for the nightly relation-snapshot refresh job.
 *
 * M10 (graph-foundation master plan, fix-cluster 3): the technology branch
 * used to parse EVERY technology snapshot id as the legacy 'radarId:entryId'
 * compound format. Post-decoupling, snapshots hold plain 'tech-…' Firestore
 * doc ids — so every technology relation was skipped nightly and forever
 * re-qualified as stale. Plain ids must resolve against the `technologies`
 * collection; the legacy parse applies only when a ':' is actually present.
 */

jest.mock('../../client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => ({
      config,
      trigger,
      handler,

      execute: (data: unknown) =>
        handler({
          event: { data },
          step: { run: async (_name: string, fn: () => unknown) => fn() },
        }),
    })),
    send: jest.fn(),
  },
}));

jest.mock('@/lib/relations-admin', () => ({
  adminGetStaleRelations: jest.fn(),
  adminUpdateRelation: jest.fn(),
}));
jest.mock('@/lib/companies-admin', () => ({ adminGetCompanies: jest.fn(async () => []) }));
jest.mock('@/lib/use-cases-admin', () => ({ adminGetUseCases: jest.fn(async () => []) }));
jest.mock('@/lib/prototypes-admin', () => ({ adminGetPrototypes: jest.fn(async () => []) }));
jest.mock('@/lib/strategies-admin', () => ({ adminGetStrategies: jest.fn(async () => []) }));
jest.mock('@/lib/signals-admin', () => ({ adminGetSignals: jest.fn(async () => []) }));

// In-memory Firestore fixture: `technologies` docs by id + radar entries by radarId.
const mockTechDocs: Record<string, Record<string, unknown>> = {};
const mockRadarEntries: Record<string, Array<Record<string, unknown>>> = {};
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn((name: string) => {
      if (name === 'technologies') {
        return {
          doc: jest.fn((id: string) => ({
            get: jest.fn(async () => ({
              exists: Boolean(mockTechDocs[id]),
              data: () => mockTechDocs[id],
            })),
          })),
        };
      }
      if (name === 'radars') {
        return {
          doc: jest.fn((radarId: string) => ({
            collection: jest.fn(() => ({
              get: jest.fn(async () => ({
                docs: (mockRadarEntries[radarId] ?? []).map((d) => ({ data: () => d })),
              })),
            })),
          })),
        };
      }
      throw new Error(`refresh-relation-snapshots test: unexpected collection ${name}`);
    }),
  },
}));

import * as relationsAdmin from '@/lib/relations-admin';
import { refreshRelationSnapshots } from '../refresh-relation-snapshots';

const mockedGetStale = relationsAdmin.adminGetStaleRelations as jest.Mock;
const mockedUpdate = relationsAdmin.adminUpdateRelation as jest.Mock;

function staleRelation(sourceId: string, targetId: string) {
  return {
    id: `rel-${sourceId}-${targetId}`,
    sourceSnapshot: { type: 'technology', id: sourceId, name: 'Stale Source', snapshotAt: 1 },
    targetSnapshot: { type: 'technology', id: targetId, name: 'Stale Target', snapshotAt: 1 },
    relationType: 'uses',
  };
}

describe('refreshRelationSnapshots — technology snapshot resolution (M10)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const k of Object.keys(mockTechDocs)) delete mockTechDocs[k];
    for (const k of Object.keys(mockRadarEntries)) delete mockRadarEntries[k];
  });

  it('refreshes relations whose technology snapshots hold plain tech-… doc ids', async () => {
    mockTechDocs['tech-1'] = { name: 'LangChain', description: 'LLM framework', tags: ['ai'] };
    mockTechDocs['tech-2'] = { name: 'Claude API', description: 'Anthropic API', tags: [] };
    mockedGetStale.mockResolvedValue([staleRelation('tech-1', 'tech-2')]);

    const r = await (refreshRelationSnapshots as any).execute({});

    expect(r.success).toBe(true);
    expect(r.refreshed).toBe(1);
    expect(r.skipped).toBe(0);

    expect(mockedUpdate).toHaveBeenCalledTimes(1);
    const [relationId, update] = mockedUpdate.mock.calls[0];
    expect(relationId).toBe('rel-tech-1-tech-2');
    expect(update.sourceSnapshot).toMatchObject({ type: 'technology', id: 'tech-1', name: 'LangChain' });
    expect(update.targetSnapshot).toMatchObject({ type: 'technology', id: 'tech-2', name: 'Claude API' });
  });

  it("still resolves legacy 'radarId:entryId' compound ids through the radar entries path", async () => {
    mockRadarEntries['radar-1'] = [{ id: 42, name: 'Legacy Entry', description: 'old-world', ring: 'Trial', tags: [] }];
    mockTechDocs['tech-2'] = { name: 'Claude API', description: '', tags: [] };
    mockedGetStale.mockResolvedValue([staleRelation('radar-1:42', 'tech-2')]);

    const r = await (refreshRelationSnapshots as any).execute({});

    expect(r.refreshed).toBe(1);
    const update = mockedUpdate.mock.calls[0][1];
    expect(update.sourceSnapshot).toMatchObject({ type: 'technology', id: 'radar-1:42', name: 'Legacy Entry' });
  });

  it('skips (without updating) when the technology doc no longer exists', async () => {
    mockTechDocs['tech-1'] = { name: 'LangChain', description: '', tags: [] };
    mockedGetStale.mockResolvedValue([staleRelation('tech-1', 'tech-gone')]);

    const r = await (refreshRelationSnapshots as any).execute({});

    expect(r.refreshed).toBe(0);
    expect(r.skipped).toBe(1);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });
});
