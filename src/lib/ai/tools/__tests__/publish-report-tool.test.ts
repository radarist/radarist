/**
 * @jest-environment node
 */

import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolveDesignBrief } from '@/lib/schemas/design-brief';
import { buildEvidenceProvenanceReceipt } from '@/lib/reports/evidence-provenance';

jest.mock('node:fs/promises');
jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('@/lib/firebase-admin', () => ({ db: {} }));
jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(),
  doc: jest.fn(() => ({ id: 'doc-id' })),
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  query: jest.fn(),
  orderBy: jest.fn(),
}));
jest.mock('@/lib/reports', () => ({
  __esModule: true,
  createReport: jest.fn(),
  upsertReportBySlot: jest.fn(),
}));
jest.mock('@/lib/html-sanitizer', () => ({
  __esModule: true,
  sanitizeHtml: jest.fn((s: string) => s.replace('<script>', '').replace('</script>', '')),
  sanitizeReportHtml: jest.fn((s: string) => s.replace('<script>bad</script>', '')),
}));
// REPORT-001: delegate to the REAL analyzer by default (so the palette/brand
// fixtures below still exercise it) but keep a handle so a single test can force
// it to throw and assert the fail-closed UNREVIEWED path.
jest.mock('@/lib/mission-quality/analyzers/creator-brand-analyzer', () => {
  const actual = jest.requireActual('@/lib/mission-quality/analyzers/creator-brand-analyzer');
  return { __esModule: true, ...actual, analyzeCreatorBrand: jest.fn(actual.analyzeCreatorBrand) };
});
jest.mock('@/lib/reports/image-inline', () => ({
  __esModule: true,
  inlineImage: jest.fn(async () => ({ dataUri: 'data:image/png;base64,b3duZXItc2NvcGVk' })),
}));
jest.mock('@/lib/missions', () => ({
  __esModule: true,
  getMissionById: jest.fn(),
}));

const { upsertReportBySlot } = jest.requireMock('@/lib/reports');
const { analyzeCreatorBrand } = jest.requireMock('@/lib/mission-quality/analyzers/creator-brand-analyzer');
const { getMissionById } = jest.requireMock('@/lib/missions');
const { executePublishReport } = require('../report-tools');

