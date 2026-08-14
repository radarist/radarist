export type AgentRunCorrelationKind = 'mission' | 'sweep';

export interface AgentRunCorrelationInput {
  missionId?: string;
  sweepId?: string;
}

export interface AgentRunCorrelation {
  id: string;
  kind: AgentRunCorrelationKind;
}

export class AgentRunCorrelationConflictError extends Error {
  constructor() {
    super('AgentRun cannot belong to both a mission and a sweep');
    this.name = 'AgentRunCorrelationConflictError';
  }
}

/** Resolve the one lifecycle identity that can own an AgentRun. */
export function resolveAgentRunCorrelation(input: AgentRunCorrelationInput): AgentRunCorrelation | null {
  if (input.missionId && input.sweepId) {
    throw new AgentRunCorrelationConflictError();
  }
  if (input.missionId) return { id: input.missionId, kind: 'mission' };
  if (input.sweepId) return { id: input.sweepId, kind: 'sweep' };
  return null;
}
