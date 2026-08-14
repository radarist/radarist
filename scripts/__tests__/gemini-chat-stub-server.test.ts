/**
 * @jest-environment node
 *
 * TEST-017 — deterministic Gemini chat stub. The stub is a scripted actor, not
 * a model: given the real route's wire-shape request (contents history), it
 * must return the exact next scripted turn for each acceptance scenario. These
 * tests pin the pure turn-planning core plus the loopback HTTP surface.
 */

import {
  buildGeminiResponseBody,
  planGeminiStubResponse,
  startGeminiChatStub,
  type GeminiStubFixtures,
  type StubContent,
} from '../testing/gemini-chat-stub-server';

const FIXTURES: GeminiStubFixtures = {
  companyId: 'rav-acme',
  technologyId: 'tech-rav-mesh',
  companyName: 'Acme Robotics',
  technologyName: 'Quantum Mesh',
};

const DIRECT_TURN = 'Create a vendor relationship between Acme Robotics and Quantum Mesh.';
const DISCOVERY_TURN =
  'What relationships might we be missing between Acme Robotics and Quantum Mesh? Propose only what you can verify for human review.';
const GROUNDED_TURN = 'Summarize stored evidence for Quantum Mesh (id: tech-rav-mesh) and cite the stored source.';

function userTurn(text: string): StubContent {
  return { role: 'user', parts: [{ text: `## SESSION CONTEXT\n...\n\n---\n\n${text}` }] };
}

function modelFunctionCall(name: string, args: Record<string, unknown>): StubContent {
  return { role: 'model', parts: [{ functionCall: { name, args } }] };
}

function functionResponseTurn(name: string, response: Record<string, unknown>): StubContent {
  return { role: 'function', parts: [{ functionResponse: { name, response } }] };
}

