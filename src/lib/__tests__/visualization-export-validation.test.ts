/**
 * @jest-environment node
 */

import { markSuperGraphSvg } from '@/lib/super-graph/provenance';
import {
  MAX_RASTER_IMAGE_DIMENSION,
  MAX_RASTER_IMAGE_PIXELS,
} from '@/lib/raster-image';
import { createValidJpegFixture, createValidPngFixture } from './helpers/raster-fixtures';
import { assertVisualizationExportPayload } from '../visualization-export-validation';

const PNG = createValidPngFixture();
const JPEG = createValidJpegFixture();

function withoutPngChunk(bytes: Buffer, type: string): Buffer {
  const typeOffset = bytes.indexOf(type, 8, 'ascii');
  if (typeOffset < 4) throw new Error(`PNG fixture has no ${type} chunk`);
  const chunkStart = typeOffset - 4;
  const chunkEnd = typeOffset + 4 + bytes.readUInt32BE(chunkStart) + 4;
  return Buffer.concat([bytes.subarray(0, chunkStart), bytes.subarray(chunkEnd)]);
}

function replaceJpegMarker(bytes: Buffer, marker: number, replacement: number): Buffer {
  const result = Buffer.from(bytes);
  const offset = result.indexOf(Buffer.from([0xff, marker]), 2);
  if (offset < 0) throw new Error(`JPEG fixture has no ${marker.toString(16)} marker`);
  result[offset + 1] = replacement;
  return result;
}

function emptyPngImageData(bytes: Buffer): Buffer {
  const typeOffset = bytes.indexOf('IDAT', 8, 'ascii');
  if (typeOffset < 4) throw new Error('PNG fixture has no IDAT chunk');
  const chunkStart = typeOffset - 4;
  const chunkEnd = typeOffset + 4 + bytes.readUInt32BE(chunkStart) + 4;
  const emptyIdat = Buffer.from([
    0x00, 0x00, 0x00, 0x00,
    0x49, 0x44, 0x41, 0x54,
    0x35, 0xaf, 0x06, 0x1e,
  ]);
  return Buffer.concat([bytes.subarray(0, chunkStart), emptyIdat, bytes.subarray(chunkEnd)]);
}

function emptyJpegEntropyPayload(bytes: Buffer): Buffer {
  const scanOffset = bytes.indexOf(Buffer.from([0xff, 0xda]));
  if (scanOffset < 0) throw new Error('JPEG fixture has no scan marker');
  const entropyOffset = scanOffset + 2 + bytes.readUInt16BE(scanOffset + 2);
  return Buffer.concat([bytes.subarray(0, entropyOffset), bytes.subarray(-2)]);
}

