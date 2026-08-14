/**
 * @file reports/__tests__/reference-anchors.test.ts
 * @description REPORT-013 — publication makes an emitted IEEE reference list
 * structurally usable.
 *
 * A synthetic fixture preserves the failure shape: a well-formed
 * `<ol class="ref-list">` with complete source URLs but no `id="ref-N"`
 * targets or `href="#ref-N"` citations. The reader sees `[5]` in the prose
 * and has no way to reach entry 5.
 *
 * Both reports also used `<span class="ref-url">` where the `cite-ieee` contract
 * and the composer use `<span class="ref-source">`, so the publication-time URL
 * normalizer — the thing that stops a legitimate `?url=https://…` source from
 * refusing the whole report — did not cover that shape.
 *
 * This normalizer is deliberately platform-owned and fragment-only. It adds no
 * off-origin authority: `#ref-N` is the one link form that survives both the
 * publication gate and the sandboxed viewer.
 */
import { normalizeReferenceAnchors, REFERENCE_LIST_CLASS_PATTERN } from '@/lib/reports/reference-anchors';
import { detectReferenceIntegrityViolations } from '@/lib/reports/reference-integrity';
import { detectExecutableReportContent } from '@/lib/reports/publication-policy';

/** Synthetic report shape that exercises reference normalization. */
const SYNTHETIC_SHAPE = `<!doctype html><html><body>
<section id="body">
  <p>Compliance spend rises 18% by 2027 [1]. Two independent filings agree [2, 3].</p>
  <p>A claim the bundle never supported [11].</p>
  <pre><code>const sample = arr[1];</code></pre>
</section>
<section id="references">
  <h2>§17 · References (IEEE Format)</h2>
  <ol class="ref-list">
    <li>
      EU Commission, "CSRD Omnibus I," accessed Aug. 1, 2026.
      <span class="ref-url">https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=COM:2025:87:FIN</span>
    </li>
    <li>
      Radarist Platform, "Graph Analytics," accessed Aug. 1, 2026.
      <span class="ref-url">radarist://graph/getGraphAnalytics</span>
    </li>
    <li>
      IEA, "World Energy Outlook 2026," accessed Aug. 1, 2026.
      <span class="ref-url">https://www.iea.org/reports/weo-2026</span>
    </li>
  </ol>
</section>
</body></html>`;

