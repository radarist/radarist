import { buildRevisionFeedback, buildRevisionFeedbackWithManifest } from '../build-feedback';

const failingChecks = [
  {
    name: 'creator-jtbd-presence',
    pass: false,
    critical: false,
    detail:
      'brief compares 4 entities but lacks JTBD framing — expected verb-led Job: line + Struggling moment block per technology',
  },
  {
    name: 'creator-evolution-stage',
    pass: false,
    critical: false,
    detail:
      'brief compares 4 entities but lacks Wardley evolution-stage placement (Genesis/Custom-built/Product/Commodity)',
  },
];

const passingCheck = {
  name: 'result-exists',
  pass: true,
  critical: true,
  detail: 'result has 35K chars',
};

describe('buildRevisionFeedback', () => {
  it('lists each failing check with its detail', () => {
    const feedback = buildRevisionFeedback({ failingChecks });
    expect(feedback).toContain('1. creator-jtbd-presence');
    expect(feedback).toContain('verb-led Job: line');
    expect(feedback).toContain('2. creator-evolution-stage');
    expect(feedback).toContain('Genesis/Custom-built');
  });

  it('omits passing checks', () => {
    const feedback = buildRevisionFeedback({ failingChecks: [...failingChecks, passingCheck] });
    expect(feedback).not.toContain('result-exists');
  });

  it('mentions PRECOMPUTED DISCIPLINE when at least one matching skill was preluded', () => {
    const feedback = buildRevisionFeedback({
      failingChecks,
      preluddedSkills: new Set(['jtbd-framing', 'evolution-stage']),
    });
    expect(feedback).toContain('PRECOMPUTED DISCIPLINE');
  });

  it('does not mention PRECOMPUTED DISCIPLINE when no relevant skills were preluded', () => {
    const feedback = buildRevisionFeedback({
      failingChecks,
      preluddedSkills: new Set(),
    });
    expect(feedback).not.toContain('PRECOMPUTED DISCIPLINE');
  });

  it('caps feedback length at 8000 chars', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      name: `check-${i}`,
      pass: false,
      critical: false,
      detail: 'x'.repeat(100),
    }));
    const feedback = buildRevisionFeedback({ failingChecks: many });
    expect(feedback.length).toBeLessThanOrEqual(8000);
  });
});

describe('buildRevisionFeedbackWithManifest', () => {
  it('returns the same feedback text plus a structured manifest', () => {
    const result = buildRevisionFeedbackWithManifest({ failingChecks });
    const plain = buildRevisionFeedback({ failingChecks });
    expect(result.feedback).toBe(plain);
    expect(result.requestedDimensions).toEqual(['creator-jtbd-presence', 'creator-evolution-stage']);
  });

  it('maps known check names to their prelude skill', () => {
    const result = buildRevisionFeedbackWithManifest({ failingChecks });
    expect(result.requestedSkills).toEqual(['jtbd-framing', 'evolution-stage']);
  });

  it('omits unmapped check names from requestedSkills', () => {
    const unmapped = [
      ...failingChecks,
      {
        name: 'creator-multi-source-quantitative',
        pass: false,
        critical: false,
        detail: 'single-source quantitative claim',
      },
    ];
    const result = buildRevisionFeedbackWithManifest({ failingChecks: unmapped });
    expect(result.requestedDimensions).toContain('creator-multi-source-quantitative');
    expect(result.requestedSkills).not.toContain('creator-multi-source-quantitative');
    expect(result.requestedSkills).toEqual(['jtbd-framing', 'evolution-stage']);
  });

  it('flags preludedRelevantSkills=true when at least one requested skill was preluded', () => {
    const result = buildRevisionFeedbackWithManifest({
      failingChecks,
      preluddedSkills: new Set(['jtbd-framing']),
    });
    expect(result.preludedRelevantSkills).toBe(true);
  });

  it('flags preludedRelevantSkills=false when no requested skill was preluded', () => {
    const result = buildRevisionFeedbackWithManifest({
      failingChecks,
      preluddedSkills: new Set(['cynefin-classification']),
    });
    expect(result.preludedRelevantSkills).toBe(false);
  });

  it('flags preludedRelevantSkills=false when preluddedSkills is undefined', () => {
    const result = buildRevisionFeedbackWithManifest({ failingChecks });
    expect(result.preludedRelevantSkills).toBe(false);
  });

  it('emits empty arrays when no checks are failing', () => {
    const result = buildRevisionFeedbackWithManifest({ failingChecks: [passingCheck] });
    expect(result.requestedDimensions).toEqual([]);
    expect(result.requestedSkills).toEqual([]);
    expect(result.preludedRelevantSkills).toBe(false);
  });

  it('requires formal calls plus material cite-ieee/design-pass corrections', () => {
    const outputFailures = [
      {
        name: 'skill-output:cite-ieee',
        pass: false,
        critical: false,
        detail: 'cite-ieee output is present but no formal Skill() receipt was persisted',
      },
      {
        name: 'skill-output:design-pass',
        pass: false,
        critical: false,
        detail: 'design-pass was invoked but its output is absent',
      },
    ];
    const result = buildRevisionFeedbackWithManifest({ failingChecks: outputFailures });

    expect(result.requestedSkills).toEqual(['cite-ieee', 'design-pass']);
    expect(result.feedback).toContain('invoke the built-in Skill tool once for each missing procedure');
    expect(result.feedback).toContain('marker-shaped sentence without a formal tool call is not a receipt');
    expect(result.feedback).toContain('anchored inline #ref-N citations');
    expect(result.feedback).toContain('Design review: PASS|FAIL');
  });
});
