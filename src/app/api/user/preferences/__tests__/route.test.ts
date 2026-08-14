/**
 * @jest-environment node
 *
 * AI-005 — /api/user/preferences: GET (harvested doc + best-effort topic
 * weights), PATCH (pin set/clear, Zod-validated), DELETE (reset). All three
 * operate on the AUTHENTICATED uid only — a client-supplied uid is never
 * honored (PATCH rejects it via strict schema; GET/DELETE never read one).
 */

import { NextRequest } from 'next/server';

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const mockGetAuthenticatedUser = jest.fn();
jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: (...args: unknown[]) => mockGetAuthenticatedUser(...args),
}));

const mockGetMissionUserPreferences = jest.fn();
const mockSetPinnedPreferences = jest.fn();
const mockResetUserPreferences = jest.fn();
jest.mock('@/lib/user-preferences', () => ({
  __esModule: true,
  getMissionUserPreferences: (...args: unknown[]) => mockGetMissionUserPreferences(...args),
  setPinnedPreferences: (...args: unknown[]) => mockSetPinnedPreferences(...args),
  resetUserPreferences: (...args: unknown[]) => mockResetUserPreferences(...args),
}));

const mockGraphGetUserPreferences = jest.fn();
jest.mock('@/lib/graph/preferences', () => ({
  __esModule: true,
  getUserPreferences: (...args: unknown[]) => mockGraphGetUserPreferences(...args),
}));

import { GET, PATCH, DELETE } from '../route';

const PREFS = {
  userId: 'auth-user-1',
  updatedAt: '2026-07-01T00:00:00.000Z',
  missionsAnalyzed: 12,
  preferredStructure: 'SBAR',
  structureConfidence: 0.7,
  requestsConfidenceScores: false,
  preferredAgents: [{ agent: 'creator', count: 8 }],
  topTopics: ['Agentic Memory'],
  avgPromptLength: 300,
};

function makeRequest(method: string, body?: unknown, url = 'http://localhost:3000/api/user/preferences') {
  return new NextRequest(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'auth-user-1', email: 'a@b.c' });
  mockGetMissionUserPreferences.mockResolvedValue(PREFS);
  mockGraphGetUserPreferences.mockResolvedValue([
    { topic: 'ai agents', actedCount: 3, dismissedCount: 1, lastUpdated: 1 },
  ]);
  mockSetPinnedPreferences.mockResolvedValue({ ...PREFS, pinned: { preferredStructure: 'IMRAD' } });
  mockResetUserPreferences.mockResolvedValue(undefined);
});

describe('GET /api/user/preferences', () => {
  it('401s when unauthenticated', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: false, error: 'no token' });
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(401);
    expect(mockGetMissionUserPreferences).not.toHaveBeenCalled();
  });

  it('returns the authenticated user’s doc plus topic weights', async () => {
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.preferences).toEqual(PREFS);
    expect(json.topicWeights).toEqual([{ topic: 'ai agents', actedCount: 3, dismissedCount: 1 }]);
    expect(mockGetMissionUserPreferences).toHaveBeenCalledWith('auth-user-1');
    expect(mockGraphGetUserPreferences).toHaveBeenCalledWith('auth-user-1');
  });

  it('ignores a client-supplied uid query param — always reads the token uid', async () => {
    const res = await GET(makeRequest('GET', undefined, 'http://localhost:3000/api/user/preferences?uid=victim-2'));
    expect(res.status).toBe(200);
    expect(mockGetMissionUserPreferences).toHaveBeenCalledWith('auth-user-1');
    expect(mockGetMissionUserPreferences).not.toHaveBeenCalledWith('victim-2');
  });

  it('degrades gracefully to topicWeights:null when Neo4j is unavailable', async () => {
    mockGraphGetUserPreferences.mockRejectedValue(new Error('bolt down'));
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.preferences).toEqual(PREFS);
    expect(json.topicWeights).toBeNull();
  });

  it('returns preferences:null before the first harvest', async () => {
    mockGetMissionUserPreferences.mockResolvedValue(null);
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
    expect((await res.json()).preferences).toBeNull();
  });

  it('500s when the Firestore read fails', async () => {
    mockGetMissionUserPreferences.mockRejectedValue(new Error('boom'));
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(500);
  });

  // Adversarial #1: SCHEMA corruption degrades to 200 {invalid:true} so the
  // UI can offer Reset as the recovery path; transport errors stay 500 above.
  it('degrades to invalid:true (200) when the stored doc fails schema validation', async () => {
    const zodErr = new Error('bad shape');
    zodErr.name = 'ZodError';
    mockGetMissionUserPreferences.mockRejectedValue(zodErr);
    const res = await GET(makeRequest('GET'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.preferences).toBeNull();
    expect(json.invalid).toBe(true);
  });
});

