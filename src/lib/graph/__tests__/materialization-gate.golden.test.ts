import { shouldMaterializeAssertion } from '../assertions';
const CONFIDENCES = [0, 50, 74, 75, 76, 100] as const;
const ASSERTERS = ['user:claudio', 'agent:linker', 'ai:assistant', 'system:chunk-mentions'] as const;
// Frozen 2026-07-05, pre-B0. Machine asserters (agent:/ai:) gate at 75; user/system always pass
// ('system:*' passes even at 0 — deriveAsserterType only machine-classifies agent:/ai: prefixes).
const GOLDEN: Record<(typeof ASSERTERS)[number], Record<(typeof CONFIDENCES)[number], boolean>> = {
  'user:claudio': {
    0: true,
    50: true,
    74: true,
    75: true,
    76: true,
    100: true,
  },
  'system:chunk-mentions': {
    0: true,
    50: true,
    74: true,
    75: true,
    76: true,
    100: true,
  },
  'agent:linker': {
    0: false,
    50: false,
    74: false,
    75: true,
    76: true,
    100: true,
  },
  'ai:assistant': {
    0: false,
    50: false,
    74: false,
    75: true,
    76: true,
    100: true,
  },
};
describe('shouldMaterializeAssertion — frozen truth table (B0 zero-drift golden)', () => {
  it.each(ASSERTERS.flatMap((a) => CONFIDENCES.map((c) => [a, c] as const)))(
    'gate(assertedBy=%s, confidence=%d) matches the frozen table',
    (assertedBy, confidence) => {
      expect(shouldMaterializeAssertion(confidence, assertedBy)).toBe(GOLDEN[assertedBy][confidence]);
    }
  );
});
