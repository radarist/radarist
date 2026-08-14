import { extractScopeEntities, splitScopeLine, MAX_ENTITIES } from '../scope';

describe('splitScopeLine', () => {
  it('returns every comma-separated fragment uncapped (so dedup/validation can run before the count cap)', () => {
    const many = Array.from({ length: 12 }, (_, i) => `Tech${i}`).join(', ');
    const prompt = `SCOPE: ${many}\nDEPTH: full`;
    expect(splitScopeLine(prompt)).toHaveLength(12);
  });

  it('returns [] when no SCOPE: line is present', () => {
    expect(splitScopeLine('Plain prompt with no scope.')).toEqual([]);
  });
});

describe('extractScopeEntities', () => {
  it('returns [] when no SCOPE: line is present', () => {
    expect(extractScopeEntities('Plain prompt with no scope.')).toEqual([]);
  });

  it('parses comma-separated entity names', () => {
    const prompt = 'ROLE: creator\nSCOPE: Workday Skills Cloud, Eightfold AI, Gloat\nDEPTH: full';
    expect(extractScopeEntities(prompt)).toEqual(['Workday Skills Cloud', 'Eightfold AI', 'Gloat']);
  });

  it('trims whitespace and ignores empty entries', () => {
    const prompt = 'SCOPE:  Workday  ,   Eightfold AI ,   ,   Gloat ';
    expect(extractScopeEntities(prompt)).toEqual(['Workday', 'Eightfold AI', 'Gloat']);
  });

  it(`caps at ${MAX_ENTITIES} entities`, () => {
    const many = Array.from({ length: 12 }, (_, i) => `Tech${i}`).join(', ');
    const prompt = `SCOPE: ${many}\nDEPTH: full`;
    expect(extractScopeEntities(prompt)).toHaveLength(MAX_ENTITIES);
  });

  it('handles a SCOPE block that ends at EOF', () => {
    const prompt = 'ROLE: creator\nSCOPE: Workday, Eightfold';
    expect(extractScopeEntities(prompt)).toEqual(['Workday', 'Eightfold']);
  });
});
