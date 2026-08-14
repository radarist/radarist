import {
  missionEntitySchema,
  missionExecutionEnvelopeSchema,
  missionSourceSchema,
  missionStatusSchema,
  createMissionSchema,
  missionSchema,
} from '../mission';

// ============================================================================
// FIXTURES
// ============================================================================

function validMissionEntity() {
  return {
    id: 'ent-001',
    name: 'Acme Corp',
    type: 'company',
    confidence: 0.85,
    sourceUrl: 'https://example.com/acme',
    agentName: 'scout',
  };
}

function validMissionSource() {
  return {
    url: 'https://techcrunch.com/article',
    title: 'Acme Raises $50M',
    snippet: 'Acme Corp announced a Series B...',
  };
}

function validMission() {
  return {
    id: 'mission-abc',
    userId: 'user-123',
    prompt: 'Find emerging AI startups',
    agent: 'scout',
    status: 'running' as const,
    progress: 42,
    progressMessage: 'Scanning sources...',
    entities: [validMissionEntity()],
    sources: [validMissionSource()],
    result: undefined,
    createdAt: new Date().toISOString(),
    completedAt: undefined,
    tokenUsage: { input: 1200, output: 800 },
    costUsd: 0.004,
    errors: [],
  };
}

function validExecutionEnvelope() {
  return {
    orchestratorMaxCostUsd: 13,
    revisionMaxCostUsd: 0.01,
    preludeMaxCostUsd: 2,
    auxiliaryMaxCostUsd: 2,
    totalMaxCostUsd: 17.01,
    maxToolCalls: 120,
    timeoutMinutes: 90,
    requestedModel: 'claude-opus-5',
  };
}

// ============================================================================
// missionExecutionEnvelopeSchema
// ============================================================================