describe('planGeminiStubResponse', () => {
  it('grounded scenario cites a URL read from the real tool result', () => {
    const first = planGeminiStubResponse({ contents: [userTurn(GROUNDED_TURN)] }, FIXTURES);
    expect(first).toMatchObject({
      scenario: 'grounded',
      stage: 0,
      kind: 'functionCall',
      functionCall: {
        name: 'getEntityDetails',
        args: { entityType: 'technology', id: 'tech-rav-mesh' },
      },
    });

    const second = planGeminiStubResponse(
      {
        contents: [
          userTurn(GROUNDED_TURN),
          modelFunctionCall('getEntityDetails', {}),
          functionResponseTurn('getEntityDetails', {
            success: true,
            data: {
              website: 'https://poison.example/not-evidence',
              logoUrl: 'https://poison.example/logo.png',
              comprehensiveResearch: { metadata: { sources: ['https://example.invalid/source-a'] } },
            },
          }),
        ],
      },
      FIXTURES
    );
    expect(second.kind).toBe('text');
    expect(second.text).toContain('RELATION-AUTHORITY-STUB grounded-complete');
    expect(second.text).toContain('https://example.invalid/source-a');
    expect(second.text).not.toContain('poison.example');
  });

  it('direct scenario: first turn calls createRelation with the exact fixture endpoints', () => {
    const plan = planGeminiStubResponse({ contents: [userTurn(DIRECT_TURN)] }, FIXTURES);
    expect(plan).toEqual({
      scenario: 'direct',
      stage: 0,
      kind: 'functionCall',
      functionCall: {
        name: 'createRelation',
        args: {
          sourceId: 'rav-acme',
          sourceType: 'company',
          targetId: 'tech-rav-mesh',
          targetType: 'technology',
          relationType: 'vendor',
        },
      },
    });
  });

  it('direct scenario: after the tool result it synthesizes the completion text', () => {
    const plan = planGeminiStubResponse(
      {
        contents: [
          userTurn(DIRECT_TURN),
          modelFunctionCall('createRelation', {}),
          functionResponseTurn('createRelation', { success: true, data: { relationId: 'rel-1' } }),
        ],
      },
      FIXTURES
    );
    expect(plan.kind).toBe('text');
    expect(plan.text).toContain('RELATION-AUTHORITY-STUB direct-complete');
  });

  it('discovery scenario: proposes first, then self-approves with the proposalId read from the tool result', () => {
    const first = planGeminiStubResponse({ contents: [userTurn(DISCOVERY_TURN)] }, FIXTURES);
    expect(first.kind).toBe('functionCall');
    expect(first.functionCall?.name).toBe('proposeVerifiedRelation');
    expect(first.functionCall?.args).toMatchObject({
      sourceId: 'rav-acme',
      targetId: 'tech-rav-mesh',
      relationType: 'uses',
      confidence: 95,
    });

    const second = planGeminiStubResponse(
      {
        contents: [
          userTurn(DISCOVERY_TURN),
          modelFunctionCall('proposeVerifiedRelation', {}),
          functionResponseTurn('proposeVerifiedRelation', {
            _source: 'platform',
            success: true,
            data: { proposalId: 'prop-abc123', created: true },
          }),
        ],
      },
      FIXTURES
    );
    expect(second).toMatchObject({
      scenario: 'discovery',
      stage: 1,
      kind: 'functionCall',
      functionCall: { name: 'approveProposedRelation', args: { proposalId: 'prop-abc123' } },
    });

    const third = planGeminiStubResponse(
      {
        contents: [
          userTurn(DISCOVERY_TURN),
          modelFunctionCall('proposeVerifiedRelation', {}),
          functionResponseTurn('proposeVerifiedRelation', {
            success: true,
            data: { proposalId: 'prop-abc123', created: true },
          }),
          modelFunctionCall('approveProposedRelation', { proposalId: 'prop-abc123' }),
          functionResponseTurn('approveProposedRelation', {
            success: false,
            data: { dispatched: false, proposalId: 'prop-abc123' },
            error: 'refused',
          }),
        ],
      },
      FIXTURES
    );
    expect(third.kind).toBe('text');
    expect(third.text).toContain('RELATION-AUTHORITY-STUB discovery-complete');
  });

  it('discovery scenario: fails loudly when the proposal result carries no proposalId', () => {
    const plan = planGeminiStubResponse(
      {
        contents: [
          userTurn(DISCOVERY_TURN),
          modelFunctionCall('proposeVerifiedRelation', {}),
          functionResponseTurn('proposeVerifiedRelation', { success: false, error: 'boom' }),
        ],
      },
      FIXTURES
    );
    expect(plan.kind).toBe('text');
    expect(plan.text).toContain('RELATION-AUTHORITY-STUB scenario-error');
  });

  it('approve scenario: calls approveProposedRelation with the id parsed from the user message', () => {
    const plan = planGeminiStubResponse({ contents: [userTurn('Approve proposal prop-xyz789.')] }, FIXTURES);
    expect(plan).toMatchObject({
      scenario: 'approve',
      kind: 'functionCall',
      functionCall: { name: 'approveProposedRelation', args: { proposalId: 'prop-xyz789' } },
    });

    const done = planGeminiStubResponse(
      {
        contents: [
          userTurn('Approve proposal prop-xyz789.'),
          modelFunctionCall('approveProposedRelation', { proposalId: 'prop-xyz789' }),
          functionResponseTurn('approveProposedRelation', {
            success: true,
            data: { proposalId: 'prop-xyz789', relationId: 'rel-9' },
          }),
        ],
      },
      FIXTURES
    );
    expect(done.kind).toBe('text');
    expect(done.text).toContain('RELATION-AUTHORITY-STUB approve-complete');
  });

  it('unknown prompts get the deterministic fallback text', () => {
    const plan = planGeminiStubResponse({ contents: [userTurn('Hello there')] }, FIXTURES);
    expect(plan.kind).toBe('text');
    expect(plan.text).toContain('RELATION-AUTHORITY-STUB fallback');
  });

  it('builds a legacy-SDK-parseable response envelope for both kinds', () => {
    const call = buildGeminiResponseBody(
      {
        scenario: 'direct',
        stage: 0,
        kind: 'functionCall',
        functionCall: { name: 'createRelation', args: { a: 1 } },
      },
      'gemini-3.1-pro-preview'
    );
    expect(call.candidates[0].content.parts).toEqual([{ functionCall: { name: 'createRelation', args: { a: 1 } } }]);
    expect(call.candidates[0].finishReason).toBe('STOP');
    expect(call.usageMetadata.promptTokenCount).toBeGreaterThan(0);
    // The SERVED model must be reported, or ARUN-022 accounting refuses to bill
    // the turn and the chat route's cost boundary 503s every later turn.
    expect(call.modelVersion).toBe('gemini-3.1-pro-preview');

    const text = buildGeminiResponseBody(
      { scenario: 'direct', stage: 1, kind: 'text', text: 'done' },
      'gemini-3.1-pro-preview'
    );
    expect(text.candidates[0].content.parts).toEqual([{ text: 'done' }]);
  });
});