describe('PATCH /api/user/preferences', () => {
  it('401s when unauthenticated', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: false, error: 'no token' });
    const res = await PATCH(makeRequest('PATCH', { pinned: { preferredStructure: 'IMRAD' } }));
    expect(res.status).toBe(401);
    expect(mockSetPinnedPreferences).not.toHaveBeenCalled();
  });

  it('sets a pin for the token uid and returns the updated doc', async () => {
    const res = await PATCH(makeRequest('PATCH', { pinned: { preferredStructure: 'IMRAD' } }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.preferences.pinned).toEqual({ preferredStructure: 'IMRAD' });
    expect(mockSetPinnedPreferences).toHaveBeenCalledWith('auth-user-1', { preferredStructure: 'IMRAD' });
  });

  it('clears a pin via null', async () => {
    const res = await PATCH(makeRequest('PATCH', { pinned: { requestsConfidenceScores: null } }));
    expect(res.status).toBe(200);
    expect(mockSetPinnedPreferences).toHaveBeenCalledWith('auth-user-1', { requestsConfidenceScores: null });
  });

  it('rejects a client-supplied userId (strict schema — never honored)', async () => {
    const res = await PATCH(makeRequest('PATCH', { userId: 'victim-2', pinned: { preferredStructure: 'IMRAD' } }));
    expect(res.status).toBe(400);
    expect(mockSetPinnedPreferences).not.toHaveBeenCalled();
  });

  it('rejects an unknown pinned field and an invalid enum value', async () => {
    const unknownField = await PATCH(makeRequest('PATCH', { pinned: { topTopics: ['x'] } }));
    expect(unknownField.status).toBe(400);
    const badEnum = await PATCH(makeRequest('PATCH', { pinned: { preferredStructure: 'HAIKU' } }));
    expect(badEnum.status).toBe(400);
    expect(mockSetPinnedPreferences).not.toHaveBeenCalled();
  });

  it('400s on a non-JSON body', async () => {
    const req = new NextRequest('http://localhost:3000/api/user/preferences', { method: 'PATCH', body: 'not json' });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });

  it('500s when the write fails', async () => {
    mockSetPinnedPreferences.mockRejectedValue(new Error('boom'));
    const res = await PATCH(makeRequest('PATCH', { pinned: { preferredStructure: 'IMRAD' } }));
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/user/preferences', () => {
  it('401s when unauthenticated', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: false, error: 'no token' });
    const res = await DELETE(makeRequest('DELETE'));
    expect(res.status).toBe(401);
    expect(mockResetUserPreferences).not.toHaveBeenCalled();
  });

  it('resets the token uid’s doc (client-supplied uid never read)', async () => {
    const res = await DELETE(
      makeRequest('DELETE', undefined, 'http://localhost:3000/api/user/preferences?uid=victim-2')
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockResetUserPreferences).toHaveBeenCalledWith('auth-user-1');
  });

  it('500s when the delete fails', async () => {
    mockResetUserPreferences.mockRejectedValue(new Error('boom'));
    const res = await DELETE(makeRequest('DELETE'));
    expect(res.status).toBe(500);
  });
});
