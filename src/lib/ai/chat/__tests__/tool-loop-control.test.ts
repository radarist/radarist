/**
 * AI-051 — unit contract for the chat tool-loop control decisions.
 *
 * These are the rules that decide whether the Assistant answers or exhausts.
 * They are pure so the route's behaviour can be reasoned about without a
 * provider, and so the two provider seams cannot drift into different rules.
 */

import {
  CHAT_TOOL_RESULT_MIN_CAP,
  CHAT_TOOL_RESULT_TURN_BUDGET_DEFAULT,
  REPEATED_TOOL_CALL_NOTE,
  boundedResultCapForTurn,
  buildSynthesisDirective,
  decideSynthesisReservation,
  findDuplicateToolCall,
  hasCitableToolEvidence,
  markRepeatedToolResult,
  toolCallSignature,
  type LoopToolCall,
} from '../tool-loop-control';

function call(name: string, args: Record<string, unknown>, success = true): LoopToolCall {
  return { name, args, result: { success } };
}

describe('toolCallSignature', () => {
  it('treats the same call with reordered keys as one signature', () => {
    expect(toolCallSignature('getEntityDetails', { id: 'tech-1', type: 'technology' })).toBe(
      toolCallSignature('getEntityDetails', { type: 'technology', id: 'tech-1' })
    );
  });

  it('separates different arguments and different tools', () => {
    expect(toolCallSignature('getEntityDetails', { id: 'a' })).not.toBe(
      toolCallSignature('getEntityDetails', { id: 'b' })
    );
    expect(toolCallSignature('getEntityDetails', { id: 'a' })).not.toBe(
      toolCallSignature('getEntityAssertions', { id: 'a' })
    );
  });

  it('is stable through nested objects and arrays', () => {
    expect(toolCallSignature('q', { filter: { b: [1, { y: 2, x: 1 }], a: 1 } })).toBe(
      toolCallSignature('q', { filter: { a: 1, b: [1, { x: 1, y: 2 }] } })
    );
    // Array ORDER is meaningful and must not collapse.
    expect(toolCallSignature('q', { ids: ['a', 'b'] })).not.toBe(toolCallSignature('q', { ids: ['b', 'a'] }));
  });

  it('ignores explicitly-undefined keys, which are absent on the wire', () => {
    expect(toolCallSignature('q', { id: 'a', limit: undefined })).toBe(toolCallSignature('q', { id: 'a' }));
  });
});

describe('findDuplicateToolCall', () => {
  it('returns the earlier identical call', () => {
    const executed = [call('searchKnowledgeGraph', { query: 'gap' }), call('getEntityDetails', { id: 'tech-1' })];
    expect(findDuplicateToolCall(executed, 'getEntityDetails', { id: 'tech-1' })).toBe(executed[1]);
  });

  it('returns undefined for a genuinely new call', () => {
    const executed = [call('getEntityDetails', { id: 'tech-1' })];
    expect(findDuplicateToolCall(executed, 'getEntityDetails', { id: 'tech-2' })).toBeUndefined();
  });

  it('matches a FAILED earlier call too — a repeat is a repeat', () => {
    const executed = [call('getGapAnalysis', {}, false)];
    expect(findDuplicateToolCall(executed, 'getGapAnalysis', {})).toBe(executed[0]);
  });
});

describe('markRepeatedToolResult', () => {
  it('re-serves the earlier payload unchanged, labelled as a repeat', () => {
    const previous = { success: true, data: { total: 3, ids: ['a', 'b', 'c'] } };
    const repeated = markRepeatedToolResult(previous) as typeof previous & {
      repeatedCall: boolean;
      _note: string;
    };
    expect(repeated.data).toEqual(previous.data);
    expect(repeated.success).toBe(true);
    expect(repeated.repeatedCall).toBe(true);
    expect(repeated._note).toBe(REPEATED_TOOL_CALL_NOTE);
    // The original is untouched — the receipt list keeps the real first call.
    expect(previous).not.toHaveProperty('repeatedCall');
  });
});

describe('hasCitableToolEvidence', () => {
  it('counts a successful call even when it found nothing', () => {
    // "The graph was searched and holds nothing about X" is a real finding and
    // is the correct answer to a no-evidence question.
    expect(hasCitableToolEvidence([call('searchKnowledgeGraph', { query: 'x' })])).toBe(true);
  });

  it('does not count failures — that is what the incomplete envelope is for', () => {
    expect(hasCitableToolEvidence([call('a', {}, false), call('b', {}, false)])).toBe(false);
    expect(hasCitableToolEvidence([])).toBe(false);
  });
});