describe('startGeminiChatStub', () => {
  it('serves generateContent, records key transport, and rejects streaming', async () => {
    const stub = await startGeminiChatStub({ fixtures: FIXTURES });
    try {
      const generate = await fetch(`${stub.url}/v1beta/models/gemini-3.1-pro-preview:generateContent?key=query-key`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': 'header-key' },
        body: JSON.stringify({ contents: [userTurn(DIRECT_TURN)] }),
      });
      expect(generate.status).toBe(200);
      const body = (await generate.json()) as {
        candidates: Array<{ content: { parts: Array<Record<string, unknown>> } }>;
      };
      expect(body.candidates[0].content.parts[0]).toHaveProperty('functionCall');

      const stream = await fetch(`${stub.url}/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [] }),
      });
      expect(stream.status).toBe(501);

      const requests = await fetch(`${stub.url}/__stub/requests`).then(
        (r) => r.json() as Promise<Array<Record<string, unknown>>>
      );
      const generateRecord = requests.find((r) => String(r.path).includes(':generateContent'));
      expect(generateRecord).toMatchObject({
        model: 'gemini-3.1-pro-preview',
        apiKeyHeader: 'header-key',
        apiKeyQuery: 'query-key',
        scenario: 'direct',
        respondedKind: 'functionCall',
      });
      const streamRecord = requests.find((r) => String(r.path).includes(':streamGenerateContent'));
      expect(streamRecord).toMatchObject({ rejected: 'streaming-not-supported' });
    } finally {
      await stub.close();
    }
  });

  it('accepts runtime fixture updates over the control endpoint', async () => {
    const stub = await startGeminiChatStub({ fixtures: FIXTURES });
    try {
      const updated = { ...FIXTURES, companyId: 'rav-other' };
      const set = await fetch(`${stub.url}/__stub/fixtures`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(updated),
      });
      expect(set.status).toBe(204);

      const generate = await fetch(`${stub.url}/v1beta/models/m:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [userTurn(DIRECT_TURN)] }),
      });
      const body = (await generate.json()) as {
        candidates: Array<{ content: { parts: Array<{ functionCall?: { args?: Record<string, unknown> } }> } }>;
      };
      expect(body.candidates[0].content.parts[0].functionCall?.args?.sourceId).toBe('rav-other');
    } finally {
      await stub.close();
    }
  });
});

describe('planGeminiStubResponse with real conversation history', () => {
  it('selects the scenario from the CURRENT user turn, not an earlier history turn', () => {
    // Turn B arrives with turn A (direct) in history — the stub must run the
    // discovery script, exactly as the route sends history to the provider.
    const plan = planGeminiStubResponse(
      {
        contents: [
          userTurn(DIRECT_TURN),
          { role: 'model', parts: [{ text: 'RELATION-AUTHORITY-STUB direct-complete' }] },
          userTurn(DISCOVERY_TURN),
        ],
      },
      FIXTURES
    );
    expect(plan.scenario).toBe('discovery');
    expect(plan.kind).toBe('functionCall');
    expect(plan.functionCall?.name).toBe('proposeVerifiedRelation');
  });

  it('never mistakes a prior model answer for the current user prompt', () => {
    // The model's own last text mentions the approve marker; the current user
    // turn is a plain question — fallback, not the approve script.
    const plan = planGeminiStubResponse(
      {
        contents: [
          userTurn('Approve proposal prop-old111.'),
          { role: 'model', parts: [{ text: 'Approve proposal prop-old111 done' }] },
          userTurn('What did you just do?'),
        ],
      },
      FIXTURES
    );
    expect(plan.scenario).toBe('fallback');
  });

  it('keeps the scenario stable across tool-loop iterations that carry history', () => {
    const contents: StubContent[] = [
      userTurn(DIRECT_TURN),
      { role: 'model', parts: [{ text: 'RELATION-AUTHORITY-STUB direct-complete' }] },
      userTurn(DISCOVERY_TURN),
      modelFunctionCall('proposeVerifiedRelation', {}),
      functionResponseTurn('proposeVerifiedRelation', {
        success: true,
        data: { proposalId: 'prop-hist1', created: true },
      }),
    ];
    const plan = planGeminiStubResponse({ contents }, FIXTURES);
    expect(plan).toMatchObject({
      scenario: 'discovery',
      stage: 1,
      functionCall: { name: 'approveProposedRelation', args: { proposalId: 'prop-hist1' } },
    });
  });
});

