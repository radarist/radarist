export type SupportedRasterMimeType = 'image/png' | 'image/jpeg';

export interface RasterImageDimensions {
  width: number;
  height: number;
}

/** Shared limits for generated images and persisted visualization exports. */
export const MAX_RASTER_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_RASTER_IMAGE_DIMENSION = 16_384;
export const MAX_RASTER_IMAGE_PIXELS = 64_000_000;

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 0x100 + bytes[offset + 1];
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[offset]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isAsciiLetter(value: number): boolean {
  return (value >= 0x41 && value <= 0x5a) || (value >= 0x61 && value <= 0x7a);
}

function hasValidPngHeader(bytes: Uint8Array, offset: number): boolean {
  const bitDepth = bytes[offset + 8];
  const colorType = bytes[offset + 9];
  const validBitDepths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  return (
    validBitDepths[colorType]?.includes(bitDepth) === true &&
    bytes[offset + 10] === 0 &&
    bytes[offset + 11] === 0 &&
    (bytes[offset + 12] === 0 || bytes[offset + 12] === 1)
  );
}

function parsePng(bytes: Uint8Array): RasterImageDimensions | undefined {
  if (bytes.length < PNG_SIGNATURE.length + 12) return undefined;
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return undefined;

  let offset = PNG_SIGNATURE.length;
  let dimensions: RasterImageDimensions | undefined;
  let colorType: number | undefined;
  let bitDepth: number | undefined;
  let sawPalette = false;
  let sawImageData = false;
  let imageDataBytes = 0;
  let imageDataEnded = false;

  while (offset < bytes.length) {
    if (offset > bytes.length - 12) return undefined;
    const chunkLength = readUint32BE(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    if (chunkLength > bytes.length - dataOffset - 4) return undefined;
    const dataEnd = dataOffset + chunkLength;
    const chunkEnd = dataEnd + 4;

    if (![0, 1, 2, 3].every((index) => isAsciiLetter(bytes[typeOffset + index]))) return undefined;
    if (readUint32BE(bytes, dataEnd) !== crc32(bytes, typeOffset, dataEnd)) return undefined;

    const chunkType = String.fromCharCode(
      bytes[typeOffset],
      bytes[typeOffset + 1],
      bytes[typeOffset + 2],
      bytes[typeOffset + 3]
    );

    if (!dimensions && chunkType !== 'IHDR') return undefined;
    if (sawImageData && chunkType !== 'IDAT' && chunkType !== 'IEND') imageDataEnded = true;

    if (chunkType === 'IHDR') {
      if (dimensions || offset !== PNG_SIGNATURE.length || chunkLength !== 13) return undefined;
      const width = readUint32BE(bytes, dataOffset);
      const height = readUint32BE(bytes, dataOffset + 4);
      if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) return undefined;
      if (!hasValidPngHeader(bytes, dataOffset)) return undefined;
      colorType = bytes[dataOffset + 9];
      bitDepth = bytes[dataOffset + 8];
      dimensions = { width, height };
    } else if (chunkType === 'PLTE') {
      if (!dimensions || sawPalette || sawImageData || chunkLength === 0 || chunkLength > 768 || chunkLength % 3 !== 0) {
        return undefined;
      }
      if (colorType === 0 || colorType === 4) return undefined;
      if (colorType === 3 && bitDepth !== undefined && chunkLength / 3 > 2 ** bitDepth) return undefined;
      sawPalette = true;
    } else if (chunkType === 'IDAT') {
      if (!dimensions || imageDataEnded || (colorType === 3 && !sawPalette)) return undefined;
      sawImageData = true;
      imageDataBytes += chunkLength;
    } else if (chunkType === 'IEND') {
      if (
        !dimensions ||
        !sawImageData ||
        imageDataBytes === 0 ||
        chunkLength !== 0 ||
        chunkEnd !== bytes.length
      ) {
        return undefined;
      }
      return dimensions;
    } else if ((bytes[typeOffset] & 0x20) === 0) {
      // Unknown critical chunks cannot be decoded safely.
      return undefined;
    }

    offset = chunkEnd;
  }

  return undefined;
}