describe('visualization export payload validation', () => {
  it.each([
    ['image/png', PNG],
    ['image/jpeg', JPEG],
  ] as const)('accepts a complete, structurally valid %s fixture', (mimeType, bytes) => {
    expect(() => assertVisualizationExportPayload(bytes, mimeType, mimeType)).not.toThrow();
  });

  it.each([
    ['truncated chunk', PNG.subarray(0, -1)],
    ['missing IDAT', withoutPngChunk(PNG, 'IDAT')],
    ['empty IDAT payload', emptyPngImageData(PNG)],
    ['invalid chunk CRC', Buffer.concat([PNG.subarray(0, -1), Buffer.from([PNG.at(-1)! ^ 0x01])])],
    ['trailing payload', Buffer.concat([PNG, Buffer.from([0x00])])],
  ])('rejects a PNG with %s', (_case, bytes) => {
    expect(() => assertVisualizationExportPayload(bytes, 'image/png', 'image/png')).toThrow('bytes do not match');
  });

  it.each([
    ['truncated EOI', JPEG.subarray(0, -1)],
    ['missing SOF', replaceJpegMarker(JPEG, 0xc0, 0xc4)],
    ['missing SOS', replaceJpegMarker(JPEG, 0xda, 0xdb)],
    ['empty entropy payload', emptyJpegEntropyPayload(JPEG)],
    ['trailing payload', Buffer.concat([JPEG, Buffer.from([0x00])])],
  ])('rejects a JPEG with %s', (_case, bytes) => {
    expect(() => assertVisualizationExportPayload(bytes, 'image/jpeg', 'image/jpeg')).toThrow('bytes do not match');
  });

  it.each([
    ['PNG width', 'image/png', createValidPngFixture(MAX_RASTER_IMAGE_DIMENSION + 1, 1)],
    ['PNG height', 'image/png', createValidPngFixture(1, MAX_RASTER_IMAGE_DIMENSION + 1)],
    ['JPEG width', 'image/jpeg', createValidJpegFixture(MAX_RASTER_IMAGE_DIMENSION + 1, 1)],
    ['JPEG height', 'image/jpeg', createValidJpegFixture(1, MAX_RASTER_IMAGE_DIMENSION + 1)],
  ] as const)('rejects a %s above the per-dimension limit', (_case, mimeType, bytes) => {
    expect(() => assertVisualizationExportPayload(bytes, mimeType, mimeType)).toThrow('bytes do not match');
  });

  it('rejects declared pixel area above the shared raster limit', () => {
    const width = 8_001;
    const height = Math.floor(MAX_RASTER_IMAGE_PIXELS / width) + 1;
    const oversizedDimensions = createValidPngFixture(width, height);

    expect(() =>
      assertVisualizationExportPayload(oversizedDimensions, 'image/png', 'image/png')
    ).toThrow('bytes do not match');
  });

  it('accepts a verified, static server-rendered SVG', () => {
    const svg = markSuperGraphSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="p" d="M0 0"/></defs><use href="#p"/></svg>'
    );

    expect(() =>
      assertVisualizationExportPayload(new TextEncoder().encode(svg), 'image/svg+xml', 'image/svg+xml')
    ).not.toThrow();
  });

  it('accepts a well-formed static legacy SVG only through the explicit compatibility option', () => {
    const legacySvg =
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="p" d="M0 0"/></defs><use href="#p"/></svg>';

    expect(() =>
      assertVisualizationExportPayload(
        new TextEncoder().encode(legacySvg),
        'image/svg+xml',
        'image/svg+xml',
        { allowLegacyStaticSvg: true }
      )
    ).not.toThrow();
  });

  it('rejects SVG input that xmldom can repair only with a parser warning', () => {
    const warningSvg = '<svg xmlns="http://www.w3.org/2000/svg" width=1></svg>';

    expect(() =>
      assertVisualizationExportPayload(
        new TextEncoder().encode(warningSvg),
        'image/svg+xml',
        'image/svg+xml',
        { allowLegacyStaticSvg: true }
      )
    ).toThrow('well-formed SVG');
  });

  it('rejects xml:base even when a resource reference is only a fragment', () => {
    const svg = markSuperGraphSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" xml:base="https://attacker.example/"><defs><path id="p"/></defs><use href="#p"/></svg>'
    );

    expect(() =>
      assertVisualizationExportPayload(new TextEncoder().encode(svg), 'image/svg+xml', 'image/svg+xml')
    ).toThrow('XML base URL');
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://attacker.example/x.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>HTML</div></foreignObject></svg>',
    '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>svg{background-image:image-set("https://attacker.example/a.png" 1x)}</style></svg>',
  ])('rejects active, external, or foreign SVG content even with a valid provenance digest', (unsafeSvg) => {
    const marked = markSuperGraphSvg(unsafeSvg);

    expect(() =>
      assertVisualizationExportPayload(new TextEncoder().encode(marked), 'image/svg+xml', 'image/svg+xml')
    ).toThrow();
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="relative.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:url(data:image/png;base64,AA)}</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
    String.raw`<svg xmlns="http://www.w3.org/2000/svg"><style>@im\70 ort "https://attacker.example/x.css";</style></svg>`,
    String.raw`<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:u\72l(https://attacker.example/x.svg)"/></svg>`,
    '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:u/**/rl(https://attacker.example/x.svg)}</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>svg{background-image:-webkit-image-set("relative.png" 1x)}</style></svg>',
  ])('keeps the strict active-content policy on the legacy compatibility path', (unsafeSvg) => {
    expect(() =>
      assertVisualizationExportPayload(
        new TextEncoder().encode(unsafeSvg),
        'image/svg+xml',
        'image/svg+xml',
        { allowLegacyStaticSvg: true }
      )
    ).toThrow();
  });

  it('rejects an unverified SVG', () => {
    expect(() =>
      assertVisualizationExportPayload(
        new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
        'image/svg+xml',
        'image/svg+xml'
      )
    ).toThrow('verified server-rendered');
  });

  it('rejects empty, MIME-mismatched, and signature-mismatched bodies', () => {
    expect(() => assertVisualizationExportPayload(new Uint8Array(), 'image/png', 'image/png')).toThrow('empty');
    expect(() => assertVisualizationExportPayload(PNG, 'image/png', 'image/jpeg')).toThrow('does not match');
    expect(() => assertVisualizationExportPayload(JPEG, 'image/png', 'image/png')).toThrow('bytes do not match');
  });
});
