import { evaluateMissionQuality, isRevisionRegression } from '../mission-quality';

describe('isRevisionRegression (MISSION-002)', () => {
  // The gate compares on VERDICT RANK (FAIL < REVISE < PASS), never on
  // overallScore — the score is a pass-ratio over a content-gated (variable
  // length) check set, so it is not comparable across drafts of different
  // completeness. These cases pin that rank-only contract.
  const rep = (verdict: 'PASS' | 'REVISE' | 'FAIL') => ({ verdict });

  it('flags a drop in verdict rank (REVISE→FAIL) as a regression', () => {
    expect(isRevisionRegression(rep('REVISE'), rep('FAIL'))).toBe(true);
  });

  it('flags a drop in verdict rank (PASS→REVISE) as a regression', () => {
    expect(isRevisionRegression(rep('PASS'), rep('REVISE'))).toBe(true);
  });

  it('flags the two-step drop PASS→FAIL as a regression', () => {
    expect(isRevisionRegression(rep('PASS'), rep('FAIL'))).toBe(true);
  });

  it('does NOT flag an equal verdict (a tie promotes the fresher revision)', () => {
    expect(isRevisionRegression(rep('REVISE'), rep('REVISE'))).toBe(false);
  });

  it('does NOT flag an improvement in verdict rank (REVISE→PASS)', () => {
    expect(isRevisionRegression(rep('REVISE'), rep('PASS'))).toBe(false);
  });

  it('does NOT flag an improvement out of FAIL (FAIL→REVISE)', () => {
    expect(isRevisionRegression(rep('FAIL'), rep('REVISE'))).toBe(false);
  });

  it('does NOT re-flag FAIL→FAIL (no NEW regression)', () => {
    expect(isRevisionRegression(rep('FAIL'), rep('FAIL'))).toBe(false);
  });

  it('ignores overallScore entirely — a worse ratio at the SAME verdict is not a regression', () => {
    // The Finding-A bug: a more-complete revision surfaces additional stricter
    // checks, enlarging the denominator and depressing the pass-ratio even
    // though the verdict is unchanged. A score-based gate wrongly rejected it;
    // the rank-based gate promotes it. Extra score fields are accepted and
    // must not change the outcome.
    const original = { verdict: 'REVISE' as const, overallScore: 0.857 };
    const revised = { verdict: 'REVISE' as const, overallScore: 0.7 };
    expect(isRevisionRegression(original, revised)).toBe(false);
  });
});