function parseJpeg(bytes: Uint8Array): RasterImageDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;

  let offset = 2;
  let dimensions: RasterImageDimensions | undefined;
  let frameComponentIds: Set<number> | undefined;
  let sawScan = false;
  let sawEntropyData = false;
  let inScan = false;

  while (offset < bytes.length) {
    let marker: number | undefined;

    if (inScan) {
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          sawEntropyData = true;
          offset += 1;
          continue;
        }
        while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.length) return undefined;
        const candidate = bytes[offset];
        offset += 1;
        if (candidate === 0x00) {
          sawEntropyData = true;
          continue;
        }
        if (candidate >= 0xd0 && candidate <= 0xd7) continue;
        marker = candidate;
        inScan = false;
        break;
      }
      if (marker === undefined) return undefined;
    } else {
      if (bytes[offset] !== 0xff) return undefined;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) return undefined;
      marker = bytes[offset];
      offset += 1;
      if (marker === 0x00) return undefined;
    }

    if (marker === 0xd9) {
      return sawScan && sawEntropyData && dimensions && offset === bytes.length ? dimensions : undefined;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker < 0xc0) {
      return undefined;
    }
    if (offset > bytes.length - 2) return undefined;

    const segmentLength = readUint16BE(bytes, offset);
    if (segmentLength < 2 || segmentLength > bytes.length - offset) return undefined;

    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (dimensions || segmentLength < 11) return undefined;
      const componentCount = bytes[offset + 7];
      if (componentCount < 1 || componentCount > 4 || segmentLength !== 8 + 3 * componentCount) return undefined;

      const height = readUint16BE(bytes, offset + 3);
      const width = readUint16BE(bytes, offset + 5);
      if (bytes[offset + 2] === 0 || width === 0 || height === 0) return undefined;

      const componentIds = new Set<number>();
      for (let index = 0; index < componentCount; index += 1) {
        const componentOffset = offset + 8 + index * 3;
        const componentId = bytes[componentOffset];
        const sampling = bytes[componentOffset + 1];
        const horizontalSampling = sampling >>> 4;
        const verticalSampling = sampling & 0x0f;
        if (
          componentIds.has(componentId) ||
          horizontalSampling < 1 ||
          horizontalSampling > 4 ||
          verticalSampling < 1 ||
          verticalSampling > 4 ||
          bytes[componentOffset + 2] > 3
        ) {
          return undefined;
        }
        componentIds.add(componentId);
      }
      dimensions = { width, height };
      frameComponentIds = componentIds;
    } else if (marker === 0xda) {
      if (!dimensions || !frameComponentIds || segmentLength < 8) return undefined;
      const componentCount = bytes[offset + 2];
      if (componentCount < 1 || componentCount > frameComponentIds.size || segmentLength !== 6 + 2 * componentCount) {
        return undefined;
      }
      const scanComponentIds = new Set<number>();
      for (let index = 0; index < componentCount; index += 1) {
        const componentId = bytes[offset + 3 + index * 2];
        if (!frameComponentIds.has(componentId) || scanComponentIds.has(componentId)) return undefined;
        scanComponentIds.add(componentId);
      }
      sawScan = true;
      inScan = true;
    }

    offset += segmentLength;
  }

  return undefined;
}

function dimensionsAreWithinLimits(dimensions: RasterImageDimensions): boolean {
  return (
    dimensions.width <= MAX_RASTER_IMAGE_DIMENSION &&
    dimensions.height <= MAX_RASTER_IMAGE_DIMENSION &&
    dimensions.width * dimensions.height <= MAX_RASTER_IMAGE_PIXELS
  );
}

/**
 * Validate a bounded PNG/JPEG container and return its declared dimensions.
 * This verifies container structure, not decompressed pixels or entropy data.
 */
export function validateRasterImageContainer(
  bytes: Uint8Array,
  mimeType: string
): RasterImageDimensions | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RASTER_IMAGE_BYTES) return undefined;

  const dimensions =
    mimeType === 'image/png'
      ? parsePng(bytes)
      : mimeType === 'image/jpeg'
        ? parseJpeg(bytes)
        : undefined;

  return dimensions && dimensionsAreWithinLimits(dimensions) ? dimensions : undefined;
}

/** @deprecated Prefer the name that makes the container-only guarantee explicit. */
export function parseRasterImage(bytes: Uint8Array, mimeType: string): RasterImageDimensions | undefined {
  return validateRasterImageContainer(bytes, mimeType);
}
