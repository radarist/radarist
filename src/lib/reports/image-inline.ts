/**
 * @file lib/reports/image-inline.ts
 * @description REPORT-012 Task 2.4 — bounded image inlining for `image-ref`
 * blocks. Generated images are fetched from this installation's Firebase
 * Storage namespace, resized/recompressed with sharp, and embedded as `data:`
 * URIs — the only image form the report CSP allows.
 *
 * The remote read is a security boundary. It is disabled unless the exact
 * Storage bucket is configured, rejects redirects, enforces a network deadline,
 * streams at most the source-size limit plus one byte, and verifies the declared
 * MIME type against a structurally valid PNG/JPEG before Sharp receives bytes.
 */
import sharp from 'sharp';
import { createLogger } from '@/lib/logger';
import { validateRasterImageContainer, type SupportedRasterMimeType } from '@/lib/raster-image';

const log = createLogger('reports/image-inline');

const FIREBASE_STORAGE_HOST = 'firebasestorage.googleapis.com';
const GOOGLE_STORAGE_HOST = 'storage.googleapis.com';
const IMAGE_STORAGE_PREFIXES = new Set(['infographics', 'visualizations']);
const SUPPORTED_SOURCE_MIME_TYPES = new Set<SupportedRasterMimeType>(['image/png', 'image/jpeg']);
const MAX_SOURCE_BYTES = 20_000_000;
const DEFAULT_MAX_BYTES = 250_000;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const MAX_FETCH_TIMEOUT_MS = 30_000;

