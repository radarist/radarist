export {};
/**
 * @jest-environment node
 *
 * P1a-T5 dispatch (also satisfies P1b-T1's failure-path test): compose → create a
 * build/evaluation mission → fire the run event. On createMission failure the run
 * event must NOT fire (no orphaned trigger).
 */
const mockComposeEvaluationBrief = jest.fn();
const mockCreateMission = jest.fn();
const mockSend = jest.fn();

jest.mock('@/lib/build-mission-eval-brief', () => ({
  composeEvaluationBrief: (...a: unknown[]) => mockComposeEvaluationBrief(...a),
}));
jest.mock('@/lib/missions', () => ({ createMission: (...a: unknown[]) => mockCreateMission(...a) }));
jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: (...a: unknown[]) => mockSend(...a), createFunction: jest.fn() },
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { dispatchEvaluation, dispatchBenchmarkEvaluation } = require('../discovery-dispatch');

describe('dispatchEvaluation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockComposeEvaluationBrief.mockResolvedValue({
      brief: 'B',
      title: 'T',
      motivation: {
        sourceTechnologyId: 't1',
        sourceEntityId: 't1',
        entityType: 'technology',
        useCaseIds: [],
        painPointIds: [],
        strategyIds: [],
      },
    });
    mockCreateMission.mockResolvedValue({ id: 'm1' });
  });

  it('composes, creates a build/evaluation mission, fires the run event, returns missionId', async () => {
    const res = await dispatchEvaluation('t1', 'technology', 'u1');
    expect(mockComposeEvaluationBrief).toHaveBeenCalledWith('t1', { entityType: 'technology' });
    expect(mockCreateMission).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        kind: 'build',
        artifactKind: 'evaluation',
        motivation: expect.objectContaining({ sourceEntityId: 't1', entityType: 'technology' }),
      })
    );
    expect(mockSend).toHaveBeenCalledWith({
      name: 'app/build-mission.run.requested',
      data: { missionId: 'm1', userId: 'u1' },
    });
    expect(res).toEqual({ missionId: 'm1' });
  });

  it('back-compat alias dispatchBenchmarkEvaluation defaults entityType to technology', async () => {
    await dispatchBenchmarkEvaluation('t1', 'system-discovery');
    expect(mockComposeEvaluationBrief).toHaveBeenCalledWith('t1', { entityType: 'technology' });
    expect(mockCreateMission).toHaveBeenCalledWith('system-discovery', expect.objectContaining({ kind: 'build' }));
  });

  it('does NOT fire the run event when createMission rejects (P1b-T1)', async () => {
    mockCreateMission.mockRejectedValue(new Error('createMission failed'));
    await expect(dispatchEvaluation('t1', 'technology', 'u1')).rejects.toThrow('createMission failed');
    expect(mockSend).not.toHaveBeenCalled();
  });
});
