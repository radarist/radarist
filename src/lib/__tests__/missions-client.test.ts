/**
 * @file missions-client.test.ts
 * @description Unit coverage for the client-SDK mission reads — focused on
 * `getRunningMissions`, the durable in-flight source for `/agents/runs`
 * (ARUN-001): it must union the user status query with the system-principal
 * leg (ARUN-005), exclude build missions, dedup, and sort newest-first.
 */
import { createFirestoreMocks, createMockQuerySnapshot } from './helpers/firestore-mock';
import type { Mission } from '@/lib/schemas/mission';

const firestoreMocks = createFirestoreMocks();
jest.mock('firebase/firestore', () => firestoreMocks);
jest.mock('@/lib/firebase', () => ({ db: {} }));

const { getRunningMissions, getBuildMissions } = require('../missions-client');

function m(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'm1',
    userId: 'u1',
    prompt: 'Find emerging AI infra startups',
    agent: 'scout',
    kind: 'research',
    status: 'running',
    progress: 0,
    entities: [],
    sources: [],
    slots: [],
    createdAt: '2026-05-09T09:00:00.000Z',
    ...overrides,
  } as Mission;
}

describe('getRunningMissions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns in-flight (running/pending) research missions, newest first, dropping completed ones', async () => {
    firestoreMocks.getDocs
      .mockResolvedValueOnce(
        createMockQuerySnapshot([
          m({ id: 'r1', status: 'running', createdAt: '2026-05-09T09:00:00.000Z' }),
          m({ id: 'done', status: 'completed', createdAt: '2026-05-09T11:00:00.000Z' }),
          m({ id: 'p1', status: 'pending', createdAt: '2026-05-09T10:00:00.000Z' }),
        ])
      )
      .mockResolvedValue(createMockQuerySnapshot([]));

    const result = await getRunningMissions('u1');

    expect(result.map((x: Mission) => x.id)).toEqual(['p1', 'r1']); // completed dropped, 10:00 before 09:00
  });

  it('filters kind AND status IN THE QUERY on every per-principal leg (ARUN-001 guarantee preserved under ARUN-005)', async () => {
    firestoreMocks.getDocs
      .mockResolvedValueOnce(createMockQuerySnapshot([m({ id: 'r1', status: 'running' })]))
      .mockResolvedValue(createMockQuerySnapshot([]));

    await getRunningMissions('u1');

    // Both exclusions must be query filters (pre-limit), not post-fetch client
    // filters — otherwise >100 gated build docs OR completed research history
    // could consume the limit and hide a genuinely-running mission. One query
    // per principal (user + 3 system) keeps the in-query status filter on
    // every leg — the single `in` budget per query is spent on `status`.
    expect(firestoreMocks.getDocs).toHaveBeenCalledTimes(4);
    for (const principal of ['u1', 'system', 'system-sweep', 'system-discovery']) {
      expect(firestoreMocks.where).toHaveBeenCalledWith('userId', '==', principal);
    }
    expect(firestoreMocks.where).toHaveBeenCalledWith('kind', '==', 'research');
    expect(firestoreMocks.where).toHaveBeenCalledWith('status', 'in', ['running', 'pending']);
    // never a leg for any OTHER human user
    expect(firestoreMocks.where).not.toHaveBeenCalledWith('userId', '==', 'someone-else');
  });

  it('unions in in-flight system-principal missions, deduped, and drops completed system history (ARUN-005)', async () => {
    firestoreMocks.getDocs
      .mockResolvedValueOnce(
        createMockQuerySnapshot([m({ id: 'mine', status: 'running', createdAt: '2026-05-09T09:00:00.000Z' })])
      )
      .mockResolvedValueOnce(createMockQuerySnapshot([])) // 'system' leg
      .mockResolvedValueOnce(
        createMockQuerySnapshot([
          m({ id: 'sweep-run', userId: 'system-sweep', status: 'running', createdAt: '2026-05-09T10:00:00.000Z' }),
          m({ id: 'sweep-old', userId: 'system-sweep', status: 'completed', createdAt: '2026-05-09T08:00:00.000Z' }),
          // duplicate id across legs must not double-render
          m({ id: 'mine', status: 'running', createdAt: '2026-05-09T09:00:00.000Z' }),
        ])
      )
      .mockResolvedValueOnce(createMockQuerySnapshot([])); // 'system-discovery' leg

    const result = await getRunningMissions('u1');

    expect(result.map((x: Mission) => x.id)).toEqual(['sweep-run', 'mine']);
  });

  it('re-throws when the underlying read fails (no silent empty list)', async () => {
    firestoreMocks.getDocs.mockRejectedValueOnce(new Error('firestore boom'));

    await expect(getRunningMissions('u1')).rejects.toThrow('firestore boom');
  });
});

describe('getBuildMissions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries the server-authorized principal union — uid + system principals, nothing else (ARUN-005)', async () => {
    firestoreMocks.getDocs.mockResolvedValueOnce(
      createMockQuerySnapshot([
        m({ id: 'b1', kind: 'build', createdAt: '2026-05-09T09:00:00.000Z' }),
        m({ id: 'b2', kind: 'build', userId: 'system-discovery', createdAt: '2026-05-09T10:00:00.000Z' }),
      ])
    );

    const result = await getBuildMissions('u1');

    expect(firestoreMocks.where).toHaveBeenCalledWith('userId', 'in', [
      'u1',
      'system',
      'system-sweep',
      'system-discovery',
    ]);
    expect(firestoreMocks.where).toHaveBeenCalledWith('kind', '==', 'build');
    expect(result.map((x: Mission) => x.id)).toEqual(['b2', 'b1']); // newest first, system build included
  });
});
