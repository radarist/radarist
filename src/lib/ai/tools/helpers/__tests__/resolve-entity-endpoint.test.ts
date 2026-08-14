/**
 * @jest-environment node
 *
 * AI-039 — the unique-exact endpoint rule. A tool that mutates a NAMED entity
 * must act on exactly one record or refuse; "closest match wins" is how a link
 * lands on the wrong entity.
 */

jest.mock('@/lib/firebase', () => ({ db: {} }));

const mockSearchEntityCandidatesByName = jest.fn();
jest.mock('../../entity-creation', () => ({
  __esModule: true,
  searchEntityCandidatesByName: (...args: unknown[]) => mockSearchEntityCandidatesByName(...args),
  normalizeEntityReferenceName: (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(),
}));

import { describeEntityEndpointFailure, resolveEntityEndpointByExactName } from '../resolve-entity-endpoint';

beforeEach(() => jest.clearAllMocks());

describe('resolveEntityEndpointByExactName', () => {
  it('always asks for exact-first ordering', async () => {
    mockSearchEntityCandidatesByName.mockResolvedValue([{ id: 'org-1', name: 'Retail Operations' }]);
    await resolveEntityEndpointByExactName('orgUnit', 'Retail Operations');
    expect(mockSearchEntityCandidatesByName).toHaveBeenCalledWith('orgUnit', 'Retail Operations', {
      prioritizeNormalizedExact: true,
    });
  });

  it('resolves one unique exact match', async () => {
    mockSearchEntityCandidatesByName.mockResolvedValue([
      { id: 'org-1', name: 'Retail Operations' },
      { id: 'org-2', name: 'Retail Operations EMEA' },
    ]);

    const result = await resolveEntityEndpointByExactName('orgUnit', 'Retail Operations');
    expect(result).toEqual({ resolved: true, id: 'org-1', name: 'Retail Operations' });
  });

  it('matches case, spacing and unicode-normalization differences as exact', async () => {
    mockSearchEntityCandidatesByName.mockResolvedValue([{ id: 'org-1', name: 'Retail  Operations' }]);

    const result = await resolveEntityEndpointByExactName('orgUnit', '  retail operations ');
    expect(result).toEqual({ resolved: true, id: 'org-1', name: 'Retail  Operations' });
  });

  it('REFUSES when several records share the exact normalized name', async () => {
    mockSearchEntityCandidatesByName.mockResolvedValue([
      { id: 'org-1', name: 'Retail Operations' },
      { id: 'org-2', name: 'retail operations' },
    ]);

    const result = await resolveEntityEndpointByExactName('orgUnit', 'Retail Operations');
    expect(result.resolved).toBe(false);
    if (result.resolved) throw new Error('unreachable');
    expect(result.failure.kind).toBe('ambiguous-exact');
    expect(describeEntityEndpointFailure(result.failure)).toContain('org-2');
  });

  it('REFUSES a partial match rather than guessing the closest one', async () => {
    mockSearchEntityCandidatesByName.mockResolvedValue([{ id: 'org-2', name: 'Retail Operations EMEA' }]);

    const result = await resolveEntityEndpointByExactName('orgUnit', 'Retail Operations');
    expect(result.resolved).toBe(false);
    if (result.resolved) throw new Error('unreachable');
    expect(result.failure.kind).toBe('no-exact-match');
    expect(describeEntityEndpointFailure(result.failure)).toContain('Retail Operations EMEA');
  });

  it('reports not-found when nothing matched', async () => {
    mockSearchEntityCandidatesByName.mockResolvedValue([]);

    const result = await resolveEntityEndpointByExactName('orgUnit', 'Nowhere');
    expect(result.resolved).toBe(false);
    if (result.resolved) throw new Error('unreachable');
    expect(result.failure.kind).toBe('not-found');
    expect(describeEntityEndpointFailure(result.failure)).toBe('No orgUnit found with name "Nowhere".');
  });

  it('reports an unsupported entity type distinctly from not-found', async () => {
    mockSearchEntityCandidatesByName.mockResolvedValue(null);

    const result = await resolveEntityEndpointByExactName('document', 'Some Title');
    expect(result.resolved).toBe(false);
    if (result.resolved) throw new Error('unreachable');
    expect(result.failure.kind).toBe('unsupported-type');
    expect(describeEntityEndpointFailure(result.failure)).toContain('supply the entity id');
  });

  it('propagates a reader failure instead of reporting it as not-found', async () => {
    mockSearchEntityCandidatesByName.mockRejectedValue(new Error('Firestore unavailable'));
    await expect(resolveEntityEndpointByExactName('orgUnit', 'Retail Operations')).rejects.toThrow(
      'Firestore unavailable'
    );
  });
});
