jest.mock('server-only', () => ({}));
const get = jest.fn();
const collection = jest.fn((_name: string) => ({ doc: jest.fn(() => ({ get })) }));
jest.mock('@/lib/firebase-admin', () => ({ db: { collection: (name: string) => collection(name) } }));

import { createOwnerScopedCitationReader } from '@/lib/graph/citation-provenance-admin';

describe('owner-scoped citation reader', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns absent only after Firestore reports not-found', async () => {
    get.mockResolvedValue({ exists: false });
    await expect(createOwnerScopedCitationReader('owner')({ collection: 'documents', id: 'missing' })).resolves.toEqual({
      state: 'absent',
    });
  });

  it('withholds cross-owner and non-allowlisted records without consulting Neo4j', async () => {
    get.mockResolvedValue({ exists: true, data: () => ({ ownerId: 'other' }) });
    await expect(createOwnerScopedCitationReader('owner')({ collection: 'documents', id: 'private' })).resolves.toEqual({
      state: 'unavailable',
      reason: 'record belongs to another owner',
    });
    await expect(createOwnerScopedCitationReader('owner')({ collection: 'users', id: 'owner' })).resolves.toEqual({
      state: 'unavailable',
      reason: 'citations may not name the "users" collection',
    });
  });
});
