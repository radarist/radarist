const REPORT_STATIC_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  'font-src data:',
  "form-action 'none'",
  "frame-src 'none'",
  'img-src data: blob:',
  'media-src data: blob:',
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "worker-src 'none'",
].join('; ');

const REMOVED_ELEMENTS = 'base, embed, form, frame, iframe, link, object';
const RESOURCE_ATTRIBUTES = ['src', 'srcset', 'poster'] as const;
const NAVIGATION_ATTRIBUTES = ['action', 'formaction', 'ping', 'target', 'download'] as const;

export interface StaticReportHtmlOptions {
  brandCss?: string | null;
  title?: string;
}

function parseHtml(html: string): Document {
  if (typeof DOMParser === 'undefined') {
    throw new Error('Static report HTML can only be prepared in a browser DOM');
  }
  const normalized = html.charCodeAt(0) === 0xfeff ? html.slice(1) : html;
  return new DOMParser().parseFromString(normalized, 'text/html');
}

function isEmbeddedUrl(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith('data:') || normalized.startsWith('blob:');
}

function isDocumentFragmentUrl(value: string): boolean {
  return value.trim().startsWith('#');
}

function decodeCssEscapes(css: string): string {
  return css.replace(/\\([0-9a-f]{1,6})(?:[\t\n\f\r ]|\r\n)?|\\([^\n\r\f0-9a-f])/gi, (_match, hex, escaped) => {
    if (hex) {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint === 0 || codePoint > 0x10ffff ? '\uFFFD' : String.fromCodePoint(codePoint);
    }
    return escaped ?? '';
  });
}

/** Remove every CSS construct that can initiate a resource request. */
function removeCssNetworkCapabilities(css: string): string {
  const normalized = decodeCssEscapes(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  return normalized
    .replace(/@import\b[\s\S]*?(?:;|$)/gi, '')
    .replace(/(?:-webkit-)?image-set\s*\([^;{}]*\)/gi, 'none')
    .replace(/url\s*\((?:[^)(]|\([^)]*\))*\)/gi, (match) => {
      // T1.9 (REPORT-011): keep embedded data:/blob: urls — they cannot egress
      // and the frame CSP already allows `font-src data:` / `img-src data:`.
      // This mirrors the attribute-side handling (`isEmbeddedUrl` on src/srcset)
      // and is what lets the embedded @font-face type pair actually load.
      const inner = match
        .slice(match.indexOf('(') + 1, -1)
        .trim()
        .replace(/^['"]|['"]$/g, '');
      // Same-document SVG gradients, filters, masks and clip paths cannot
      // egress. Preserve only the strict fragment form; a network URL that
      // merely contains a hash remains blocked.
      return isEmbeddedUrl(inner) || isDocumentFragmentUrl(inner) ? match : 'url("")';
    });
}

function removeExternalCapabilities(document: Document): void {
  document.querySelectorAll(REMOVED_ELEMENTS).forEach((element) => element.remove());
  document.querySelectorAll('meta[http-equiv]').forEach((element) => {
    const directive = element.getAttribute('http-equiv')?.trim().toLowerCase();
    if (directive === 'content-security-policy' || directive === 'content-type' || directive === 'refresh') {
      element.remove();
    }
  });
  document.querySelectorAll('meta[charset], meta[name="viewport" i]').forEach((element) => element.remove());

  document.querySelectorAll('script').forEach((script) => script.remove());

  document.querySelectorAll('style').forEach((style) => {
    style.textContent = removeCssNetworkCapabilities(style.textContent ?? '');
  });

  document.querySelectorAll('*').forEach((element) => {
    for (const attribute of NAVIGATION_ATTRIBUTES) element.removeAttribute(attribute);

    for (const attribute of RESOURCE_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value !== null && !isEmbeddedUrl(value)) element.removeAttribute(attribute);
    }

    // Only same-document anchors remain navigable. A data:/blob: URL is safe as
    // an image source, but as an anchor it can replace a downloaded document
    // with a fresh executable document that no longer carries this CSP.
    for (const attribute of ['href', 'xlink:href']) {
      const value = element.getAttribute(attribute);
      if (value !== null && !isDocumentFragmentUrl(value)) element.removeAttribute(attribute);
    }

    for (const attribute of [...element.attributes]) {
      if (attribute.name.toLowerCase().startsWith('on')) element.removeAttribute(attribute.name);
    }

    const inlineStyle = element.getAttribute('style');
    if (inlineStyle !== null) element.setAttribute('style', removeCssNetworkCapabilities(inlineStyle));
  });
}

function addPolicy(document: Document): void {
  const policy = document.createElement('meta');
  policy.setAttribute('http-equiv', 'Content-Security-Policy');
  policy.setAttribute('content', REPORT_STATIC_CSP);
  document.head.prepend(policy);

  const charset = document.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  const viewport = document.createElement('meta');
  viewport.setAttribute('name', 'viewport');
  viewport.setAttribute('content', 'width=device-width, initial-scale=1');
  policy.after(charset, viewport);
}

function addBrandCss(document: Document, brandCss: string | null | undefined): void {
  if (!brandCss) return;
  const existing = document.querySelector('style[data-source="report-brand.css"]');
  if (existing) {
    existing.textContent = removeCssNetworkCapabilities(brandCss);
    return;
  }
  const style = document.createElement('style');
  style.setAttribute('data-source', 'report-brand.css');
  style.textContent = removeCssNetworkCapabilities(brandCss);
  // Keep the server-authored page-theme override last in the cascade. Appending
  // brand CSS after it silently replaced the resolved mission palette in the
  // supposedly exact product export.
  const pageTheme = document.head.querySelector('style[data-design-pass="page-theme"]');
  if (pageTheme) document.head.insertBefore(style, pageTheme);
  else document.head.append(style);
}

function serialize(document: Document): string {
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

/**
 * Converts report-authored HTML into a self-contained, static document.
 *
 * Preview, print, public sharing, and download all use this exact transform so
 * legacy or restored report code cannot regain execution through a weaker
 * output path. Inline SVG/CSS, embedded images, fragment anchors, and native
 * disclosure controls remain available.
 */
export function buildStaticReportHtml(html: string, options: StaticReportHtmlOptions = {}): string {
  return buildStaticReportHtmlFromDocument(parseHtml(html), options);
}

/** Server-safe entrypoint for callers that supply their own DOM implementation. */
export function buildStaticReportHtmlFromDocument(
  document: Document,
  options: StaticReportHtmlOptions = {}
): string {
  removeExternalCapabilities(document);
  addPolicy(document);
  addBrandCss(document, options.brandCss);
  if (options.title !== undefined) document.title = options.title;
  return serialize(document);
}
