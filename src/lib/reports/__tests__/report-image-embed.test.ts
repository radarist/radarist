/**
 * REPORT-013 — bounded image embedding for the shipped legacy report path.
 *
 * Failure-first proof: in-report images shipped until the July gate era and then
 * hit zero, because the only imageId -> bounded `data:` URI bridge lived in the
 * default-off composer branch. This module is that bridge for the legacy path.
 * It resolves ONLY ids minted by this mission's own image cache — an agent can
 * never hand it a remote URL — and every byte still passes through the existing
 * owner-scoped `inlineImage` boundary.
 */
import {
  MAX_EMBEDDED_REPORT_IMAGES,
  REPORT_FIGURE_IMAGE_CLASS,
  REPORT_IMAGE_ID_ATTRIBUTE,
} from '@/lib/reports/publication-contract';
import { resolveReportImageEmbeds } from '@/lib/reports/report-image-embed';

const DATA_URI = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

function deps(overrides: Partial<Parameters<typeof resolveReportImageEmbeds>[1]> = {}) {
  return {
    resolveImageUrl: jest.fn(async (imageId: string) =>
      imageId === 'img-known' ? 'https://firebasestorage.googleapis.com/owned.png' : null
    ),
    inlineImage: jest.fn(async () => ({ dataUri: DATA_URI, bytes: 1024 })),
    ...overrides,
  };
}

describe('resolveReportImageEmbeds', () => {
  it('replaces an image-id placeholder with a bounded data: URI', async () => {
    const html = `<p>Before</p><img ${REPORT_IMAGE_ID_ATTRIBUTE}="img-known" alt="Adoption curve">`;
    const result = await resolveReportImageEmbeds(html, deps());

    expect(result.embedded).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.html).toContain(`src="${DATA_URI}"`);
    expect(result.html).toContain('alt="Adoption curve"');
    // The placeholder must not survive into the stored document.
    expect(result.html).not.toContain(REPORT_IMAGE_ID_ATTRIBUTE);
  });

  // REPORT-014: the embedded image must arrive BOUNDED. Before this, publication
  // forwarded only `alt`, so the image carried no width constraint from any
  // source — report-brand.css defined no image rule, and the composer's
  // `.report-figure img { max-width: 100% }` floor is composer-path-only. A
  // 1200px generated infographic then pushed the document past the viewport.
  it('stamps the responsive figure class the stylesheet bounds', async () => {
    const html = `<img ${REPORT_IMAGE_ID_ATTRIBUTE}="img-known" alt="Adoption curve">`;
    const result = await resolveReportImageEmbeds(html, deps());

    expect(result.html).toContain(`class="${REPORT_FIGURE_IMAGE_CLASS}"`);
    expect(result.html).toContain('alt="Adoption curve"');
  });

  it('does not forward an author class or any other attribute from the draft', async () => {
    // The draft may only choose WHICH image; how it renders is the platform's.
    const html = `<img ${REPORT_IMAGE_ID_ATTRIBUTE}="img-known" class="infographic-img" width="1200" onload="x()" alt="Curve">`;
    const result = await resolveReportImageEmbeds(html, deps());

    expect(result.html).not.toContain('infographic-img');
    expect(result.html).not.toContain('width="1200"');
    expect(result.html).not.toContain('onload');
    expect(result.html).toContain(`class="${REPORT_FIGURE_IMAGE_CLASS}"`);
  });

  it('leaves HTML untouched when it references no images', async () => {
    const html = '<p>No visuals here.</p>';
    const d = deps();
    const result = await resolveReportImageEmbeds(html, d);

    expect(result.html).toBe(html);
    expect(result.embedded).toBe(0);
    expect(d.resolveImageUrl).not.toHaveBeenCalled();
  });

  it('never resolves an agent-supplied remote URL — only ids from the mission cache', async () => {
    const html = '<img src="https://evil.example.com/tracker.png" alt="Remote">';
    const d = deps();
    const result = await resolveReportImageEmbeds(html, d);

    expect(d.resolveImageUrl).not.toHaveBeenCalled();
    expect(d.inlineImage).not.toHaveBeenCalled();
    // Untouched: the publication gate remains the authority that rejects it.
    expect(result.html).toContain('https://evil.example.com/tracker.png');
    expect(result.embedded).toBe(0);
  });

  it('reports an unknown image id as a truthful visible failure, never a silent claim', async () => {
    const html = `<img ${REPORT_IMAGE_ID_ATTRIBUTE}="img-missing" alt="Missing figure">`;
    const result = await resolveReportImageEmbeds(html, deps());

    expect(result.embedded).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ imageId: 'img-missing' });
    // No <img> may survive claiming an image that is not there.
    expect(result.html).not.toContain('<img');
    expect(result.html).not.toContain(REPORT_IMAGE_ID_ATTRIBUTE);
    // The reader is told, in the document, that the visual is unavailable.
    expect(result.html).toMatch(/unavailable/i);
    expect(result.html).toContain('Missing figure');
  });

  it('surfaces an inlining failure the same truthful way', async () => {
    const html = `<img ${REPORT_IMAGE_ID_ATTRIBUTE}="img-known" alt="Too big">`;
    const result = await resolveReportImageEmbeds(
      html,
      deps({
        inlineImage: jest.fn(async () => {
          throw new Error('image-inline: image is 900000 bytes after max compression');
        }),
      })
    );

    expect(result.embedded).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toContain('image-inline');
    expect(result.html).not.toContain('<img');
    expect(result.html).toMatch(/unavailable/i);
  });

  it(`rejects a draft that references more than ${MAX_EMBEDDED_REPORT_IMAGES} images`, async () => {
    const html = Array.from(
      { length: MAX_EMBEDDED_REPORT_IMAGES + 1 },
      (_, i) => `<img ${REPORT_IMAGE_ID_ATTRIBUTE}="img-${i}" alt="Figure ${i}">`
    ).join('');

    await expect(resolveReportImageEmbeds(html, deps())).rejects.toThrow(
      new RegExp(`max ${MAX_EMBEDDED_REPORT_IMAGES}`)
    );
  });

  it('passes the caller-supplied per-image byte budget through to the boundary', async () => {
    const d = deps();
    await resolveReportImageEmbeds(`<img ${REPORT_IMAGE_ID_ATTRIBUTE}="img-known" alt="Chart">`, {
      ...d,
      maxBytesPerImage: 120_000,
    });

    expect(d.inlineImage).toHaveBeenCalledWith('https://firebasestorage.googleapis.com/owned.png', 120_000);
  });

  it('escapes a hostile alt value instead of reflecting it into markup', async () => {
    const html = `<img ${REPORT_IMAGE_ID_ATTRIBUTE}="img-missing" alt="&lt;script&gt;alert(1)&lt;/script&gt;">`;
    const result = await resolveReportImageEmbeds(html, deps());

    expect(result.html).not.toContain('<script>');
  });
});
