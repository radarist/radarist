import {
  buildEvidenceProvenanceReceipt,
  scoutBundleSha256,
  verifyPublishedReportEvidence,
} from '@/lib/reports/evidence-provenance';
import type { ScoutBundle } from '@/lib/schemas/scout-bundle';

const bundle: ScoutBundle = {
  queries: ['q1', 'q2', 'q3'],
  sources: [
    {
      id: 9,
      title: 'Accepted source',
      url: 'https://example.com/source?a=1&b=2',
      fetched_via: 'exa',
      tool_call_id: 'call-9',
      admiralty: 'A1',
      date_accessed: '2026-08-05',
    },
  ],
  findings: ['Finding [9].'],
  unresolved: [],
};
const receipt = buildEvidenceProvenanceReceipt({
  sourceMissionId: 'scout-1',
  bundle,
  graphDerivedChecked: 0,
  eligibleGraphSourceIds: [],
  withheldAbsentSourceIds: [],
  withheldUnavailableSourceIds: [],
  filteredAt: '2026-08-05T00:00:00.000Z',
});

describe('evidence provenance receipt', () => {
  it('binds exact sparse source ids and printed accepted URLs', () => {
    const html = '<p>Claim [9].</p><ol><li id="ref-9">https://example.com/source?a=1&amp;b=2</li></ol>';
    expect(receipt.bundleSha256).toBe(scoutBundleSha256(bundle));
    expect(verifyPublishedReportEvidence(html, bundle, receipt)).toEqual({ ok: true, citedIds: [9] });
  });

  it('rejects renumbering, source substitution, and bundle mutation', () => {
    expect(verifyPublishedReportEvidence('<p>[1]</p><li id="ref-1">x</li>', bundle, receipt).ok).toBe(false);
    expect(verifyPublishedReportEvidence('<p>[9]</p><li id="ref-9">https://other.test</li>', bundle, receipt).ok).toBe(
      false
    );
    expect(verifyPublishedReportEvidence('<p>[9]</p>', { ...bundle, unresolved: ['changed'] }, receipt).ok).toBe(false);
  });
});
