/**
 * OBS-007 / TEST-036 — the shared verification-output contract.
 *
 * Every fixture here is built by the PRODUCTION builders, never hand-written.
 * The defect these tests lock out was invisible precisely because the old tests
 * invented their own 0-1 payloads instead of asking the producer what it emits.
 */

import {
  MIN_CONFIRMING_FOR_VERIFIED,
  VERIFICATION_OUTPUT_CONTRACT_VERSION,
  VERIFICATION_SCORE_MAX,
  buildSmartEntityVerificationOutput,
  isHostileVerificationOutput,
  parseVerificationOutput,
  summarizeVerificationSources,
  type VerificationSource,
} from '@/lib/verification-output-contract';

const TERMINAL = { terminal: true } as const;

function sources(confirming: number, contradicting = 0, inconclusive = 0): VerificationSource[] {
  return [
    ...Array.from({ length: confirming }, (_, i) => ({ label: `c${i}`, verdict: 'confirming' as const })),
    ...Array.from({ length: contradicting }, (_, i) => ({ label: `x${i}`, verdict: 'contradicting' as const })),
    ...Array.from({ length: inconclusive }, (_, i) => ({ label: `i${i}`, verdict: 'inconclusive' as const })),
  ];
}

describe('summarizeVerificationSources (production producer contract)', () => {
  it('emits confidence on the canonical 0-100 scale, never a 0-1 fraction', () => {
    const output = summarizeVerificationSources(sources(2), 'defense-minister-v1-edge');
    expect(output.score).toBe(100);
    expect(output.score).toBeGreaterThan(1);
    expect(output.score).toBeLessThanOrEqual(VERIFICATION_SCORE_MAX);
  });

  it('scores the confirming share of decisive checks', () => {
    // 3 of 4 decisive confirm; one inconclusive check is not decisive.
    expect(summarizeVerificationSources(sources(3, 1, 1), 'v').score).toBe(75);
  });

  it('treats an all-inconclusive set as undetermined (50), not disputed', () => {
    const output = summarizeVerificationSources(sources(0, 0, 3), 'v');
    expect(output.score).toBe(50);
    expect(output.status).toBe('unverified');
  });

  it('holds a single unreplicated confirming source at unverified (VERIFY-001)', () => {
    const output = summarizeVerificationSources(sources(1), 'v');
    expect(output.score).toBe(100);
    expect(output.status).toBe('unverified');
    expect(output.reasoning).toContain('single unreplicated source');
  });

  it('promotes to verified once replication is met', () => {
    const output = summarizeVerificationSources(sources(MIN_CONFIRMING_FOR_VERIFIED), 'v');
    expect(output.status).toBe('verified');
  });

  it('stamps the contract version', () => {
    expect(summarizeVerificationSources(sources(1), 'v').contractVersion).toBe(VERIFICATION_OUTPUT_CONTRACT_VERSION);
  });
});

describe('buildSmartEntityVerificationOutput', () => {
  const smart = buildSmartEntityVerificationOutput({
    status: 'verified',
    score: 85,
    observationCount: 6,
    weightedConfirming: 3.756,
    weightedContradicting: 0.4,
  });

  it('preserves the canonical 0-100 score', () => {
    expect(smart.score).toBe(85);
  });

  it('emits legitimately FRACTIONAL decay-weighted source counts', () => {
    expect(smart.sourcesConfirming).toBe(3.76);
    expect(Number.isInteger(smart.sourcesConfirming)).toBe(false);
  });

  it('round-trips through the parser without degrading a single field', () => {
    const parsed = parseVerificationOutput({ entityId: 'e1', ...smart }, 'entity', TERMINAL);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.degradedFields).toEqual([]);
    expect(parsed.fields.sourcesConfirming).toBe(3.76);
    expect(parsed.fields.score).toBe(85);
  });
});

describe('parseVerificationOutput — real producer output is accepted', () => {
  it('accepts a real 0-100 edge verdict and keeps every proven fact', () => {
    const produced = {
      relationId: 'rel-1',
      sourceEntityId: 'src-1',
      targetEntityId: 'tgt-1',
      ...summarizeVerificationSources(sources(2), 'defense-minister-v1-edge'),
    };
    const parsed = parseVerificationOutput(produced, 'edge', TERMINAL);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.degradedFields).toEqual([]);
    expect(parsed.fields).toMatchObject({
      relationId: 'rel-1',
      sourceEntityId: 'src-1',
      targetEntityId: 'tgt-1',
      status: 'verified',
      score: 100,
      verifierModel: 'defense-minister-v1-edge',
    });
  });

  it('accepts score 85 — the exact value the old 0-1 reader rejected', () => {
    const parsed = parseVerificationOutput({ entityId: 'e1', score: 85, status: 'verified' }, 'entity', TERMINAL);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.fields.score).toBe(85);
    expect(parsed.degradedFields).toEqual([]);
  });
});

