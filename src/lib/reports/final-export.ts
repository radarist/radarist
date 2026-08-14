import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';
import { buildDownloadHtmlFromDocument } from './build-download-html';

export interface FinalReportExport {
  html: string;
  bytes: number;
  sha256: string;
  cssSha256: string;
}

export function reportArtifactSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Build the exact self-contained product export on the server before storage. */
export async function buildFinalReportExport(html: string, title: string): Promise<FinalReportExport> {
  const cssPath = path.resolve(process.cwd(), 'public/css/report-brand.css');
  const brandCss = await fs.readFile(cssPath, 'utf8');
  const dom = new JSDOM(html);
  const exported = buildDownloadHtmlFromDocument(dom.window.document as unknown as Document, title, { brandCss });
  return {
    html: exported,
    bytes: Buffer.byteLength(exported, 'utf8'),
    sha256: reportArtifactSha256(exported),
    cssSha256: reportArtifactSha256(brandCss),
  };
}