export interface InlineImageResult {
  dataUri: string;
  bytes: number;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: Pick<Headers, 'get'>;
  body: ReadableStream<Uint8Array> | null;
  redirected?: boolean;
  url?: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<FetchResponseLike>;

interface InlineImageOptions {
  /** Authenticated owner whose exact Storage path is eligible for inlining. */
  ownerId: string;
  maxBytes?: number;
  fetchImpl?: FetchLike;
  /** Tests may tighten, never raise, the production source-byte ceiling. */
  maxSourceBytes?: number;
  /** Tests may shorten the deadline; production callers cannot exceed 30s. */
  timeoutMs?: number;
}

interface OwnedStorageObject {
  host: string;
  objectPath: string;
}

function configuredStorageBucket(): string | null {
  const bucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  if (!bucket || bucket !== bucket.trim() || bucket.includes('/') || bucket.includes('\\')) return null;
  return bucket;
}

function configuredEmulatorOrigin(): string | null {
  const raw = process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? process.env.NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST;
  if (!raw || raw !== raw.trim() || raw.includes('/') || raw.includes('@')) return null;
  try {
    const url = new URL(`http://${raw}`);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase()) ||
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

function decodeComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isOwnedImageObjectPath(objectPath: string, ownerId: string): boolean {
  const parts = objectPath.split('/');
  if (parts.length !== 3 || !IMAGE_STORAGE_PREFIXES.has(parts[0])) return false;
  const [, pathOwner, objectName] = parts;
  if (!pathOwner || !objectName || pathOwner !== ownerId) return false;
  return parts.every(
    (part) => part !== '.' && part !== '..' && !/[\u0000-\u001f\u007f\\]/.test(part)
  );
}

/**
 * Resolve only an object in this installation's configured image namespace.
 * Host allowlisting alone is insufficient: both Google hosts serve arbitrary
 * tenants, so the bucket and object path are part of the authorization check.
 */
function resolveOwnedStorageObject(urlString: string, bucket: string, ownerId: string): OwnedStorageObject | null {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;

  const emulatorOrigin = configuredEmulatorOrigin();
  const isEmulator = url.protocol === 'http:' && emulatorOrigin !== null && url.origin === emulatorOrigin;
  const isFirebase =
    url.protocol === 'https:' && url.hostname === FIREBASE_STORAGE_HOST && url.port === '';
  const isGoogleStorage =
    url.protocol === 'https:' && url.hostname === GOOGLE_STORAGE_HOST && url.port === '';
  if (!isEmulator && !isFirebase && !isGoogleStorage) return null;

  let urlBucket: string | null = null;
  let objectPath: string | null = null;
  if (isEmulator || isFirebase) {
    const parts = url.pathname.split('/');
    if (parts.length !== 6 || parts[1] !== 'v0' || parts[2] !== 'b' || parts[4] !== 'o') return null;
    urlBucket = decodeComponent(parts[3] ?? '');
    objectPath = decodeComponent(parts[5] ?? '');
  } else {
    const parts = url.pathname.split('/');
    if (parts.length < 4 || parts[0] !== '') return null;
    urlBucket = decodeComponent(parts[1] ?? '');
    objectPath = decodeComponent(parts.slice(2).join('/'));
  }

  if (urlBucket !== bucket || objectPath === null || !isOwnedImageObjectPath(objectPath, ownerId)) return null;
  return { host: url.host, objectPath };
}

function normalizeMimeType(value: string | null): SupportedRasterMimeType | null {
  const mimeType = value?.split(';', 1)[0]?.trim().toLowerCase();
  return mimeType && SUPPORTED_SOURCE_MIME_TYPES.has(mimeType as SupportedRasterMimeType)
    ? (mimeType as SupportedRasterMimeType)
    : null;
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) throw new Error('image-inline: invalid Content-Length header');
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new Error('image-inline: invalid Content-Length header');
  return length;
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    function cleanup(): void {
      signal.removeEventListener('abort', onAbort);
    }
    function onAbort(): void {
      cleanup();
      reject(signal.reason);
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal
): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await raceWithAbort(reader.read(), signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('image-inline: response body returned invalid bytes');
      if (value.byteLength === 0) continue;

      // Retain at most max + 1 bytes. The extra byte is the deterministic proof
      // that the source exceeded the boundary; the rest is never buffered.
      const retained = Math.min(value.byteLength, maxBytes + 1 - total);
      if (retained > 0) {
        // Copy the retained slice. A view over value.buffer would keep an
        // attacker-sized backing allocation alive even though its visible
        // byteLength was bounded.
        chunks.push(Buffer.from(value.subarray(0, retained)));
        total += retained;
      }
      if (total > maxBytes || retained < value.byteLength) {
        void reader.cancel('image source exceeded byte limit').catch(() => undefined);
        throw new Error(`image-inline: source image exceeds ${maxBytes} bytes`);
      }
    }
  } catch (error) {
    if (signal.aborted) void reader.cancel(signal.reason).catch(() => undefined);
    throw error;
  } finally {
    // A hostile stream can leave read() pending after abort. Releasing a reader
    // with a pending request throws; the detached cancel still closes native
    // fetch streams without letting cleanup defeat the caller's deadline.
    try {
      reader.releaseLock();
    } catch {
      // The abort result is authoritative.
    }
  }
  return Buffer.concat(chunks, total);
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (!body) return;
  void body.cancel().catch(() => undefined);
}

/**
 * Fetch + resize + recompress an image into a bounded data: URI.
 * Throws with an actionable message on storage-policy, network, image-integrity,
 * or output-budget failures.
 */
