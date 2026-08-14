/**
 * @file text-cleanup.test.ts
 * @description Guard the two cleanup fns that stopped Google News RSS items
 * landing as "<a href=...>Title</a> <font color=\"#6f6f6f\">BBC</font>" in
 * the UI and fixed the 0% relevance score.
 */

// Break the firebase init chain that base-fetcher pulls in transitively via
// entity-factory — tests don't need a live Firestore.
jest.mock('@/lib/firebase', () => ({ db: {} }));

import { computeKeywordRelevance, buildAiSummary, extractPublisherFromTitle } from '../base-fetcher';

// Extract the cleanText behaviour via a tiny spy: parseRSSXML invokes it on
// every description. We exercise the behaviour through a small Google-News-
// style fixture to avoid exporting the private helper.
import { fetchGoogleNewsRSS } from '../rss-fallback';

describe('computeKeywordRelevance', () => {
  it('returns a neutral 50 when no keywords are provided', () => {
    expect(computeKeywordRelevance('any title', 'any description', [])).toBe(50);
  });

  it('starts at 60 when a keyword matches only the description and scales with more matches', () => {
    const r = computeKeywordRelevance('News roundup', 'Article about AI and ML', ['ai', 'ml']);
    expect(r).toBeGreaterThanOrEqual(60);
    expect(r).toBeLessThanOrEqual(95);
  });

  it('scores higher when keywords match the title than only the description', () => {
    const titleHit = computeKeywordRelevance('Nvidia announces AI chip', 'Cloud computing news', ['ai']);
    const descHit = computeKeywordRelevance('Cloud news', 'AI-powered analytics', ['ai']);
    expect(titleHit).toBeGreaterThan(descHit);
  });

  it('caps the score at 95 so downstream evaluator can promote to 100', () => {
    const r = computeKeywordRelevance('AI AI AI AI AI AI chip', 'AI platform story', [
      'ai',
      'chip',
      'platform',
      'story',
      'language',
      'model',
      'embedding',
    ]);
    expect(r).toBeLessThanOrEqual(95);
  });

  it('falls back to a low base (30) when no keyword matches anywhere', () => {
    const r = computeKeywordRelevance('Weather update', 'Local forecast', ['ai']);
    expect(r).toBeLessThan(60);
  });
});

describe('extractPublisherFromTitle', () => {
  it('splits "Title - Publisher" when the suffix looks like a publisher name', () => {
    const r = extractPublisherFromTitle(
      'What is Mythos and why are experts worried about Anthropics AI model - Scientific American'
    );
    expect(r.title).toBe('What is Mythos and why are experts worried about Anthropics AI model');
    expect(r.publisher).toBe('Scientific American');
  });

  it('returns the original title when there is no " - " separator', () => {
    const r = extractPublisherFromTitle('A one-line headline');
    expect(r.title).toBe('A one-line headline');
    expect(r.publisher).toBeUndefined();
  });

  it('splits on the LAST " - " so legitimate in-title dashes survive', () => {
    const r = extractPublisherFromTitle('Nvidia Q4 earnings - chips and AI - CNBC');
    expect(r.title).toBe('Nvidia Q4 earnings - chips and AI');
    expect(r.publisher).toBe('CNBC');
  });

  it('rejects the split when the candidate publisher looks like a sentence', () => {
    const r = extractPublisherFromTitle("Meta launches new chip - it's a big deal.");
    expect(r.title).toBe("Meta launches new chip - it's a big deal.");
    expect(r.publisher).toBeUndefined();
  });

  it('rejects suffixes longer than 40 chars (likely article fragment)', () => {
    const r = extractPublisherFromTitle('Short title - this is a really long fragment that keeps going and going');
    expect(r.publisher).toBeUndefined();
  });

  it('returns original when the prefix is too short to be a title', () => {
    const r = extractPublisherFromTitle('A - BBC');
    expect(r.title).toBe('A - BBC');
    expect(r.publisher).toBeUndefined();
  });
});

describe('buildAiSummary', () => {
  it('returns just the title when description is empty', () => {
    expect(buildAiSummary('Headline', '')).toBe('Headline');
  });

  it('returns just the title when description merely restates the title', () => {
    expect(buildAiSummary('Nvidia announces chip', 'Nvidia announces chip')).toBe('Nvidia announces chip');
  });

  it('appends an excerpt when description adds real content', () => {
    const out = buildAiSummary('Nvidia announces chip', 'A full article with real context about the announcement.');
    expect(out).toContain('Nvidia announces chip');
    expect(out).toContain('full article with real context');
  });

  it('truncates long descriptions to 240 chars with an ellipsis', () => {
    const long = 'X'.repeat(500);
    const out = buildAiSummary('Title', long);
    // Should end with '...'
    expect(out.endsWith('...')).toBe(true);
  });
});

// Integration-style: plug a fetch stub so we can verify parseRSSXML's output
// ends up free of the Google-News-style HTML wrapper.
describe('Google News RSS cleanup (no HTML in description/title)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('strips embedded <a> / <font> wrappers that arrive HTML-encoded', async () => {
    const xml = `<?xml version="1.0"?>
<rss>
  <channel>
    <item>
      <title>Claude Mythos: Finance ministers ... - BBC</title>
      <link>https://news.google.com/rss/articles/CBMiABC?oc=5</link>
      <description>&lt;a href="https://news.google.com/rss/articles/CBMiABC?oc=5" target="_blank"&gt;Claude Mythos: Finance ministers ...&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;BBC&lt;/font&gt;</description>
      <pubDate>Thu, 17 Apr 2026 19:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => xml,
    }) as typeof fetch;

    const items = await fetchGoogleNewsRSS(['AI'], 5);
    expect(items).toHaveLength(1);
    const { title, description } = items[0];

    expect(title).not.toContain('<');
    expect(title).not.toContain('&lt;');
    expect(description).not.toContain('<a');
    expect(description).not.toContain('<font');
    expect(description).not.toContain('&lt;');
    // We expect the human-readable text to survive.
    expect(description.toLowerCase()).toContain('claude mythos');
    expect(description.toLowerCase()).toContain('bbc');
  });
});
