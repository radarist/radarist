export interface VisualizationExportFormat {
  extension: 'png' | 'jpg' | 'svg';
  label: 'PNG' | 'JPEG' | 'SVG';
  mimeType: 'image/png' | 'image/jpeg' | 'image/svg+xml';
}

type VisualizationExportFetcher = (url: string, options?: RequestInit) => Promise<Response>;

const EXPORT_FORMATS: Record<VisualizationExportFormat['mimeType'], VisualizationExportFormat> = {
  'image/png': { extension: 'png', label: 'PNG', mimeType: 'image/png' },
  'image/jpeg': { extension: 'jpg', label: 'JPEG', mimeType: 'image/jpeg' },
  'image/svg+xml': { extension: 'svg', label: 'SVG', mimeType: 'image/svg+xml' },
};

export function getVisualizationExportFormat(mimeType: string): VisualizationExportFormat | null {
  return EXPORT_FORMATS[mimeType as VisualizationExportFormat['mimeType']] ?? null;
}

export function buildVisualizationExportFilename(title: string, mimeType: string): string | null {
  const format = getVisualizationExportFormat(mimeType);
  if (!format) return null;

  const baseName =
    title
      .normalize('NFKD')
      .replace(/[^\x00-\x7F]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120)
      .replace(/-+$/g, '') || 'infographic';
  return `${baseName}.${format.extension}`;
}

export function normalizeVisualizationMimeType(value: string | null): string | null {
  if (!value) return null;
  return value.split(';', 1)[0]?.trim().toLowerCase() || null;
}

function isOwnedVisualizationStoragePath(path: string, uid: string): boolean {
  const ownerPrefix = `visualizations/${uid}/`;
  const objectName = path.startsWith(ownerPrefix) ? path.slice(ownerPrefix.length) : '';
  return objectName.length > 0 && !objectName.includes('/');
}

/**
 * Resolve a server-readable object identity without ever fetching the stored URL.
 * Current records carry storageObjectPath. The strict Firebase URL fallback keeps
 * older gallery records exportable while still resolving only the configured
 * bucket and the authenticated owner's single object.
 */
export function resolveOwnedVisualizationStoragePath(input: {
  storageObjectPath?: string | null;
  imageUrl: string;
  uid: string;
  storageBucket?: string;
  storageEmulatorHost?: string;
}): string | null {
  // A current record that carries an invalid path must fail closed. Falling
  // through to imageUrl would silently grant legacy compatibility to a record
  // that claims to have a canonical object identity.
  if (input.storageObjectPath !== undefined && input.storageObjectPath !== null) {
    return isOwnedVisualizationStoragePath(input.storageObjectPath, input.uid)
      ? input.storageObjectPath
      : null;
  }
  if (!input.storageBucket) return null;

  try {
    const url = new URL(input.imageUrl);
    if (url.username || url.password) {
      return null;
    }

    const isProductionOrigin =
      url.protocol === 'https:' && url.hostname === 'firebasestorage.googleapis.com';
    const emulatorOrigin = parseLoopbackStorageEmulatorOrigin(input.storageEmulatorHost);
    const isConfiguredEmulatorOrigin = url.protocol === 'http:' && emulatorOrigin === url.origin;
    if (!isProductionOrigin && !isConfiguredEmulatorOrigin) return null;

    const parts = url.pathname.split('/');
    if (parts.length !== 6 || parts[1] !== 'v0' || parts[2] !== 'b' || parts[4] !== 'o') return null;

    const bucket = decodeURIComponent(parts[3] ?? '');
    const storagePath = decodeURIComponent(parts[5] ?? '');
    if (bucket !== input.storageBucket || !isOwnedVisualizationStoragePath(storagePath, input.uid)) return null;
    return storagePath;
  } catch {
    return null;
  }
}

function parseLoopbackStorageEmulatorOrigin(rawHost: string | undefined): string | null {
  if (!rawHost || rawHost !== rawHost.trim() || rawHost.includes('/') || rawHost.includes('@')) return null;
  try {
    const url = new URL(`http://${rawHost}`);
    const hostname = url.hostname.toLowerCase();
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(hostname) ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export async function fetchVisualizationExport(
  visualizationId: string,
  storedMimeType: string,
  fetcher: VisualizationExportFetcher = fetch
): Promise<Blob> {
  const format = getVisualizationExportFormat(storedMimeType);
  if (!format) {
    throw new Error('This infographic has an unsupported media type.');
  }

  if (!visualizationId) {
    throw new Error('A visualization ID is required to download an infographic.');
  }

  const response = await fetcher(`/api/visualizations/${encodeURIComponent(visualizationId)}/export`);
  if (!response.ok) {
    throw new Error(`The infographic could not be downloaded (${response.status}).`);
  }

  const responseMimeType = normalizeVisualizationMimeType(response.headers.get('content-type'));
  if (responseMimeType !== format.mimeType) {
    throw new Error('The downloaded media type does not match this infographic.');
  }

  const blob = await response.blob();
  if (blob.size === 0) {
    throw new Error('The downloaded infographic is empty.');
  }

  return blob;
}