describe('executePublishReport', () => {
  beforeEach(() => jest.clearAllMocks());

  const validSlots = [{ name: 'main', intent: 'x' }];

  function exactArtifactHarness() {
    const stored = new Map<string, string>();
    let draft =
      '<!doctype html><html><head><title>Draft</title><link rel="stylesheet" href="/css/report-brand.css">' +
      '<style>.report-hero{padding:2rem}</style></head><body><main class="report-hero"><h1>Decision</h1>' +
      '<p>Evidence-backed recommendation [1].</p></main>' +
      '<ol><li id="ref-1">https://example.com/source</li></ol></body></html>';
    (fs.readFile as jest.Mock).mockImplementation(async (file: string) => {
      const key = String(file);
      if (key.endsWith('public/css/report-brand.css')) {
        return ':root{--bg-primary:#ffffff;--text-primary:#111111}.report-hero{display:block}';
      }
      if (key.endsWith('/main.html')) return draft;
      const value = stored.get(key);
      if (value === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return value;
    });
    (fs.writeFile as jest.Mock).mockImplementation(async (file: string, value: string) => {
      stored.set(String(file), String(value));
    });
    const evidenceBundle = {
      queries: ['q1', 'q2', 'q3'],
      sources: [
        {
          id: 1,
          title: 'Source',
          url: 'https://example.com/source',
          fetched_via: 'exa' as const,
          tool_call_id: 'call-1',
          admiralty: 'A1',
          date_accessed: '2026-08-05',
        },
      ],
      findings: ['Supported finding [1].'],
      unresolved: [],
    };
    const context = {
      missionId: 'mission-exact-1',
      slots: validSlots,
      userId: 'u1',
      designBrief: { ...resolveDesignBrief('u1'), visualAmbition: 'rich-executive' as const },
      evidenceBundle,
      evidenceProvenance: buildEvidenceProvenanceReceipt({
        sourceMissionId: 'mission-scout-1',
        bundle: evidenceBundle,
        graphDerivedChecked: 0,
        eligibleGraphSourceIds: [],
        withheldAbsentSourceIds: [],
        withheldUnavailableSourceIds: [],
      }),
    };
    return { context, setDraft: (value: string) => (draft = value) };
  }

  it('stages, review-binds, and persists one exact self-contained export identity', async () => {
    const { context } = exactArtifactHarness();
    const staged = await executePublishReport(
      { slotName: 'main', title: 'Exact report', description: 'stage' },
      { ...context, stageOnly: true }
    );
    expect(staged.success).toBe(true);
    expect(staged.stagedExport?.exportSha256).toMatch(/^[a-f0-9]{64}$/);
    const exportSha256 = staged.stagedExport!.exportSha256;

    getMissionById.mockResolvedValue({
      skillInvocations: [
        { skill: 'design-pass', args: `review export ${exportSha256}`, firedAt: '9999-01-01T00:00:00.000Z' },
        { skill: 'critique-report', args: `critique export ${exportSha256}`, firedAt: '9999-01-01T00:00:00.000Z' },
      ],
    });
    upsertReportBySlot.mockResolvedValue({ reportId: 'r-exact', reportUrl: '/reports/r-exact', isUpsert: false });
    const published = await executePublishReport(
      {
        slotName: 'main',
        title: 'Exact report',
        description: 'published',
        expectedExportSha256: exportSha256,
      },
      context
    );

    expect(published).toEqual(expect.objectContaining({ success: true }));
    const persisted = upsertReportBySlot.mock.calls[0][0];
    expect(createHash('sha256').update(persisted.html, 'utf8').digest('hex')).toBe(exportSha256);
    expect(persisted.html).not.toContain('<link');
    expect(persisted.html).toContain('data-source="report-brand.css"');
    expect(persisted.artifactIdentity).toEqual(
      expect.objectContaining({
        sha256: exportSha256,
        revisionNumber: 0,
        reviewedBy: ['design-pass', 'critique-report'],
        evidenceBundleSha256: context.evidenceProvenance.bundleSha256,
      })
    );
  });

  it('fails closed when exact-export reviews are absent or cite another hash', async () => {
    const { context } = exactArtifactHarness();
    const staged = await executePublishReport(
      { slotName: 'main', title: 'Exact report', description: 'stage' },
      { ...context, stageOnly: true }
    );
    getMissionById.mockResolvedValue({
      skillInvocations: [
        { skill: 'design-pass', args: `review export ${'f'.repeat(64)}`, firedAt: '9999-01-01T00:00:00.000Z' },
        { skill: 'critique-report', args: `critique export ${'f'.repeat(64)}`, firedAt: '9999-01-01T00:00:00.000Z' },
      ],
    });
    const published = await executePublishReport(
      {
        slotName: 'main',
        title: 'Exact report',
        description: 'published',
        expectedExportSha256: staged.stagedExport!.exportSha256,
      },
      context
    );
    expect(published).toEqual(
      expect.objectContaining({ success: false, error: expect.stringMatching(/design-pass.*full export SHA/) })
    );
    expect(upsertReportBySlot).not.toHaveBeenCalled();
  });

  it('allows one corrective export revision and refuses a second', async () => {
    const { context, setDraft } = exactArtifactHarness();
    const stage = () =>
      executePublishReport(
        { slotName: 'main', title: 'Exact report', description: 'stage' },
        { ...context, stageOnly: true }
      );
    const initial = await stage();
    expect(initial.stagedExport?.revisionNumber).toBe(0);
    setDraft(
      '<html><head><link rel="stylesheet" href="/css/report-brand.css"></head>' +
        '<body>revision one [1]<li id="ref-1">https://example.com/source</li></body></html>'
    );
    const correction = await stage();
    expect(correction.stagedExport?.revisionNumber).toBe(1);
    setDraft(
      '<html><head><link rel="stylesheet" href="/css/report-brand.css"></head>' +
        '<body>revision two [1]<li id="ref-1">https://example.com/source</li></body></html>'
    );
    const refused = await stage();
    expect(refused).toEqual(
      expect.objectContaining({ success: false, error: expect.stringMatching(/revision limit/) })
    );
  });

  it('reads draft from FS, sanitizes, and upserts on success', async () => {
    (fs.readFile as jest.Mock).mockResolvedValue('<p>hi</p>');
    upsertReportBySlot.mockResolvedValue({
      reportId: 'report-abc',
      reportUrl: '/reports/report-abc',
      isUpsert: false,
    });

    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'm1', slots: validSlots, userId: 'u1' }
    );

    expect(fs.readFile).toHaveBeenCalledWith(expect.stringContaining('m1'), 'utf-8');
    expect(upsertReportBySlot).toHaveBeenCalledWith(
      expect.objectContaining({ missionId: 'm1', slotName: 'main', html: '<p>hi</p>' })
    );
    expect(result.success).toBe(true);
    expect(result.data?.reportId).toBe('report-abc');
    expect(result.data?.isUpsert).toBe(false);
  });

  it('REPORT-006: the publish result data carries EXACTLY {reportId, reportUrl, isUpsert} — the field set the mission prompts promise (agent/src/publish-contract.ts PUBLISH_RESULT_FIELDS); there is no shareUrl at publish time', async () => {
    (fs.readFile as jest.Mock).mockResolvedValue('<p>hi</p>');
    upsertReportBySlot.mockResolvedValue({
      reportId: 'report-abc',
      reportUrl: '/reports/report-abc',
      isUpsert: false,
    });

    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'm1', slots: validSlots, userId: 'u1' }
    );

    expect(Object.keys(result.data ?? {}).sort()).toEqual(['isUpsert', 'reportId', 'reportUrl']);
    expect(result.data?.reportUrl).toBe('/reports/report-abc');
  });

  it('rejects when slotName is not in mission manifest', async () => {
    const result = await executePublishReport(
      { slotName: 'rogue-slot', title: 'T', description: 'd' },
      { missionId: 'm1', slots: validSlots, userId: 'u1' }
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not in manifest/);
    expect(result.error).toContain('main');
    expect(upsertReportBySlot).not.toHaveBeenCalled();
  });

  it('rejects when no draft exists at the expected FS path', async () => {
    (fs.readFile as jest.Mock).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'm1', slots: validSlots, userId: 'u1' }
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no draft/i);
    expect(upsertReportBySlot).not.toHaveBeenCalled();
  });

  it('rejects when missionId is unbound', async () => {
    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { slots: validSlots }
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/missionId/);
  });

  it('returns isUpsert=true when upsertReportBySlot reports update path', async () => {
    (fs.readFile as jest.Mock).mockResolvedValue('<p>v2</p>');
    upsertReportBySlot.mockResolvedValue({
      reportId: 'report-existing',
      reportUrl: '/reports/report-existing',
      isUpsert: true,
    });
    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'm1', slots: validSlots, userId: 'u1' }
    );
    expect(result.data?.isUpsert).toBe(true);
  });

  it('sanitizes the html before passing to upsert', async () => {
    (fs.readFile as jest.Mock).mockResolvedValue('<p>hi</p><script>bad</script>');
    upsertReportBySlot.mockResolvedValue({ reportId: 'r1', reportUrl: '/reports/r1', isUpsert: false });
    await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'm1', slots: validSlots, userId: 'u1' }
    );
    const callArg = upsertReportBySlot.mock.calls[0][0];
    expect(callArg.html).not.toContain('<script>');
  });

  // Publication repairs a well-formed IEEE reference list that has complete
  // source URLs but no `id="ref-N"` targets, linking only what the author wrote.
  it('REPORT-013: publication makes an emitted reference list navigable', async () => {
    (fs.readFile as jest.Mock).mockResolvedValue(
      `<p>Compliance spend rises 18% by 2027 [1], and filings agree [2].</p>` +
        `<p>A claim with no entry [9].</p>` +
        `<ol class="ref-list"><li>EU Commission<span class="ref-url">https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=COM:2025:87:FIN</span></li>` +
        `<li>IEA<span class="ref-url">https://www.iea.org/reports/weo-2026</span></li></ol>`
    );
    upsertReportBySlot.mockResolvedValue({ reportId: 'r1', reportUrl: '/reports/r1', isUpsert: false });

    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'm1', slots: validSlots, userId: 'u1' }
    );

    expect(result.success).toBe(true);
    const html: string = upsertReportBySlot.mock.calls[0][0].html;
    expect(html).toContain('<li id="ref-1"');
    expect(html).toContain('<li id="ref-2"');
    expect(html).toContain('href="#ref-1"');
    expect(html).toContain('href="#ref-2"');
    // A marker with no entry stays inert rather than becoming a dangling
    // citation that would refuse the whole report at the integrity gate.
    expect(html).not.toContain('href="#ref-9"');
    expect(html).toContain('[9]');
    // The `?url=`-class hazard is escaped, and the URL stays copyable.
    expect(html).toContain('&#61;');
    expect(html).toContain('eur-lex.europa.eu/legal-content/EN/TXT/');
    // Fragment-only: publication grants no off-origin navigation authority.
    expect(html).not.toMatch(/<a\b[^>]*href\s*=\s*["']https?:/i);
  });

  it('REPORT-013: a report with no reference list publishes byte-identically', async () => {
    const draft = '<p>A short note with no sources and a stray [1] marker.</p>';
    (fs.readFile as jest.Mock).mockResolvedValue(draft);
    upsertReportBySlot.mockResolvedValue({ reportId: 'r1', reportUrl: '/reports/r1', isUpsert: false });

    await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'm1', slots: validSlots, userId: 'u1' }
    );

    expect(upsertReportBySlot.mock.calls[0][0].html).toBe(draft);
  });
});

