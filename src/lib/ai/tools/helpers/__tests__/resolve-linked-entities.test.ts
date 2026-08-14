/**
 * @jest-environment node
 *
 * AI-040 — these tests used to mock the Firebase CLIENT service barrels
 * (`@/lib/companies`, `@/lib/technology-service`), which is exactly what the
 * helper wrongly imported. The suite was green while production silently
 * persisted `linkedEntities: []`. Importing either client barrel is now a hard
 * failure here, so the boundary regression cannot come back green.
 */

jest.mock('@/lib/firebase', () => {
  throw new Error('resolve-linked-entities must not import the Firebase client runtime');
});
jest.mock('firebase/firestore', () => {
  throw new Error('resolve-linked-entities must not import firebase/firestore');
});
jest.mock('@/lib/companies', () => {
  throw new Error('resolve-linked-entities must read companies through the Admin twin');
});
jest.mock('@/lib/technology-service', () => {
  throw new Error('resolve-linked-entities must read technologies through the Admin twin');
});

const mockAdminGetCompanies = jest.fn();
jest.mock('@/lib/companies-admin', () => ({
  __esModule: true,
  adminGetCompanies: (...args: unknown[]) => mockAdminGetCompanies(...args),
}));

const mockAdminGetTechnologies = jest.fn();
jest.mock('@/lib/technology-admin', () => ({
  __esModule: true,
  adminGetTechnologies: (...args: unknown[]) => mockAdminGetTechnologies(...args),
}));

import { LINKED_ENTITY_NAME_CAP, LinkedEntityLookupError, resolveLinkedEntityNames } from '../resolve-linked-entities';

describe('resolveLinkedEntityNames', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminGetCompanies.mockResolvedValue([
      { id: 'co-nvidia', name: 'NVIDIA' },
      { id: 'co-honor', name: 'Honor' },
    ]);
    mockAdminGetTechnologies.mockResolvedValue([
      { id: 'tech-isaac-groot', name: 'NVIDIA Isaac GR00T' },
      { id: 'tech-newton', name: 'Newton Physics Engine' },
    ]);
  });

  it('reads both libraries through the Admin SDK twins', async () => {
    await resolveLinkedEntityNames(['NVIDIA']);
    expect(mockAdminGetCompanies).toHaveBeenCalledTimes(1);
    expect(mockAdminGetTechnologies).toHaveBeenCalledTimes(1);
  });

  it('resolves an exact-match company name with its full identity', async () => {
    const result = await resolveLinkedEntityNames(['NVIDIA']);
    expect(result.companies).toEqual(['co-nvidia']);
    expect(result.technologies).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.resolved).toEqual([
      { requestedName: 'NVIDIA', matchedName: 'NVIDIA', id: 'co-nvidia', kind: 'company' },
    ]);
  });

  it('resolves a fuzzy-match technology name (>= 0.85)', async () => {
    const result = await resolveLinkedEntityNames(['Isaac GR00T']);
    expect(result.technologies).toEqual(['tech-isaac-groot']);
    expect(result.resolved[0]).toEqual({
      requestedName: 'Isaac GR00T',
      matchedName: 'NVIDIA Isaac GR00T',
      id: 'tech-isaac-groot',
      kind: 'technology',
    });
  });

  it('REPORTS unresolvable names instead of dropping them silently', async () => {
    const result = await resolveLinkedEntityNames(['Unknown Entity Name']);
    expect(result.companies).toEqual([]);
    expect(result.technologies).toEqual([]);
    expect(result.resolved).toEqual([]);
    expect(result.unresolved).toEqual(['Unknown Entity Name']);
  });

  it('reports a partial resolution as both resolved and unresolved', async () => {
    const result = await resolveLinkedEntityNames(['NVIDIA', 'Nowhere Systems']);
    expect(result.companies).toEqual(['co-nvidia']);
    expect(result.resolved).toHaveLength(1);
    expect(result.unresolved).toEqual(['Nowhere Systems']);
  });

  it('resolves multiple names across both types', async () => {
    const result = await resolveLinkedEntityNames(['NVIDIA', 'Newton Physics Engine']);
    expect(result.companies).toEqual(['co-nvidia']);
    expect(result.technologies).toEqual(['tech-newton']);
    expect(result.unresolved).toEqual([]);
  });

  it('de-duplicates repeated names into one bucket entry', async () => {
    const result = await resolveLinkedEntityNames(['NVIDIA', 'NVIDIA']);
    expect(result.companies).toEqual(['co-nvidia']);
    expect(result.resolved).toHaveLength(2);
  });

  it('THROWS over the name cap rather than silently truncating', async () => {
    const names = Array.from({ length: LINKED_ENTITY_NAME_CAP + 1 }, (_, index) => `Name${index}`);
    await expect(resolveLinkedEntityNames(names)).rejects.toThrow(RangeError);
    expect(mockAdminGetCompanies).not.toHaveBeenCalled();
  });

  it('resolves exactly at the cap', async () => {
    const names = Array.from({ length: LINKED_ENTITY_NAME_CAP }, (_, index) => `Name${index}`);
    const result = await resolveLinkedEntityNames(names);
    expect(result.unresolved).toHaveLength(LINKED_ENTITY_NAME_CAP);
  });

  it('returns empty buckets for empty input without reading anything', async () => {
    const result = await resolveLinkedEntityNames([]);
    expect(result).toEqual({ companies: [], technologies: [], resolved: [], unresolved: [] });
    expect(mockAdminGetCompanies).not.toHaveBeenCalled();
  });

  it('THROWS a typed lookup error when the company library cannot be read', async () => {
    mockAdminGetCompanies.mockRejectedValueOnce(new Error('Firestore down'));
    // The old contract returned an empty pool here, which made every name look
    // unresolvable — an inconclusive read reported as a definite answer.
    await expect(resolveLinkedEntityNames(['NVIDIA', 'Isaac GR00T'])).rejects.toBeInstanceOf(LinkedEntityLookupError);
  });

  it('THROWS a typed lookup error when the technology library cannot be read', async () => {
    mockAdminGetTechnologies.mockRejectedValueOnce(new Error('Firestore down'));
    await expect(resolveLinkedEntityNames(['NVIDIA'])).rejects.toBeInstanceOf(LinkedEntityLookupError);
  });
});
