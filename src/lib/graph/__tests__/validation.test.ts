/**
 * Tests for src/lib/graph/validation.ts.
 *
 * Covers Cypher injection vectors (sprint plan attacks 1-3, plus backtick
 * injection) and parameterization edge cases for limit / depth / orderBy.
 */

import {
  relationTypeCypherSchema,
  relationTypeLowerSchema,
  limitSchema,
  depthSchema,
  orderBySchema,
  labelSchema,
} from '../validation';

const RELATION_TYPES_LOWER = [
  'uses',
  'enables',
  'competes_with',
  'vendor',
  'user',
  'partner',
  'competitor',
  'addresses',
  'requires',
  'aligns_with',
  'supports',
  'owned_by',
  'sponsors',
  'funds',
  'solves',
  'impacts',
  'drives',
  'mentions',
  'documented_in',
  'source',
  'reveals',
  'experiences',
  'invests_in',
  'parent',
  'child',
  'demonstrates',
  'implements',
  'informed_by',
  'about',
  'acquired_by',
  'invested_in',
  'integrates_with',
  'alternative_to',
  'built_on',
  'customer_of',
  'supplier_of',
  'references',
  'supersedes',
  'supplements',
  'cites',
  'related_to',
  'custom',
] as const;

describe('validation: relationTypeCypherSchema', () => {
  describe('rejects Cypher injection attacks', () => {
    it('rejects "}MATCH" (sprint attack 1)', () => {
      expect(() => relationTypeCypherSchema.parse('}MATCH')).toThrow();
    });

    it('rejects "; DROP" (sprint attack 2)', () => {
      expect(() => relationTypeCypherSchema.parse('; DROP')).toThrow();
    });

    it('rejects multi-line "R\\nMATCH (n) DETACH" (sprint attack 3)', () => {
      expect(() => relationTypeCypherSchema.parse('R\nMATCH (n) DETACH')).toThrow();
    });

    it('rejects backtick-injection "USES`MATCH"', () => {
      expect(() => relationTypeCypherSchema.parse('USES`MATCH')).toThrow();
    });

    it('rejects empty string', () => {
      expect(() => relationTypeCypherSchema.parse('')).toThrow();
    });

    it('rejects unrecognized but syntactically clean values', () => {
      expect(() => relationTypeCypherSchema.parse('FOOBAR')).toThrow();
      expect(() => relationTypeCypherSchema.parse('not_a_real_type')).toThrow();
    });
  });

  describe('accepts the full RelationType union', () => {
    it.each(RELATION_TYPES_LOWER)('accepts lowercase "%s"', (rel) => {
      expect(relationTypeCypherSchema.parse(rel)).toBe(rel);
    });

    it.each(['USES', 'ENABLES', 'COMPETES_WITH', 'OWNED_BY', 'INTEGRATES_WITH'])('accepts UPPER_SNAKE "%s"', (rel) => {
      expect(relationTypeCypherSchema.parse(rel)).toBe(rel);
    });
  });
});

describe('validation: relationTypeLowerSchema', () => {
  it('accepts every lowercase member', () => {
    for (const rel of RELATION_TYPES_LOWER) {
      expect(relationTypeLowerSchema.parse(rel)).toBe(rel);
    }
  });

  it('rejects UPPER_SNAKE form (use relationTypeCypherSchema for that)', () => {
    expect(() => relationTypeLowerSchema.parse('USES')).toThrow();
  });

  it('rejects malicious values', () => {
    expect(() => relationTypeLowerSchema.parse('uses; DROP')).toThrow();
  });
});

describe('validation: limitSchema', () => {
  it('coerces string "10" to number 10', () => {
    expect(limitSchema.parse('10')).toBe(10);
  });

  it('passes integer 100 through', () => {
    expect(limitSchema.parse(100)).toBe(100);
  });

  it('rejects "10; DROP" (injection inside coerced numeric)', () => {
    expect(() => limitSchema.parse('10; DROP')).toThrow();
  });

  it('rejects values >1000', () => {
    expect(() => limitSchema.parse(1001)).toThrow();
  });

  it('rejects values <1', () => {
    expect(() => limitSchema.parse(0)).toThrow();
    expect(() => limitSchema.parse(-1)).toThrow();
  });

  it('floors floats (matches prior Math.floor behavior)', () => {
    expect(limitSchema.parse(3.14)).toBe(3);
    expect(limitSchema.parse(10.9)).toBe(10);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => limitSchema.parse(NaN)).toThrow();
    expect(() => limitSchema.parse(Infinity)).toThrow();
  });
});

describe('validation: depthSchema', () => {
  it('coerces string "3" to 3', () => {
    expect(depthSchema.parse('3')).toBe(3);
  });

  it('rejects negative depth', () => {
    expect(() => depthSchema.parse(-1)).toThrow();
  });

  it('rejects depth >10', () => {
    expect(() => depthSchema.parse(11)).toThrow();
  });

  it('rejects depth 0', () => {
    expect(() => depthSchema.parse(0)).toThrow();
  });
});

describe('validation: orderBySchema', () => {
  it('accepts whitelisted columns', () => {
    expect(orderBySchema.parse('n.name')).toBe('n.name');
    expect(orderBySchema.parse('r.confidence')).toBe('r.confidence');
  });

  it('rejects unknown column', () => {
    expect(() => orderBySchema.parse('n.foo')).toThrow();
  });

  it('rejects "name; DROP TABLE" (injection)', () => {
    expect(() => orderBySchema.parse('name; DROP TABLE')).toThrow();
  });
});

describe('validation: labelSchema', () => {
  it('accepts valid Cypher labels', () => {
    expect(labelSchema.parse('Technology')).toBe('Technology');
    expect(labelSchema.parse('Org_Unit')).toBe('Org_Unit');
  });

  it('rejects labels starting with lowercase', () => {
    expect(() => labelSchema.parse('technology')).toThrow();
  });

  it('rejects labels with non-ident characters', () => {
    expect(() => labelSchema.parse('Tech;DROP')).toThrow();
    expect(() => labelSchema.parse('Tech ology')).toThrow();
    expect(() => labelSchema.parse('Tech`MATCH')).toThrow();
  });

  it('rejects empty label', () => {
    expect(() => labelSchema.parse('')).toThrow();
  });
});
