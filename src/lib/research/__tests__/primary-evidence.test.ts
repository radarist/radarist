/**
 * @jest-environment node
 * @file primary-evidence.test.ts
 * @description AI-038 — the evidence gate.
 *
 * Uses a synthetic hostile report with unresolved Google grounding redirects,
 * no primary URLs, fabricated patent numbers, and an overlong raw title. Every test
 * here is pure markdown in / verdict out — no provider calls, no network, no
 * clock, so the suite costs nothing to run.
 */

import {
  MAX_REPORTED_UNSUPPORTED_CLAIMS,
  MAX_RESEARCH_TITLE_LENGTH,
  MIN_DISTINCT_PRIMARY_SOURCES,
  annotateResearchReport,
  boundResearchTitle,
  classifyResearchSource,
  evaluateResearchEvidence,
  extractIdentifierClaims,
  extractResearchCitations,
  renderEvidenceReviewSection,
} from '../primary-evidence';

// ---------------------------------------------------------------------------
// Source classification
// ---------------------------------------------------------------------------

describe('classifyResearchSource', () => {
  it.each([
    ['https://patents.google.com/patent/US11234567B2/en', 'patent office'],
    ['https://patentscope.wipo.int/search/en/detail.jsf?docId=WO2023123456', 'WIPO'],
    ['https://doi.org/10.1234/abcd', 'DOI'],
    ['https://arxiv.org/abs/2401.12345', 'arXiv'],
    ['https://www.sec.gov/Archives/edgar/data/1/000.htm', 'SEC'],
    ['https://csrc.nist.gov/pubs/fips/203/final', 'NIST'],
    ['https://datatracker.ietf.org/doc/html/rfc8446', 'IETF'],
    ['https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1689', 'EUR-Lex'],
  ])('classifies %s as primary (%s)', (url) => {
    expect(classifyResearchSource(url)).toBe('primary');
  });

  it('treats an unresolved Google grounding redirect as a search redirect, never evidence', () => {
    expect(classifyResearchSource('https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbCdEf123')).toBe(
      'search-redirect'
    );
  });

  it('treats a search-engine result page as a search redirect', () => {
    expect(classifyResearchSource('https://www.google.com/search?q=quantum+patents')).toBe('search-redirect');
    expect(classifyResearchSource('https://www.google.com/url?q=https%3A%2F%2Fexample.com')).toBe('search-redirect');
  });

  it('classifies ordinary publishers as secondary', () => {
    expect(classifyResearchSource('https://techcrunch.com/2026/01/quantum')).toBe('secondary');
    expect(classifyResearchSource('https://somevendor.io/blog/our-quantum-story')).toBe('secondary');
  });

  it('classifies any official government host as primary', () => {
    expect(classifyResearchSource('https://www.energy.gov/articles/quantum')).toBe('primary');
  });

  it('rejects non-http and credentialed URLs as unusable', () => {
    expect(classifyResearchSource('ftp://example.com/file')).toBe('unusable');
    expect(classifyResearchSource('https://user:pass@example.com/x')).toBe('unusable');
    expect(classifyResearchSource('not a url')).toBe('unusable');
  });
});

// ---------------------------------------------------------------------------
// Citation extraction
// ---------------------------------------------------------------------------

