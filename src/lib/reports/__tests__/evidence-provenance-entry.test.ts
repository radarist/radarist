/**
 * Regression coverage for the reference-entry extractor.
 *
 * The prior implementation matched non-greedily to the FIRST closing tag, so a
 * conventional IEEE entry that opens with a styled number span had its URL cut
 * out of scope. `verifyPublishedReportEvidence` then reported
 * "does not print its accepted source URL" for a citation that plainly did.
 * The fixture preserves that nested-tag shape without retaining run evidence.
 */
import { extractReferenceEntry } from '@/lib/reports/evidence-provenance';

const URL_1 = 'https://eur-lex.europa.eu/eli/dir/2026/470/oj/eng';

describe('extractReferenceEntry', () => {
  it('includes the URL when the entry opens with a nested number span (the regression)', () => {
    const html = `<ol class="references-list">
      <li id="ref-1"><span class="ref-num">[1]</span> European Parliament, "Directive (EU) 2026/470," OJ L 2026/470. Available: ${URL_1} <span class="ref-grade">PRIMARY REGULATORY</span></li>
    </ol>`;
    const entry = extractReferenceEntry(html, 1);
    expect(entry).toBeDefined();
    expect(entry).toContain(URL_1);
  });

  it('returns the whole element including trailing children', () => {
    const html = `<li id="ref-2">Text ${URL_1} <span class="ref-grade">ADMIRALTY A2</span></li>`;
    expect(extractReferenceEntry(html, 2)).toContain('ADMIRALTY A2');
  });

  it('handles same-tag nesting without stopping at the inner close', () => {
    const html = `<div id="ref-3">outer <div>inner</div> ${URL_1}</div><div>after</div>`;
    const entry = extractReferenceEntry(html, 3);
    expect(entry).toContain(URL_1);
    expect(entry).not.toContain('after');
  });

  it('does not run past the end of its own element', () => {
    const html = `<li id="ref-4">first ${URL_1}</li><li id="ref-5">second https://example.com/other</li>`;
    const entry = extractReferenceEntry(html, 4);
    expect(entry).toContain(URL_1);
    expect(entry).not.toContain('example.com/other');
  });

  it('returns undefined when no entry carries the id', () => {
    expect(extractReferenceEntry('<li id="ref-9">x</li>', 1)).toBeUndefined();
  });

  it('tolerates single quotes and extra attributes on the opening tag', () => {
    const html = `<li class="ref" id='ref-6' data-x="y"><span>[6]</span> ${URL_1}</li>`;
    expect(extractReferenceEntry(html, 6)).toContain(URL_1);
  });

  it('falls back to the remainder rather than false-failing on unclosed markup', () => {
    const html = `<li id="ref-7"><span>[7]</span> ${URL_1}`;
    expect(extractReferenceEntry(html, 7)).toContain(URL_1);
  });
});