describe('executePublishReport — design-pass SOFT gate (P4, fail-open)', () => {
  beforeEach(() => jest.clearAllMocks());
  const validSlots = [{ name: 'main', intent: 'x' }];
  const { resolveDesignBrief } = require('@/lib/schemas/design-brief');
  const wrap = (svg: string) =>
    `<html><head><link rel="stylesheet" href="/css/report-brand.css" /></head><body>${svg}${'x'.repeat(220)}</body></html>`;

  // An advisory-only report (off-palette chart fill — the deliberately
  // non-blocking chart-palette check) is PASS/published: an advisory is not a
  // failed review, and the L1 path never REVISEs it, so withholding it would
  // leave it permanently invisible with no recovery. The advisory is still
  // recorded in designPassDetails for visibility.
  it('publishes an advisory-only report as PASS/published but records the advisory', async () => {
    (fs.readFile as jest.Mock).mockResolvedValue(wrap('<svg><rect fill="#ff00ff" /></svg>'));
    upsertReportBySlot.mockResolvedValue({ reportId: 'r1', reportUrl: '/reports/r1', isUpsert: false });

    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'm1', slots: validSlots, userId: 'u1', designBrief: resolveDesignBrief('u1') }
    );

    expect(result.success).toBe(true); // publish never blocked
    expect(upsertReportBySlot).toHaveBeenCalled();
    expect(result.designPassVerdict).toBe('PASS'); // advisory ≠ FAIL
    expect(result.designPassDetails).toContain('chart-palette-conformance'); // still recorded
    expect(result.reviewStatus).toBe('published'); // NOT withheld
    expect(upsertReportBySlot).toHaveBeenCalledWith(
      expect.objectContaining({ reviewStatus: 'published', designPassVerdict: 'PASS' })
    );
  });

  // Brand violations were advisory while the writer had no corresponding
  // authoring contract. REPORT-015 delivers the DesignBrief to the
  // writer, so the two checks the brief makes satisfiable — the verbatim
  // stylesheet link and the analyzer's own BRAND_VARIABLES list — are armed
  // again. Everything else stays recorded-only.
  it('REPORT-015: withholds when an ARMED brand check fails (brand token shadowed)', async () => {
    // COORD-017: variable shadowing is the remaining armed brand check — the
    // authored CSS survives into the final export, so a shadowed brand token
    // genuinely changes rendered pixels.
    const shadowing = `<html><head><link rel="stylesheet" href="/css/report-brand.css" />
      <style>:root{--accent-gold:#ff0000}</style></head>
      <body><p>report body</p>${'x'.repeat(220)}</body></html>`;
    (fs.readFile as jest.Mock).mockResolvedValue(shadowing);
    upsertReportBySlot.mockResolvedValue({ reportId: 'r-fail', reportUrl: '/reports/r-fail', isUpsert: false });

    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'm1', slots: validSlots, userId: 'u1', designBrief: resolveDesignBrief('u1') }
    );

    expect(result.success).toBe(true); // publish itself is still never blocked
    expect(result.designPassVerdict).toBe('FAIL');
    expect(result.reviewStatus).toBe('needs-review');
    expect(upsertReportBySlot).toHaveBeenCalledWith(
      expect.objectContaining({ reviewStatus: 'needs-review', designPassVerdict: 'FAIL' })
    );
  });

  it('COORD-017: records a missing brand link as telemetry without withholding the pixel-identical export', async () => {
    // The product exporter strips every <link> and inlines the brand CSS bytes
    // regardless of the authored link, so its absence cannot change a rendered
    // pixel — it is an authoring-method marker, not visual-design authority.
    const noBrandCss = `<html><head></head><body><p>report body</p>${'x'.repeat(220)}</body></html>`;
    (fs.readFile as jest.Mock).mockResolvedValue(noBrandCss);
    upsertReportBySlot.mockResolvedValue({ reportId: 'r-link', reportUrl: '/reports/r-link', isUpsert: false });

    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'm1', slots: validSlots, userId: 'u1', designBrief: resolveDesignBrief('u1') }
    );

    expect(result.success).toBe(true);
    expect(result.designPassVerdict).toBe('FAIL'); // telemetry retained
    expect(result.designPassDetails).toContain('brand-stylesheet-linked');
    expect(result.reviewStatus).toBe('published'); // NOT withheld
  });

  it('REPORT-015: still PUBLISHES when only a NON-armed brand check fails', async () => {
    // Brand stylesheet linked and no shadowed tokens, but the citation markup
    // omits class="cite" — a recorded-only check. The brief does not make the
    // citation/class-count rules deterministically satisfiable, so they must not
    // strand the report the way the un-briefed gate once stranded 16/16.
    const body = `<html><head><link rel="stylesheet" href="/css/report-brand.css" /></head>
      <body><p>report body<sup>[1]</sup></p>${'x'.repeat(220)}</body></html>`;
    (fs.readFile as jest.Mock).mockResolvedValue(body);
    upsertReportBySlot.mockResolvedValue({ reportId: 'r-adv', reportUrl: '/reports/r-adv', isUpsert: false });

    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'm1', slots: validSlots, userId: 'u1', designBrief: resolveDesignBrief('u1') }
    );

    expect(result.success).toBe(true);
    expect(result.designPassVerdict).toBe('FAIL'); // telemetry retained
    expect(result.designPassDetails).toContain('citations-use-cite-class');
    expect(result.reviewStatus).toBe('published'); // NOT withheld
  });

  it('REPORT-015: a brief-less mission keeps the pre-arming behaviour exactly', async () => {
    // No designBrief reached the writer, so no brand rule may withhold.
    const noBrandCss = `<html><head></head><body><p>report body</p>${'x'.repeat(220)}</body></html>`;
    (fs.readFile as jest.Mock).mockResolvedValue(noBrandCss);
    upsertReportBySlot.mockResolvedValue({ reportId: 'r-nb', reportUrl: '/reports/r-nb', isUpsert: false });

    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'm1', slots: validSlots, userId: 'u1' }
    );

    expect(result.designPassVerdict).toBe('FAIL');
    expect(result.reviewStatus).toBe('published');
  });

  it('T1.3: user brand-light brief + no brand link → clean PASS (no dark-brand gating)', async () => {
    const noBrandCss = `<html><head></head><body><p>light report</p>${'x'.repeat(220)}</body></html>`;
    (fs.readFile as jest.Mock).mockResolvedValue(noBrandCss);
    upsertReportBySlot.mockResolvedValue({ reportId: 'r-light', reportUrl: '/reports/r-light', isUpsert: false });

    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      {
        missionId: 'm1',
        slots: validSlots,
        userId: 'u1',
        designBrief: resolveDesignBrief('u1', { theme: 'brand-light', source: 'user' }),
      }
    );

    expect(result.designPassVerdict).toBe('PASS');
    expect(result.reviewStatus).toBe('published');
  });

  it('records PASS for an on-brand report', async () => {
    (fs.readFile as jest.Mock).mockResolvedValue(wrap('<svg><rect fill="#d4a84b" /></svg>'));
    upsertReportBySlot.mockResolvedValue({ reportId: 'r2', reportUrl: '/reports/r2', isUpsert: false });

    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'm1', slots: validSlots, userId: 'u1', designBrief: resolveDesignBrief('u1') }
    );

    expect(result.success).toBe(true);
    expect(result.designPassVerdict).toBe('PASS');
    // REPORT-001: a PASSing design review publishes a final report.
    expect(result.reviewStatus).toBe('published');
    expect(upsertReportBySlot).toHaveBeenCalledWith(
      expect.objectContaining({ reviewStatus: 'published', designPassVerdict: 'PASS' })
    );
  });

  it('runs the design gate even without a brief (REPORT-003 — brief-less publishes no longer skip review)', async () => {
    // A brief-less publish must not skip the design gate.
    (fs.readFile as jest.Mock).mockResolvedValue(wrap('<svg><rect fill="#ff00ff" /></svg>'));
    upsertReportBySlot.mockResolvedValue({ reportId: 'r3', reportUrl: '/reports/r3', isUpsert: false });

    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'm1', slots: validSlots, userId: 'u1' }
    );

    expect(result.success).toBe(true);
    // The gate ran — the REAL brand analyzer (requireActual) on an on-brand
    // fixture — and stamped a verdict where a brief-less publish previously
    // recorded none at all.
    expect(result.designPassVerdict).toBe('PASS');
    expect(result.reviewStatus).toBe('published');
    expect(upsertReportBySlot.mock.calls[0][0].reviewStatus).toBe('published');
  });

  it('withholds a brief-less publish whose authored CSS fails the WCAG-contrast floor (REPORT-003)', async () => {
    (fs.readFile as jest.Mock).mockResolvedValue(
      wrap(
        '<style>.final-verdict-title{color:#e8eaf0;background:#ffffff}</style><div class="final-verdict-title">Adopt now</div>'
      )
    );
    upsertReportBySlot.mockResolvedValue({ reportId: 'r7', reportUrl: '/reports/r7', isUpsert: false });

    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'm1', slots: validSlots, userId: 'u1' }
    );

    expect(result.success).toBe(true);
    expect(result.designPassVerdict).toBe('FAIL');
    expect(result.reviewStatus).toBe('needs-review');
    expect(result.designPassDetails).toMatch(/minimum-contrast/);
    expect(result.designPassDetails).toMatch(/1\.2\d:1/);
    expect(upsertReportBySlot).toHaveBeenCalledWith(
      expect.objectContaining({ reviewStatus: 'needs-review', designPassVerdict: 'FAIL' })
    );
  });

  it('marks the artifact UNREVIEWED / needs-review (never silent PASS) when the design analyzer throws', async () => {
    analyzeCreatorBrand.mockImplementationOnce(() => {
      throw new Error('analyzer boom');
    });
    (fs.readFile as jest.Mock).mockResolvedValue(wrap('<svg><rect fill="#d4a84b" /></svg>'));
    upsertReportBySlot.mockResolvedValue({ reportId: 'r6', reportUrl: '/reports/r6', isUpsert: false });

    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'm1', slots: validSlots, userId: 'u1', designBrief: resolveDesignBrief('u1') }
    );

    // Publish still succeeds (a gate error must not block), but the artifact is
    // withheld as visibly UNREVIEWED — never treated as a passed design review.
    expect(result.success).toBe(true);
    expect(result.designPassVerdict).toBe('UNREVIEWED');
    expect(result.reviewStatus).toBe('needs-review');
    expect(upsertReportBySlot).toHaveBeenCalledWith(
      expect.objectContaining({ reviewStatus: 'needs-review', designPassVerdict: 'UNREVIEWED' })
    );
  });

  it('T1.2: the publish path injects the :root block and PRESERVES authored colors byte-for-byte', async () => {
    // A report whose agent hardcoded a near-black table-header background.
    (fs.readFile as jest.Mock).mockResolvedValue(
      wrap('<style>th{background:#0f172a;color:#fff}</style><table><tr><th>H</th></tr></table>')
    );
    upsertReportBySlot.mockResolvedValue({ reportId: 'r4', reportUrl: '/reports/r4', isUpsert: false });

    await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      {
        missionId: 'm1',
        slots: validSlots,
        userId: 'u1',
        designBrief: resolveDesignBrief('u1', { theme: 'brand-light' }),
      }
    );

    const publishedHtml = upsertReportBySlot.mock.calls[0][0].html as string;
    expect(publishedHtml).toContain('data-design-pass="page-theme"'); // page theme injected by the pipeline
    expect(publishedHtml).toMatch(/background[^;}]*:\s*#0f172a/i); // T1.2: authored surfaces preserved
    expect(publishedHtml).toMatch(/color\s*:\s*#fff\b/i); // T1.2: authored text preserved
  });

  it('reviews the exact final themed HTML and withholds a custom white-on-white palette', async () => {
    (fs.readFile as jest.Mock).mockResolvedValue(wrap('<h1>Readable before the platform theme</h1>'));
    upsertReportBySlot.mockResolvedValue({
      reportId: 'r-theme-fail',
      reportUrl: '/reports/r-theme-fail',
      isUpsert: false,
    });
    const unsafeBrief = resolveDesignBrief('u1', {
      theme: 'custom',
      palette: {
        bg: '#ffffff',
        surface: '#ffffff',
        ink: '#ffffff',
        accent: '#ffffff',
        sequence: ['#ffffff'],
      },
    });

    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'm1', slots: validSlots, userId: 'u1', designBrief: unsafeBrief }
    );

    const publishedHtml = upsertReportBySlot.mock.calls[0][0].html as string;
    const { analyzeReportContrast } = require('@/lib/mission-quality/analyzers/report-design-contrast');
    expect(publishedHtml).toContain('html,body{background:#ffffff;color:#ffffff;}');
    expect(analyzeReportContrast(publishedHtml).ok).toBe(false);
    expect(result.designPassVerdict).toBe('FAIL');
    expect(result.reviewStatus).toBe('needs-review');
    expect(result.designPassDetails).toMatch(/1\.00:1/);
  });

  it('page-theme: no brief → html is published unchanged (no theme block injected)', async () => {
    (fs.readFile as jest.Mock).mockResolvedValue(wrap('<style>th{background:#0f172a}</style><table></table>'));
    upsertReportBySlot.mockResolvedValue({ reportId: 'r5', reportUrl: '/reports/r5', isUpsert: false });

    await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'm1', slots: validSlots, userId: 'u1' }
    );

    const publishedHtml = upsertReportBySlot.mock.calls[0][0].html as string;
    expect(publishedHtml).not.toContain('data-design-pass="page-theme"');
    expect(publishedHtml).toContain('#0f172a'); // untouched when there is no brief (back-compat)
  });
});

