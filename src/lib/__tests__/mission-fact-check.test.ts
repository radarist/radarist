/**
 * @file lib/__tests__/mission-fact-check.test.ts
 * Unit tests for the grounded report fact-check (Quality Layer 1.5).
 *
 * The module's only runtime dependency is `@/lib/ai/client` (the QualityCheck
 * import is type-only), so mocking the two client functions fully isolates it.
 */

const mockGenerateContent = jest.fn();
const mockGenerateStructuredContent = jest.fn();

jest.mock('@/lib/ai/client', () => ({
  // MISSION-005: production code now uses the WithMetadata variants; the
  // mocks wrap the same per-test return values with a fixed cost so existing
  // fixtures keep working and cost accumulation is testable.
  generateContentWithMetadata: async (...args: unknown[]) => ({
    text: await mockGenerateContent(...args),
    costUsd: 0.001,
    requestId: 'req-test',
    durationMs: 1,
  }),
  generateStructuredContentWithMetadata: async (...args: unknown[]) => ({
    data: await mockGenerateStructuredContent(...args),
    costUsd: 0.002,
    requestId: 'req-test',
    durationMs: 1,
  }),
}));

import {
  runReportFactCheck,
  partitionExternallyCheckable,
  FACT_CHECK_NAME,
  type ExtractedClaim,
} from '../mission-fact-check';

/** A report comfortably above the MIN_REPORT_CHARS (800) floor. */
const LONG_REPORT = `# Quantum Computing Foresight\n\n${'Body content with substantive analysis. '.repeat(40)}\nMicrosoft Majorana-1 has 32 logical qubits [3]. IBM Condor reaches 1,121 qubits.`;

