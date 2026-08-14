/**
 * @file __tests__/decode-html-entities.test.ts
 * @description Unit tests for the tiny plain-text HTML entity decoder.
 */

import { decodeHtmlEntities } from '../decode-html-entities';

describe('decodeHtmlEntities', () => {
  it('decodes &amp; to &', () => {
    expect(decodeHtmlEntities('MCP &amp; The Production Reality Check')).toBe('MCP & The Production Reality Check');
  });

  it('decodes &lt; and &gt; to < and >', () => {
    expect(decodeHtmlEntities('a &lt;b&gt; c')).toBe('a <b> c');
  });

  it('decodes &quot; to "', () => {
    expect(decodeHtmlEntities('say &quot;hello&quot;')).toBe('say "hello"');
  });

  it("decodes &#39; to '", () => {
    expect(decodeHtmlEntities('it&#39;s here')).toBe("it's here");
  });

  it('decodes multiple distinct entities in one string', () => {
    expect(decodeHtmlEntities('&lt;div&gt; A &amp; B &quot;test&quot; &#39;x&#39;')).toBe('<div> A & B "test" \'x\'');
  });

  it('returns the input unchanged when there are no entities', () => {
    expect(decodeHtmlEntities('The Agentic PKG Harness V2')).toBe('The Agentic PKG Harness V2');
  });

  it('returns empty string unchanged', () => {
    expect(decodeHtmlEntities('')).toBe('');
  });

  it('is single-pass, not recursive — only unwraps one level of escaping', () => {
    // A doubly-escaped value ("&amp;amp;") should decode to "&amp;", not "&".
    expect(decodeHtmlEntities('&amp;amp;')).toBe('&amp;');
  });

  it('does not touch unrelated ampersands or unknown entities', () => {
    expect(decodeHtmlEntities('Q1 &amp; Q2 report &copy;')).toBe('Q1 & Q2 report &copy;');
  });

  it('matches the real-world corrupted report title from the bug report', () => {
    const stored = 'The Agentic PKG Harness V2 &mdash; Architecture, MCP &amp; The Production Reality Check';
    expect(decodeHtmlEntities(stored)).toBe(
      'The Agentic PKG Harness V2 &mdash; Architecture, MCP & The Production Reality Check'
    );
  });
});