describe('REPORT-013 — reference anchors for an unlinked fixture', () => {
  it('the synthetic shape has no usable citation targets before normalization', () => {
    expect(SYNTHETIC_SHAPE).not.toMatch(/id\s*=\s*["']ref-/i);
    expect(SYNTHETIC_SHAPE).not.toMatch(/href\s*=\s*["']#ref-/i);
  });

  it('stamps one target per reference entry, in document order', () => {
    const out = normalizeReferenceAnchors(SYNTHETIC_SHAPE);
    expect(out).toContain('<li id="ref-1"');
    expect(out).toContain('<li id="ref-2"');
    expect(out).toContain('<li id="ref-3"');
    expect(out).not.toContain('id="ref-4"');
  });

  it('anchors every resolvable body marker to exactly one target', () => {
    const out = normalizeReferenceAnchors(SYNTHETIC_SHAPE);
    expect(out).toContain('<a class="cite-link" href="#ref-1"><sup class="cite">[1]</sup></a>');
    // A grouped marker resolves each of its numbers.
    expect(out).toContain('href="#ref-2"');
    expect(out).toContain('href="#ref-3"');
    expect(detectReferenceIntegrityViolations(out)).toEqual([]);
  });

  it('leaves an unresolvable marker as plain text rather than minting a dangling citation', () => {
    // `[11]` represents a citation with no matching source. Linking it would
    // turn a visible sourcing problem
    // into a publication REFUSAL for a report that publishes today, so the
    // marker stays inert and the existing creator-citations check still reports it.
    const out = normalizeReferenceAnchors(SYNTHETIC_SHAPE);
    expect(out).toContain('[11]');
    expect(out).not.toContain('href="#ref-11"');
    expect(detectReferenceIntegrityViolations(out)).toEqual([]);
  });

  it('never rewrites markers inside code, pre, script, style or the references list itself', () => {
    const out = normalizeReferenceAnchors(SYNTHETIC_SHAPE);
    expect(out).toContain('<code>const sample = arr[1];</code>');
    // The reference entries themselves must not gain citations back to themselves.
    const referencesBlock = out.slice(out.indexOf('<ol class="ref-list">'));
    expect(referencesBlock).not.toContain('cite-link');
  });

  it('is idempotent — a re-publish does not double-wrap or duplicate a target', () => {
    const once = normalizeReferenceAnchors(SYNTHETIC_SHAPE);
    const twice = normalizeReferenceAnchors(once);
    expect(twice).toBe(once);
    expect(detectReferenceIntegrityViolations(twice)).toEqual([]);
  });

  it('preserves an author who already followed the contract', () => {
    const compliant = `<ol class="ref-list"><li id="ref-1">A. Smith</li></ol>
<p>Claim <a class="cite-link" href="#ref-1"><sup class="cite">[1]</sup></a>.</p>`;
    expect(normalizeReferenceAnchors(compliant)).toBe(compliant);
  });

  it('wraps an author sup that carries the marker without an anchor', () => {
    const supOnly = `<ol class="ref-list"><li>A. Smith</li></ol><p>Claim <sup class="cite">[1]</sup>.</p>`;
    const out = normalizeReferenceAnchors(supOnly);
    expect(out).toContain('<a class="cite-link" href="#ref-1"><sup class="cite">[1]</sup></a>');
    expect(out).not.toContain('<sup class="cite">[1]</sup></sup>');
    expect(detectReferenceIntegrityViolations(out)).toEqual([]);
  });

  it('does nothing when the document has no reference list', () => {
    const noRefs = '<p>A claim [1] with nowhere to go.</p>';
    expect(normalizeReferenceAnchors(noRefs)).toBe(noRefs);
  });

  it('recognizes the reference-list class names real output uses', () => {
    for (const cls of ['ref-list', 'references-list', 'reference-list']) {
      expect(REFERENCE_LIST_CLASS_PATTERN.test(cls)).toBe(true);
    }
    expect(REFERENCE_LIST_CLASS_PATTERN.test('recommendation-list')).toBe(false);
  });
});

describe('REPORT-013 — source URLs stay recoverable without weakening the gate', () => {
  it('escapes a ref-url source that would otherwise refuse the whole report', () => {
    // The `?url=https://` form matches the publication gate's external-resource
    // rule anywhere in the stored bytes. The fixture uses `ref-url`, which the
    // pre-existing normalizer (ref-source only) never touched.
    const hostile = `<ol class="ref-list"><li><span class="ref-url">https://news.example/redirect?url=https://iea.org/weo</span></li></ol>`;
    expect(detectExecutableReportContent(hostile).length).toBeGreaterThan(0);
    const out = normalizeReferenceAnchors(hostile);
    expect(detectExecutableReportContent(out)).toEqual([]);
    // Byte-for-byte recoverable by a reader who copies the rendered text.
    expect(out).toContain('&#61;');
    expect(out).toContain('iea.org/weo');
  });

  it('flattens an off-origin anchor inside a source span to text', () => {
    const linked = `<ol class="ref-list"><li><span class="ref-url"><a href="https://iea.org/weo">IEA</a></span></li></ol>`;
    const out = normalizeReferenceAnchors(linked);
    expect(out).not.toMatch(/<a\b[^>]*href\s*=\s*["']https/i);
    expect(detectExecutableReportContent(out)).toEqual([]);
  });

  it('still refuses a hostile stylesheet — the gate keeps its full strength', () => {
    const hostileCss = `<style>body{background:url(https://evil.example/beacon.png)}</style><ol class="ref-list"><li>x</li></ol>`;
    const out = normalizeReferenceAnchors(hostileCss);
    expect(detectExecutableReportContent(out).length).toBeGreaterThan(0);
  });

  it('adds no off-origin href, anchor target or popup authority', () => {
    const out = normalizeReferenceAnchors(SYNTHETIC_SHAPE);
    const anchors = out.match(/<a\b[^>]*>/gi) ?? [];
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(anchor).toMatch(/href="#ref-\d+"/);
      expect(anchor).not.toMatch(/\btarget=/i);
      expect(anchor).not.toMatch(/\brel=/i);
    }
  });
});
