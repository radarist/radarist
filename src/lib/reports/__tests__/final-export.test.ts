/**
 * @jest-environment node
 */

import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { buildFinalReportExport } from '../final-export';

describe('buildFinalReportExport', () => {
  it('produces hash-bound self-contained product bytes with no outbound capability', async () => {
    const result = await buildFinalReportExport(
      '<!doctype html><html><head><link rel="stylesheet" href="/css/report-brand.css">' +
        '<style>.safe{fill:url(#gradient)}.network{background:url(https://example.com/pixel.png)}</style>' +
        '<style data-design-pass="page-theme">:root{--bg-primary:#123456}</style></head>' +
        '<body><svg><defs><linearGradient id="gradient"></linearGradient></defs><rect class="safe"></rect></svg></body></html>',
      'Exact export'
    );

    expect(createHash('sha256').update(result.html, 'utf8').digest('hex')).toBe(result.sha256);
    expect(Buffer.byteLength(result.html, 'utf8')).toBe(result.bytes);
    expect(result.cssSha256).toMatch(/^[a-f0-9]{64}$/);
    const document = new JSDOM(result.html).window.document;
    expect(document.querySelector('link, script')).toBeNull();
    expect(document.querySelector('style[data-source="report-brand.css"]')).not.toBeNull();
    expect(result.html).not.toContain('https://example.com/pixel.png');
    expect(result.html).toContain('url(#gradient)');
    expect(result.html.indexOf('data-source="report-brand.css"')).toBeLessThan(
      result.html.indexOf('data-design-pass="page-theme"')
    );
  });
});
