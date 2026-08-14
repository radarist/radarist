import { normalizeSignalEvidenceSources } from '../evidence-sources';

const signal = (url = '') => ({
  title: 'A central signal claim',
  source: 'Original publication',
  url,
});

describe('normalizeSignalEvidenceSources', () => {
  it('returns zero sources when neither an original URL nor evidence URLs exist', () => {
    expect(normalizeSignalEvidenceSources(signal())).toEqual([]);
  });

  it('counts the actual original URL once as confirming evidence', () => {
    expect(normalizeSignalEvidenceSources(signal('https://example.com/report'))).toEqual([
      {
        title: 'Original publication',
        url: 'https://example.com/report',
        verdict: 'confirming',
      },
    ]);
  });

  it('deduplicates tracking, www, fragment, and trailing-slash variants', () => {
    const sources = normalizeSignalEvidenceSources(signal('https://www.example.com/Report/?utm_source=feed#claim'), [
      {
        title: 'Duplicate citation',
        url: 'https://example.com/Report?fbclid=123',
        verdict: 'confirming',
      },
    ]);

    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe('https://www.example.com/Report/?utm_source=feed#claim');
  });

  it('deduplicates HTTP and HTTPS aliases without rewriting the displayed URL', () => {
    const sources = normalizeSignalEvidenceSources(signal('http://example.com/report'), [
      { title: 'TLS alias', url: 'https://www.example.com/report', verdict: 'confirming' },
    ]);

    expect(sources).toEqual([
      { title: 'Original publication', url: 'http://example.com/report', verdict: 'confirming' },
    ]);
  });

  it('preserves case-sensitive paths and meaningful query parameters', () => {
    const sources = normalizeSignalEvidenceSources(signal('https://example.com/Report?source=one'), [
      { title: 'Different path', url: 'https://example.com/report?source=one', verdict: 'confirming' },
      { title: 'Different query', url: 'https://example.com/Report?source=two', verdict: 'confirming' },
    ]);

    expect(sources).toHaveLength(3);
    expect(sources.map((source) => source.url)).toEqual([
      'https://example.com/Report?source=one',
      'https://example.com/report?source=one',
      'https://example.com/Report?source=two',
    ]);
  });

  it('retains two distinct confirming sources and explicit counter-evidence semantics', () => {
    const sources = normalizeSignalEvidenceSources(signal(), [
      { title: 'A', url: 'https://a.example/claim', verdict: 'confirming' },
      { title: 'B', url: 'https://b.example/claim', verdict: 'confirming' },
      { title: 'C', url: 'https://c.example/claim', verdict: 'contradicting' },
      { title: 'D', url: 'https://d.example/claim', verdict: 'inconclusive' },
    ]);

    expect(sources.filter((source) => source.verdict === 'confirming')).toHaveLength(2);
    expect(sources.map((source) => source.verdict)).toEqual([
      'confirming',
      'confirming',
      'contradicting',
      'inconclusive',
    ]);
  });

  it('keeps only actual grounding citations and uses declarations only for stance', () => {
    const sources = normalizeSignalEvidenceSources(
      signal('https://original.example/story'),
      [
        {
          title: 'Grounded declaration',
          url: 'https://grounded.example/post?utm_campaign=launch',
          verdict: 'contradicting',
        },
        { title: 'Invented', url: 'https://invented.example/post', verdict: 'confirming' },
      ],
      {
        groundedCitations: [
          { uri: 'https://grounded.example/post?fbclid=abc', title: 'Grounding metadata title' },
          { uri: 'https://unclassified.example/post', title: 'Unclassified citation' },
        ],
      }
    );

    expect(sources).toEqual([
      {
        title: 'Original publication',
        url: 'https://original.example/story',
        verdict: 'confirming',
      },
      {
        title: 'Grounding metadata title',
        url: 'https://grounded.example/post?fbclid=abc',
        verdict: 'contradicting',
      },
      {
        title: 'Unclassified citation',
        url: 'https://unclassified.example/post',
        verdict: 'inconclusive',
      },
    ]);
  });

  it('does not transfer a stance by title when the grounded URL differs', () => {
    const sources = normalizeSignalEvidenceSources(
      signal('https://original.example/story'),
      [{ title: 'Generic News', url: 'https://invented.example/post', verdict: 'confirming' }],
      { groundedCitations: [{ uri: 'https://grounded.example/post', title: 'Generic News' }] }
    );

    expect(sources[1]).toEqual({
      title: 'Generic News',
      url: 'https://grounded.example/post',
      verdict: 'inconclusive',
    });
  });

  it('matches stance by a resolved publisher identity while preserving the grounding URL', () => {
    const redirectUrl = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/token';
    const sources = normalizeSignalEvidenceSources(
      signal('https://original.example/story'),
      [
        {
          title: 'Publisher declaration',
          url: 'https://publisher.example/report?utm_source=gemini',
          verdict: 'confirming',
        },
      ],
      {
        groundedCitations: [
          {
            uri: redirectUrl,
            identityUri: 'https://publisher.example/report?fbclid=google',
            title: 'publisher.example',
          },
        ],
      }
    );

    expect(sources[1]).toEqual({
      title: 'publisher.example',
      url: redirectUrl,
      verdict: 'confirming',
    });
  });

  it('keeps an unresolved Google redirect inconclusive even when the model declares that exact URL', () => {
    const redirectUrl = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/token';
    const sources = normalizeSignalEvidenceSources(
      signal('https://original.example/story'),
      [{ title: 'Self-declared redirect', url: redirectUrl, verdict: 'confirming' }],
      { groundedCitations: [{ uri: redirectUrl, title: 'publisher.example' }] }
    );

    expect(sources[1]).toEqual({
      title: 'publisher.example',
      url: redirectUrl,
      verdict: 'inconclusive',
    });
  });

  it('fails closed when duplicate declarations disagree about stance', () => {
    const sources = normalizeSignalEvidenceSources(signal(), [
      { title: 'First', url: 'https://evidence.example/post?utm_source=a', verdict: 'confirming' },
      { title: 'Second', url: 'https://www.evidence.example/post?fbclid=b', verdict: 'contradicting' },
    ]);

    expect(sources).toEqual([
      {
        title: 'First',
        url: 'https://evidence.example/post?utm_source=a',
        verdict: 'inconclusive',
      },
    ]);
  });

  it('fails closed when evidence contradicts the original URL identity', () => {
    const sources = normalizeSignalEvidenceSources(signal('https://example.com/story'), [
      {
        title: 'Contradicting annotation',
        url: 'https://www.example.com/story?utm_source=search',
        verdict: 'contradicting',
      },
    ]);

    expect(sources).toEqual([
      {
        title: 'Original publication',
        url: 'https://example.com/story',
        verdict: 'inconclusive',
      },
    ]);
  });
});
