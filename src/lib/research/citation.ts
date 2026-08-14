/**
 * IEEE citation formatting for the primary-source research tools.
 *
 * `@citation-js/plugin-csl` only bundles the `apa`, `vancouver`, and
 * `harvard1` CSL templates (verified against
 * `node_modules/@citation-js/plugin-csl/lib/styles.json`) — there is no
 * built-in `ieee` template. Requesting an unregistered template name does
 * NOT throw: citation-js silently falls back to `apa`, which would produce
 * mislabeled "IEEE" output without ever hitting the try/catch fallback below.
 *
 * To get genuine IEEE formatting we vendor the official IEEE CSL style
 * (`IEEE_CSL_XML` in `ieee-csl.ts`, sourced from the
 * citation-style-language/styles repo, CC-BY-SA-3.0 — see
 * THIRD-PARTY-NOTICES.md and the `<rights>` element in that constant) and
 * register it under the `ieee` template key before first use. The XML is
 * inlined as a TypeScript string constant (not read from a `.csl` file on
 * disk at runtime) because that asset may not survive Next.js/turbopack
 * production bundling — a runtime file read against it can fail with
 * ENOENT in prod even though it works fine in dev/test.
 *
 * `formatIeeeCitation` additionally guards against the silent-APA case by
 * checking that the `ieee` template is actually registered before ever
 * calling `.format(..., { template: 'ieee' })`. If registration failed (or
 * hasn't happened for some other reason), it returns the plain fallback
 * directly instead of risking a mislabeled APA string.
 */

import { Cite, plugins } from '@citation-js/core';
import '@citation-js/plugin-csl';
import { createLogger } from '@/lib/logger';
import { IEEE_CSL_XML } from './ieee-csl';

const log = createLogger('research/citation');

const IEEE_TEMPLATE_NAME = 'ieee';

function registerIeeeTemplate(): void {
  const cslConfig = plugins.config.get('@csl');
  if (cslConfig.templates.has(IEEE_TEMPLATE_NAME)) return;
  cslConfig.templates.add(IEEE_TEMPLATE_NAME, IEEE_CSL_XML);
}

try {
  registerIeeeTemplate();
} catch (err) {
  log.warn('failed to register vendored IEEE_CSL_XML template; formatIeeeCitation will use the plain fallback', {
    err: err instanceof Error ? err.message : String(err),
  });
}

export function formatIeeeCitation(input: {
  title: string;
  authors: string[];
  year: number | null;
  url: string;
  doi?: string | null;
}): string {
  const plain = `${input.authors.join(', ') || 'Unknown'} (${input.year ?? 'n.d.'}). ${input.title}. ${input.url}`;

  // Guard against the silent-APA fallback: citation-js does NOT throw on an
  // unregistered template name — it silently formats with `apa` instead,
  // which (being non-empty) would beat `plain` below and get mislabeled as
  // IEEE forever. If registration didn't happen (or failed), skip straight
  // to the plain fallback rather than ever calling `format(..., { template:
  // 'ieee' })` against an unregistered template.
  if (!plugins.config.get('@csl').templates.has(IEEE_TEMPLATE_NAME)) {
    log.warn('ieee CSL template is not registered; using the plain fallback instead of risking a silent APA mislabel', {
      title: input.title,
    });
    return plain;
  }

  try {
    const csl = {
      type: 'article-journal',
      title: input.title,
      author: input.authors.map((a) => ({ literal: a })),
      issued: input.year ? { 'date-parts': [[input.year]] } : undefined,
      URL: input.url,
      DOI: input.doi ?? undefined,
    };
    const out = new Cite(csl).format('bibliography', {
      format: 'text',
      template: IEEE_TEMPLATE_NAME,
      lang: 'en-US',
    });
    const trimmed = typeof out === 'string' ? out.trim() : '';
    return trimmed || plain;
  } catch (err) {
    log.warn('citation-js failed, using plain fallback', {
      title: input.title,
      err: err instanceof Error ? err.message : String(err),
    });
    return plain;
  }
}