function claim(overrides: Partial<ExtractedClaim> = {}): ExtractedClaim {
  return {
    text: 'Microsoft Majorana-1 has 32 logical qubits',
    subject: 'Microsoft Majorana-1',
    value: '32 logical qubits',
    hasCitation: true,
    verificationQuestion: 'How many qubits does Microsoft Majorana-1 have, physical or logical?',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runReportFactCheck', () => {
  it('passes when all load-bearing claims are confirmed', async () => {
    mockGenerateStructuredContent
      .mockResolvedValueOnce({ claims: [claim()] }) // extraction
      .mockResolvedValueOnce({ verdicts: [{ index: 0, status: 'confirmed', note: 'matches sources' }] }); // judge
    mockGenerateContent.mockResolvedValue('Sources confirm the stated value.');

    const result = await runReportFactCheck({ reportText: LONG_REPORT });

    expect(result.check.name).toBe(FACT_CHECK_NAME);
    expect(result.check.pass).toBe(true);
    expect(result.check.critical).toBe(false); // always soft
    expect(result.confirmed).toBe(1);
    expect(result.contradicted).toBe(0);
    expect(result.failedOpen).toBe(false);
  });

  it('fails (REVISE-eligible) with an actionable correction when a claim is contradicted', async () => {
    mockGenerateStructuredContent.mockResolvedValueOnce({ claims: [claim()] }).mockResolvedValueOnce({
      verdicts: [
        {
          index: 0,
          status: 'contradicted',
          groundedValue: '8 physical topological qubits',
          note: 'Microsoft roadmap states 8 physical qubits, not 32 logical.',
        },
      ],
    });
    mockGenerateContent.mockResolvedValue('Majorana-1 has 8 physical topological qubits per Microsoft.');

    const result = await runReportFactCheck({ reportText: LONG_REPORT });

    expect(result.check.pass).toBe(false);
    expect(result.check.critical).toBe(false); // soft → REVISE, never FAIL
    expect(result.contradicted).toBe(1);
    // Detail must carry the correction so the revise loop can act on it.
    expect(result.check.detail).toMatch(/CONTRADICTED/i);
    expect(result.check.detail).toContain('8 physical topological qubits');
    expect(result.check.detail).toContain('Majorana-1');
  });

  it('keeps the correction actionable when a contradicted verdict omits groundedValue', async () => {
    // The schema allows groundedValue to be absent. The feedback must still name
    // the asserted value to replace and surface the (required) note, so the
    // revise loop is never told "this is wrong" with no way to fix it.
    mockGenerateStructuredContent.mockResolvedValueOnce({ claims: [claim()] }).mockResolvedValueOnce({
      verdicts: [{ index: 0, status: 'contradicted', note: 'Microsoft states a different, smaller count.' }],
    });
    mockGenerateContent.mockResolvedValue('Majorana-1 figures differ from the claim.');

    const result = await runReportFactCheck({ reportText: LONG_REPORT });

    expect(result.check.pass).toBe(false);
    expect(result.contradicted).toBe(1);
    expect(result.check.detail).toContain('32 logical qubits'); // asserted value to replace
    expect(result.check.detail).toContain('different, smaller count'); // note carries the correction
  });

  it('does NOT fail on unverifiable claims (no false positives)', async () => {
    mockGenerateStructuredContent.mockResolvedValueOnce({ claims: [claim()] }).mockResolvedValueOnce({
      verdicts: [{ index: 0, status: 'unverifiable', note: 'no specific value in sources' }],
    });
    mockGenerateContent.mockResolvedValue('Sources discuss the topic but give no specific count.');

    const result = await runReportFactCheck({ reportText: LONG_REPORT });

    expect(result.check.pass).toBe(true);
    expect(result.unverifiable).toBe(1);
    expect(result.check.detail).toMatch(/unverifiable/i);
  });

  it('treats a missing verdict as unverifiable — never a pass and never a contradiction', async () => {
    mockGenerateStructuredContent
      .mockResolvedValueOnce({
        claims: [
          claim(),
          claim({ text: 'IBM Condor reaches 1,121 qubits', subject: 'IBM Condor', value: '1,121 qubits' }),
        ],
      })
      .mockResolvedValueOnce({ verdicts: [{ index: 0, status: 'confirmed', note: 'ok' }] }); // index 1 dropped
    mockGenerateContent.mockResolvedValue('grounded text');

    const result = await runReportFactCheck({ reportText: LONG_REPORT });

    expect(result.check.pass).toBe(true); // dropped verdict → unverifiable, not contradiction
    expect(result.confirmed).toBe(1);
    expect(result.unverifiable).toBe(1);
  });

  it('fails open (PASS) when claim extraction throws', async () => {
    mockGenerateStructuredContent.mockRejectedValueOnce(new Error('gemini down'));

    const result = await runReportFactCheck({ reportText: LONG_REPORT });

    expect(result.check.pass).toBe(true);
    expect(result.failedOpen).toBe(true);
    expect(result.check.detail).toMatch(/not run/i);
    expect(mockGenerateContent).not.toHaveBeenCalled(); // never reached grounding
  });

  it('fails open (PASS) when no checkable claims are found', async () => {
    mockGenerateStructuredContent.mockResolvedValueOnce({ claims: [] });

    const result = await runReportFactCheck({ reportText: LONG_REPORT });

    expect(result.check.pass).toBe(true);
    expect(result.failedOpen).toBe(true);
    expect(result.claimsChecked).toBe(0);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('fails open (PASS) when every grounding search returns empty (outage)', async () => {
    mockGenerateStructuredContent.mockResolvedValueOnce({ claims: [claim()] });
    mockGenerateContent.mockRejectedValue(new Error('grounding 503')); // per-claim catch → ''

    const result = await runReportFactCheck({ reportText: LONG_REPORT });

    expect(result.check.pass).toBe(true);
    expect(result.failedOpen).toBe(true);
    // Judge must never run when there is nothing grounded to judge.
    expect(mockGenerateStructuredContent).toHaveBeenCalledTimes(1);
  });

  it('preserves grounded evidence (all unverifiable, NOT fail-open) when the judge API throws', async () => {
    // A genuine judge infrastructure throw must NOT erase the grounded evidence.
    // Every grounded claim degrades to `unverifiable` — worst case per claim,
    // never a total discard that retains only the cost.
    mockGenerateStructuredContent
      .mockResolvedValueOnce({ claims: [claim(), claim({ subject: 'IBM Condor' })] })
      .mockRejectedValueOnce(new Error('judge down'));
    mockGenerateContent.mockResolvedValue('grounded text');

    const result = await runReportFactCheck({ reportText: LONG_REPORT });

    expect(result.failedOpen).toBe(false);
    expect(result.claimsChecked).toBe(2);
    expect(result.unverifiable).toBe(2);
    expect(result.contradicted).toBe(0);
    expect(result.check.pass).toBe(true);
    // Extraction + grounding spend is retained even though the judge threw.
    expect(result.costUsd).toBeCloseTo(0.002 + 0.001 * 2, 6);
  });

  it('skips entirely (fail-open) for a report below the size floor', async () => {
    const result = await runReportFactCheck({ reportText: 'tiny' });

    expect(result.check.pass).toBe(true);
    expect(result.failedOpen).toBe(true);
    expect(mockGenerateStructuredContent).not.toHaveBeenCalled();
  });

  it('honours the claim cap (never grounds more than maxClaims)', async () => {
    const many = Array.from({ length: 20 }, (_, i) => claim({ subject: `Entity ${i}` }));
    mockGenerateStructuredContent.mockResolvedValueOnce({ claims: many }).mockResolvedValueOnce({
      verdicts: many.slice(0, 3).map((_, i) => ({ index: i, status: 'confirmed', note: 'ok' })),
    });
    mockGenerateContent.mockResolvedValue('grounded');

    await runReportFactCheck({ reportText: LONG_REPORT, maxClaims: 3 });

    expect(mockGenerateContent).toHaveBeenCalledTimes(3); // capped grounding calls
  });
});

// ---------------------------------------------------------------------------
// MISSION-008 — deterministic exclusion of internal-shape claims
// ---------------------------------------------------------------------------

describe('runReportFactCheck — internal-reference exclusion (MISSION-008)', () => {
  const EXTERNAL = claim(); // Microsoft Majorana-1 / 32 logical qubits — externally checkable
  const INTERNAL_CLAIMS: Array<{ label: string; c: ExtractedClaim }> = [
    {
      label: 'firestore-id',
      c: claim({
        text: 'Signal aB3xK9mNp2qR7sT4uV6w was archived',
        subject: 'Signal record',
        value: 'aB3xK9mNp2qR7sT4uV6w',
        verificationQuestion: 'what is the status of record aB3xK9mNp2qR7sT4uV6w',
      }),
    },
    {
      label: 'mission-id',
      c: claim({
        text: 'Mission mission-a1b2c3 completed successfully',
        subject: 'mission-a1b2c3',
        value: 'completed',
        verificationQuestion: 'did mission mission-a1b2c3 complete',
      }),
    },
    {
      label: 'local-404',
      c: claim({
        text: 'The entity endpoint returned a local 404',
        subject: 'entity endpoint',
        value: '404',
        verificationQuestion: 'why did the entity endpoint return a local 404',
      }),
    },
    {
      label: 'audit-timestamp',
      c: claim({
        text: 'The record createdAt was 2026-07-14T02:31:00Z',
        subject: 'the record',
        value: '2026-07-14T02:31:00Z',
        verificationQuestion: 'when was createdAt set to 2026-07-14T02:31:00Z',
      }),
    },
    {
      label: 'telemetry',
      c: claim({
        text: 'The run consumed 400000 tokens',
        subject: 'the run',
        value: '400000 tokens',
        verificationQuestion: 'how many tokens did the run consume',
      }),
    },
    {
      label: 'model-codename',
      c: claim({
        text: 'The research model used was MUZZLE',
        subject: 'research model',
        value: 'MUZZLE',
        verificationQuestion: 'what research model was used',
      }),
    },
  ];

  it('never sends internal-shape claims to public grounding, only externally-checkable ones', async () => {
    mockGenerateStructuredContent
      .mockResolvedValueOnce({ claims: [EXTERNAL, ...INTERNAL_CLAIMS.map((x) => x.c)] })
      .mockResolvedValueOnce({ verdicts: [{ index: 0, status: 'confirmed', note: 'matches' }] });
    mockGenerateContent.mockResolvedValue('Sources confirm the value.');

    const result = await runReportFactCheck({ reportText: LONG_REPORT });

    // Grounding is called EXACTLY once — for the one external claim.
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    const groundedQuestions = mockGenerateContent.mock.calls.map((call) => call[0]);
    expect(groundedQuestions).toEqual([EXTERNAL.verificationQuestion]);
    // No internal-shape verificationQuestion ever reached grounding.
    for (const { c } of INTERNAL_CLAIMS) {
      expect(groundedQuestions).not.toContain(c.verificationQuestion);
    }
    expect(result.excluded).toBe(INTERNAL_CLAIMS.length);
    expect(result.claimsChecked).toBe(1);
    expect(result.check.pass).toBe(true);
  });

  it('preserves a benign product fact that merely contains digits (not telemetry)', async () => {
    const productFact = claim({
      text: 'GPT-5 has a context window of 400000 tokens',
      subject: 'GPT-5',
      value: '400000 tokens',
      verificationQuestion: 'what is the context window of GPT-5',
    });
    mockGenerateStructuredContent
      .mockResolvedValueOnce({ claims: [productFact] })
      .mockResolvedValueOnce({ verdicts: [{ index: 0, status: 'confirmed', note: 'matches' }] });
    mockGenerateContent.mockResolvedValue('Sources confirm 400k tokens.');

    const result = await runReportFactCheck({ reportText: LONG_REPORT });

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(mockGenerateContent.mock.calls[0][0]).toBe(productFact.verificationQuestion);
    expect(result.excluded).toBe(0);
    expect(result.claimsChecked).toBe(1);
  });

  // MISSION-008 review-fix (Finding 3): the http-status and run-provenance
  // markers were tightened so external business facts that merely contain a
  // 4xx/5xx-looking number or the phrase "model used by" are NOT dropped.
  it('keeps external business facts that superficially resemble internal telemetry', () => {
    const preserved: Array<{ label: string; c: ExtractedClaim }> = [
      {
        label: 'market-metric-500',
        c: claim({
          text: 'OpenAI reported 500 million weekly active users in 2025',
          subject: 'OpenAI',
          value: '500 million weekly active users',
          verificationQuestion: 'how many weekly active users did OpenAI report in 2025',
        }),
      },
      {
        label: 'returns-450-pct',
        c: claim({
          text: 'The fund returned a 450% gain over the period',
          subject: 'the fund',
          value: '450% gain',
          verificationQuestion: 'what gain did the fund return over the period',
        }),
      },
      {
        label: 'external-model-attribution',
        c: claim({
          text: 'The model used by OpenAI for ChatGPT is GPT-4o',
          subject: 'ChatGPT',
          value: 'GPT-4o',
          verificationQuestion: 'what model does OpenAI use for ChatGPT',
        }),
      },
    ];

    const { checkable, excluded } = partitionExternallyCheckable(preserved.map((x) => x.c));

    expect(excluded).toHaveLength(0);
    expect(checkable).toHaveLength(preserved.length);
  });

  it('still drops genuine internal HTTP/error and run-provenance references', () => {
    const internal = [
      claim({
        text: 'The entity endpoint returned a 500 error',
        subject: 'entity endpoint',
        value: '500',
        verificationQuestion: 'why did the entity endpoint return a 500 error',
      }),
      claim({
        text: 'The research model used was MUZZLE',
        subject: 'research model',
        value: 'MUZZLE',
        verificationQuestion: 'what research model was used',
      }),
    ];

    const { checkable, excluded } = partitionExternallyCheckable(internal);

    expect(checkable).toHaveLength(0);
    expect(excluded.map((e) => e.reason)).toEqual(expect.arrayContaining(['http-status', 'run-provenance']));
  });

  it('fails open (never grounds) when every extracted claim is an internal reference', async () => {
    mockGenerateStructuredContent.mockResolvedValueOnce({ claims: INTERNAL_CLAIMS.map((x) => x.c) });

    const result = await runReportFactCheck({ reportText: LONG_REPORT });

    expect(mockGenerateContent).not.toHaveBeenCalled();
    expect(result.failedOpen).toBe(true);
    expect(result.check.pass).toBe(true);
    expect(result.excluded).toBe(INTERNAL_CLAIMS.length);
  });
});

// ---------------------------------------------------------------------------
// MISSION-008 — partial-evidence survival (malformed / truncated judge)
// ---------------------------------------------------------------------------

describe('runReportFactCheck — partial judge results survive (MISSION-008)', () => {
  const THREE = [claim(), claim({ subject: 'IBM Condor' }), claim({ subject: 'Google Willow' })];

  it('salvages valid verdicts and degrades malformed items to unverifiable — NOT fail-open', async () => {
    mockGenerateStructuredContent.mockResolvedValueOnce({ claims: THREE }).mockResolvedValueOnce({
      verdicts: [
        { index: 0, status: 'confirmed', note: 'ok' },
        { index: 1, status: 'NOT_A_STATUS' }, // malformed — dropped by salvage
        { totally: 'garbage' }, // malformed — dropped by salvage
      ],
    });
    mockGenerateContent.mockResolvedValue('grounded');

    const result = await runReportFactCheck({ reportText: LONG_REPORT });

    expect(result.failedOpen).toBe(false);
    expect(result.claimsChecked).toBe(3);
    expect(result.confirmed).toBe(1);
    expect(result.unverifiable).toBe(2); // the two malformed → no verdict → unverifiable
    expect(result.contradicted).toBe(0);
    // Judge spend is folded even though only one verdict survived.
    expect(result.costUsd).toBeCloseTo(0.002 + 0.001 * 3 + 0.002, 6);
  });

  it('surfaces a contradiction hidden in a truncated/garbage judge payload', async () => {
    mockGenerateStructuredContent.mockResolvedValueOnce({ claims: THREE }).mockResolvedValueOnce({
      verdicts: [
        { index: 1, status: 'contradicted', groundedValue: '8 physical qubits', note: 'sources say 8' },
        { broken: true }, // truncation garbage — dropped, must not erase the contradiction
      ],
    });
    mockGenerateContent.mockResolvedValue('grounded');

    const result = await runReportFactCheck({ reportText: LONG_REPORT });

    expect(result.failedOpen).toBe(false);
    expect(result.contradicted).toBe(1);
    expect(result.check.pass).toBe(false); // contradiction survives truncation
    expect(result.check.detail).toMatch(/8 physical qubits/);
  });

  it('does NOT fail open when one search fails but others succeed', async () => {
    mockGenerateStructuredContent
      .mockResolvedValueOnce({ claims: [claim(), claim({ subject: 'IBM Condor' })] })
      .mockResolvedValueOnce({
        verdicts: [
          { index: 0, status: 'unverifiable', note: 'no result' },
          { index: 1, status: 'confirmed', note: 'ok' },
        ],
      });
    // First grounding call rejects, the second succeeds.
    mockGenerateContent.mockRejectedValueOnce(new Error('one search 503')).mockResolvedValueOnce('grounded evidence');

    const result = await runReportFactCheck({ reportText: LONG_REPORT });

    expect(result.failedOpen).toBe(false);
    expect(result.claimsChecked).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// MISSION-008 — bounded grounding (per-claim timeout, total budget, concurrency)
// ---------------------------------------------------------------------------

describe('runReportFactCheck — bounded grounding (MISSION-008)', () => {
  it('a hung search degrades to unverifiable via the per-claim timeout; the run stays bounded', async () => {
    const hanging = claim({
      subject: 'Slow Entity',
      verificationQuestion: 'HANG: how slow is Slow Entity',
    });
    const fast = claim({ subject: 'IBM Condor', verificationQuestion: 'how many qubits does IBM Condor have' });
    mockGenerateStructuredContent.mockResolvedValueOnce({ claims: [hanging, fast] }).mockResolvedValueOnce({
      verdicts: [{ index: 1, status: 'confirmed', note: 'ok' }],
    });
    mockGenerateContent.mockImplementation((q: string) =>
      q.includes('HANG') ? new Promise(() => {}) : Promise.resolve('grounded')
    );

    const result = await runReportFactCheck({ reportText: LONG_REPORT, groundingTimeoutMs: 20 });

    // Resolves despite the hung call; the fast claim still verifies.
    expect(result.failedOpen).toBe(false);
    expect(result.claimsChecked).toBe(2);
    expect(result.unverifiable).toBe(1); // the hung claim
    expect(result.confirmed).toBe(1);
  });

  it('short-circuits to a bounded fail-open when the total grounding budget is already spent', async () => {
    mockGenerateStructuredContent.mockResolvedValueOnce({ claims: [claim(), claim({ subject: 'IBM Condor' })] });
    mockGenerateContent.mockResolvedValue('grounded');

    const result = await runReportFactCheck({ reportText: LONG_REPORT, totalTimeoutMs: 0 });

    // Deadline already passed → no grounding calls, bounded fail-open.
    expect(mockGenerateContent).not.toHaveBeenCalled();
    expect(result.failedOpen).toBe(true);
  });

  it('never exceeds the grounding concurrency ceiling', async () => {
    const six = Array.from({ length: 6 }, (_, i) => claim({ subject: `Entity ${i}` }));
    mockGenerateStructuredContent.mockResolvedValueOnce({ claims: six }).mockResolvedValueOnce({
      verdicts: six.map((_, i) => ({ index: i, status: 'confirmed', note: 'ok' })),
    });
    let inFlight = 0;
    let maxInFlight = 0;
    mockGenerateContent.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return 'grounded';
    });

    await runReportFactCheck({ reportText: LONG_REPORT });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(mockGenerateContent).toHaveBeenCalledTimes(6);
  });
});