describe('decideSynthesisReservation', () => {
  const evidence = [call('findDataGaps', {})];

  it('reserves the final iteration once evidence exists', () => {
    expect(
      decideSynthesisReservation({ iterations: 15, maxIterations: 15, executed: evidence, batchWasAllRepeats: false })
    ).toBe('final-iteration-reserved');
  });

  it('reserves early when a whole batch only repeated calls already made', () => {
    expect(
      decideSynthesisReservation({ iterations: 3, maxIterations: 15, executed: evidence, batchWasAllRepeats: true })
    ).toBe('duplicate-probe-loop');
  });

  it('does not reserve mid-loop while genuinely new evidence is arriving', () => {
    expect(
      decideSynthesisReservation({ iterations: 3, maxIterations: 15, executed: evidence, batchWasAllRepeats: false })
    ).toBeNull();
  });

  it('never reserves without citable evidence, at the cap or in a repeat loop', () => {
    const failures = [call('findDataGaps', {}, false)];
    expect(
      decideSynthesisReservation({ iterations: 15, maxIterations: 15, executed: failures, batchWasAllRepeats: false })
    ).toBeNull();
    expect(
      decideSynthesisReservation({ iterations: 4, maxIterations: 15, executed: failures, batchWasAllRepeats: true })
    ).toBeNull();
    expect(
      decideSynthesisReservation({ iterations: 15, maxIterations: 15, executed: [], batchWasAllRepeats: false })
    ).toBeNull();
  });

  it('holds at a cap of 1 — the smallest turn still gets its answer', () => {
    expect(
      decideSynthesisReservation({ iterations: 1, maxIterations: 1, executed: evidence, batchWasAllRepeats: false })
    ).toBe('final-iteration-reserved');
  });
});

describe('buildSynthesisDirective', () => {
  it.each(['final-iteration-reserved', 'duplicate-probe-loop'] as const)(
    'demands cited tool facts and forbids invention (%s)',
    (reason) => {
      const directive = buildSynthesisDirective(reason);
      expect(directive).toMatch(/ONLY the tool results already in this conversation/);
      expect(directive).toMatch(/name the tool and the specific values/i);
      expect(directive).toMatch(/never invent an id, number, date or name/i);
      expect(directive).toMatch(/state plainly which part is unsupported/i);
    }
  );

  it('names the reason so the model knows why no more tools are coming', () => {
    expect(buildSynthesisDirective('final-iteration-reserved')).toMatch(/tool budget for this turn is now spent/i);
    expect(buildSynthesisDirective('duplicate-probe-loop')).toMatch(/only repeated calls that had already run/i);
  });
});

describe('boundedResultCapForTurn', () => {
  it('leaves ordinary turns byte-identical to the per-result cap', () => {
    expect(boundedResultCapForTurn(0, 50_000)).toBe(50_000);
    expect(boundedResultCapForTurn(10_000, 50_000)).toBe(50_000);
  });

  it('tightens once the turn budget is nearly spent', () => {
    const nearlySpent = CHAT_TOOL_RESULT_TURN_BUDGET_DEFAULT - 10_000;
    expect(boundedResultCapForTurn(nearlySpent, 50_000)).toBe(10_000);
  });

  it('never returns an unreadable empty payload once the budget is gone', () => {
    expect(boundedResultCapForTurn(CHAT_TOOL_RESULT_TURN_BUDGET_DEFAULT + 1_000_000, 50_000)).toBe(
      CHAT_TOOL_RESULT_MIN_CAP
    );
  });

  it('is disabled by a zero or negative budget', () => {
    expect(boundedResultCapForTurn(999_999, 50_000, 0)).toBe(50_000);
    expect(boundedResultCapForTurn(999_999, 50_000, -1)).toBe(50_000);
    expect(boundedResultCapForTurn(999_999, 50_000, Number.NaN)).toBe(50_000);
  });

  it('never widens the per-result cap', () => {
    expect(boundedResultCapForTurn(0, 1_000, 500_000)).toBe(1_000);
  });
});
