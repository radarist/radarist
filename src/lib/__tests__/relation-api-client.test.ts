import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { CORRELATION_ID_HEADER, isCorrelationId } from '@/lib/observability/correlation';
import {
  createRelationViaApi,
  deleteRelationViaApi,
  deleteRelationsForEntityViaApi,
  updateRelationViaApi,
} from '@/lib/relation-api-client';

jest.mock('@/lib/fetch-with-auth', () => ({ fetchWithAuth: jest.fn() }));

const mockedFetchWithAuth = fetchWithAuth as jest.MockedFunction<typeof fetchWithAuth>;
const relation = {
  id: 'rel-1',
  relationType: 'uses',
  sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'React', snapshotAt: 1 },
  targetSnapshot: { id: 'company-1', type: 'company', name: 'Meta', snapshotAt: 1 },
  createdAt: 1,
  updatedAt: 1,
} as never;

function successfulResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue({ success: true, data }),
  } as unknown as Response;
}

describe('relation API correlation headers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('generates one valid opaque ID per create/update/delete request', async () => {
    mockedFetchWithAuth
      .mockResolvedValueOnce(successfulResponse(relation))
      .mockResolvedValueOnce(successfulResponse(relation))
      .mockResolvedValueOnce(successfulResponse({ deleted: true }));

    await createRelationViaApi(relation);
    await updateRelationViaApi('rel-1', { confidence: 90 });
    await deleteRelationViaApi('rel-1');

    const correlationIds = mockedFetchWithAuth.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get(CORRELATION_ID_HEADER)
    );
    expect(correlationIds.every(isCorrelationId)).toBe(true);
    expect(new Set(correlationIds).size).toBe(3);
  });

  it('adds correlation to the entity cascade request without changing its result', async () => {
    mockedFetchWithAuth.mockResolvedValueOnce(successfulResponse({ deleted: 4 }));

    await expect(deleteRelationsForEntityViaApi('company/with spaces')).resolves.toBe(4);

    const [url, init] = mockedFetchWithAuth.mock.calls[0];
    expect(url).toBe('/api/relations?entityId=company%2Fwith%20spaces');
    expect(isCorrelationId(new Headers(init?.headers).get(CORRELATION_ID_HEADER))).toBe(true);
  });
});
