import {
  BUILD_TERMINAL_REASONS,
  classifyBuildTerminal,
  type BuildSessionTerminalInput,
  type BuildSupervisorTerminalReason,
} from '../build-mission-terminal';

function session(overrides: Partial<BuildSessionTerminalInput> = {}): BuildSessionTerminalInput {
  return {
    source: 'session',
    sessionDone: true,
    exitCode: 0,
    launchedMaxTurns: 160,
    result: {
      subtype: 'success',
      numTurns: 12,
      isError: false,
      resultText: 'Completed cleanly.',
    },
    ...overrides,
  };
}

describe('classifyBuildTerminal', () => {
  it('exports the complete persistable reason vocabulary', () => {
    expect(BUILD_TERMINAL_REASONS).toEqual([
      'completed',
      'runtime-failure',
      'budget-exhausted',
      'turns-exhausted',
      'session-cap-exhausted',
      'review-failure',
      'cancelled',
    ]);
  });

  it('classifies a clean provider result as completed and retains bounded evidence', () => {
    expect(classifyBuildTerminal(session())).toEqual({
      reason: 'completed',
      basis: 'completed-result',
      evidence: {
        source: 'session',
        subtype: 'success',
        isError: false,
        apiStatus: null,
        exitCode: 0,
        resultExcerpt: 'Completed cleanly.',
        observedTurns: 12,
        launchedMaxTurns: 160,
      },
    });
  });

  it.each([
    {
      subtype: 'error_max_turns',
      numTurns: 161,
      isError: true,
      resultText: 'Stopped.',
    },
    {
      subtype: 'error_during_execution',
      numTurns: 160,
      isError: true,
      resultText: 'Reached max turns (160).',
    },
  ])('classifies an explicit turn signature at the launched bound as turns exhausted', (result) => {
    expect(classifyBuildTerminal(session({ result }))).toMatchObject({
      reason: 'turns-exhausted',
      basis: 'provider-turn-limit',
      evidence: { observedTurns: result.numTurns, launchedMaxTurns: 160 },
    });
  });

  it('does not infer turn exhaustion from turn count without an explicit provider signature', () => {
    expect(
      classifyBuildTerminal(
        session({
          result: {
            subtype: 'error_during_execution',
            numTurns: 161,
            isError: true,
            resultText: 'An unknown execution error occurred.',
          },
        })
      )
    ).toMatchObject({ reason: 'runtime-failure', basis: 'provider-reported-error' });
  });

  it('does not accept a turn signature below the launched bound', () => {
    expect(
      classifyBuildTerminal(
        session({
          result: {
            subtype: 'error_max_turns',
            numTurns: 159,
            isError: true,
            resultText: 'Reached max turns.',
          },
        })
      )
    ).toMatchObject({ reason: 'runtime-failure', basis: 'provider-reported-error' });
  });

  it.each([
    {
      label: 'timeout',
      input: session({
        sessionDone: false,
        result: { subtype: 'error_max_turns', numTurns: 161, isError: true },
      }),
      basis: 'session-timeout',
    },
    {
      label: 'missing result',
      input: session({ result: null }),
      basis: 'missing-result',
    },
    {
      label: 'malformed result',
      input: session({ result: { subtype: 'error_max_turns', numTurns: '161', isError: true } }),
      basis: 'malformed-result',
    },
    {
      label: 'missing exit marker',
      input: session({
        exitCode: null,
        result: { subtype: 'error_max_turns', numTurns: 161, isError: true },
      }),
      basis: 'invalid-wrapper-exit',
    },
    {
      label: 'nonzero wrapper exit',
      input: session({
        exitCode: 72,
        result: { subtype: 'error_max_turns', numTurns: 161, isError: true },
      }),
      basis: 'nonzero-wrapper-exit',
    },
    {
      label: 'provider API failure',
      input: session({
        result: {
          subtype: 'error_max_turns',
          numTurns: 161,
          isError: true,
          apiErrorStatus: 404,
          resultText: 'Reached max turns, but the model was not found.',
        },
      }),
      basis: 'provider-api-error',
    },
  ])('$label outranks an apparent turn-limit result', ({ input, basis }) => {
    expect(classifyBuildTerminal(input)).toMatchObject({ reason: 'runtime-failure', basis });
  });

  it.each([
    {
      subtype: 'error_max_budget',
      numTurns: 44,
      isError: true,
      resultText: 'Stopped.',
    },
    {
      subtype: 'error_during_execution',
      numTurns: 44,
      isError: true,
      resultText: 'The maximum budget was reached.',
    },
  ])('classifies an explicit provider budget boundary separately', (result) => {
    expect(classifyBuildTerminal(session({ result }))).toMatchObject({
      reason: 'budget-exhausted',
      basis: 'provider-budget-limit',
    });
  });

  it('does not mistake successful prose mentioning a turn limit for terminal authority', () => {
    expect(
      classifyBuildTerminal(
        session({
          result: {
            subtype: 'success',
            numTurns: 160,
            isError: false,
            resultText: 'The documentation explains when the turn limit is reached.',
          },
        })
      )
    ).toMatchObject({ reason: 'completed', basis: 'completed-result' });
  });

  it('fails an unknown non-error subtype closed as a runtime failure', () => {
    expect(
      classifyBuildTerminal(session({ result: { subtype: 'future_state', numTurns: 1, isError: false } }))
    ).toMatchObject({ reason: 'runtime-failure', basis: 'unexpected-result-subtype' });
  });

  it('bounds the persisted result excerpt without losing the raw terminal fields', () => {
    const classified = classifyBuildTerminal(
      session({
        result: {
          subtype: 'error_during_execution',
          numTurns: 7,
          isError: true,
          resultText: `  ${'x'.repeat(1_500)}  `,
        },
      })
    );
    expect(classified.evidence).toMatchObject({
      subtype: 'error_during_execution',
      isError: true,
      exitCode: 0,
      observedTurns: 7,
      launchedMaxTurns: 160,
    });
    expect(classified.evidence.resultExcerpt).toHaveLength(1_000);
  });

  it.each<[BuildSupervisorTerminalReason, string]>([
    ['runtime-failure', 'supervisor-runtime-failure'],
    ['budget-exhausted', 'supervisor-budget-limit'],
    ['session-cap-exhausted', 'supervisor-session-cap'],
    ['review-failure', 'review-gate'],
    ['cancelled', 'user-cancelled'],
  ])('preserves the supervisor terminal reason %s without fabricating session evidence', (reason, basis) => {
    expect(classifyBuildTerminal({ source: 'supervisor', reason })).toEqual({
      reason,
      basis,
      evidence: {
        source: 'supervisor',
        subtype: null,
        isError: null,
        apiStatus: null,
        exitCode: null,
        resultExcerpt: null,
        observedTurns: null,
        launchedMaxTurns: null,
      },
    });
  });
});
