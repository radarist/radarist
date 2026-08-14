import { parseLinkerBundle, containsLinkerBundleMarker } from '../mission-quality/analyzers/linker-bundle-parser';

const VALID_BUNDLE = {
  edges: [
    {
      sourceEntityName: 'OpenAI',
      targetEntityName: 'Anthropic',
      relationType: 'competes-with',
      evidence: 'OpenAI and Anthropic both offer frontier LLM APIs, actively competing for enterprise customers.',
      confidence: 0.85,
    },
  ],
};

function wrapInMarkdown(bundle: unknown, prose = 'linker notes'): string {
  return `${prose}\n\n\`\`\`json\n${JSON.stringify(bundle, null, 2)}\n\`\`\`\n`;
}

describe('parseLinkerBundle', () => {
  it('parses a valid bundle with one edge', () => {
    const result = parseLinkerBundle(wrapInMarkdown(VALID_BUNDLE));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundle.edges).toHaveLength(1);
      expect(result.bundle.edges[0].relationType).toBe('competes-with');
    }
  });

  it('fails when no fenced json block is present', () => {
    const result = parseLinkerBundle('just prose');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no.*json.*block/i);
  });

  // MISSION-011: an empty bundle is WELL-FORMED, not a schema violation. "I
  // looked and found nothing defensible" is a legitimate research outcome, and
  // failing it critically here made the honest answer indistinguishable from
  // ignoring the deliverable contract — a direct incentive to invent an edge.
  // The soft `linker-proposals-present` check reports the emptiness instead.
  it('accepts an empty edges array as a well-formed honest-empty bundle', () => {
    const empty = { edges: [] };
    const result = parseLinkerBundle(wrapInMarkdown(empty));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bundle.edges).toHaveLength(0);
  });

  it('fails when an edge is missing sourceEntityName', () => {
    const bad = { edges: [{ ...VALID_BUNDLE.edges[0], sourceEntityName: undefined }] };
    const result = parseLinkerBundle(wrapInMarkdown(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/sourceEntityName/);
  });

  it('fails when evidence is empty', () => {
    const bad = { edges: [{ ...VALID_BUNDLE.edges[0], evidence: '' }] };
    const result = parseLinkerBundle(wrapInMarkdown(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/evidence/);
  });

  it('picks the last fenced json block when multiple are present', () => {
    const text = '```json\n{"discarded": true}\n```\n\nmore prose\n\n' + wrapInMarkdown(VALID_BUNDLE, '');
    const result = parseLinkerBundle(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bundle.edges[0].relationType).toBe('competes-with');
  });
});

describe('containsLinkerBundleMarker', () => {
  it('detects the marker in prompts containing the expected fields', () => {
    expect(containsLinkerBundleMarker('Return a ```json block with edges + evidence per edge')).toBe(true);
    expect(containsLinkerBundleMarker('end with sourceEntityName, targetEntityName, relationType per edge')).toBe(true);
  });

  it('returns false for prompts without the marker', () => {
    expect(containsLinkerBundleMarker('propose some relationships')).toBe(false);
  });
});
