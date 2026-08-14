/**
 * REPORT-013 — the composer must preserve COMPLETE, copyable source URLs.
 *
 * Failure-first proof: commit 6d32d19e8 replaced `<a href="{url}">source</a>`
 * with hostname-only muted text. That fixed the publication-gate violation but
 * discarded the URL itself, so a reader could no longer reach — or even
 * reconstruct — the source. RC.2 keeps sources UNLINKED (no off-origin href, no
 * viewer navigation) while restoring the full URL as copyable text.
 */
import { composeReport } from '@/lib/reports/report-composer';
import { detectExecutableReportContent } from '@/lib/reports/publication-policy';
import { resolveDesignBrief } from '@/lib/schemas/design-brief';
import { reportBlocksDocSchema } from '@/lib/schemas/report-blocks';

const brief = resolveDesignBrief('user-1');

const FULL_URL = 'https://arxiv.org/abs/2601.12345v2';

/** Parse through the real schema so a malformed fixture fails here, not inside a renderer. */
async function compose(doc: unknown): Promise<string> {
  const result = await composeReport({
    doc: reportBlocksDocSchema.parse(doc),
    brief,
    missionId: 'mission-1',
    charts: async () => null,
    images: async () => null,
    generatedAt: '2026-07-31T00:00:00.000Z',
  });
  return result.html;
}

describe('composed references', () => {
  it('prints the complete source URL, not just its hostname', async () => {
    const html = await compose({
      title: 'Quantum readiness',
      blocks: [{ type: 'section', label: 'Context', title: 'Sources' }, { type: 'prose', body: 'Body text.' }, { type: 'references', items: [{ n: 1, text: 'A. Smith, "Error correction," 2026.', url: FULL_URL }] }],
    });

    expect(html).toContain('arxiv.org/abs/2601.12345v2');
    expect(html).toContain('A. Smith, &quot;Error correction,&quot; 2026.');
  });

  it('keeps the source unlinked — no off-origin anchor survives', async () => {
    const html = await compose({
      title: 'Quantum readiness',
      blocks: [{ type: 'section', label: 'Context', title: 'Sources' }, { type: 'prose', body: 'Body text.' }, { type: 'references', items: [{ n: 1, text: 'Source one.', url: FULL_URL }] }],
    });

    expect(html).not.toContain(`href="${FULL_URL}"`);
    expect(detectExecutableReportContent(html)).toEqual([]);
  });

  it('publishes a URL whose query string would otherwise trip the external-resource rule', async () => {
    // A plain-text `…?url=https://…` matches the gate's own external-resource
    // pattern. Preserving the URL must not make the report unpublishable.
    const tricky = 'https://news.example.com/redirect?url=https://target.example.com/paper';
    const html = await compose({
      title: 'Tricky source',
      blocks: [{ type: 'section', label: 'Context', title: 'Sources' }, { type: 'prose', body: 'Body text.' }, { type: 'references', items: [{ n: 1, text: 'Redirected source.', url: tricky }] }],
    });

    expect(detectExecutableReportContent(html)).toEqual([]);
  });

  it('preserves the full URL of a markdown link in prose', async () => {
    const html = await compose({
      title: 'Prose links',
      blocks: [
        { type: 'section', label: 'Context', title: 'Body' },
        { type: 'prose', body: `See [the roadmap](${FULL_URL}) for detail.` },
        { type: 'prose', body: 'Closing note.' },
      ],
    });

    expect(html).toContain('arxiv.org/abs/2601.12345v2');
    expect(html).not.toContain(`href="${FULL_URL}"`);
    expect(detectExecutableReportContent(html)).toEqual([]);
  });

  it('still renders an entry that carries no URL', async () => {
    const html = await compose({
      title: 'No URL',
      blocks: [{ type: 'section', label: 'Context', title: 'Sources' }, { type: 'prose', body: 'Body text.' }, { type: 'references', items: [{ n: 1, text: 'Internal placement ledger, Q3 2026.' }] }],
    });

    expect(html).toContain('Internal placement ledger, Q3 2026.');
  });
});
