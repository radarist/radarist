import { analyzeLinkerEdgeEvidence } from '../mission-quality/analyzers/linker-bundle-analyzer';
import type { LinkerBundle } from '../schemas/linker-bundle';

function makeBundle(overrides: Partial<LinkerBundle> = {}): LinkerBundle {
  return {
    edges: [
      {
        sourceEntityName: 'OpenAI',
        targetEntityName: 'Anthropic',
        relationType: 'competes-with',
        evidence: 'OpenAI and Anthropic both ship frontier LLM APIs to enterprise customers.',
        confidence: 0.85,
      },
    ],
    ...overrides,
  };
}

describe('analyzeLinkerEdgeEvidence', () => {
  it('passes when evidence mentions both source and target entity names', () => {
    const result = analyzeLinkerEdgeEvidence(makeBundle());
    expect(result.ok).toBe(true);
  });

  it('fails when evidence does not mention the target entity name', () => {
    const bundle = makeBundle({
      edges: [
        {
          sourceEntityName: 'OpenAI',
          targetEntityName: 'Anthropic',
          relationType: 'competes-with',
          evidence: 'OpenAI ships frontier LLM APIs to enterprise customers.',
          confidence: 0.85,
        },
      ],
    });
    const result = analyzeLinkerEdgeEvidence(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].missingEntityNames).toContain('Anthropic');
    }
  });

  it('fails when evidence does not mention the source entity name', () => {
    const bundle = makeBundle({
      edges: [
        {
          sourceEntityName: 'OpenAI',
          targetEntityName: 'Anthropic',
          relationType: 'competes-with',
          evidence: 'Anthropic ships Claude as a frontier enterprise LLM.',
          confidence: 0.85,
        },
      ],
    });
    const result = analyzeLinkerEdgeEvidence(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0].missingEntityNames).toContain('OpenAI');
    }
  });

  it('matches case-insensitively', () => {
    const bundle = makeBundle({
      edges: [
        {
          sourceEntityName: 'OpenAI',
          targetEntityName: 'Anthropic',
          relationType: 'competes-with',
          evidence: 'openai and anthropic compete on enterprise LLM APIs.',
          confidence: 0.85,
        },
      ],
    });
    const result = analyzeLinkerEdgeEvidence(bundle);
    expect(result.ok).toBe(true);
  });

  it('reports multiple violations across edges', () => {
    const bundle = makeBundle({
      edges: [
        {
          sourceEntityName: 'OpenAI',
          targetEntityName: 'Anthropic',
          relationType: 'competes-with',
          evidence: 'Two frontier API vendors dominate the enterprise LLM market.',
          confidence: 0.7,
        },
        {
          sourceEntityName: 'Meta',
          targetEntityName: 'Mistral',
          relationType: 'competes-with',
          evidence: 'The open-weight market is growing.',
          confidence: 0.6,
        },
      ],
    });
    const result = analyzeLinkerEdgeEvidence(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations).toHaveLength(2);
  });
});