export async function inlineImage(url: string, opts: InlineImageOptions): Promise<InlineImageResult> {
  const bucket = configuredStorageBucket();
  if (!bucket) {
    throw new Error('image-inline: Firebase Storage bucket is not configured; remote image inlining is disabled');
  }

  if (!opts.ownerId || opts.ownerId !== opts.ownerId.trim() || /[\/\\\u0000-\u001f\u007f]/.test(opts.ownerId)) {
    throw new Error('image-inline: a valid authenticated ownerId is required');
  }

  const storageObject = resolveOwnedStorageObject(url, bucket, opts.ownerId);
  if (!storageObject) {
    throw new Error('image-inline: URL is not an owned image object in the configured Firebase Storage bucket');
  }

  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > DEFAULT_MAX_BYTES) {
    throw new Error(`image-inline: maxBytes must be between 1 and ${DEFAULT_MAX_BYTES}`);
  }
  const requestedSourceLimit = opts.maxSourceBytes ?? MAX_SOURCE_BYTES;
  if (!Number.isSafeInteger(requestedSourceLimit) || requestedSourceLimit <= 0) {
    throw new Error('image-inline: maxSourceBytes must be a positive integer');
  }
  const maxSourceBytes = Math.min(requestedSourceLimit, MAX_SOURCE_BYTES);
  const requestedTimeout = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout <= 0) {
    throw new Error('image-inline: timeoutMs must be a positive integer');
  }
  const timeoutMs = Math.min(requestedTimeout, MAX_FETCH_TIMEOUT_MS);
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);

  const controller = new AbortController();
  const timeoutError = new Error(`image-inline: fetch timed out after ${timeoutMs}ms`);
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  let res: FetchResponseLike;
  let source: Buffer;
  try {
    res = await raceWithAbort(fetchImpl(url, { redirect: 'manual', signal: controller.signal }), controller.signal);
    if (res.redirected || (res.url && res.url !== url) || (res.status >= 300 && res.status < 400)) {
      cancelBody(res.body);
      throw new Error('image-inline: redirects are not allowed');
    }
    if (!res.ok) {
      cancelBody(res.body);
      throw new Error(`image-inline: fetch failed with status ${res.status}`);
    }

    const mimeType = normalizeMimeType(res.headers.get('content-type'));
    if (!mimeType) {
      cancelBody(res.body);
      throw new Error('image-inline: response Content-Type must be image/png or image/jpeg');
    }

    let declaredLength: number | null;
    try {
      declaredLength = parseContentLength(res.headers.get('content-length'));
    } catch (error) {
      cancelBody(res.body);
      throw error;
    }
    if (declaredLength !== null && declaredLength > maxSourceBytes) {
      cancelBody(res.body);
      throw new Error(`image-inline: declared source size exceeds ${maxSourceBytes} bytes`);
    }
    if (!res.body) throw new Error('image-inline: response body is unavailable');

    source = await readBoundedBody(res.body, maxSourceBytes, controller.signal);
    if (declaredLength !== null && declaredLength !== source.byteLength) {
      throw new Error('image-inline: response body size does not match Content-Length');
    }
    if (!validateRasterImageContainer(source, mimeType)) {
      throw new Error('image-inline: declared MIME type does not match a valid bounded image container');
    }
  } catch (err) {
    if (controller.signal.aborted) throw timeoutError;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  try {
    const compressed = await sharp(source)
      .resize({ width: 1200, withoutEnlargement: true })
      .jpeg({ quality: 78, mozjpeg: true })
      .toBuffer();
    if (compressed.byteLength > maxBytes) {
      // One retry at a harder setting before giving up.
      const harder = await sharp(source)
        .resize({ width: 900, withoutEnlargement: true })
        .jpeg({ quality: 65, mozjpeg: true })
        .toBuffer();
      if (harder.byteLength > maxBytes) {
        throw new Error(
          `image-inline: image is ${harder.byteLength} bytes after max compression (budget ${maxBytes}) — use a simpler image`
        );
      }
      return { dataUri: `data:image/jpeg;base64,${harder.toString('base64')}`, bytes: harder.byteLength };
    }
    return { dataUri: `data:image/jpeg;base64,${compressed.toString('base64')}`, bytes: compressed.byteLength };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('image-inline:')) throw err;
    log.error('image processing failed', err instanceof Error ? err : new Error(String(err)), {
      sourceHost: storageObject.host,
      objectPath: storageObject.objectPath.slice(0, 160),
    });
    throw new Error(`image-inline: processing failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}
