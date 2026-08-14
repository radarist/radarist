import {
  AgentRunCorrelationConflictError,
  resolveAgentRunCorrelation,
} from '../agent-run-correlation';

describe('resolveAgentRunCorrelation', () => {
  it('resolves mission, sweep, and standalone identities without conflation', () => {
    expect(resolveAgentRunCorrelation({ missionId: 'mission-1' })).toEqual({ id: 'mission-1', kind: 'mission' });
    expect(resolveAgentRunCorrelation({ sweepId: 'sweep-1' })).toEqual({ id: 'sweep-1', kind: 'sweep' });
    expect(resolveAgentRunCorrelation({})).toBeNull();
  });

  it('rejects an ambiguous dual owner', () => {
    expect(() => resolveAgentRunCorrelation({ missionId: 'mission-1', sweepId: 'sweep-1' })).toThrow(
      AgentRunCorrelationConflictError
    );
  });
});
