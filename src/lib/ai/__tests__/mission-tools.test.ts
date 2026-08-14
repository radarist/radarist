/**
 * @file ai/__tests__/mission-tools.test.ts
 * @jest-environment node
 */

jest.mock('@/lib/missions', () => ({
  createMission: jest.fn(),
  getMissionById: jest.fn(),
  listMissions: jest.fn(),
}));

jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: jest.fn() },
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { MISSION_TOOLS, executeGetMissionStatus, executeListUserMissions } from '../tools/mission-tools';

describe('mission-tools', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('MISSION_TOOLS declarations', () => {
    it('should declare getMissionStatus tool', () => {
      const tool = MISSION_TOOLS.find((t) => t.name === 'getMissionStatus');
      expect(tool).toBeDefined();
      expect(tool!.parameters!.required).toContain('missionId');
    });

    it('should declare listUserMissions tool', () => {
      const tool = MISSION_TOOLS.find((t) => t.name === 'listUserMissions');
      expect(tool).toBeDefined();
    });
  });

  describe('executeGetMissionStatus', () => {
    it('should return mission data when found', async () => {
      const { getMissionById } = jest.requireMock('@/lib/missions');
      getMissionById.mockResolvedValue({
        id: 'mission-123',
        status: 'completed',
        progress: 100,
        prompt: 'Research AI',
        agent: 'scout',
        result: 'Found 5 companies',
        progressMessage: 'Done',
        entities: [{ id: 'e1', name: 'Acme', type: 'company', confidence: 0.9, agentName: 'scout' }],
        sources: [{ url: 'https://example.com', title: 'Example' }],
        createdAt: '2026-02-26T00:00:00Z',
        completedAt: '2026-02-26T01:00:00Z',
      });

      const result = await executeGetMissionStatus({ missionId: 'mission-123' });
      expect(result.found).toBe(true);
      expect(result.mission!.status).toBe('completed');
      expect(result.mission!.progress).toBe(100);
      expect(result.mission!.result).toBe('Found 5 companies');
      expect(result.mission!.entities).toHaveLength(1);
      expect(result.mission!.sources).toHaveLength(1);
      expect(result.mission!.completedAt).toBe('2026-02-26T01:00:00Z');
      expect(getMissionById).toHaveBeenCalledWith('mission-123');
    });

    it('should return found=false when mission not found', async () => {
      const { getMissionById } = jest.requireMock('@/lib/missions');
      getMissionById.mockResolvedValue(null);

      const result = await executeGetMissionStatus({ missionId: 'nonexistent' });
      expect(result.found).toBe(false);
      expect(result.mission).toBeUndefined();
    });
  });

  describe('executeListUserMissions', () => {
    it('should return missions for authenticated user', async () => {
      const { listMissions } = jest.requireMock('@/lib/missions');
      listMissions.mockResolvedValue([
        { id: 'mission-1', status: 'completed', prompt: 'Research AI', agent: 'scout', progress: 100, createdAt: '2026-02-26T00:00:00Z' },
        { id: 'mission-2', status: 'running', prompt: 'Analyze trends', agent: 'evaluator', progress: 50, createdAt: '2026-02-26T01:00:00Z' },
      ]);

      const result = await executeListUserMissions({}, 'user-123');
      expect(result.missions).toHaveLength(2);
      expect(result.missions[0].id).toBe('mission-1');
      expect(result.missions[1].status).toBe('running');
      expect(listMissions).toHaveBeenCalledWith('user-123');
    });

    it('should respect limit parameter', async () => {
      const { listMissions } = jest.requireMock('@/lib/missions');
      const manyMissions = Array.from({ length: 20 }, (_, i) => ({
        id: `mission-${i}`,
        status: 'completed',
        prompt: `Task ${i}`,
        agent: 'scout',
        progress: 100,
        createdAt: '2026-02-26T00:00:00Z',
      }));
      listMissions.mockResolvedValue(manyMissions);

      const result = await executeListUserMissions({ limit: 5 }, 'user-123');
      expect(result.missions).toHaveLength(5);
    });

    it('should cap limit at 50', async () => {
      const { listMissions } = jest.requireMock('@/lib/missions');
      const manyMissions = Array.from({ length: 60 }, (_, i) => ({
        id: `mission-${i}`,
        status: 'completed',
        prompt: `Task ${i}`,
        agent: 'scout',
        progress: 100,
        createdAt: '2026-02-26T00:00:00Z',
      }));
      listMissions.mockResolvedValue(manyMissions);

      const result = await executeListUserMissions({ limit: 100 }, 'user-123');
      expect(result.missions).toHaveLength(50);
    });

    it('should throw when userId is missing', async () => {
      await expect(executeListUserMissions({}, '')).rejects.toThrow('requires an authenticated user');
    });
  });
});