describe('evaluateMissionQuality', () => {
  describe('result-exists critical check', () => {
    it('FAILs when result is empty', () => {
      const report = evaluateMissionQuality({ prompt: 'Do the thing', result: '' });
      expect(report.verdict).toBe('FAIL');
      const resultCheck = report.checks.find((c) => c.name === 'result-exists')!;
      expect(resultCheck.pass).toBe(false);
      expect(resultCheck.critical).toBe(true);
    });

    it('FAILs when result is under 100 chars', () => {
      const report = evaluateMissionQuality({ prompt: 'Do the thing', result: 'short' });
      expect(report.verdict).toBe('FAIL');
    });

    it('PASSes the result-exists check when result ≥100 chars', () => {
      const report = evaluateMissionQuality({
        prompt: 'Hi',
        result: 'x'.repeat(150),
      });
      const resultCheck = report.checks.find((c) => c.name === 'result-exists')!;
      expect(resultCheck.pass).toBe(true);
    });

    it('FAILs long success-like prose when structured terminal state says execution failed', () => {
      const report = evaluateMissionQuality({
        prompt: 'Create a report',
        result: `Mission completed successfully. ${'x'.repeat(200)}`,
        terminalState: {
          executionSucceeded: false,
          deliverable: { required: true, resolution: 'missing', ownerVisibleArtifactIds: [] },
        },
      });

      const resultCheck = report.checks.find((c) => c.name === 'result-exists')!;
      expect(resultCheck.pass).toBe(false);
      expect(resultCheck.detail).toContain('execution failed');
      expect(report.verdict).toBe('FAIL');
    });

    it('FAILs a promised report when no owner-visible artifact was resolved', () => {
      const report = evaluateMissionQuality({
        prompt: 'Create a report',
        result: 'x'.repeat(200),
        terminalState: {
          executionSucceeded: true,
          // A foreign or ownerless report must never enter this owner-bound set.
          deliverable: { required: true, resolution: 'owner-visible', ownerVisibleArtifactIds: [] },
        },
      });

      const resultCheck = report.checks.find((c) => c.name === 'result-exists')!;
      expect(resultCheck.pass).toBe(false);
      expect(resultCheck.detail).toContain('0 owner-visible artifact ids');
      expect(report.verdict).toBe('FAIL');
    });

    it('FAILs successful execution with only local-path prose and a missing canonical report', () => {
      const report = evaluateMissionQuality({
        prompt: 'Create a report',
        result:
          'The report was generated at /tmp/mission-output/report.html and is ready for review. ' + 'x'.repeat(180),
        skillInvocations: [{ skill: 'report-generation' }],
        terminalState: {
          executionSucceeded: true,
          deliverable: { required: true, resolution: 'missing', ownerVisibleArtifactIds: [] },
        },
      });

      const resultCheck = report.checks.find((c) => c.name === 'result-exists')!;
      const partialCheck = report.checks.find((c) => c.name === 'not-partial')!;
      expect(resultCheck.pass).toBe(false);
      expect(resultCheck.detail).toContain('required deliverable is missing');
      // Terminal truth is penalized once, by the critical result-exists check.
      // not-partial reports only whether checkpoint recovery was used.
      expect(partialCheck.pass).toBe(true);
      expect(partialCheck.detail).not.toContain('completed cleanly');
      expect(report.verdict).toBe('FAIL');
      expect(report.overallScore).toBe(5 / 6);
    });

    it('FAILs closed when canonical deliverable lookup failed', () => {
      const report = evaluateMissionQuality({
        prompt: 'Create a report',
        result: 'x'.repeat(200),
        terminalState: {
          executionSucceeded: true,
          deliverable: { required: true, resolution: 'lookup-failed', ownerVisibleArtifactIds: [] },
        },
      });

      const resultCheck = report.checks.find((c) => c.name === 'result-exists')!;
      expect(resultCheck.pass).toBe(false);
      expect(resultCheck.detail).toContain('lookup-failed');
    });

    it('PASSes a promised report only with a persisted owner-visible artifact identity', () => {
      const report = evaluateMissionQuality({
        prompt: 'Create a report',
        result: 'x'.repeat(200),
        terminalState: {
          executionSucceeded: true,
          deliverable: {
            required: true,
            resolution: 'owner-visible',
            ownerVisibleArtifactIds: ['report-owned-1'],
          },
        },
      });

      const resultCheck = report.checks.find((c) => c.name === 'result-exists')!;
      expect(resultCheck.pass).toBe(true);
      expect(resultCheck.detail).toContain('1 owner-visible deliverable');
    });

    it('rejects blank owner-visible artifact identities', () => {
      const report = evaluateMissionQuality({
        prompt: 'Create a report',
        result: 'x'.repeat(200),
        terminalState: {
          executionSucceeded: true,
          deliverable: { required: true, resolution: 'owner-visible', ownerVisibleArtifactIds: ['  '] },
        },
      });

      const resultCheck = report.checks.find((c) => c.name === 'result-exists')!;
      expect(resultCheck.pass).toBe(false);
      expect(resultCheck.detail).toContain('0 owner-visible artifact ids');
    });

    it('keeps successful exploratory work valid when no report was required', () => {
      const report = evaluateMissionQuality({
        prompt: 'Summarize the graph',
        result: 'x'.repeat(200),
        agent: 'strategist',
        terminalState: {
          executionSucceeded: true,
          deliverable: { required: false, resolution: 'not-required' },
        },
      });

      const resultCheck = report.checks.find((c) => c.name === 'result-exists')!;
      expect(resultCheck.pass).toBe(true);
      expect(resultCheck.detail).toContain('no deliverable was required');
    });

    it('does not require an owner-visible report from a successful unslotted exploratory Linker mission', () => {
      const report = evaluateMissionQuality({
        prompt: 'Find relationships between these entities',
        result: `Source A -> RELATES_TO -> Target B. Confidence: 90. ${'x'.repeat(160)}`,
        agent: 'linker',
        terminalState: {
          executionSucceeded: true,
          deliverable: { required: false, resolution: 'not-required' },
        },
      });

      const resultCheck = report.checks.find((c) => c.name === 'result-exists')!;
      expect(resultCheck.pass).toBe(true);
    });

    it('FAILs a classified Linker mission when its promised report is missing', () => {
      const report = evaluateMissionQuality({
        prompt: 'Find relationships and publish the requested report',
        result: `Source A -> RELATES_TO -> Target B. ${'x'.repeat(180)}`,
        agent: 'linker',
        terminalState: {
          executionSucceeded: true,
          deliverable: { required: true, resolution: 'missing', ownerVisibleArtifactIds: [] },
        },
      });

      const resultCheck = report.checks.find((c) => c.name === 'result-exists')!;
      expect(resultCheck.pass).toBe(false);
      expect(report.verdict).toBe('FAIL');
    });
  });

  describe('has-expected-sections (IMRAD)', () => {
    it('PASSes when all 5 IMRAD sections are present', () => {
      const result = `
## Introduction
Some intro.
## Methods
We did X.
## Results
Found Y.
## Discussion
Means Z.
## References
[1] Thing.
`;
      const report = evaluateMissionQuality({
        prompt: 'Produce an IMRAD whitepaper on X.',
        result,
      });
      const check = report.checks.find((c) => c.name === 'has-expected-sections')!;
      expect(check.pass).toBe(true);
    });

    it('REVISEs when only 3 of 5 IMRAD sections present', () => {
      const result = `
## Introduction
Hi.
## Methods
Did stuff.
## Results
Found it.
`;
      const report = evaluateMissionQuality({
        prompt: 'Produce an IMRAD whitepaper on X.',
        result: result + 'x'.repeat(200),
      });
      const check = report.checks.find((c) => c.name === 'has-expected-sections')!;
      expect(check.pass).toBe(false);
      expect(check.critical).toBe(false);
      expect(report.verdict).toBe('REVISE');
    });
  });

  describe('has-expected-sections (SBAR)', () => {
    it('PASSes when all 4 SBAR sections are present', () => {
      const result = `
## Situation
Now.
## Background
Before.
## Assessment
So what.
## Recommendation
Do X. Confidence: 0.85.
`;
      const report = evaluateMissionQuality({
        prompt: 'Give me an SBAR brief for the board.',
        result: result + 'x'.repeat(200),
      });
      const check = report.checks.find((c) => c.name === 'has-expected-sections')!;
      expect(check.pass).toBe(true);
    });

    it('skips the section check when no format mentioned', () => {
      const report = evaluateMissionQuality({
        prompt: 'What is the latest news?',
        result: 'x'.repeat(200),
      });
      const check = report.checks.find((c) => c.name === 'has-expected-sections')!;
      expect(check.pass).toBe(true);
      expect(check.detail).toMatch(/no structured format/i);
    });
  });

  describe('citations-present', () => {
    it('PASSes when ≥3 IEEE citation markers are present and prompt expects them', () => {
      const report = evaluateMissionQuality({
        prompt: 'Produce a report with IEEE citations.',
        result: 'Paragraph with [1], [2], and [3] markers. ' + 'x'.repeat(200),
      });
      const check = report.checks.find((c) => c.name === 'citations-present')!;
      expect(check.pass).toBe(true);
    });

    it('REVISEs when prompt expects citations but result has none', () => {
      const report = evaluateMissionQuality({
        prompt: 'Produce a report with IEEE citations.',
        result: 'No citations at all. ' + 'x'.repeat(200),
      });
      const check = report.checks.find((c) => c.name === 'citations-present')!;
      expect(check.pass).toBe(false);
      expect(report.verdict).toBe('REVISE');
    });

    it('skips the citation check when prompt does not request them', () => {
      const report = evaluateMissionQuality({
        prompt: 'What is Anthropic?',
        result: 'x'.repeat(200),
      });
      const check = report.checks.find((c) => c.name === 'citations-present')!;
      expect(check.pass).toBe(true);
      expect(check.detail).toMatch(/not requested/i);
    });

    it('counts DOI + arXiv markers in addition to IEEE brackets', () => {
      const report = evaluateMissionQuality({
        prompt: 'Produce a report with references (DOI / arxiv accepted).',
        result: 'See doi: 10.1234/abcd and arxiv:2309.11495 and 10.5555/wxyz for details. ' + 'x'.repeat(200),
      });
      const check = report.checks.find((c) => c.name === 'citations-present')!;
      expect(check.pass).toBe(true);
    });
  });

  describe('confidence-scores', () => {
    it('PASSes when confidence marker present and expected', () => {
      const report = evaluateMissionQuality({
        prompt: 'Emit with calibrated confidence.',
        result: 'Verdict: Y. Confidence: 0.85. ' + 'x'.repeat(200),
      });
      const check = report.checks.find((c) => c.name === 'confidence-scores')!;
      expect(check.pass).toBe(true);
    });

    it('REVISEs when prompt expects confidence but none present', () => {
      const report = evaluateMissionQuality({
        prompt: 'Emit with calibrated confidence.',
        result: 'Answer without any score. ' + 'x'.repeat(200),
      });
      const check = report.checks.find((c) => c.name === 'confidence-scores')!;
      expect(check.pass).toBe(false);
    });
  });

  describe('skill-adherence', () => {
    it('PASSes when ≥1 skill invocation on a non-trivial prompt', () => {
      const report = evaluateMissionQuality({
        prompt: 'Produce a full strategic analysis of X with recommendations.',
        result: 'x'.repeat(200),
        skillInvocations: [{ skill: 'analysis-of-competing-hypotheses' }],
      });
      const check = report.checks.find((c) => c.name === 'skill-adherence')!;
      expect(check.pass).toBe(true);
    });

    it('PASSes when ≥2 skill-procedure markers detected without formal invocation', () => {
      // Output uses Admiralty grading (A1, B2) AND ACH scoring (H1 Consistent)
      // — both strong procedure markers — but no Skill() was called.
      const result =
        'Source X graded A1 source reliability admiralty. Source Y graded B2 reliability. ' +
        'H1 Consistent hypothesis — supported by evidence. Confidence: 0.75. ' +
        'x'.repeat(200);
      const report = evaluateMissionQuality({
        prompt: 'Produce a full strategic analysis of X with recommendations.',
        result,
        skillInvocations: [],
      });
      const check = report.checks.find((c) => c.name === 'skill-adherence')!;
      expect(check.pass).toBe(true);
      expect(check.detail).toMatch(/procedure marker/);
    });

    it('REVISEs when only 1 procedure marker and no formal invocation', () => {
      const result = 'Source X graded A1 source reliability admiralty. ' + 'x'.repeat(200);
      const report = evaluateMissionQuality({
        prompt: 'Produce a full strategic analysis of X with recommendations.',
        result,
        skillInvocations: [],
      });
      const check = report.checks.find((c) => c.name === 'skill-adherence')!;
      expect(check.pass).toBe(false);
      expect(check.detail).toMatch(/only 1 procedure marker/);
    });

    it('REVISEs when non-trivial prompt has no skill invocations and no markers', () => {
      const report = evaluateMissionQuality({
        prompt: 'Produce a full strategic analysis of X with recommendations.',
        result: 'x'.repeat(200),
        skillInvocations: [],
      });
      const check = report.checks.find((c) => c.name === 'skill-adherence')!;
      expect(check.pass).toBe(false);
    });

    it('skips the check for trivial prompts', () => {
      const report = evaluateMissionQuality({
        prompt: 'Hi there',
        result: 'x'.repeat(200),
        skillInvocations: [],
      });
      const check = report.checks.find((c) => c.name === 'skill-adherence')!;
      expect(check.pass).toBe(true);
      expect(check.detail).toMatch(/trivial/i);
    });

    it('detects foresight skill via "Weak signals to watch NOW" + "Kill signals ... retract" markers', () => {
      // A realistic foresight output also cites sources with Admiralty grades.
      // Combined with the foresight block, two distinct skills should be
      // detected and the adherence check should pass.
      const result =
        'Prediction: Open-weight 70B-class models run on sub-$5k hardware by Q4 2026 (confidence: 0.7).\n\n' +
        'Accelerants:\n- NVIDIA ships sub-$2000 48GB SKU (lead time: 6m)\n\n' +
        'Blockers:\n- VRAM supply constraint (lead time: 3m)\n\n' +
        'Weak signals to watch NOW:\n- MMLU > 75% on open 8B — observed at papers with code\n\n' +
        'Kill signals (if observed, retract):\n- NVIDIA removes consumer 48GB tier through 2027.\n\n' +
        'Review: 2026-09-01 — check the next Llama release cadence.\n\n' +
        'Primary source graded A1 source reliability admiralty.';
      const report = evaluateMissionQuality({
        prompt:
          'Produce a strategic analysis forecasting when open-weight models will reach consumer hardware, with the drivers and kill signals to watch.',
        result,
        skillInvocations: [],
      });
      const check = report.checks.find((c) => c.name === 'skill-adherence')!;
      expect(check.pass).toBe(true);
      expect(check.detail).toMatch(/foresight/);
    });

    it('detects jtbd-framing skill via verb-led Job: line + Struggling moment markers', () => {
      // JTBD output uses a verb-led Job: statement (Ulwick outcome-driven format)
      // plus a Struggling moment block. Combined with an Admiralty grade marker,
      // two distinct skills should be detected and adherence should pass.
      const result =
        'Technology: Workday Skills Cloud\n\n' +
        'Job: minimize the time it takes to identify high-fit internal candidates for an open requisition.\n' +
        'Context: Fortune 1000 enterprises with siloed talent pools.\n\n' +
        'Competing solutions:\n' +
        '- Static job-description matching tools\n' +
        '- External recruiting agencies\n' +
        '- Non-consumption (leaving reqs open)\n\n' +
        'Struggling moment: "We have 8,000 engineers but a hiring manager can only search the 200 they have worked with."\n\n' +
        'Primary source graded A1 source reliability admiralty.';
      const report = evaluateMissionQuality({
        prompt:
          'Produce a strategic analysis comparing HR-tech vendors with a focus on the jobs each technology gets hired for.',
        result,
        skillInvocations: [],
      });
      const check = report.checks.find((c) => c.name === 'skill-adherence')!;
      expect(check.pass).toBe(true);
      expect(check.detail).toMatch(/jtbd-framing/);
    });

    it('detects claim-provenance skill via [validated, source] + [assumption, retire-by] bracketed tags', () => {
      // Discovery-Driven Planning style claim tagging: every fact-claim
      // labelled [validated, source] (when cited) or [assumption, retire-by milestone]
      // (when an open question). Combined with an Admiralty grade marker,
      // two distinct skills should be detected.
      const result =
        'The AI in HR market reached $6.25B in 2026 [validated, MarketsAndMarkets 2026 [12]; cross-check against IDC by Q3].\n\n' +
        'Skills graphs will become the dominant talent-mobility primitive by Q2 2027 [assumption, retire-by Q4 2026 with Workday Skills Cloud installed-base count].\n\n' +
        'Primary source graded A1 source reliability admiralty.';
      const report = evaluateMissionQuality({
        prompt:
          'Produce a strategic analysis with assumption-vs-validated provenance on every quantitative claim, in the Discovery-Driven Planning tradition.',
        result,
        skillInvocations: [],
      });
      const check = report.checks.find((c) => c.name === 'skill-adherence')!;
      expect(check.pass).toBe(true);
      expect(check.detail).toMatch(/claim-provenance/);
    });

    it('detects cynefin-classification skill via "Decision domain:" + decision-mode language', () => {
      // Snowden's Cynefin: brief opens with a domain classification
      // (Clear/Complicated/Complex/Chaotic) and prescribes the matching
      // decision mode (sense-categorize-respond / sense-analyze-respond /
      // probe-sense-respond / act-sense-respond).
      const result =
        '**Decision domain:** Complex (causation visible only in hindsight)\n\n' +
        'Implication: this brief outlines probes, not best-practice answers. The right mode here is probe-sense-respond, not sense-analyze-respond — treat each recommendation as a hypothesis to falsify.\n\n' +
        'Primary source graded A1 source reliability admiralty.';
      const report = evaluateMissionQuality({
        prompt:
          'Produce a strategic analysis of the agentic-AI-in-HR space and classify the decision domain to set the right decision mode for the reader.',
        result,
        skillInvocations: [],
      });
      const check = report.checks.find((c) => c.name === 'skill-adherence')!;
      expect(check.pass).toBe(true);
      expect(check.detail).toMatch(/cynefin-classification/);
    });

    it('detects evolution-stage skill via "Evolution stage:" + Wardley reference markers', () => {
      // Wardley evolution placement: every technology gets a Genesis /
      // Custom-built / Product / Commodity stage tag with a one-line
      // rationale. Combined with an Admiralty grade, two distinct skills
      // should be detected.
      const result =
        'Evolution stage: Product\n\n' +
        'Workday Skills Cloud sits in the Product stage of the Wardley map — documented integration patterns, on-vendor-roadmap, but evolution is constrained by enterprise-customer specifics.\n\n' +
        'Primary source graded A1 source reliability admiralty.';
      const report = evaluateMissionQuality({
        prompt:
          'Produce a strategic analysis placing each HR-tech vendor on the Wardley evolution axis and explaining the maturity of the category.',
        result,
        skillInvocations: [],
      });
      const check = report.checks.find((c) => c.name === 'skill-adherence')!;
      expect(check.pass).toBe(true);
      expect(check.detail).toMatch(/evolution-stage/);
    });

    it('detects three-horizons skill via "Horizon: H1/H2/H3" + Three Horizons reference markers', () => {
      // McKinsey Three Horizons: every tech tagged H1 (0-12 mo) / H2 (1-3 yr)
      // / H3 (3-5 yr) with a time-to-revenue estimate. Combined with an
      // Admiralty grade, two distinct skills should be detected.
      const result =
        '**Horizon:** H2 (1-3 yr to revenue impact)\n\n' +
        'In the Three Horizons frame, skills-graph adoption sits in H2 — meaningful revenue impact requires organizational change before monetization, but the capability is buildable today.\n\n' +
        'Primary source graded A1 source reliability admiralty.';
      const report = evaluateMissionQuality({
        prompt:
          'Produce a strategic analysis placing each capability on the Three Horizons portfolio framework with a time-to-revenue estimate.',
        result,
        skillInvocations: [],
      });
      const check = report.checks.find((c) => c.name === 'skill-adherence')!;
      expect(check.pass).toBe(true);
      expect(check.detail).toMatch(/three-horizons/);
    });

    it('detects cheapest-experiment skill via "Smallest test:" + "Decision rule: pass if/fail if" markers', () => {
      // Innovation-accounting style recommendation: a recommendation that
      // names the smallest validating test, its cost/duration, and a
      // decision rule with explicit pass/fail thresholds. Combined with an
      // Admiralty grade, two distinct skills should be detected.
      const result =
        'Recommendation: Pilot agentic recruiting on 50 engineering reqs in EMEA.\n\n' +
        'Smallest test: 8-week pilot, agent stops at offer-letter generation (no autonomous offer extension).\n' +
        'Cost: $80k-$120k all-in (vendor pilot fees + 0.5 FTE eng integration).\n' +
        'Decision rule: pass if cost-per-hire down ≥20% AND interviewer satisfaction ≥3.5/5; fail if either misses.\n' +
        'What we would learn: whether agentic narrows the funnel correctly or widens it pathologically.\n\n' +
        'Primary source graded A1 source reliability admiralty.';
      const report = evaluateMissionQuality({
        prompt: 'Produce a strategic analysis with concrete recommendations for piloting agentic recruiting in HR.',
        result,
        skillInvocations: [],
      });
      const check = report.checks.find((c) => c.name === 'skill-adherence')!;
      expect(check.pass).toBe(true);
      expect(check.detail).toMatch(/cheapest-experiment/);
    });
  });

  describe('agent-aware rubric — scout', () => {
    it('scout missions use scout-schema-adherence instead of IMRAD sections', () => {
      const scoutResult =
        'OpenAI Series F funding: stage Series F, amount_usd 3500000000, lead_investors Coatue. ' +
        'Source: Reuters A1. Secondary: Crunchbase B2. Aggregator: TechCrunch C3. ' +
        'x'.repeat(200);
      const report = evaluateMissionQuality({
        prompt: 'Find AI funding rounds this week',
        agent: 'scout',
        result: scoutResult,
      });
      const schemaCheck = report.checks.find((c) => c.name === 'scout-schema-adherence')!;
      expect(schemaCheck).toBeDefined();
      expect(schemaCheck.pass).toBe(true);
      // IMRAD sections check should NOT appear for scout
      expect(report.checks.find((c) => c.name === 'has-expected-sections')).toBeUndefined();
    });

    it('scout REVISEs when admiralty grades are missing', () => {
      const report = evaluateMissionQuality({
        prompt: 'Find AI funding rounds this week',
        agent: 'scout',
        result: 'Some unstructured prose with no grades. ' + 'x'.repeat(200),
      });
      const schemaCheck = report.checks.find((c) => c.name === 'scout-schema-adherence')!;
      expect(schemaCheck.pass).toBe(false);
    });
  });

  describe('agent-aware rubric — evaluator', () => {
    it('evaluator PASSes TRL-mentioning prompt when TRL markers present', () => {
      const result =
        'Claude Agent SDK assessed at TRL 6. LangChain at TRL 8. ' +
        'Evidence: named pilot, reference customer. ReliabilityScore 3. ' +
        'x'.repeat(200);
      const report = evaluateMissionQuality({
        prompt: 'Score both SDKs on TRL and audit their benchmark claims',
        agent: 'evaluator',
        result,
      });
      const check = report.checks.find((c) => c.name === 'evaluator-signals')!;
      expect(check).toBeDefined();
      expect(check.pass).toBe(true);
    });

    it('evaluator REVISEs when TRL requested but no TRL markers in output', () => {
      const report = evaluateMissionQuality({
        prompt: 'Score both SDKs on TRL and audit their benchmark claims',
        agent: 'evaluator',
        result: 'General discussion without TRL levels. ' + 'x'.repeat(200),
      });
      const check = report.checks.find((c) => c.name === 'evaluator-signals')!;
      expect(check.pass).toBe(false);
    });

    it('evaluator skips the check when prompt asks nothing TRL/benchmark-related', () => {
      const report = evaluateMissionQuality({
        prompt: 'Summarize the last 3 signals',
        agent: 'evaluator',
        result: 'x'.repeat(200),
      });
      const check = report.checks.find((c) => c.name === 'evaluator-signals')!;
      expect(check.pass).toBe(true);
      expect(check.detail).toMatch(/no TRL/i);
    });
  });

  describe('agent-aware rubric — linker', () => {
    it('PASSes when output has ≥2 relation-proposal markers', () => {
      const result =
        '{ relationType: "uses", sourceUrl: "https://example.com/src", ' +
        'confidence: 0.85, evidence: "Found in press release" } ' +
        'x'.repeat(200);
      const report = evaluateMissionQuality({
        prompt: 'Propose relations between new signals and existing entities',
        agent: 'linker',
        result,
      });
      const check = report.checks.find((c) => c.name === 'linker-edge-evidence')!;
      expect(check).toBeDefined();
      expect(check.pass).toBe(true);
      // IMRAD check should NOT appear for linker
      expect(report.checks.find((c) => c.name === 'has-expected-sections')).toBeUndefined();
    });

    it('REVISEs when output is prose with no structured markers', () => {
      const report = evaluateMissionQuality({
        prompt: 'Propose relations between new signals and existing entities',
        agent: 'linker',
        result: 'General prose analysis about how X could connect to Y. ' + 'x'.repeat(200),
      });
      const check = report.checks.find((c) => c.name === 'linker-edge-evidence')!;
      expect(check.pass).toBe(false);
      expect(check.detail).toMatch(/at least 2 of/);
    });
  });

  describe('agent-aware rubric — curator', () => {
    it('PASSes when output has ≥2 enrichment markers', () => {
      const result =
        'Curator enrichment: filled the founding_year field from source https://techcrunch.com/... as of 2025-03-14. ' +
        'x'.repeat(200);
      const report = evaluateMissionQuality({
        prompt: 'Enrich the Anthropic entity with missing fields',
        agent: 'curator',
        result,
      });
      const check = report.checks.find((c) => c.name === 'curator-enrichment-signals')!;
      expect(check).toBeDefined();
      expect(check.pass).toBe(true);
    });

    it('REVISEs when curator output is generic commentary', () => {
      const report = evaluateMissionQuality({
        prompt: 'Enrich the Anthropic entity with missing fields',
        agent: 'curator',
        result: 'The entity looks good overall. Nothing specific to report. ' + 'x'.repeat(200),
      });
      const check = report.checks.find((c) => c.name === 'curator-enrichment-signals')!;
      expect(check.pass).toBe(false);
    });
  });

  describe('agent-aware rubric — defense-minister', () => {
    it('PASSes when output has ≥2 verification markers', () => {
      const result =
        'Verification verdict: verified. Sources checked: 4. Confirming: 3. Contradicting: 1. ' + 'x'.repeat(200);
      const report = evaluateMissionQuality({
        prompt: 'Verify the founding_year field on the Anthropic entity',
        agent: 'defense-minister',
        result,
      });
      const check = report.checks.find((c) => c.name === 'verification-signals')!;
      expect(check).toBeDefined();
      expect(check.pass).toBe(true);
    });

    it('REVISEs when verification output omits verdict + source count', () => {
      const report = evaluateMissionQuality({
        prompt: 'Verify the founding_year field on the Anthropic entity',
        agent: 'defense-minister',
        result: 'Looked into it briefly, seems plausible. ' + 'x'.repeat(200),
      });
      const check = report.checks.find((c) => c.name === 'verification-signals')!;
      expect(check.pass).toBe(false);
    });
  });

  describe('rubric dispatcher', () => {
    it('creator + strategist still use IMRAD/SBAR section check', () => {
      const report = evaluateMissionQuality({
        prompt: 'Produce an IMRAD whitepaper on X',
        agent: 'creator',
        result: '## Introduction\n## Methods\n## Results\n## Discussion\n## References\n' + 'x'.repeat(200),
      });
      expect(report.checks.find((c) => c.name === 'has-expected-sections')).toBeDefined();
      expect(report.checks.find((c) => c.name === 'linker-edge-evidence')).toBeUndefined();
      expect(report.checks.find((c) => c.name === 'curator-enrichment-signals')).toBeUndefined();
      expect(report.checks.find((c) => c.name === 'verification-signals')).toBeUndefined();
    });

    it('each agent-specific check only appears for its own agent', () => {
      const linker = evaluateMissionQuality({
        prompt: 'relate',
        agent: 'linker',
        result: 'x'.repeat(200),
      });
      const curator = evaluateMissionQuality({
        prompt: 'enrich',
        agent: 'curator',
        result: 'x'.repeat(200),
      });
      const dm = evaluateMissionQuality({
        prompt: 'verify',
        agent: 'defense-minister',
        result: 'x'.repeat(200),
      });

      expect(linker.checks.find((c) => c.name === 'linker-edge-evidence')).toBeDefined();
      expect(linker.checks.find((c) => c.name === 'curator-enrichment-signals')).toBeUndefined();
      expect(linker.checks.find((c) => c.name === 'verification-signals')).toBeUndefined();

      expect(curator.checks.find((c) => c.name === 'curator-enrichment-signals')).toBeDefined();
      expect(curator.checks.find((c) => c.name === 'linker-edge-evidence')).toBeUndefined();
      expect(curator.checks.find((c) => c.name === 'verification-signals')).toBeUndefined();

      expect(dm.checks.find((c) => c.name === 'verification-signals')).toBeDefined();
      expect(dm.checks.find((c) => c.name === 'linker-edge-evidence')).toBeUndefined();
      expect(dm.checks.find((c) => c.name === 'curator-enrichment-signals')).toBeUndefined();
    });
  });

  describe('not-partial', () => {
    it('flags partial=true missions with a soft failure', () => {
      const report = evaluateMissionQuality({
        prompt: 'Do the thing',
        result: 'x'.repeat(200),
        partial: true,
      });
      const check = report.checks.find((c) => c.name === 'not-partial')!;
      expect(check.pass).toBe(false);
      expect(check.critical).toBe(false);
    });

    it('PASSes for clean completions', () => {
      const report = evaluateMissionQuality({
        prompt: 'Do the thing',
        result: 'x'.repeat(200),
        partial: null,
      });
      const check = report.checks.find((c) => c.name === 'not-partial')!;
      expect(check.pass).toBe(true);
    });

    it('describes only the absence of partial recovery, not overall execution success', () => {
      const report = evaluateMissionQuality({
        prompt: 'Create a report',
        result: 'x'.repeat(200),
        partial: false,
        terminalState: {
          executionSucceeded: false,
          deliverable: { required: true, resolution: 'missing', ownerVisibleArtifactIds: [] },
        },
      });

      const check = report.checks.find((c) => c.name === 'not-partial')!;
      expect(check.pass).toBe(true);
      expect(check.detail).toBe('no partial-output recovery was recorded');
      expect(check.detail).not.toContain('completed cleanly');
    });
  });

  describe('overall verdict', () => {
    it('returns PASS when all checks pass', () => {
      const result =
        '## Situation\nNow.\n## Background\nBefore.\n## Assessment\nWhy.\n## Recommendation\nDo X. Confidence: 0.9.\n' +
        'x'.repeat(100);
      const report = evaluateMissionQuality({
        prompt: 'Give me an SBAR brief with confidence and IEEE citations [1].',
        result: result + ' [1].\n## References\n[1] First ref.\n[2] Second ref.\n[3] Third ref.',
        skillInvocations: [{ skill: 'write-srl-brief' }, { skill: 'cite-ieee' }],
      });
      expect(report.verdict).toBe('PASS');
      expect(report.overallScore).toBe(1.0);
    });

    it('returns FAIL when any critical check fails', () => {
      const report = evaluateMissionQuality({
        prompt: 'Whatever',
        result: '', // empty → critical fail
      });
      expect(report.verdict).toBe('FAIL');
      expect(report.overallScore).toBeLessThan(1.0);
    });

    it('returns REVISE when only soft checks fail', () => {
      const report = evaluateMissionQuality({
        prompt: 'Give me an SBAR brief with IEEE citations.',
        result: 'Situation. Background. Assessment. Recommendation. No citations though. ' + 'x'.repeat(200),
      });
      // citations-present should fail (soft) → REVISE
      expect(report.verdict).toBe('REVISE');
    });

    it('computes overallScore as fraction of checks passing', () => {
      const report = evaluateMissionQuality({
        prompt: 'Do the thing',
        result: 'x'.repeat(200),
      });
      // 6 checks, all should pass for this simple prompt (no format, citations, or confidence expected, no skills needed for simple prompt)
      expect(report.overallScore).toBe(1.0);
    });
  });
});

