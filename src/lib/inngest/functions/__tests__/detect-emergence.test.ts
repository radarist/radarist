/**
 * Tests for the C5 detect-emergence Inngest handler.
 */

jest.mock('@/lib/graph/emergence', () => ({
  detectEmergence: jest.fn(),
}));

jest.mock('@/lib/graph/proactive-insights', () => ({
  recordAgentObservation: jest.fn(),
}));

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

import * as emergence from '@/lib/graph/emergence';
import * as proactiveInsights from '@/lib/graph/proactive-insights';
import { inngest } from '../../client';
import { detectEmergenceJob } from '../detect-emergence';

const mockedDetect = emergence.detectEmergence as jest.Mock;
const mockedRecord = proactiveInsights.recordAgentObservation as jest.Mock;
const mockedSend = inngest.send as jest.Mock;

const finding = (overrides: Partial<emergence.EmergenceFinding> = {}): emergence.EmergenceFinding => ({
  entityId: 'tech-1',
  entityName: 'LangGraph',
  entityType: 'technology',
  recentCount: 6,
  priorCount: 2,
  acceleration: 3,
  ...overrides,
});

describe('detectEmergenceJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('records one pattern observation per finding with agentType emergence-detector', async () => {
    mockedDetect.mockResolvedValue([finding(), finding({ entityId: 'tech-2', entityName: 'Other Tech' })]);
    mockedRecord.mockResolvedValue({ id: 'obs-1' });

    const r = await (detectEmergenceJob as any).execute({});

    expect(mockedRecord).toHaveBeenCalledTimes(2);
    expect(mockedRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: 'emergence-detector',
        observationType: 'pattern',
        entityId: 'tech-1',
        entityName: 'LangGraph',
        entityType: 'technology',
      })
    );
    // Confidence lands on the 0-1 scale: min(0.95, (50 + 10*3)/100) = 0.8.
    expect(mockedRecord.mock.calls[0][0].confidence).toBeCloseTo(0.8);
    expect(r.observationsRecorded).toBe(2);
    expect(r.findings).toBe(2);
  });

  it('a single per-finding recording failure does not lose the rest of the batch', async () => {
    mockedDetect.mockResolvedValue([finding({ entityId: 'tech-1' }), finding({ entityId: 'tech-2' })]);
    mockedRecord.mockRejectedValueOnce(new Error('entity not found')).mockResolvedValueOnce({ id: 'obs-2' });

    const r = await (detectEmergenceJob as any).execute({});

    expect(mockedRecord).toHaveBeenCalledTimes(2);
    expect(r.observationsRecorded).toBe(1);
  });

  it('honours event overrides and records nothing on dryRun', async () => {
    mockedDetect.mockResolvedValue([finding()]);

    const r = await (detectEmergenceJob as any).execute({
      windowDays: 14,
      minEdges: 1,
      accelerationFactor: 1,
      limit: 1,
      dryRun: true,
    });

    expect(mockedDetect).toHaveBeenCalledWith({ windowDays: 14, minEdges: 1, accelerationFactor: 1, limit: 1 });
    expect(mockedRecord).not.toHaveBeenCalled();
    expect(r.observationsRecorded).toBe(0);
    expect(r.dryRun).toBe(true);
  });

  it('emits the completion event with finding counts', async () => {
    mockedDetect.mockResolvedValue([finding(), finding({ entityId: 'tech-2' })]);
    mockedRecord.mockResolvedValue({ id: 'obs-1' });

    await (detectEmergenceJob as any).execute({});

    expect(mockedSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/schedule.emergence.detect.completed',
        data: expect.objectContaining({ findings: 2, observationsRecorded: 2 }),
      })
    );
  });

  it('is registered on the app/schedule.emergence.detect event and cron', () => {
    const trigger = (detectEmergenceJob as unknown as { trigger: unknown[] }).trigger;
    expect(trigger).toEqual([{ event: 'app/schedule.emergence.detect' }, { cron: 'TZ=UTC 30 3 * * *' }]);
  });
});