// ---------------------------------------------------------------------------
// REPORT-012 T2.6 — template mode (REPORT_COMPOSER_MODE=template): a
// structured blocks draft is server-composed, verified, and published; legacy
// html drafts keep the exact pre-existing path.
// ---------------------------------------------------------------------------
describe('executePublishReport — template mode (T2.6)', () => {
  const validSlots = [{ name: 'main', intent: 'x' }];
  const { resolveDesignBrief } = require('@/lib/schemas/design-brief');
  const SIGNED_SVG = '<svg data-radarist-super-graph-sha256="cafe01" viewBox="0 0 10 10"><rect fill="#d4a84b"/></svg>';

  const blocksDoc = JSON.stringify({
    title: 'Composed Canary',
    blocks: [
      { type: 'section', label: 'Summary', title: 'One page' },
      { type: 'prose', body: 'Claim [1].' },
      { type: 'chart-ref', chartId: 'sankey-x-1', title: 'Flows' },
      { type: 'references', items: [{ n: 1, text: 'Source' }] },
    ],
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REPORT_COMPOSER_MODE = 'template';
    jest.doMock('@/lib/super-graph/chart-cache', () => ({
      __esModule: true,
      getChartSvg: jest.fn(async (_m: string, id: string) => (id === 'sankey-x-1' ? SIGNED_SVG : null)),
      getImageUrl: jest.fn(async () => null),
    }));
  });
  afterEach(() => {
    delete process.env.REPORT_COMPOSER_MODE;
    jest.dontMock('@/lib/super-graph/chart-cache');
  });

  it('composes a blocks draft: brand link, byte-exact chart, composer marker, published', async () => {
    (fs.readFile as jest.Mock).mockImplementation(async (p: string) => {
      if (String(p).endsWith('.blocks.json')) return blocksDoc;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    upsertReportBySlot.mockResolvedValue({ reportId: 'r-comp', reportUrl: '/reports/r-comp', isUpsert: false });

    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'mission-tmpl-1', slots: validSlots, userId: 'u1', designBrief: resolveDesignBrief('u1') }
    );

    expect(result.success).toBe(true);
    const persisted = upsertReportBySlot.mock.calls[0][0].html as string;
    expect(persisted).toContain('/css/report-brand.css');
    expect(persisted).toContain(SIGNED_SVG); // byte-exact by-reference chart
    expect(persisted).toContain('data-composer="v1"');
    expect(result.reviewStatus).toBe('published');
  });

  it('binds a persisted figure plan to composed chart bytes before publication', async () => {
    const plannedDoc = JSON.stringify({
      title: 'Planned chart',
      blocks: [
        { type: 'section', label: 'Summary', title: 'One page' },
        { type: 'prose', body: 'Claim [1].' },
        { type: 'chart-ref', chartId: 'sankey-x-1', figureId: 'fig-flow', title: 'Flows' },
        { type: 'references', items: [{ n: 1, text: 'Source' }] },
      ],
    });
    const plan = JSON.stringify([
      {
        figureId: 'fig-flow',
        readerQuestion: 'How does evidence move through the flow?',
        visualKind: 'sankey',
        findingIds: [1],
        sourceIds: [1],
      },
    ]);
    (fs.readFile as jest.Mock).mockImplementation(async (p: string) => {
      if (String(p).endsWith('.blocks.json')) return plannedDoc;
      if (String(p).endsWith('.figure-plan.json')) return plan;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    upsertReportBySlot.mockResolvedValue({ reportId: 'r-plan', reportUrl: '/reports/r-plan', isUpsert: false });

    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'mission-tmpl-plan', slots: validSlots, userId: 'u1', designBrief: resolveDesignBrief('u1') }
    );

    expect(result.success).toBe(true);
    const persisted = upsertReportBySlot.mock.calls[0][0].html as string;
    expect(persisted).toContain('data-figure-id="fig-flow"');
    expect(persisted).toContain('data-figure-plan-sha256=');
    expect(persisted).toContain('Evidence: findings F1; sources [1].');
  });

  it('passes the authenticated report owner into image inlining', async () => {
    const imageDoc = JSON.stringify({
      title: 'Owner-scoped image',
      blocks: [
        { type: 'section', label: 'Summary', title: 'One page' },
        { type: 'prose', body: 'Claim.' },
        { type: 'image-ref', imageId: 'viz-owner-1', alt: 'Decision map' },
      ],
    });
    (fs.readFile as jest.Mock).mockImplementation(async (p: string) => {
      if (String(p).endsWith('.blocks.json')) return imageDoc;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const chartCache = jest.requireMock('@/lib/super-graph/chart-cache');
    chartCache.getImageUrl.mockResolvedValueOnce(
      'https://storage.googleapis.com/test-bucket/visualizations/u1/viz-owner-1.png'
    );
    upsertReportBySlot.mockResolvedValue({ reportId: 'r-image', reportUrl: '/reports/r-image', isUpsert: false });

    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'mission-tmpl-image', slots: validSlots, userId: 'u1', designBrief: resolveDesignBrief('u1') }
    );

    expect(result.success).toBe(true);
    const { inlineImage } = jest.requireMock('@/lib/reports/image-inline');
    expect(inlineImage).toHaveBeenCalledWith(
      'https://storage.googleapis.com/test-bucket/visualizations/u1/viz-owner-1.png',
      { ownerId: 'u1' }
    );
  });

  it('blocks publish with actionable findings when a cite has no reference', async () => {
    const badDoc = JSON.stringify({
      title: 'Broken cites',
      blocks: [
        { type: 'section', label: 'S', title: 'S' },
        { type: 'prose', body: 'Claim [7].' },
        { type: 'prose', body: 'More.' },
      ],
    });
    (fs.readFile as jest.Mock).mockImplementation(async (p: string) => {
      if (String(p).endsWith('.blocks.json')) return badDoc;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'mission-tmpl-2', slots: validSlots, userId: 'u1', designBrief: resolveDesignBrief('u1') }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('composition verify failed');
    expect(result.error).toContain('[7]');
    expect(upsertReportBySlot).not.toHaveBeenCalled();
  });

  it('flag off → blocks draft ignored, legacy html path byte-identical', async () => {
    delete process.env.REPORT_COMPOSER_MODE;
    (fs.readFile as jest.Mock).mockImplementation(async (p: string) => {
      if (String(p).endsWith('.blocks.json')) return blocksDoc;
      return wrapLegacy('<p>legacy body</p>');
    });
    upsertReportBySlot.mockResolvedValue({ reportId: 'r-leg', reportUrl: '/reports/r-leg', isUpsert: false });

    const result = await executePublishReport(
      { slotName: 'main', title: 'T', description: 'd' },
      { missionId: 'mission-tmpl-3', slots: validSlots, userId: 'u1' }
    );
    expect(result.success).toBe(true);
    const persisted = upsertReportBySlot.mock.calls[0][0].html as string;
    expect(persisted).toContain('legacy body');
    expect(persisted).not.toContain('data-composer="v1"');
  });

  function wrapLegacy(body: string): string {
    return `<html><head><link rel="stylesheet" href="/css/report-brand.css" /></head><body>${body}${'x'.repeat(220)}</body></html>`;
  }
});
