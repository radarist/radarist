import { render, screen, waitFor } from '@testing-library/react';
import type { Report } from '@/lib/schemas/report';

jest.mock('@/lib/reports', () => ({
  getReportById: jest.fn(),
}));

import ShareReportPage, { generateMetadata } from '../page';
import { SHARE_REPORT_IFRAME_SANDBOX } from '../share-iframe';
import { getReportById } from '@/lib/reports';

const mockGetReportById = getReportById as jest.MockedFunction<typeof getReportById>;

const PRIVATE_TITLE = 'Confidential acquisition analysis';
const PRIVATE_DESCRIPTION = 'Material non-public strategy details';
const REPORT_HTML = '<html><body>private report</body></html>';

const SHARED_REPORT: Report = {
  id: 'report-private',
  title: PRIVATE_TITLE,
  html: REPORT_HTML,
  createdAt: '2026-07-11T10:00:00.000Z',
  createdBy: 'user',
  ownerId: 'local-operator',
  entityIds: [],
  metadata: {
    description: PRIVATE_DESCRIPTION,
    dataSnapshotAt: '2026-07-11T09:00:00.000Z',
  },
  shared: true,
};

function reportWithSharedValue(shared: unknown): Report {
  const report: Record<string, unknown> = {
    ...SHARED_REPORT,
    metadata: { ...SHARED_REPORT.metadata },
  };

  if (shared === undefined) {
    delete report.shared;
  } else {
    report.shared = shared;
  }

  // Firestore is a legacy data boundary and can contain records created before
  // the current schema, or malformed values written outside the application.
  return report as unknown as Report;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('SHARE_REPORT_IFRAME_SANDBOX', () => {
  it('grants no report-authored capability', () => {
    expect(SHARE_REPORT_IFRAME_SANDBOX).toBe('');
  });
});

describe('public report sharing policy', () => {
  it.each([
    ['missing', undefined],
    ['false', false],
    ['malformed truthy', 'true'],
  ])('fails closed for a %s shared value in metadata', async (_label, shared) => {
    mockGetReportById.mockResolvedValue(reportWithSharedValue(shared));

    const metadata = await generateMetadata({ params: Promise.resolve({ id: SHARED_REPORT.id }) });

    expect(metadata).toEqual({
      title: 'Report Not Shared',
      description: 'This report is not publicly shared.',
    });
    expect(JSON.stringify(metadata)).not.toContain(PRIVATE_TITLE);
    expect(JSON.stringify(metadata)).not.toContain(PRIVATE_DESCRIPTION);
  });

  it.each([
    ['missing', undefined],
    ['false', false],
    ['malformed truthy', 'true'],
  ])('fails closed for a %s shared value in the rendered page', async (_label, shared) => {
    mockGetReportById.mockResolvedValue(reportWithSharedValue(shared));

    const { container } = render(await ShareReportPage({ params: Promise.resolve({ id: SHARED_REPORT.id }) }));

    expect(screen.getByRole('heading', { name: 'Report Not Shared' })).toBeInTheDocument();
    expect(container.querySelector('iframe')).not.toBeInTheDocument();
    expect(container.textContent).not.toContain(PRIVATE_TITLE);
    expect(container.textContent).not.toContain(PRIVATE_DESCRIPTION);
    expect(container.innerHTML).not.toContain('private report');
  });

  it('withholds metadata for a needs-review draft even with a stale shared:true', async () => {
    // Reachable state: a shared report whose later revision failed the design
    // gate — reviewStatus flips to needs-review while shared stays true. The
    // body already fails closed; metadata must not leak title/description.
    mockGetReportById.mockResolvedValue({
      ...SHARED_REPORT,
      reviewStatus: 'needs-review',
      shared: true,
    } as Report);

    const metadata = await generateMetadata({ params: Promise.resolve({ id: SHARED_REPORT.id }) });

    expect(metadata).toEqual({
      title: 'Report Not Available',
      description: 'This report is a draft pending review and is not publicly available.',
    });
    expect(JSON.stringify(metadata)).not.toContain(PRIVATE_TITLE);
    expect(JSON.stringify(metadata)).not.toContain(PRIVATE_DESCRIPTION);
  });

  it('withholds the rendered page for a needs-review draft even with a stale shared:true', async () => {
    mockGetReportById.mockResolvedValue({
      ...SHARED_REPORT,
      reviewStatus: 'needs-review',
      shared: true,
    } as Report);

    const { container } = render(await ShareReportPage({ params: Promise.resolve({ id: SHARED_REPORT.id }) }));

    expect(screen.getByRole('heading', { name: 'Report Not Available' })).toBeInTheDocument();
    expect(container.querySelector('iframe')).not.toBeInTheDocument();
    expect(container.textContent).not.toContain(PRIVATE_TITLE);
    expect(container.innerHTML).not.toContain('private report');
  });

  it('exposes metadata and content only for an explicit boolean true', async () => {
    mockGetReportById.mockResolvedValue(SHARED_REPORT);

    const metadata = await generateMetadata({ params: Promise.resolve({ id: SHARED_REPORT.id }) });
    expect(metadata).toMatchObject({
      title: PRIVATE_TITLE,
      description: PRIVATE_DESCRIPTION,
      openGraph: {
        title: PRIVATE_TITLE,
        description: PRIVATE_DESCRIPTION,
      },
    });

    mockGetReportById.mockResolvedValue(SHARED_REPORT);
    const { container } = render(await ShareReportPage({ params: Promise.resolve({ id: SHARED_REPORT.id }) }));

    const iframe = await screen.findByTitle(PRIVATE_TITLE);
    expect(container.querySelectorAll(`iframe[title="${PRIVATE_TITLE}"]`)).toHaveLength(1);
    expect(iframe).toHaveAttribute('sandbox', '');
    expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
    await waitFor(() => expect(iframe.getAttribute('srcdoc')).toContain('private report'));
  });

  it('uses the static parser boundary for malicious public report HTML', async () => {
    const report = {
      ...SHARED_REPORT,
      html: `<!doctype html><html><head>
        <meta http-equiv="refresh" content="0;url=https://attacker.invalid">
        <script>parent.document.body.dataset.pwned = 'true'</script>
      </head><body>
        <h1 onclick="alert('x')">Static evidence</h1>
        <details><summary>Details</summary><p>Preserved prose</p></details>
        <svg><circle cx="5" cy="5" r="5"></circle></svg>
        <a id="external" href="https://attacker.invalid/open" target="_top">Leave</a>
        <a id="fragment" href="#evidence">Evidence</a>
        <img id="external-image" src="https://attacker.invalid/pixel.png">
        <img id="embedded-image" src="data:image/png;base64,AA==">
        <form action="/api/mutate"><button>Submit</button></form>
        <iframe src="https://attacker.invalid/frame"></iframe>
      </body></html>`,
    };
    mockGetReportById.mockResolvedValue(report);

    render(await ShareReportPage({ params: Promise.resolve({ id: report.id }) }));
    const iframe = await screen.findByTitle(PRIVATE_TITLE);
    await waitFor(() => expect(iframe.getAttribute('srcdoc')).toContain('Static evidence'));

    const frameDocument = new DOMParser().parseFromString(iframe.getAttribute('srcdoc') ?? '', 'text/html');
    expect(frameDocument.head.firstElementChild).toMatchObject({
      tagName: 'META',
    });
    expect(frameDocument.head.firstElementChild?.getAttribute('content')).toContain("script-src 'none'");
    expect(frameDocument.querySelector('script, form, iframe, meta[http-equiv="refresh"]')).toBeNull();
    expect(frameDocument.querySelector('[onclick]')).toBeNull();
    expect(frameDocument.querySelector('#external')?.getAttribute('href')).toBeNull();
    expect(frameDocument.querySelector('#external-image')?.getAttribute('src')).toBeNull();
    expect(frameDocument.querySelector('#fragment')?.getAttribute('href')).toBe('#evidence');
    expect(frameDocument.querySelector('#embedded-image')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
    expect(frameDocument.querySelector('details p')?.textContent).toBe('Preserved prose');
    expect(frameDocument.querySelector('svg circle')).not.toBeNull();
  });

  it('escapes report fields that could close the JSON-LD script outside the sandbox', async () => {
    const injection = '</script><script>window.reportInjection = true</script>';
    const report = {
      ...SHARED_REPORT,
      title: injection,
      metadata: { ...SHARED_REPORT.metadata, description: injection },
    };
    mockGetReportById.mockResolvedValue(report);

    const { container } = render(await ShareReportPage({ params: Promise.resolve({ id: SHARED_REPORT.id }) }));

    const jsonLd = container.querySelector('script[type="application/ld+json"]');
    expect(jsonLd).not.toBeNull();
    expect(jsonLd?.innerHTML).not.toContain('</script>');
    expect(container.querySelectorAll('script')).toHaveLength(1);
    expect(JSON.parse(jsonLd?.innerHTML ?? '{}')).toEqual(
      expect.objectContaining({ headline: injection, description: injection })
    );
    const iframe = await screen.findByTitle(injection);
    await waitFor(() => expect(iframe.getAttribute('srcdoc')).not.toBe(''));
  });

  it('renders an explicitly shared legacy report with missing metadata safely', async () => {
    const legacy = { ...SHARED_REPORT } as unknown as Record<string, unknown>;
    delete legacy.metadata;
    mockGetReportById.mockResolvedValue(legacy as unknown as Report);

    const metadata = await generateMetadata({ params: Promise.resolve({ id: SHARED_REPORT.id }) });
    expect(metadata).toMatchObject({
      title: PRIVATE_TITLE,
      description: 'Shared report generated by Radarist.',
    });

    mockGetReportById.mockResolvedValue(legacy as unknown as Report);
    render(await ShareReportPage({ params: Promise.resolve({ id: SHARED_REPORT.id }) }));
    const iframe = await screen.findByTitle(PRIVATE_TITLE);
    expect(iframe).toBeInTheDocument();
    await waitFor(() => expect(iframe.getAttribute('srcdoc')).not.toBe(''));
  });
});
