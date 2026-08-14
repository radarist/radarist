/**
 * @file gemini-chat-stub-closure-scenarios.test.ts
 * @description Pins the deterministic stub scenarios the AI-042/043/046/047
 * closure acceptance depends on.
 *
 * The stub is a scripted actor, not a model: if its turn planner drifts, the
 * browser acceptance silently exercises the wrong path (or, worse, passes for
 * the wrong reason). These cases are the planner's contract — they cost
 * milliseconds and remove a whole class of "the acceptance ran but proved
 * nothing" failures from a multi-minute disposable-stack run.
 */

import {
  buildGeminiResponseBody,
  companyResearchJson,
  planGeminiStubResponse,
  splitApprovalList,
  STUB_MISSING_PAIN_POINT_ID,
  type GeminiStubFixtures,
  type StubContent,
} from '../gemini-chat-stub-server';

const FIXTURES: GeminiStubFixtures = {
  companyId: 'co-orbital',
  technologyId: 'tech-lattice',
  companyName: 'Orbital Grid Systems',
  technologyName: 'Lattice Router',
  missingPainPointId: 'pp-absent',
};

function userTurn(text: string): StubContent[] {
  return [{ role: 'user', parts: [{ text }] }];
}

/** One completed tool-result turn, which advances the script's stage counter. */
function afterToolResult(text: string): StubContent[] {
  return [
    ...userTurn(text),
    { role: 'model', parts: [{ functionCall: { name: 'createRelation', args: {} } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'createRelation', response: { success: false } } }] },
  ];
}

describe('splitApprovalList', () => {
  it('reads every bare id from comma and "and" separated lists', () => {
    expect(splitApprovalList('a-1, b-2, and c-3')).toEqual(['a-1', 'b-2', 'c-3']);
    expect(splitApprovalList('a_1 and b_2')).toEqual(['a_1', 'b_2']);
  });

  it('drops non-identifier members rather than inventing ids', () => {
    expect(splitApprovalList('a-1, but not, b-2')).toEqual(['a-1', 'b-2']);
  });
});

describe('AI-046 — plural approval scenario', () => {
  it('emits one approveProposedRelation call per listed id in a single candidate', () => {
    const plan = planGeminiStubResponse({ contents: userTurn('Approve proposals p-one, p-two.') }, FIXTURES);

    expect(plan.scenario).toBe('approve-multi');
    expect(plan.kind).toBe('functionCall');
    expect(plan.functionCalls?.map((call) => call.name)).toEqual([
      'approveProposedRelation',
      'approveProposedRelation',
    ]);
    expect(plan.functionCalls?.map((call) => call.args.proposalId)).toEqual(['p-one', 'p-two']);
  });

  it('scripts the same calls for negated wording — the ROUTE, not the stub, refuses', () => {
    const plan = planGeminiStubResponse(
      { contents: userTurn('Do not approve proposals p-one, p-two until I have read them.') },
      FIXTURES
    );

    expect(plan.scenario).toBe('approve-multi');
    expect(plan.functionCalls?.map((call) => call.args.proposalId)).toEqual(['p-one', 'p-two']);
  });

  it('leaves a single-id turn on the unchanged singular script', () => {
    const plan = planGeminiStubResponse({ contents: userTurn('Approve proposal p-only.') }, FIXTURES);

    expect(plan.scenario).toBe('approve');
    expect(plan.functionCall?.args.proposalId).toBe('p-only');
  });
});

describe('AI-047 / AI-042 — pain-point link scenarios', () => {
  it('scripts a lone doomed write for an explicit link instruction', () => {
    const plan = planGeminiStubResponse(
      { contents: userTurn('Link Orbital Grid Systems to the pain point Grid Interconnect Backlog.') },
      FIXTURES
    );

    expect(plan.scenario).toBe('pre-write-lookup');
    expect(plan.functionCalls).toBeUndefined();
    expect(plan.functionCall).toEqual({
      name: 'createRelation',
      args: {
        sourceId: FIXTURES.companyId,
        sourceType: 'company',
        targetId: 'pp-absent',
        targetType: 'painPoint',
        relationType: 'experiences',
      },
    });
  });

  it('batches a real read alongside the doomed write when the turn also asks to summarize', () => {
    const plan = planGeminiStubResponse(
      {
        contents: userTurn(
          'Summarize Lattice Router for me and link Orbital Grid Systems to the pain point Grid Interconnect Backlog.'
        ),
      },
      FIXTURES
    );

    expect(plan.scenario).toBe('partial-turn');
    expect(plan.functionCalls?.map((call) => call.name)).toEqual(['getEntityDetails', 'createRelation']);
  });

  it('falls back to the shared default when no missing id was configured', () => {
    const { missingPainPointId: _unused, ...withoutMissingId } = FIXTURES;
    const plan = planGeminiStubResponse(
      { contents: userTurn('Link Orbital Grid Systems to the pain point Grid Interconnect Backlog.') },
      withoutMissingId
    );

    expect(plan.functionCall?.args.targetId).toBe(STUB_MISSING_PAIN_POINT_ID);
  });

  it('completes the turn with text once the tool result returns', () => {
    const plan = planGeminiStubResponse(
      { contents: afterToolResult('Link Orbital Grid Systems to the pain point Grid Interconnect Backlog.') },
      FIXTURES
    );

    expect(plan.kind).toBe('text');
    expect(plan.text).toContain('pre-write-lookup-complete');
  });
});

