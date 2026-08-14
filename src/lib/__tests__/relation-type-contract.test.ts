import { RELATION_TYPES_LOWER } from '@/lib/graph/relation-registry';
import {
  InvalidRelationTypeError,
  assertCanonicalRelationType,
  isCanonicalRelationType,
  isSymmetricRelationType,
  parseCanonicalRelationType,
  SYMMETRIC_RELATION_TYPES,
} from '@/lib/relation-type-contract';

describe('relation type runtime contract', () => {
  it.each(RELATION_TYPES_LOWER)('accepts canonical relation type %s', (relationType) => {
    expect(isCanonicalRelationType(relationType)).toBe(true);
    expect(parseCanonicalRelationType(relationType)).toBe(relationType);
  });

  it.each(['provides', 'built_by', 'aligns_with,', 'USES', ' uses ', '', null, 42])(
    'rejects noncanonical value %p without silently normalizing it',
    (value) => {
      expect(isCanonicalRelationType(value)).toBe(false);
      expect(() => assertCanonicalRelationType(value)).toThrow(InvalidRelationTypeError);
    }
  );

  it('uses one exhaustive documented symmetry contract', () => {
    for (const relationType of SYMMETRIC_RELATION_TYPES) {
      expect(isSymmetricRelationType(relationType)).toBe(true);
    }
    expect(SYMMETRIC_RELATION_TYPES).toEqual(
      expect.arrayContaining(['parallels', 'complements', 'conflicts_with'])
    );
    expect(isSymmetricRelationType('uses')).toBe(false);
    expect(isSymmetricRelationType('evidences')).toBe(false);
  });
});