describe('scout-bundle-parseable critical check', () => {
  const VALID_BUNDLE = {
    queries: ['query one', 'query two', 'query three'],
    sources: [
      {
        id: 1,
        title: 'Example',
        url: 'https://example.com/p',
        fetched_via: 'exa',
        tool_call_id: 'toolu_abc',
        admiralty: 'A2',
        date_accessed: '2026-04-22',
      },
    ],
    findings: ['Cost down 30% [1]'],
    unresolved: [],
  };

  function wrapBundle(b: unknown): string {
    return `research notes...\n\n\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  }

  /** A prompt that carries the bundle-requirement marker (matches scout chain prompt). */
  const BUNDLE_PROMPT =
    'Procedure: call exa, then firecrawl. End with a ```json bundle block with tool_call_id per source.';

  it('PASSes when scout output contains a valid bundle', () => {
    const report = evaluateMissionQuality({
      agent: 'scout',
      prompt: BUNDLE_PROMPT,
      result: wrapBundle(VALID_BUNDLE) + '\n\n' + 'x'.repeat(500),
    });
    const check = report.checks.find((c) => c.name === 'scout-bundle-parseable')!;
    expect(check.pass).toBe(true);
    expect(check.critical).toBe(true);
  });

  it('FAILs when scout output omits the json block', () => {
    const report = evaluateMissionQuality({
      agent: 'scout',
      prompt: BUNDLE_PROMPT,
      result: 'free-form prose with no json block' + 'x'.repeat(500),
    });
    const check = report.checks.find((c) => c.name === 'scout-bundle-parseable')!;
    expect(check.pass).toBe(false);
    expect(check.critical).toBe(true);
    expect(report.verdict).toBe('FAIL');
  });

  it('FAILs when the bundle is malformed (missing tool_call_id)', () => {
    const bad = {
      ...VALID_BUNDLE,
      sources: [{ ...VALID_BUNDLE.sources[0], tool_call_id: undefined }],
    };
    const report = evaluateMissionQuality({
      agent: 'scout',
      prompt: BUNDLE_PROMPT,
      result: wrapBundle(bad) + 'x'.repeat(500),
    });
    const check = report.checks.find((c) => c.name === 'scout-bundle-parseable')!;
    expect(check.pass).toBe(false);
    expect(check.critical).toBe(true);
  });

  it('is SKIPPED when the prompt does not require a bundle (legacy scout call)', () => {
    const report = evaluateMissionQuality({
      agent: 'scout',
      prompt: 'find some AI startups',
      result: 'found 3 startups' + 'x'.repeat(500),
    });
    const check = report.checks.find((c) => c.name === 'scout-bundle-parseable');
    expect(check).toBeUndefined();
  });

  it('does NOT fire on non-scout agents', () => {
    const report = evaluateMissionQuality({
      agent: 'creator',
      prompt: BUNDLE_PROMPT + ' plus some creator stuff',
      result: 'creator report' + 'x'.repeat(500),
    });
    const check = report.checks.find((c) => c.name === 'scout-bundle-parseable');
    expect(check).toBeUndefined();
  });
});

describe('scout-no-citation-padding critical check', () => {
  const BUNDLE_PROMPT =
    'Procedure: call exa, then firecrawl. End with a ```json bundle block with tool_call_id per source.';

  const CLEAN_BUNDLE = {
    queries: ['q1', 'q2', 'q3'],
    sources: [
      {
        id: 1,
        title: 'S1',
        url: 'https://s1.example.com',
        fetched_via: 'exa',
        tool_call_id: 'toolu_1',
        admiralty: 'A2',
        date_accessed: '2026-04-23',
        snippet: 'Cost dropped 30% in 2026 per the report.',
      },
      {
        id: 2,
        title: 'S2',
        url: 'https://s2.example.com',
        fetched_via: 'exa',
        tool_call_id: 'toolu_2',
        admiralty: 'A2',
        date_accessed: '2026-04-23',
        snippet: 'A second source confirmed the 30% drop.',
      },
    ],
    findings: ['Cost dropped 30% [1, 2]'],
    unresolved: [],
  };

  const PADDED_BUNDLE = {
    ...CLEAN_BUNDLE,
    sources: [
      CLEAN_BUNDLE.sources[0],
      {
        ...CLEAN_BUNDLE.sources[1],
        snippet: 'Unrelated topic coverage — no matching quantitative data.',
      },
    ],
  };

  function wrapBundle(b: unknown): string {
    return `research...\n\n\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  }

  it('PASSes when the bundle has no citation padding', () => {
    const report = evaluateMissionQuality({
      agent: 'scout',
      prompt: BUNDLE_PROMPT,
      result: wrapBundle(CLEAN_BUNDLE) + '\n\n' + 'x'.repeat(500),
    });
    const check = report.checks.find((c) => c.name === 'scout-no-citation-padding')!;
    expect(check.pass).toBe(true);
    expect(check.critical).toBe(true);
  });

  it('FAILs (critical → L1 FAIL) when a multi-cite finding pads citations', () => {
    const report = evaluateMissionQuality({
      agent: 'scout',
      prompt: BUNDLE_PROMPT,
      result: wrapBundle(PADDED_BUNDLE) + 'x'.repeat(500),
    });
    const check = report.checks.find((c) => c.name === 'scout-no-citation-padding')!;
    expect(check.pass).toBe(false);
    expect(check.critical).toBe(true);
    expect(check.detail).toMatch(/finding 0|source 2/i);
    expect(report.verdict).toBe('FAIL');
  });

  it('is SKIPPED when the prompt does not require a bundle (legacy scout call)', () => {
    const report = evaluateMissionQuality({
      agent: 'scout',
      prompt: 'find some AI startups',
      result: 'found 3 startups' + 'x'.repeat(500),
    });
    const check = report.checks.find((c) => c.name === 'scout-no-citation-padding');
    expect(check).toBeUndefined();
  });
});

describe('linker-bundle-parseable + linker-no-fabricated-evidence critical checks', () => {
  const LINKER_PROMPT =
    'Propose relationships between entities. End with a ```json block containing ' +
    'edges: { sourceEntityName, targetEntityName, relationType, evidence, confidence } per edge.';

  const CLEAN_BUNDLE = {
    edges: [
      {
        sourceEntityName: 'OpenAI',
        targetEntityName: 'Anthropic',
        relationType: 'competes-with',
        evidence: 'OpenAI and Anthropic both ship frontier LLM APIs.',
        confidence: 0.85,
      },
    ],
  };

  const FABRICATED_BUNDLE = {
    edges: [
      {
        sourceEntityName: 'OpenAI',
        targetEntityName: 'Anthropic',
        relationType: 'competes-with',
        evidence: 'Two frontier LLM vendors share the enterprise market.',
        confidence: 0.85,
      },
    ],
  };

  function wrapLinker(b: unknown): string {
    return `linker notes\n\n\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  }

  it('PASSes linker-bundle-parseable when output has a valid bundle', () => {
    const report = evaluateMissionQuality({
      agent: 'linker',
      prompt: LINKER_PROMPT,
      result: wrapLinker(CLEAN_BUNDLE) + '\n' + 'x'.repeat(200),
    });
    const check = report.checks.find((c) => c.name === 'linker-bundle-parseable')!;
    expect(check.pass).toBe(true);
    expect(check.critical).toBe(true);
  });

  it('FAILs linker-bundle-parseable when output has no json block', () => {
    const report = evaluateMissionQuality({
      agent: 'linker',
      prompt: LINKER_PROMPT,
      result: 'free-form prose with no block' + 'x'.repeat(200),
    });
    const check = report.checks.find((c) => c.name === 'linker-bundle-parseable')!;
    expect(check.pass).toBe(false);
    expect(check.critical).toBe(true);
    expect(report.verdict).toBe('FAIL');
  });

  it('FAILs linker-no-fabricated-evidence when evidence misses target entity', () => {
    const report = evaluateMissionQuality({
      agent: 'linker',
      prompt: LINKER_PROMPT,
      result: wrapLinker(FABRICATED_BUNDLE) + '\n' + 'x'.repeat(200),
    });
    const check = report.checks.find((c) => c.name === 'linker-no-fabricated-evidence')!;
    expect(check.pass).toBe(false);
    expect(check.critical).toBe(true);
    expect(check.detail).toMatch(/OpenAI|Anthropic/);
    expect(report.verdict).toBe('FAIL');
  });

  it('does not run the linker checks on non-linker agents', () => {
    const report = evaluateMissionQuality({
      agent: 'scout',
      prompt: 'irrelevant',
      result: wrapLinker(CLEAN_BUNDLE) + '\n' + 'x'.repeat(200),
    });
    expect(report.checks.find((c) => c.name === 'linker-bundle-parseable')).toBeUndefined();
  });
});

describe('scout-no-fake-urls critical check (async)', () => {
  const BUNDLE_PROMPT =
    'Procedure: call exa, then firecrawl. End with a ```json bundle block with tool_call_id per source.';

  const bundleWith = (url: string) => ({
    queries: ['q1', 'q2', 'q3'],
    sources: [
      {
        id: 1,
        title: 'S1',
        url,
        fetched_via: 'exa',
        tool_call_id: 'toolu_1',
        admiralty: 'A2',
        date_accessed: '2026-04-23',
      },
    ],
    findings: ['something [1]'],
    unresolved: [],
  });

  function wrapBundle(b: unknown): string {
    return `notes\n\n\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  }

  beforeEach(() => {
    jest.resetModules();
  });

  it('PASSes when all scout URLs resolve', async () => {
    jest.doMock('../scout-url-verifier', () => ({
      verifyUrlsReachable: jest.fn().mockResolvedValue({ ok: true }),
    }));
    const mod = require('../mission-quality') as typeof import('../mission-quality');
    const report = await mod.evaluateMissionQualityAsync({
      agent: 'scout',
      prompt: BUNDLE_PROMPT,
      result: wrapBundle(bundleWith('https://good.example.com/paper')) + 'x'.repeat(200),
    });
    const check = report.checks.find((c) => c.name === 'scout-no-fake-urls')!;
    expect(check.pass).toBe(true);
  });

  it('FAILs when a scout URL returns 404', async () => {
    jest.doMock('../scout-url-verifier', () => ({
      verifyUrlsReachable: jest.fn().mockResolvedValue({
        ok: false,
        unreachable: [{ url: 'https://fake.example.com/paper', reachable: false, reason: '404 Not Found' }],
      }),
    }));
    const mod = require('../mission-quality') as typeof import('../mission-quality');
    const report = await mod.evaluateMissionQualityAsync({
      agent: 'scout',
      prompt: BUNDLE_PROMPT,
      result: wrapBundle(bundleWith('https://fake.example.com/paper')) + 'x'.repeat(200),
    });
    const check = report.checks.find((c) => c.name === 'scout-no-fake-urls')!;
    expect(check.pass).toBe(false);
    expect(check.critical).toBe(true);
    expect(report.verdict).toBe('FAIL');
  });

  it('SKIPs the check when prompt does not demand a bundle', async () => {
    const mod = require('../mission-quality') as typeof import('../mission-quality');
    const report = await mod.evaluateMissionQualityAsync({
      agent: 'scout',
      prompt: 'quick scout check, no bundle required',
      result: 'short result' + 'x'.repeat(200),
    });
    expect(report.checks.find((c) => c.name === 'scout-no-fake-urls')).toBeUndefined();
  });
});

describe('creator-citations-resolve critical check', () => {
  const bundleJson = JSON.stringify({
    queries: ['q1', 'q2', 'q3'],
    sources: [
      {
        id: 1,
        title: 'Source 1',
        url: 'https://example.com/1',
        fetched_via: 'exa',
        tool_call_id: 'toolu_1',
        admiralty: 'A2',
        date_accessed: '2026-04-23',
      },
      {
        id: 2,
        title: 'Source 2',
        url: 'https://example.com/2',
        fetched_via: 'exa',
        tool_call_id: 'toolu_2',
        admiralty: 'A2',
        date_accessed: '2026-04-23',
      },
    ],
    findings: ['cost dropped [1]'],
    unresolved: [],
  });

  const PROMPT_WITH_BUNDLE =
    'Write the report based on the research bundle below.\n\n### Research Bundle\n\n' +
    '```json\n' +
    bundleJson +
    '\n```\n\ntool_call_id and fetched_via fields are in each source.';

  const PROMPT_NO_BUNDLE = 'Write a quick qualitative brief on open-weight AI economics.';

  it('PASSes when every [N] in the creator result resolves to a bundle source id', () => {
    const report = evaluateMissionQuality({
      agent: 'creator',
      prompt: PROMPT_WITH_BUNDLE,
      result: 'Cost dropped 30% [1] and adoption rose [2].\n\n' + 'x'.repeat(200),
    });
    const check = report.checks.find((c) => c.name === 'creator-citations-resolve')!;
    expect(check.pass).toBe(true);
    expect(check.critical).toBe(true);
  });

  it('FAILs when the creator result cites an unknown source id', () => {
    const report = evaluateMissionQuality({
      agent: 'creator',
      prompt: PROMPT_WITH_BUNDLE,
      result: 'Cost dropped 30% [1] and the market grew [7].\n\n' + 'x'.repeat(200),
    });
    const check = report.checks.find((c) => c.name === 'creator-citations-resolve')!;
    expect(check.pass).toBe(false);
    expect(check.critical).toBe(true);
    expect(check.detail).toMatch(/7/);
    expect(report.verdict).toBe('FAIL');
  });

  it('SKIPs the check when the creator prompt has no bundle (manual/inline mode)', () => {
    const report = evaluateMissionQuality({
      agent: 'creator',
      prompt: PROMPT_NO_BUNDLE,
      result: 'A qualitative brief with no citations.\n\n' + 'x'.repeat(200),
    });
    expect(report.checks.find((c) => c.name === 'creator-citations-resolve')).toBeUndefined();
  });
});

describe('evaluator-trl-defensible L1 critical check', () => {
  it('passes when evaluator result has no TRL ≥ 5 claims', () => {
    const report = evaluateMissionQuality({
      prompt: 'Assess the technology maturity',
      agent: 'evaluator',
      result:
        'We looked at the whitepapers and concluded this is at TRL 3 — a working proof of concept but not yet validated outside the lab.',
    });
    const check = report.checks.find((c) => c.name === 'evaluator-trl-defensible');
    expect(check).toBeDefined();
    expect(check?.pass).toBe(true);
    expect(check?.critical).toBe(true);
  });

  it('fails critically when evaluator claims TRL 7 without deployment evidence', () => {
    const report = evaluateMissionQuality({
      prompt: 'Assess the technology readiness level',
      agent: 'evaluator',
      result:
        'After reviewing the vendor collateral and GitHub we believe this is TRL 7. Market momentum is strong and interest continues to grow across the sector.',
    });
    const check = report.checks.find((c) => c.name === 'evaluator-trl-defensible');
    expect(check?.pass).toBe(false);
    expect(check?.critical).toBe(true);
    expect(report.verdict).toBe('FAIL');
  });

  it('passes when evaluator TRL 7 claim is backed by a deployment reference nearby', () => {
    const report = evaluateMissionQuality({
      prompt: 'Assess the technology readiness level',
      agent: 'evaluator',
      result:
        'The vendor has a reference customer running this in production at Acme Corp. Based on that we assess the tech at TRL 7 with high confidence.',
    });
    const check = report.checks.find((c) => c.name === 'evaluator-trl-defensible');
    expect(check?.pass).toBe(true);
    expect(check?.critical).toBe(true);
  });
});

describe('creator-multi-source-quantitative L1 soft check', () => {
  const creatorPrompt =
    'Write a brief on open-weight AI economics. ### Research Bundle ```json {"sources":[{"id":1,"url":"x"},{"id":2,"url":"y"}]}```';

  it('skips when result has no quantitative content', () => {
    const report = evaluateMissionQuality({
      prompt: creatorPrompt,
      agent: 'creator',
      result: 'A general overview without numbers. [1] More text. [2] ' + 'x'.repeat(120),
    });
    const check = report.checks.find((c) => c.name === 'creator-multi-source-quantitative');
    expect(check?.pass).toBe(true);
    expect(check?.critical).toBe(false);
  });

  it('passes when quantitative sentences are multi-sourced', () => {
    const report = evaluateMissionQuality({
      prompt: creatorPrompt,
      agent: 'creator',
      result: 'Adoption grew 30% YoY. [1, 2] Funding reached $5B. [1, 2] More context. ' + 'x'.repeat(120),
    });
    const check = report.checks.find((c) => c.name === 'creator-multi-source-quantitative');
    expect(check?.pass).toBe(true);
    expect(check?.critical).toBe(false);
  });

  it('REVISEs (soft fail) when a quantitative sentence cites only one source', () => {
    const report = evaluateMissionQuality({
      prompt: creatorPrompt,
      agent: 'creator',
      result: 'Adoption grew 30% YoY. [1] Other context here. ' + 'x'.repeat(120),
    });
    const check = report.checks.find((c) => c.name === 'creator-multi-source-quantitative');
    expect(check?.pass).toBe(false);
    expect(check?.critical).toBe(false);
  });
});

describe('scout-multi-source-quantitative L1 soft check', () => {
  const scoutPrompt =
    'Research open-weight model economics. Emit a scout bundle (queries, sources, findings) with tool_call_id and fetched_via per source.';

  it('skips when scout result has no parseable bundle', () => {
    const report = evaluateMissionQuality({
      prompt: scoutPrompt,
      agent: 'scout',
      result: 'Just prose, no bundle here.',
    });
    const check = report.checks.find((c) => c.name === 'scout-multi-source-quantitative');
    if (check) {
      expect(check.critical).toBe(false);
    }
  });

  it('passes when all quantitative findings are multi-sourced', () => {
    const bundleJson = JSON.stringify({
      queries: ['q1', 'q2', 'q3'],
      sources: [
        {
          id: 1,
          title: 'A',
          url: 'https://a',
          fetched_via: 'exa',
          tool_call_id: 't1',
          admiralty: 'A2',
          date_accessed: '2026-04-25',
        },
        {
          id: 2,
          title: 'B',
          url: 'https://b',
          fetched_via: 'exa',
          tool_call_id: 't2',
          admiralty: 'A2',
          date_accessed: '2026-04-25',
        },
      ],
      findings: ['Adoption grew 30% YoY. [1, 2]'],
      unresolved: [],
    });
    const result = '```json\n' + bundleJson + '\n```\n\n' + 'x'.repeat(120);
    const report = evaluateMissionQuality({ prompt: scoutPrompt, agent: 'scout', result });
    const check = report.checks.find((c) => c.name === 'scout-multi-source-quantitative');
    expect(check).toBeDefined();
    expect(check?.pass).toBe(true);
    expect(check?.critical).toBe(false);
  });

  it('REVISEs (soft fail) when a quantitative finding cites only one source', () => {
    const bundleJson = JSON.stringify({
      queries: ['q1', 'q2', 'q3'],
      sources: [
        {
          id: 1,
          title: 'A',
          url: 'https://a',
          fetched_via: 'exa',
          tool_call_id: 't1',
          admiralty: 'A2',
          date_accessed: '2026-04-25',
        },
        {
          id: 2,
          title: 'B',
          url: 'https://b',
          fetched_via: 'exa',
          tool_call_id: 't2',
          admiralty: 'A2',
          date_accessed: '2026-04-25',
        },
      ],
      findings: ['Funding closed at $120M. [1]', 'Community sentiment was positive. [2]'],
      unresolved: [],
    });
    const result = '```json\n' + bundleJson + '\n```\n\n' + 'x'.repeat(120);
    const report = evaluateMissionQuality({ prompt: scoutPrompt, agent: 'scout', result });
    const check = report.checks.find((c) => c.name === 'scout-multi-source-quantitative');
    expect(check?.pass).toBe(false);
    expect(check?.critical).toBe(false);
  });
});

describe('linker-multi-source-quantitative L1 soft check', () => {
  const linkerPrompt =
    'Propose typed relations between entities. Emit a JSON edges bundle. Each edge needs evidence and a sourceUrl.';

  function linkerResultWith(edges: unknown[]): string {
    return '```json\n' + JSON.stringify({ edges }) + '\n```';
  }

  it('skips when result has no parseable linker bundle', () => {
    const report = evaluateMissionQuality({
      prompt: linkerPrompt,
      agent: 'linker',
      result: 'Just prose, no JSON.',
    });
    const check = report.checks.find((c) => c.name === 'linker-multi-source-quantitative');
    if (check) expect(check.critical).toBe(false);
  });

  it('passes when quantitative edges have ≥2 distinct hostnames', () => {
    const result = linkerResultWith([
      {
        sourceEntityName: 'Anthropic',
        targetEntityName: 'OpenAI',
        relationType: 'competes-with',
        evidence: 'Anthropic raised $4B per https://anthropic.com/news and https://reuters.com/article-12345.',
        confidence: 0.9,
      },
    ]);
    const report = evaluateMissionQuality({ prompt: linkerPrompt, agent: 'linker', result });
    const check = report.checks.find((c) => c.name === 'linker-multi-source-quantitative');
    expect(check?.pass).toBe(true);
    expect(check?.critical).toBe(false);
  });

  it('REVISEs (soft fail) when a quantitative edge has ≤1 hostname', () => {
    const result = linkerResultWith([
      {
        sourceEntityName: 'OpenAI',
        targetEntityName: 'Microsoft',
        relationType: 'partners-with',
        evidence: 'OpenAI has 700M weekly active users.',
        confidence: 0.85,
      },
    ]);
    const report = evaluateMissionQuality({ prompt: linkerPrompt, agent: 'linker', result });
    const check = report.checks.find((c) => c.name === 'linker-multi-source-quantitative');
    expect(check?.pass).toBe(false);
    expect(check?.critical).toBe(false);
  });
});

describe('creator-jtbd-presence L1 soft check (context-gated)', () => {
  const COMPARISON_PROMPT =
    'Generate a landscape report titled "Startup Ecosystem — AI in HR" covering the vendor competitive map and buy-vs-build decisions.';
  const NON_COMPARISON_PROMPT =
    'Produce a foresight report on AI in HR through 2028 with 3 dated predictions, accelerants, blockers, and kill signals.';

  const FIVE_TECH_RESULT =
    '## Vendor Landscape\n\n' +
    '**Workday Skills Cloud** is the leader. Workday Skills Cloud has 1B skill elements.\n' +
    '**Eightfold AI** competes directly. Eightfold AI has 1.6B career profiles.\n' +
    '**HiredScore Platform** focuses on hiring orchestration. HiredScore Platform is Workday-owned.\n' +
    '**Beamery Talent CRM** is the talent CRM player. Beamery Talent CRM integrates with Workday.\n' +
    '**LinkedIn Talent Insights** completes the picture. LinkedIn Talent Insights has scale.\n\n' +
    'x'.repeat(200);

  const FIVE_TECH_WITH_JTBD =
    FIVE_TECH_RESULT +
    '\n\nJob: minimize the time to identify high-fit internal candidates.\n' +
    'Struggling moment: "We have 8,000 engineers but a hiring manager can only search 200."\n';

  const TWO_TECH_RESULT =
    '**Workday Skills Cloud** is the incumbent. Workday Skills Cloud has wide adoption.\n' +
    '**Salesforce Agentforce** is exploring HR. Salesforce Agentforce hired a new CHRO.\n\n' +
    'x'.repeat(200);

  it('skips on non-creator agents', () => {
    const report = evaluateMissionQuality({
      agent: 'scout',
      prompt: COMPARISON_PROMPT,
      result: FIVE_TECH_RESULT,
    });
    expect(report.checks.find((c) => c.name === 'creator-jtbd-presence')).toBeUndefined();
  });

  it('skips when prompt does not indicate comparison (e.g., foresight prompt)', () => {
    const report = evaluateMissionQuality({
      agent: 'creator',
      prompt: NON_COMPARISON_PROMPT,
      result: FIVE_TECH_RESULT,
    });
    expect(report.checks.find((c) => c.name === 'creator-jtbd-presence')).toBeUndefined();
  });

  it('skips when output names fewer than 3 named entities', () => {
    const report = evaluateMissionQuality({
      agent: 'creator',
      prompt: COMPARISON_PROMPT,
      result: TWO_TECH_RESULT,
    });
    expect(report.checks.find((c) => c.name === 'creator-jtbd-presence')).toBeUndefined();
  });

  it('PASSes when comparison brief with ≥3 named entities AND JTBD markers present', () => {
    const report = evaluateMissionQuality({
      agent: 'creator',
      prompt: COMPARISON_PROMPT,
      result: FIVE_TECH_WITH_JTBD,
    });
    const check = report.checks.find((c) => c.name === 'creator-jtbd-presence');
    expect(check?.pass).toBe(true);
    expect(check?.critical).toBe(false);
  });

  it('REVISEs when comparison brief with ≥3 entities but JTBD markers absent', () => {
    const report = evaluateMissionQuality({
      agent: 'creator',
      prompt: COMPARISON_PROMPT,
      result: FIVE_TECH_RESULT,
    });
    const check = report.checks.find((c) => c.name === 'creator-jtbd-presence');
    expect(check?.pass).toBe(false);
    expect(check?.critical).toBe(false);
    expect(report.verdict).not.toBe('FAIL');
  });
});

describe('creator-evolution-stage L1 soft check (context-gated)', () => {
  const TECH_PROMPT =
    'Produce a tech radar update for AI-in-HR with maturity assessments across the major vendors and their adoption status.';
  const NON_TECH_PROMPT = 'Write a transformation roadmap with three culture-change pillars.';

  const FIVE_TECH_RESULT =
    '**Workday Skills Cloud** is the leader. Workday Skills Cloud has 1B skill elements.\n' +
    '**Eightfold AI** competes directly. Eightfold AI has 1.6B career profiles.\n' +
    '**HiredScore Platform** focuses on hiring orchestration. HiredScore Platform is Workday-owned.\n' +
    '**Beamery Talent CRM** is the talent CRM player. Beamery Talent CRM integrates with Workday.\n' +
    '**LinkedIn Talent Insights** completes the picture. LinkedIn Talent Insights has scale.\n\n' +
    'x'.repeat(200);

  const FIVE_TECH_WITH_WARDLEY =
    FIVE_TECH_RESULT +
    '\n\nEvolution stage: Product\n\n' +
    'Workday Skills Cloud sits in the Product stage of the Wardley map.';

  it('skips when prompt does not ask about technology maturity / comparison', () => {
    const report = evaluateMissionQuality({
      agent: 'creator',
      prompt: NON_TECH_PROMPT,
      result: FIVE_TECH_RESULT,
    });
    expect(report.checks.find((c) => c.name === 'creator-evolution-stage')).toBeUndefined();
  });

  it('skips when fewer than 3 named entities in output', () => {
    const report = evaluateMissionQuality({
      agent: 'creator',
      prompt: TECH_PROMPT,
      result: '**Workday Skills Cloud** alone. Workday Skills Cloud only.\n' + 'x'.repeat(200),
    });
    expect(report.checks.find((c) => c.name === 'creator-evolution-stage')).toBeUndefined();
  });

  it('PASSes when ≥3 entities AND Wardley evolution-stage tag or reference present', () => {
    const report = evaluateMissionQuality({
      agent: 'creator',
      prompt: TECH_PROMPT,
      result: FIVE_TECH_WITH_WARDLEY,
    });
    const check = report.checks.find((c) => c.name === 'creator-evolution-stage');
    expect(check?.pass).toBe(true);
    expect(check?.critical).toBe(false);
  });

  it('REVISEs when ≥3 entities but no Wardley placement', () => {
    const report = evaluateMissionQuality({
      agent: 'creator',
      prompt: TECH_PROMPT,
      result: FIVE_TECH_RESULT,
    });
    const check = report.checks.find((c) => c.name === 'creator-evolution-stage');
    expect(check?.pass).toBe(false);
    expect(check?.critical).toBe(false);
  });
});

describe('creator-three-horizons L1 soft check (context-gated)', () => {
  const PORTFOLIO_PROMPT =
    'Write an investment opportunities brief on AI in HR for an enterprise corp-dev team with a multi-year roadmap and a portfolio of 5 acquisition targets.';
  const NON_PORTFOLIO_PROMPT = 'Produce a current-state IMRAD whitepaper on the AI-in-HR market today.';

  const THREE_RECS_RESULT =
    '## Recommendations\n\n' +
    '**Recommendation 1: Acquire Harver before Q4 2026.**\n' +
    'Acquire Harver to capture the assessment IP.\n\n' +
    '**Recommendation 2: Pilot Eightfold AI Talent Insights for engineering reqs in EMEA.**\n' +
    'Pilot Eightfold AI Talent Insights for 90 days then decide.\n\n' +
    '**Recommendation 3: Build a custom skills-graph in-house.**\n' +
    'Build a custom skills-graph as a 24-month bet.\n\n' +
    'x'.repeat(200);

  const THREE_RECS_WITH_HORIZONS =
    THREE_RECS_RESULT +
    '\n\n## Portfolio Mix\n\n' +
    '**Horizon:** H1 (Recommendation 1)\n' +
    '**Horizon:** H2 (Recommendation 2)\n' +
    '**Horizon:** H3 (Recommendation 3)\n' +
    'Three Horizons portfolio framing applied.\n';

  it('skips when prompt does not indicate portfolio / multi-bet (e.g., current-state)', () => {
    const report = evaluateMissionQuality({
      agent: 'creator',
      prompt: NON_PORTFOLIO_PROMPT,
      result: THREE_RECS_RESULT,
    });
    expect(report.checks.find((c) => c.name === 'creator-three-horizons')).toBeUndefined();
  });

  it('skips when output proposes <3 recommendations / bets', () => {
    const report = evaluateMissionQuality({
      agent: 'creator',
      prompt: PORTFOLIO_PROMPT,
      result: '**Recommendation 1: Single bet.**\n' + 'x'.repeat(300),
    });
    expect(report.checks.find((c) => c.name === 'creator-three-horizons')).toBeUndefined();
  });

  it('PASSes when portfolio prompt + ≥3 recs + Horizon: H1/H2/H3 tags present', () => {
    const report = evaluateMissionQuality({
      agent: 'creator',
      prompt: PORTFOLIO_PROMPT,
      result: THREE_RECS_WITH_HORIZONS,
    });
    const check = report.checks.find((c) => c.name === 'creator-three-horizons');
    expect(check?.pass).toBe(true);
    expect(check?.critical).toBe(false);
  });

  it('REVISEs when portfolio prompt + ≥3 recs but no horizon tags', () => {
    const report = evaluateMissionQuality({
      agent: 'creator',
      prompt: PORTFOLIO_PROMPT,
      result: THREE_RECS_RESULT,
    });
    const check = report.checks.find((c) => c.name === 'creator-three-horizons');
    expect(check?.pass).toBe(false);
    expect(check?.critical).toBe(false);
  });
});

describe('MISSION-009 — CRITICAL DIMENSIONS N/A short-circuits L1 checks (no unnecessary REVISE)', () => {
  // A single brief whose vocabulary would normally fire the JTBD / Wardley /
  // Three-Horizons soft checks, but which explicitly marks each of those
  // dimensions N/A. The typed required/N/A contract must suppress the checks so
  // the mission is not dragged to REVISE (and does not pay for a revision turn)
  // for dimensions the author declared out of scope.
  const COMPARISON_PORTFOLIO_DIRECTIVE =
    'Compare the AI-in-HR vendor landscape and propose a multi-year portfolio roadmap.';

  const NA_DIMENSIONS_BLOCK = `

CRITICAL DIMENSIONS:
- JTBD framing per technology: N/A — this is an integrity audit
- Wardley evolution-stage per technology: N/A — maturity is out of scope
- Three Horizons tag per recommendation: N/A — no portfolio roadmap`;

  // ≥3 named entities (each ≥2 mentions) + ≥3 recommendation lines, but NO
  // JTBD / Wardley / Horizon discipline markers — so absent the N/A marks all
  // three soft checks fire.
  const UNDISCIPLINED_RESULT =
    '## Vendor Landscape\n\n' +
    '**Company Alpha** leads the market. Company Alpha has broad adoption.\n' +
    '**Technology Beta** competes directly. Technology Beta has strong traction.\n' +
    '**Strategy Gamma** rounds out the field. Strategy Gamma targets enterprises.\n\n' +
    'Recommendation 1: pilot Company Alpha next quarter.\n' +
    'Recommendation 2: benchmark Technology Beta against incumbents.\n' +
    'Recommendation 3: hold on Strategy Gamma pending evidence.\n\n' +
    'x'.repeat(200);

  const SOFT_CHECK_NAMES = ['creator-jtbd-presence', 'creator-evolution-stage', 'creator-three-horizons'];

  it('suppresses JTBD / Wardley / Three-Horizons checks when the brief marks them N/A', () => {
    const report = evaluateMissionQuality({
      agent: 'creator',
      prompt: COMPARISON_PORTFOLIO_DIRECTIVE + NA_DIMENSIONS_BLOCK,
      result: UNDISCIPLINED_RESULT,
    });
    for (const name of SOFT_CHECK_NAMES) {
      expect(report.checks.find((c) => c.name === name)).toBeUndefined();
    }
    // None of these dimensions may contribute a soft failure.
    const softFailures = report.checks.filter((c) => !c.critical && !c.pass).map((c) => c.name);
    for (const name of SOFT_CHECK_NAMES) {
      expect(softFailures).not.toContain(name);
    }
  });

  it('regression guard: the SAME brief WITHOUT the N/A block still fires all three checks (REVISE)', () => {
    const report = evaluateMissionQuality({
      agent: 'creator',
      prompt: COMPARISON_PORTFOLIO_DIRECTIVE,
      result: UNDISCIPLINED_RESULT,
    });
    for (const name of SOFT_CHECK_NAMES) {
      const check = report.checks.find((c) => c.name === name);
      expect(check?.pass).toBe(false);
      expect(check?.critical).toBe(false);
    }
    expect(report.verdict).toBe('REVISE');
  });

  it('evaluator: a TRL-N/A brief does not fire the TRL revision it otherwise would', () => {
    const withNa = evaluateMissionQuality({
      agent: 'evaluator',
      prompt:
        'Score the production readiness (TRL) of each SDK.\n\nCRITICAL DIMENSIONS:\n' +
        '- NASA TRL per technology: N/A — readiness is out of scope for this integrity audit',
      result: 'General discussion without readiness levels. ' + 'x'.repeat(200),
    });
    const naCheck = withNa.checks.find((c) => c.name === 'evaluator-signals')!;
    expect(naCheck.pass).toBe(true);
    expect(naCheck.detail).toMatch(/no TRL/i);

    // Guard: same directive without the N/A mark REVISEs (TRL requested, absent).
    const withoutNa = evaluateMissionQuality({
      agent: 'evaluator',
      prompt: 'Score the production readiness (TRL) of each SDK.',
      result: 'General discussion without readiness levels. ' + 'x'.repeat(200),
    });
    const guardCheck = withoutNa.checks.find((c) => c.name === 'evaluator-signals')!;
    expect(guardCheck.pass).toBe(false);
  });
});