/**
 * ARUN-022 accounting refuses to bill a requested-model fallback
 * (`operation-receipt-pricing.ts` → `provider-unreported`). A stub that omits
 * `modelVersion` therefore makes every scripted turn unpriceable, the chat
 * route's cost-accounting boundary trips, and every turn after the first is
 * 503'd — which reads as a product regression rather than a harness gap.
 */
describe('provider envelope', () => {
  it('reports the served model, exactly as a real Gemini response does', () => {
    const plan = planGeminiStubResponse({ contents: userTurn('hello') }, FIXTURES);

    expect(buildGeminiResponseBody(plan, 'gemini-3.1-pro-preview').modelVersion).toBe('gemini-3.1-pro-preview');
  });
});

describe('AI-043 — company research scenario', () => {
  it('answers the generator prompt with absolute http(s) sources only', () => {
    const plan = planGeminiStubResponse(
      {
        contents: userTurn('…lots of instructions…\n\nNOW research "Helio Narrative Works" and return ONLY the JSON.'),
      },
      FIXTURES
    );

    expect(plan.scenario).toBe('company-research');
    expect(plan.kind).toBe('text');
    const parsed = JSON.parse(plan.text ?? '{}') as { metadata?: { sources?: string[] } };
    expect(parsed.metadata?.sources?.length).toBeGreaterThan(0);
    for (const source of parsed.metadata?.sources ?? []) {
      expect(source).toMatch(/^https?:\/\//);
    }
  });

  it('produces parseable JSON even when the company name cannot be read', () => {
    const parsed = JSON.parse(companyResearchJson('')) as { metadata?: { sources?: string[] } };
    expect(parsed.metadata?.sources?.every((source) => source.startsWith('https://'))).toBe(true);
  });
});

describe('AI-051 — evidence-gap scenario and the withheld-tools contract', () => {
  const TURN = 'Which retained evidence gap most weakens our current radar view? Read only.';

  it('asks for the same read on every turn — the loop, not the script, must stop it', () => {
    for (const contents of [userTurn(TURN), afterToolResult(TURN)]) {
      const plan = planGeminiStubResponse({ contents }, FIXTURES);
      expect(plan.scenario).toBe('evidence-gap');
      expect(plan.kind).toBe('functionCall');
      expect(plan.functionCall).toEqual({ name: 'findDataGaps', args: {} });
    }
  });

  it('answers with TEXT when tools are withheld, as a real model must', () => {
    const contents: StubContent[] = [
      ...userTurn(TURN),
      { role: 'model', parts: [{ functionCall: { name: 'findDataGaps', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'findDataGaps', response: { success: true } } }] },
    ];
    const plan = planGeminiStubResponse(
      { contents, toolConfig: { functionCallingConfig: { mode: 'NONE' } } },
      FIXTURES
    );

    expect(plan.kind).toBe('text');
    expect(plan.functionCall).toBeUndefined();
    // The answer names the tool its facts came from, so the acceptance can
    // assert a CITED fact rather than merely a non-empty string.
    expect(plan.text).toContain('findDataGaps');
  });

  it('honours withheld tools for every scenario, not just this one', () => {
    // A script that would otherwise have called a tool must still answer.
    const plan = planGeminiStubResponse(
      {
        contents: userTurn(`Create a vendor relationship between ${FIXTURES.companyName} and ${FIXTURES.technologyName}`),
        toolConfig: { functionCallingConfig: { mode: 'NONE' } },
      },
      FIXTURES
    );
    expect(plan.kind).toBe('text');
    expect(plan.functionCall).toBeUndefined();
  });
});
