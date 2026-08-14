/**
 * REPORT-013 — reference-integrity gate.
 *
 * Failure-first proof: before this module existed, a report could publish with
 * citation anchors whose targets did not exist (one stored output carried 115
 * `#ref-N` anchors against 38 targets, none of which resolved) and with the same
 * reference id defined twice. Both make a citation silently unclickable while
 * still LOOKING sourced, which is the provenance failure this row exists to fix.
 */
import {
  assertReportReferenceIntegrity,
  detectReferenceIntegrityViolations,
  ReportReferenceIntegrityError,
} from '@/lib/reports/reference-integrity';

const withRefs = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;

describe('detectReferenceIntegrityViolations', () => {
  it('accepts a report whose every citation anchor resolves to exactly one target', () => {
    const html = withRefs(
      `<p>Claim <a class="cite-link" href="#ref-1"><sup class="cite">[1]</sup></a> and again <a href="#ref-1">[1]</a>.</p>
       <ol class="references-list"><li id="ref-1">A. Smith, "Title," 2026.</li></ol>`
    );
    expect(detectReferenceIntegrityViolations(html)).toEqual([]);
  });

  it('flags a citation anchor with no matching reference target', () => {
    const html = withRefs(`<p>Claim <a href="#ref-2">[2]</a>.</p><ol><li id="ref-1">Only source one.</li></ol>`);
    const violations = detectReferenceIntegrityViolations(html);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: 'dangling-citation', reference: 'ref-2' });
  });

  it('flags a reference id defined more than once', () => {
    const html = withRefs(
      `<p>Claim <a href="#ref-1">[1]</a>.</p><ol><li id="ref-1">First.</li><li id="ref-1">Duplicate.</li></ol>`
    );
    const violations = detectReferenceIntegrityViolations(html);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: 'duplicate-reference-target', reference: 'ref-1' });
  });

  it('ignores non-reference fragment anchors such as a table of contents', () => {
    const html = withRefs(`<nav><a href="#s1">Section 1</a></nav><section id="s1">Body</section>`);
    expect(detectReferenceIntegrityViolations(html)).toEqual([]);
  });

  it('ignores anchors and ids inside HTML comments', () => {
    const html = withRefs(`<!-- <a href="#ref-9">[9]</a> --><p>Body</p>`);
    expect(detectReferenceIntegrityViolations(html)).toEqual([]);
  });

  it('matches single-quoted and unquoted attribute forms', () => {
    const html = withRefs(`<p><a href='#ref-3'>[3]</a></p><ol><li id=ref-3>Three.</li></ol>`);
    expect(detectReferenceIntegrityViolations(html)).toEqual([]);
  });

  it('bounds the number of reported violations so an error message stays readable', () => {
    const anchors = Array.from({ length: 40 }, (_, i) => `<a href="#ref-${i + 1}">[${i + 1}]</a>`).join('');
    const violations = detectReferenceIntegrityViolations(withRefs(anchors));
    expect(violations.length).toBeLessThanOrEqual(10);
  });
});

describe('assertReportReferenceIntegrity', () => {
  it('returns silently for an intact report', () => {
    const html = withRefs(`<a href="#ref-1">[1]</a><ol><li id="ref-1">Source.</li></ol>`);
    expect(() => assertReportReferenceIntegrity(html)).not.toThrow();
  });

  it('throws an operator-readable error naming the unresolved reference', () => {
    const html = withRefs(`<a href="#ref-7">[7]</a>`);
    let thrown: unknown;
    try {
      assertReportReferenceIntegrity(html);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ReportReferenceIntegrityError);
    const message = (thrown as Error).message;
    expect(message).toContain('ref-7');
    expect(message.length).toBeLessThan(2000);
  });
});