describe('extractResearchCitations', () => {
  it('finds inline links, reference definitions, autolinks and bare URLs', () => {
    const markdown = [
      'Inline [the patent](https://patents.google.com/patent/US11234567B2/en) here.',
      'Autolink <https://arxiv.org/abs/2401.12345>.',
      'Bare https://www.sec.gov/filing/1.htm in prose.',
      '',
      '[1]: https://csrc.nist.gov/pubs/fips/203/final',
    ].join('\n');

    const urls = extractResearchCitations(markdown).map((citation) => citation.url);
    expect(urls).toHaveLength(4);
    expect(urls).toEqual(
      expect.arrayContaining([
        'https://patents.google.com/patent/US11234567B2/en',
        'https://arxiv.org/abs/2401.12345',
        'https://www.sec.gov/filing/1.htm',
        'https://csrc.nist.gov/pubs/fips/203/final',
      ])
    );
  });

  it('keeps the link label so an identifier cited by name is still traceable', () => {
    const citations = extractResearchCitations('[US11234567B2](https://example.com/patent-page)');
    expect(citations[0].label).toBe('US11234567B2');
  });

  it('de-duplicates the same source cited many times', () => {
    const markdown = [
      '[a](https://arxiv.org/abs/2401.12345)',
      '[b](https://arxiv.org/abs/2401.12345?utm_source=newsletter)',
      'https://arxiv.org/abs/2401.12345',
    ].join('\n');
    expect(extractResearchCitations(markdown)).toHaveLength(1);
  });

  it('strips sentence punctuation from a bare URL', () => {
    const citations = extractResearchCitations('See https://arxiv.org/abs/2401.12345.');
    expect(citations[0].url).toBe('https://arxiv.org/abs/2401.12345');
  });

  it('returns nothing for a report with no links', () => {
    expect(extractResearchCitations('# Title\n\nProse with no sources.')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Identifier claims
// ---------------------------------------------------------------------------

describe('extractIdentifierClaims', () => {
  it('extracts patent, DOI, arXiv and CVE identifiers', () => {
    const markdown = [
      'Patent US11234567B2 and EP3456789A1 and WO2023/123456.',
      'Paper 10.1038/s41586-024-07000-0 and arXiv:2401.12345.',
      'Advisory CVE-2024-21762.',
    ].join('\n');

    const kinds = extractIdentifierClaims(markdown).map((claim) => claim.kind);
    expect(kinds.filter((kind) => kind === 'patent')).toHaveLength(3);
    expect(kinds).toContain('doi');
    expect(kinds).toContain('arxiv');
    expect(kinds).toContain('cve');
  });

  it('does not treat ordinary prose numbers as patents', () => {
    const markdown = 'Roughly IN 12345 deployments across ISO 27001 programmes during 2026.';
    expect(extractIdentifierClaims(markdown)).toEqual([]);
  });

  it('de-duplicates the same identifier written differently', () => {
    const claims = extractIdentifierClaims('US11234567B2 appears again as US 11234567 B2.');
    expect(claims).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const WELL_SOURCED = [
  '# Post-Quantum Cryptography',
  '',
  'The lattice scheme is claimed in [US11234567B2](https://patents.google.com/patent/US11234567B2/en).',
  'The security proof is in [arXiv:2401.12345](https://arxiv.org/abs/2401.12345).',
  'Standardized as FIPS 203: https://csrc.nist.gov/pubs/fips/203/final',
].join('\n');

/** The live AI-038 failure in miniature: many citations, none of them evidence. */
const REDIRECT_ONLY = [
  '# Quantum Patent Landscape',
  '',
  'IBM holds US11234567B2 covering lattice key exchange, and Google filed EP3456789A1.',
  '',
  ...Array.from(
    { length: 43 },
    (_, index) => `[${index + 1}]: https://vertexaisearch.cloud.google.com/grounding-api-redirect/token${index}`
  ),
].join('\n');

describe('evaluateResearchEvidence', () => {
  it('passes a report with primary sources and traceable identifiers', () => {
    const report = evaluateResearchEvidence(WELL_SOURCED);

    expect(report.verdict).toBe('sufficient');
    expect(report.findings).toEqual([]);
    expect(report.distinctPrimaryDomains).toBeGreaterThanOrEqual(MIN_DISTINCT_PRIMARY_SOURCES);
    expect(report.unsupportedIdentifiers).toEqual([]);
  });

  it('rejects 43 synthetic redirect-only citations and fabricated patent numbers', () => {
    const report = evaluateResearchEvidence(REDIRECT_ONLY);

    expect(report.verdict).toBe('insufficient');
    expect(report.totalCitations).toBe(43);
    expect(report.searchRedirectCitations).toBe(43);
    expect(report.primaryCitations).toBe(0);
    expect(report.secondaryCitations).toBe(0);

    const codes = report.findings.map((finding) => finding.code);
    expect(codes).toContain('no-resolvable-citations');
    expect(codes).toContain('unsupported-identifier-claims');
    expect(codes).toContain('below-primary-quota');
    expect(report.unsupportedIdentifiers).toEqual(expect.arrayContaining(['US11234567B2', 'EP3456789A1']));
  });

  it('fails a report that cites nothing at all', () => {
    const report = evaluateResearchEvidence('# Title\n\nConfident prose, zero sources.');

    expect(report.verdict).toBe('insufficient');
    expect(report.findings.map((finding) => finding.code)).toContain('no-citations');
  });

  it('fails when an identifier is asserted but never cited, even with good sources elsewhere', () => {
    const markdown = `${WELL_SOURCED}\nA rival holds US9998887B1 covering the same ground.`;
    const report = evaluateResearchEvidence(markdown);

    expect(report.verdict).toBe('insufficient');
    expect(report.unsupportedIdentifiers).toEqual(['US9998887B1']);
  });

  it('accepts an identifier cited only via the link LABEL', () => {
    const markdown = [WELL_SOURCED, 'A rival holds [US9998887B1](https://example.com/opaque-patent-viewer).'].join(
      '\n'
    );

    expect(evaluateResearchEvidence(markdown).unsupportedIdentifiers).toEqual([]);
  });

  it('grades a sourced-but-thin report as `limited`, not `insufficient`', () => {
    const markdown = [
      '# Market View',
      'Analysts expect growth ([TechCrunch](https://techcrunch.com/a), [Reuters](https://reuters.com/b)).',
    ].join('\n');
    const report = evaluateResearchEvidence(markdown);

    expect(report.verdict).toBe('limited');
    expect(report.secondaryCitations).toBe(2);
    expect(report.findings.map((finding) => finding.code)).toEqual(['below-primary-quota']);
  });

  it('does not count two redirects as two independent sources', () => {
    const markdown = [
      '# X',
      '[a](https://vertexaisearch.cloud.google.com/grounding-api-redirect/one)',
      '[b](https://vertexaisearch.cloud.google.com/grounding-api-redirect/two)',
    ].join('\n');
    const report = evaluateResearchEvidence(markdown);

    expect(report.primaryCitations + report.secondaryCitations).toBe(0);
    expect(report.verdict).toBe('insufficient');
  });

  it('bounds the persisted unsupported-identifier list', () => {
    const many = Array.from({ length: 25 }, (_, index) => `US${11000000 + index}B2`).join(', ');
    const report = evaluateResearchEvidence(`# X\n\nPatents: ${many}\n\n[a](https://arxiv.org/abs/2401.12345)`);

    expect(report.identifierClaims).toBe(25);
    expect(report.unsupportedIdentifiers).toHaveLength(MAX_REPORTED_UNSUPPORTED_CLAIMS);
  });

  it('is deterministic — the same markdown always yields the same verdict', () => {
    expect(evaluateResearchEvidence(REDIRECT_ONLY)).toEqual(evaluateResearchEvidence(REDIRECT_ONLY));
  });

  it('never throws on degenerate input', () => {
    expect(evaluateResearchEvidence('').verdict).toBe('insufficient');
    expect(evaluateResearchEvidence(undefined as unknown as string).verdict).toBe('insufficient');
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('renderEvidenceReviewSection / annotateResearchReport', () => {
  it('renders nothing for a sufficient report — a banner on everything is a banner nobody reads', () => {
    const report = evaluateResearchEvidence(WELL_SOURCED);
    expect(renderEvidenceReviewSection(report)).toBe('');
    expect(annotateResearchReport(WELL_SOURCED, report)).toBe(WELL_SOURCED);
  });

  it('states the verdict, every finding, and the citation breakdown', () => {
    const section = renderEvidenceReviewSection(evaluateResearchEvidence(REDIRECT_ONLY));

    expect(section).toContain('insufficient primary evidence');
    expect(section).toContain('43 total');
    expect(section).toContain('43 unresolved search redirects');
    expect(section).toContain('US11234567B2');
    expect(section).toContain('UNVERIFIED');
  });

  it('uses softer language for a `limited` report', () => {
    const report = evaluateResearchEvidence('# X\n[a](https://techcrunch.com/a) [b](https://reuters.com/b)');
    const section = renderEvidenceReviewSection(report);

    expect(section).toContain('limited primary evidence');
    expect(section).not.toContain('UNVERIFIED');
  });

  it('prepends the section so the caveat leads the document (and every chunk of it)', () => {
    const report = evaluateResearchEvidence(REDIRECT_ONLY);
    const annotated = annotateResearchReport(REDIRECT_ONLY, report);

    expect(annotated.startsWith('> **Evidence review')).toBe(true);
    expect(annotated).toContain(REDIRECT_ONLY);
  });

  it('renders as a markdown blockquote so it survives rendering as a caveat, not as content', () => {
    const section = renderEvidenceReviewSection(evaluateResearchEvidence(REDIRECT_ONLY));
    for (const line of section.trim().split('\n')) {
      expect(line.startsWith('>')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Bounded metadata
// ---------------------------------------------------------------------------

describe('boundResearchTitle', () => {
  it('leaves a normal title untouched', () => {
    expect(boundResearchTitle('Post-Quantum Cryptography in financial services')).toBe(
      'Post-Quantum Cryptography in financial services'
    );
  });

  it('bounds a synthetic overlong title', () => {
    const runaway = `Research the quantum patent landscape. ${'Consider every filing and assignee. '.repeat(40)}`;
    expect(runaway.length).toBeGreaterThan(1_000);

    const bounded = boundResearchTitle(runaway);
    expect(bounded.length).toBeLessThanOrEqual(MAX_RESEARCH_TITLE_LENGTH);
    expect(bounded.endsWith('…')).toBe(true);
    expect(bounded.startsWith('Research the quantum patent landscape.')).toBe(true);
  });

  it('collapses whitespace and newlines a multi-line brief would carry into the title', () => {
    expect(boundResearchTitle('  Quantum\n\n  patents   2026 ')).toBe('Quantum patents 2026');
  });

  it('truncates on a word boundary when one is available', () => {
    const bounded = boundResearchTitle('alpha beta gamma delta epsilon zeta eta theta', 20);
    expect(bounded).toBe('alpha beta gamma…');
  });

  it('still bounds a single unbroken token', () => {
    const bounded = boundResearchTitle('x'.repeat(500), 30);
    expect(bounded).toHaveLength(30);
  });
});