describe('missionExecutionEnvelopeSchema', () => {
  it('accepts the COORD-011 authorized allocation', () => {
    expect(missionExecutionEnvelopeSchema.safeParse(validExecutionEnvelope()).success).toBe(true);
  });

  it('accepts explicit zero revision and prelude allocations', () => {
    const result = missionExecutionEnvelopeSchema.safeParse({
      ...validExecutionEnvelope(),
      revisionMaxCostUsd: 0,
      preludeMaxCostUsd: 0,
      totalMaxCostUsd: 15,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an envelope whose components do not sum to its total', () => {
    const result = missionExecutionEnvelopeSchema.safeParse({
      ...validExecutionEnvelope(),
      totalMaxCostUsd: 15.3,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a timeout above the 120-minute platform ceiling', () => {
    const result = missionExecutionEnvelopeSchema.safeParse({
      ...validExecutionEnvelope(),
      timeoutMinutes: 121,
    });
    expect(result.success).toBe(false);
  });

  it('accepts an envelope without model identity fields', () => {
    const { requestedModel: _requestedModel, ...rest } = validExecutionEnvelope();
    expect(missionExecutionEnvelopeSchema.safeParse(rest).success).toBe(true);
  });

  it('rejects a non-integer tool-call cap', () => {
    const result = missionExecutionEnvelopeSchema.safeParse({
      ...validExecutionEnvelope(),
      maxToolCalls: 12.5,
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// missionEntitySchema
// ============================================================================

describe('missionEntitySchema', () => {
  it('accepts a valid entity', () => {
    const result = missionEntitySchema.safeParse(validMissionEntity());
    expect(result.success).toBe(true);
  });

  it('accepts entity without optional sourceUrl', () => {
    const { sourceUrl: _, ...rest } = validMissionEntity();
    const result = missionEntitySchema.safeParse(rest);
    expect(result.success).toBe(true);
  });

  it('rejects empty id', () => {
    const result = missionEntitySchema.safeParse({ ...validMissionEntity(), id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const result = missionEntitySchema.safeParse({ ...validMissionEntity(), name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects empty type', () => {
    const result = missionEntitySchema.safeParse({ ...validMissionEntity(), type: '' });
    expect(result.success).toBe(false);
  });

  it('rejects confidence below 0', () => {
    const result = missionEntitySchema.safeParse({ ...validMissionEntity(), confidence: -0.1 });
    expect(result.success).toBe(false);
  });

  it('rejects confidence above 1', () => {
    const result = missionEntitySchema.safeParse({ ...validMissionEntity(), confidence: 1.1 });
    expect(result.success).toBe(false);
  });

  it('accepts confidence at boundaries (0 and 1)', () => {
    expect(missionEntitySchema.safeParse({ ...validMissionEntity(), confidence: 0 }).success).toBe(true);
    expect(missionEntitySchema.safeParse({ ...validMissionEntity(), confidence: 1 }).success).toBe(true);
  });

  it('rejects invalid sourceUrl', () => {
    const result = missionEntitySchema.safeParse({ ...validMissionEntity(), sourceUrl: 'not-a-url' });
    expect(result.success).toBe(false);
  });

  it('rejects empty agentName', () => {
    const result = missionEntitySchema.safeParse({ ...validMissionEntity(), agentName: '' });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// missionSourceSchema
// ============================================================================

describe('missionSourceSchema', () => {
  it('accepts a valid source', () => {
    const result = missionSourceSchema.safeParse(validMissionSource());
    expect(result.success).toBe(true);
  });

  it('accepts source without optional snippet', () => {
    const { snippet: _, ...rest } = validMissionSource();
    const result = missionSourceSchema.safeParse(rest);
    expect(result.success).toBe(true);
  });

  it('rejects invalid url', () => {
    const result = missionSourceSchema.safeParse({ ...validMissionSource(), url: 'bad' });
    expect(result.success).toBe(false);
  });

  it('rejects empty title', () => {
    const result = missionSourceSchema.safeParse({ ...validMissionSource(), title: '' });
    expect(result.success).toBe(false);
  });

  it('rejects missing url', () => {
    const { url: _, ...rest } = validMissionSource();
    const result = missionSourceSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// missionStatusSchema
// ============================================================================

describe('missionStatusSchema', () => {
  it.each(['pending', 'running', 'completed', 'failed'] as const)('accepts "%s"', (status) => {
    expect(missionStatusSchema.safeParse(status).success).toBe(true);
  });

  it('rejects unknown status', () => {
    expect(missionStatusSchema.safeParse('cancelled').success).toBe(false);
  });

  it('rejects empty string', () => {
    expect(missionStatusSchema.safeParse('').success).toBe(false);
  });
});

// ============================================================================
// createMissionSchema
// ============================================================================

describe('createMissionSchema', () => {
  it('accepts valid input with explicit agent', () => {
    const result = createMissionSchema.safeParse({ prompt: 'Find AI startups', agent: 'scout' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.prompt).toBe('Find AI startups');
      expect(result.data.agent).toBe('scout');
    }
  });

  it('defaults agent to "scout" when not provided', () => {
    const result = createMissionSchema.safeParse({ prompt: 'Research quantum computing' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agent).toBe('scout');
    }
  });

  it('rejects missing prompt', () => {
    const result = createMissionSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects empty prompt', () => {
    const result = createMissionSchema.safeParse({ prompt: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('Mission prompt is required');
    }
  });

  it('rejects prompt exceeding the 50000-char default cap', () => {
    const result = createMissionSchema.safeParse({ prompt: 'x'.repeat(50001) });
    expect(result.success).toBe(false);
  });

  it('accepts prompt at exactly the 50000-char default cap', () => {
    const result = createMissionSchema.safeParse({ prompt: 'x'.repeat(50000) });
    expect(result.success).toBe(true);
  });

  it('rejects empty agent string', () => {
    const result = createMissionSchema.safeParse({ prompt: 'test', agent: '' });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// missionSchema (full)
// ============================================================================

describe('missionSchema', () => {
  it('accepts a valid full mission', () => {
    const result = missionSchema.safeParse(validMission());
    expect(result.success).toBe(true);
  });

  it('accepts a positive user-authorized cost cap', () => {
    expect(missionSchema.safeParse({ ...validMission(), authorizedMaxCostUsd: 31 }).success).toBe(true);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid user-authorized cost cap %p', (cap) => {
    expect(missionSchema.safeParse({ ...validMission(), authorizedMaxCostUsd: cap }).success).toBe(false);
  });

  it('retains a persisted confirmed and effective execution envelope', () => {
    const result = missionSchema.safeParse({
      ...validMission(),
      authorizedMaxCostUsd: 17.01,
      executionEnvelope: validExecutionEnvelope(),
      effectiveExecutionEnvelope: validExecutionEnvelope(),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.executionEnvelope).toEqual(validExecutionEnvelope());
      expect(result.data.effectiveExecutionEnvelope).toEqual(validExecutionEnvelope());
    }
  });

  it('accepts mission with empty entities and sources arrays', () => {
    const mission = { ...validMission(), entities: [], sources: [] };
    const result = missionSchema.safeParse(mission);
    expect(result.success).toBe(true);
  });

  it('accepts mission without optional fields', () => {
    const mission = {
      id: 'mission-1',
      userId: 'user-1',
      prompt: 'Search',
      agent: 'scout',
      status: 'pending' as const,
      progress: 0,
      entities: [],
      sources: [],
      createdAt: new Date().toISOString(),
    };
    const result = missionSchema.safeParse(mission);
    expect(result.success).toBe(true);
  });

  it('rejects missing id', () => {
    const { id: _, ...rest } = validMission();
    expect(missionSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing userId', () => {
    const { userId: _, ...rest } = validMission();
    expect(missionSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing prompt', () => {
    const { prompt: _, ...rest } = validMission();
    expect(missionSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing agent', () => {
    const { agent: _, ...rest } = validMission();
    expect(missionSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing status', () => {
    const { status: _, ...rest } = validMission();
    expect(missionSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects invalid status value', () => {
    const result = missionSchema.safeParse({ ...validMission(), status: 'paused' });
    expect(result.success).toBe(false);
  });

  it('rejects progress below 0', () => {
    const result = missionSchema.safeParse({ ...validMission(), progress: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects progress above 100', () => {
    const result = missionSchema.safeParse({ ...validMission(), progress: 101 });
    expect(result.success).toBe(false);
  });

  it('accepts progress at boundaries (0 and 100)', () => {
    expect(missionSchema.safeParse({ ...validMission(), progress: 0 }).success).toBe(true);
    expect(missionSchema.safeParse({ ...validMission(), progress: 100 }).success).toBe(true);
  });

  it('rejects invalid entity in entities array', () => {
    const result = missionSchema.safeParse({
      ...validMission(),
      entities: [{ id: '', name: 'Bad', type: 'x', confidence: 0.5, agentName: 'scout' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid source in sources array', () => {
    const result = missionSchema.safeParse({
      ...validMission(),
      sources: [{ url: 'not-valid', title: 'Bad' }],
    });
    expect(result.success).toBe(false);
  });

  it('validates tokenUsage structure', () => {
    const result = missionSchema.safeParse({
      ...validMission(),
      tokenUsage: { input: 'not-a-number', output: 500 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing createdAt', () => {
    const { createdAt: _, ...rest } = validMission();
    expect(missionSchema.safeParse(rest).success).toBe(false);
  });

  it('accepts honest nullable prelude/revision ledgers and their terminal unavailable components', () => {
    const result = missionSchema.safeParse({
      ...validMission(),
      costUsd: undefined,
      costUnavailableReason: 'unknown-pricing',
      costUnavailableComponents: ['prelude', 'revisions'],
      skillPrelude: [
        {
          skill: 'jtbd-framing',
          block: '<jtbd>result</jtbd>',
          costUsd: null,
          costUnavailableReason: 'unknown-pricing',
          durationMs: 100,
          firedAt: new Date().toISOString(),
          success: true,
        },
      ],
      preludeAccounting: {
        targets: { accepted: ['Acme'], rejected: [], duplicates: [], droppedForCountCap: [], countCap: 5 },
        tasks: { planned: 1, executed: 1, skipped: [] },
        cost: {
          totalUsd: null,
          costUnavailableReason: 'unknown-pricing',
          capUsd: 2,
          aborted: true,
        },
      },
      revisionAttempts: [
        {
          attempt: 1,
          triggeredByVerdict: 'REVISE',
          failingChecks: ['evidence'],
          feedback: 'Add citations',
          costUsd: null,
          costUnavailableReason: 'accounting-incomplete',
          durationMs: 250,
          revisedAt: new Date().toISOString(),
        },
      ],
    });

    expect(result.success).toBe(true);
  });
});
