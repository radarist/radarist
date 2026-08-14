import 'server-only';

import { DOMParser } from '@xmldom/xmldom';

import { detectExecutableReportContent } from '@/lib/reports/publication-policy';
import { validateRasterImageContainer } from '@/lib/raster-image';
import { hasValidSuperGraphProvenance } from '@/lib/super-graph/provenance';
import { getVisualizationExportFormat, normalizeVisualizationMimeType } from '@/lib/visualization-export';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const ACTIVE_SVG_ELEMENTS = new Set([
  'animate',
  'animatemotion',
  'animatetransform',
  'audio',
  'canvas',
  'discard',
  'embed',
  'foreignobject',
  'iframe',
  'object',
  'script',
  'set',
  'video',
]);

function containsNonFragmentCssUrl(value: string): boolean {
  // CSS escape decoding happens in the browser after XML parsing and can hide
  // `url` / `@import` tokens (for example `@im\70 ort`). Renderer output does
  // not require escapes or comments, so reject both instead of maintaining a
  // second CSS tokenizer at this download boundary.
  if (value.includes('\\') || value.includes('/*') || value.includes('*/')) return true;
  const withoutLocalReferences = value.replace(/url\(\s*(['"]?)#[a-zA-Z0-9_.:-]+\1\s*\)/gi, '');
  return /@import\b|url\s*\(|(?:-webkit-)?image-set\s*\(/i.test(withoutLocalReferences);
}

function assertStaticSvgDocument(svg: string): void {
  if (/<!DOCTYPE\b|<!ENTITY\b|<\?xml-stylesheet\b/i.test(svg)) {
    throw new Error('The downloaded SVG contains an active XML declaration.');
  }

  const parseErrors: string[] = [];
  const document = new DOMParser({
    errorHandler: {
      warning: (message) => parseErrors.push(String(message)),
      error: (message) => parseErrors.push(String(message)),
      fatalError: (message) => parseErrors.push(String(message)),
    },
  }).parseFromString(svg, 'image/svg+xml');
  const root = document.documentElement;
  if (
    parseErrors.length > 0 ||
    !root ||
    root.localName.toLowerCase() !== 'svg' ||
    root.namespaceURI !== SVG_NAMESPACE
  ) {
    throw new Error('The downloaded SVG is not a well-formed SVG document.');
  }

  const pending: Element[] = [root];
  while (pending.length > 0) {
    const element = pending.pop()!;
    const elementName = element.localName.toLowerCase();
    if (ACTIVE_SVG_ELEMENTS.has(elementName)) {
      throw new Error(`The downloaded SVG contains active content (${elementName}).`);
    }

    for (let index = 0; index < element.attributes.length; index += 1) {
      const attribute = element.attributes.item(index);
      if (!attribute) continue;
      const attributeName = attribute.localName.toLowerCase();
      const value = attribute.value.trim();
      if (attribute.namespaceURI === XML_NAMESPACE && attributeName === 'base') {
        throw new Error('The downloaded SVG contains an XML base URL.');
      }
      if (attributeName.startsWith('on')) {
        throw new Error(`The downloaded SVG contains an event handler (${attributeName}).`);
      }
      if (['href', 'src', 'poster', 'data'].includes(attributeName) && value && !value.startsWith('#')) {
        throw new Error(`The downloaded SVG contains a non-fragment resource reference (${attributeName}).`);
      }
      if (containsNonFragmentCssUrl(value)) {
        throw new Error(`The downloaded SVG contains an external CSS resource (${attributeName}).`);
      }
    }

    if (elementName === 'style' && containsNonFragmentCssUrl(element.textContent ?? '')) {
      throw new Error('The downloaded SVG contains an external CSS resource (style).');
    }

    for (let index = 0; index < element.childNodes.length; index += 1) {
      const child = element.childNodes.item(index);
      if (child?.nodeType === 1) pending.push(child as Element);
    }
  }
}

function assertSafeServerRenderedSvg(bytes: Uint8Array, allowLegacyStaticSvg: boolean): void {
  let svg: string;
  try {
    svg = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('The downloaded SVG is not valid UTF-8.');
  }

  if (!allowLegacyStaticSvg && !hasValidSuperGraphProvenance(svg)) {
    throw new Error('The downloaded SVG is not a verified server-rendered diagram.');
  }

  const violations = detectExecutableReportContent(svg);
  if (violations.length > 0) {
    throw new Error(`The downloaded SVG contains active content (${violations[0].kind}).`);
  }

  // The XML walk catches SVG/XML-specific active constructs and resource
  // attributes that are outside the report HTML policy's vocabulary.
  assertStaticSvgDocument(svg);
}

export interface VisualizationExportValidationOptions {
  /** Compatibility only for canonical owner-scoped Firebase records that predate provenance. */
  allowLegacyStaticSvg?: boolean;
}

/** Validate that stored image bytes agree with the visualization's persisted MIME. */
export function assertVisualizationExportPayload(
  bytes: Uint8Array,
  storedMimeType: string,
  responseMimeType: string | null,
  options: VisualizationExportValidationOptions = {}
): void {
  const format = getVisualizationExportFormat(storedMimeType);
  if (!format) {
    throw new Error('This infographic has an unsupported media type.');
  }

  if (normalizeVisualizationMimeType(responseMimeType) !== format.mimeType) {
    throw new Error('The downloaded media type does not match this infographic.');
  }

  if (bytes.byteLength === 0) {
    throw new Error('The downloaded infographic is empty.');
  }

  if (format.mimeType === 'image/svg+xml') {
    assertSafeServerRenderedSvg(bytes, options.allowLegacyStaticSvg === true);
  } else if (!validateRasterImageContainer(bytes, format.mimeType)) {
    throw new Error('The downloaded bytes do not match this infographic media type.');
  }
}