describe('parseVerificationOutput — fields degrade independently', () => {
  it('keeps target, verifier and verdict when ONLY the score is unreadable', () => {
    const parsed = parseVerificationOutput(
      {
        relationId: 'rel-9',
        sourceEntityId: 'src-9',
        targetEntityId: 'tgt-9',
        status: 'disputed',
        score: 4321, // out of range
        verifierModel: 'defense-minister-v1-edge',
      },
      'edge',
      TERMINAL
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.degradedFields).toEqual(['score']);
    expect(parsed.fields.score).toBeUndefined();
    // The whole point of OBS-007: one bad field erases nothing else.
    expect(parsed.fields.relationId).toBe('rel-9');
    expect(parsed.fields.status).toBe('disputed');
    expect(parsed.fields.verifierModel).toBe('defense-minister-v1-edge');
  });

  it('keeps the score when only the target id is unreadable', () => {
    const parsed = parseVerificationOutput({ entityId: '', score: 85 }, 'entity', TERMINAL);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.degradedFields).toEqual(['entityId']);
    expect(parsed.fields.score).toBe(85);
  });

  it('rejects a negative score but keeps the rest', () => {
    const parsed = parseVerificationOutput({ entityId: 'e', score: -1, status: 'verified' }, 'entity', TERMINAL);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.degradedFields).toEqual(['score']);
    expect(parsed.fields.status).toBe('verified');
  });

  it('ignores an edge-only field on an entity run rather than adopting a foreign target', () => {
    const parsed = parseVerificationOutput({ entityId: 'e1', relationId: 'rel-x' }, 'entity', TERMINAL);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.fields.entityId).toBe('e1');
    expect(parsed.fields.relationId).toBeUndefined();
    expect(parsed.degradedFields).toEqual([]);
  });
});

describe('parseVerificationOutput — fail-closed refusals', () => {
  it.each([
    ['prototype pollution key', { __proto__value: 'x', $where: 'y', entityId: 'e' }],
    ['script value', { entityId: 'e', verifierModel: '<script>alert(1)</script>' }],
    ['javascript: url value', { entityId: 'e', reasoning: 'javascript:alert(1)' }],
  ])('refuses the whole payload for %s', (_label, payload) => {
    const parsed = parseVerificationOutput(payload, 'entity', TERMINAL);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.reason).toBe('hostile-output');
  });

  it('refuses a hostile payload even when other fields would validate', () => {
    const parsed = parseVerificationOutput(
      { entityId: 'e1', score: 85, status: 'verified', $ne: 1 },
      'entity',
      TERMINAL
    );
    expect(parsed.ok).toBe(false);
  });

  it('refuses a non-object output', () => {
    expect(parseVerificationOutput('a string', 'entity', TERMINAL).ok).toBe(false);
    expect(parseVerificationOutput([1, 2], 'entity', TERMINAL).ok).toBe(false);
  });

  it('refuses a TERMINAL run whose output shares no contract field', () => {
    const parsed = parseVerificationOutput({ unrelated: 'value' }, 'entity', TERMINAL);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.reason).toBe('malformed-output');
  });

  it('does NOT refuse a still-running run that has written no fields yet', () => {
    const parsed = parseVerificationOutput({ unrelated: 'value' }, 'entity', { terminal: false });
    expect(parsed.ok).toBe(true);
  });

  it('treats an absent output as empty, not malformed', () => {
    expect(parseVerificationOutput(undefined, 'entity', TERMINAL)).toEqual({
      ok: true,
      fields: {},
      degradedFields: [],
    });
    expect(parseVerificationOutput(null, 'edge', TERMINAL).ok).toBe(true);
  });

  it('bounds an over-long verifier model instead of surfacing it', () => {
    const parsed = parseVerificationOutput({ entityId: 'e', verifierModel: 'x'.repeat(5000) }, 'entity', TERMINAL);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.degradedFields).toEqual(['verifierModel']);
    expect(parsed.fields.verifierModel).toBeUndefined();
  });
});

describe('isHostileVerificationOutput', () => {
  it('passes a clean produced payload', () => {
    expect(isHostileVerificationOutput({ entityId: 'e', ...summarizeVerificationSources(sources(1), 'v') })).toBe(
      false
    );
  });
});