describe('planGeminiStubResponse — AI-024/AI-023 artifact-intent and document-link scenarios', () => {
  const EXPLICIT_QUEUE_TURN = 'Queue an HTML report recommendation on edge AI inference chips.';
  const VAGUE_TURN = 'What should I be looking at these days?';
  const SUGGEST_TURN = 'Anything interesting on my radar lately?';
  const DOC_LINK_TURN = 'Link "Q3 Architecture Review" to Acme Robotics';
  const DOC_LINK_SUGGEST_TURN = 'Could we maybe link "Q3 Architecture Review" to Acme Robotics?';

  it('artifact-explicit: an explicit queue instruction yields TWO identical recommendArtifact calls in one turn', () => {
    const plan = planGeminiStubResponse({ contents: [userTurn(EXPLICIT_QUEUE_TURN)] }, FIXTURES);

    expect(plan.scenario).toBe('artifact-explicit');
    expect(plan.stage).toBe(0);
    expect(plan.kind).toBe('functionCall');
    expect(plan.functionCalls).toHaveLength(2);
    const [first, second] = plan.functionCalls ?? [];
    expect(first).toEqual(second);
    expect(first?.name).toBe('recommendArtifact');
    expect(first?.args).toMatchObject({
      artifactKind: 'report',
      title: 'Radar report: edge AI inference chips',
      query: 'edge AI inference chips',
    });
  });

  it('artifact-explicit: completes with text after the tool results return', () => {
    const plan = planGeminiStubResponse(
      {
        contents: [
          userTurn(EXPLICIT_QUEUE_TURN),
          modelFunctionCall('recommendArtifact', {
            artifactKind: 'report',
            title: 'Radar report: edge AI inference chips',
          }),
          functionResponseTurn('recommendArtifact', { success: true, data: { created: true } }),
        ],
      },
      FIXTURES
    );

    expect(plan.scenario).toBe('artifact-explicit');
    expect(plan.kind).toBe('text');
  });

  it('vague requests fall through to the deterministic fallback with no tool call', () => {
    const plan = planGeminiStubResponse({ contents: [userTurn(VAGUE_TURN)] }, FIXTURES);
    expect(plan).toMatchObject({ scenario: 'fallback', kind: 'text' });
    expect(plan.functionCall).toBeUndefined();
    expect(plan.functionCalls).toBeUndefined();
  });

  it('artifact-suggest: a model-authored suggestion is prose only — including a JSON-looking snippet — never a functionCall', () => {
    const plan = planGeminiStubResponse({ contents: [userTurn(SUGGEST_TURN)] }, FIXTURES);

    expect(plan.scenario).toBe('artifact-suggest');
    expect(plan.kind).toBe('text');
    expect(plan.functionCall).toBeUndefined();
    expect(plan.functionCalls).toBeUndefined();
    expect(plan.text).toContain('recommendArtifact');
    expect(plan.text).toContain('"artifactKind"');
  });

  it('doc-link: an explicit link instruction yields two identical calls to exercise transaction convergence', () => {
    const plan = planGeminiStubResponse({ contents: [userTurn(DOC_LINK_TURN)] }, FIXTURES);

    expect(plan.scenario).toBe('doc-link');
    expect(plan.stage).toBe(0);
    expect(plan.kind).toBe('functionCall');
    expect(plan.functionCalls).toHaveLength(2);
    expect(plan.functionCalls?.[0]).toEqual({
      name: 'linkDocumentToEntity',
      args: {
        documentTitle: 'Q3 Architecture Review',
        entityType: 'company',
        entityName: 'Acme Robotics',
      },
    });
    expect(plan.functionCalls?.[1]).toEqual(plan.functionCalls?.[0]);
  });

  it('doc-link: completes with text after the tool result returns', () => {
    const plan = planGeminiStubResponse(
      {
        contents: [
          userTurn(DOC_LINK_TURN),
          modelFunctionCall('linkDocumentToEntity', { documentTitle: 'Q3 Architecture Review' }),
          functionResponseTurn('linkDocumentToEntity', { success: true, data: { created: true } }),
        ],
      },
      FIXTURES
    );

    expect(plan.scenario).toBe('doc-link');
    expect(plan.kind).toBe('text');
  });

  it('doc-link-suggest: discovery-flavored wording STILL scripts the tool call so the route must refuse it', () => {
    const plan = planGeminiStubResponse({ contents: [userTurn(DOC_LINK_SUGGEST_TURN)] }, FIXTURES);

    expect(plan.scenario).toBe('doc-link-suggest');
    expect(plan.stage).toBe(0);
    expect(plan.kind).toBe('functionCall');
    expect(plan.functionCall).toEqual({
      name: 'linkDocumentToEntity',
      args: {
        documentTitle: 'Q3 Architecture Review',
        entityType: 'company',
        entityName: 'Acme Robotics',
      },
    });
  });

  it('builds a multi-part envelope when a plan carries plural functionCalls', () => {
    const body = buildGeminiResponseBody(
      planGeminiStubResponse({ contents: [userTurn(EXPLICIT_QUEUE_TURN)] }, FIXTURES),
      'gemini-3.1-pro-preview'
    );
    const parts = body.candidates[0].content.parts;
    expect(parts).toHaveLength(2);
    expect(parts[0].functionCall?.name).toBe('recommendArtifact');
    expect(parts[1]).toEqual(parts[0]);
  });
});
