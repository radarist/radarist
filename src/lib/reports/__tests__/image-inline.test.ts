/**
 * @jest-environment node
 */
import sharp from 'sharp';
import { inlineImage, type FetchLike, type FetchResponseLike } from '../image-inline';

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const BUCKET = 'project.firebasestorage.app';
const OBJECT_PATH = 'infographics/user-1/report-image.png';
const FIREBASE_URL = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(
  OBJECT_PATH
)}?alt=media&token=do-not-log`;
const GCS_URL = `https://storage.googleapis.com/${BUCKET}/${OBJECT_PATH}`;

const originalBucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
const originalEmulator = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
const originalPublicEmulator = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function responseWith(
  buf: Buffer,
  init: { ok?: boolean; status?: number; contentType?: string; contentLength?: string } = {}
): FetchResponseLike {
  const status = init.status ?? 200;
  return new Response(new Uint8Array(buf), {
    status,
    headers: {
      'content-type': init.contentType ?? 'image/png',
      ...(init.contentLength === undefined ? {} : { 'content-length': init.contentLength }),
    },
  });
}

const fetchWith = (
  buf: Buffer,
  init: { ok?: boolean; status?: number; contentType?: string; contentLength?: string } = {}
): FetchLike => jest.fn(async () => responseWith(buf, init));

function streamingResponse(chunks: Uint8Array[], headers: Record<string, string>): FetchResponseLike {
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    redirected: false,
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    }),
  };
}

describe('inlineImage (REPORT-012 T2.4)', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = BUCKET;
    delete process.env.FIREBASE_STORAGE_EMULATOR_HOST;
    delete process.env.NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST;
  });

  afterAll(() => {
    restoreEnv('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET', originalBucket);
    restoreEnv('FIREBASE_STORAGE_EMULATOR_HOST', originalEmulator);
    restoreEnv('NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST', originalPublicEmulator);
  });

  it('resizes a healthy owned 2000px source to a bounded jpeg data URI', async () => {
    const big = await sharp({
      create: { width: 2000, height: 1100, channels: 3, background: { r: 20, g: 30, b: 60 } },
    })
      .png()
      .toBuffer();
    const fetchImpl = fetchWith(big, { contentLength: String(big.byteLength) });

    const result = await inlineImage(FIREBASE_URL, { fetchImpl, ownerId: 'user-1' });

    expect(result.dataUri.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(250_000);
    expect(fetchImpl).toHaveBeenCalledWith(
      FIREBASE_URL,
      expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) })
    );
  });

  it('is disabled when the exact Firebase Storage bucket is not configured', async () => {
    delete process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
    const fetchImpl = fetchWith(Buffer.alloc(4));

    await expect(inlineImage(FIREBASE_URL, { fetchImpl, ownerId: 'user-1' })).rejects.toThrow(
      'remote image inlining is disabled'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires an authenticated owner before any fetch', async () => {
    const fetchImpl = fetchWith(Buffer.alloc(4));
    await expect(
      inlineImage(FIREBASE_URL, { fetchImpl } as Parameters<typeof inlineImage>[1])
    ).rejects.toThrow('authenticated ownerId is required');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a foreign bucket',
      `https://firebasestorage.googleapis.com/v0/b/foreign.firebasestorage.app/o/${encodeURIComponent(OBJECT_PATH)}`,
    ],
    ['a generic external host', 'https://evil.example/infographics/user-1/report-image.png'],
    ['plain HTTP on a Google host', `http://storage.googleapis.com/${BUCKET}/${OBJECT_PATH}`],
    ['an unowned object namespace', `https://storage.googleapis.com/${BUCKET}/documents/user-1/report-image.png`],
    ['a foreign owner when pinned', GCS_URL],
  ])('rejects %s before any fetch', async (_label, url) => {
    const fetchImpl = fetchWith(Buffer.alloc(4));
    await expect(
      inlineImage(url, {
        fetchImpl,
        ownerId: _label === 'a foreign owner when pinned' ? 'user-2' : 'user-1',
      })
    ).rejects.toThrow('not an owned image object');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows HTTP only for the exact configured loopback Storage emulator origin and bucket', async () => {
    process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:19199';
    const png = await sharp({
      create: { width: 20, height: 20, channels: 3, background: '#235789' },
    })
      .png()
      .toBuffer();
    const emulatorUrl = `http://127.0.0.1:19199/v0/b/${BUCKET}/o/${encodeURIComponent(OBJECT_PATH)}?alt=media`;
    const fetchImpl = fetchWith(png);

    await expect(inlineImage(emulatorUrl, { fetchImpl, ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ dataUri: expect.stringMatching(/^data:image\/jpeg;base64,/) })
    );
    await expect(
      inlineImage(
        `http://localhost:19199/v0/b/${BUCKET}/o/${encodeURIComponent(OBJECT_PATH)}?alt=media`,
        { fetchImpl, ownerId: 'user-1' }
      )
    ).rejects.toThrow('not an owned image object');
  });

  it('requests manual redirect handling and refuses redirect responses without following them', async () => {
    const fetchImpl = jest.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example/redirected.png' },
      });
    }) as FetchLike;

    await expect(inlineImage(FIREBASE_URL, { fetchImpl, ownerId: 'user-1' })).rejects.toThrow(
      'redirects are not allowed'
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a response whose final URL differs even if a fetch adapter hides its redirect flag', async () => {
    const source = responseWith(Buffer.from('unused'));
    const response: FetchResponseLike = {
      ok: source.ok,
      status: source.status,
      headers: source.headers,
      body: source.body,
      redirected: false,
      url: 'https://evil.example/final.png',
    };

    await expect(
      inlineImage(FIREBASE_URL, {
        fetchImpl: jest.fn(async () => response),
        ownerId: 'user-1',
      })
    ).rejects.toThrow('redirects are not allowed');
  });

  it('rejects failed fetches with the status', async () => {
    await expect(
      inlineImage(FIREBASE_URL, {
        fetchImpl: fetchWith(Buffer.alloc(4), { status: 404, contentType: 'text/plain' }),
        ownerId: 'user-1',
      })
    ).rejects.toThrow('status 404');
  });

  it('rejects an oversized Content-Length before reading the body', async () => {
    const getReader = jest.fn(() => {
      throw new Error('body must not be read');
    });
    const response: FetchResponseLike = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png', 'content-length': '65' }),
      body: {
        getReader,
        cancel: jest.fn(async () => undefined),
      } as unknown as ReadableStream<Uint8Array>,
    };
    await expect(
      inlineImage(FIREBASE_URL, {
        fetchImpl: jest.fn(async () => response),
        maxSourceBytes: 64,
        ownerId: 'user-1',
      })
    ).rejects.toThrow('declared source size exceeds 64 bytes');
    expect(getReader).not.toHaveBeenCalled();
  });

  it.each([
    ['an absent Content-Length', {}],
    ['a lying short Content-Length', { 'content-length': '1' }],
  ])('cuts off an oversized streamed body with %s at max + 1 bytes', async (_label, extraHeaders) => {
    const first = new Uint8Array(40);
    const second = new Uint8Array(40);
    const response = streamingResponse([first, second], { 'content-type': 'image/png', ...extraHeaders });

    await expect(
      inlineImage(FIREBASE_URL, {
        fetchImpl: jest.fn(async () => response),
        maxSourceBytes: 64,
        ownerId: 'user-1',
      })
    ).rejects.toThrow('source image exceeds 64 bytes');
  });

  it('aborts a fetch that does not complete within the deadline', async () => {
    const fetchImpl = jest.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<FetchResponseLike>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        })
    );

    await expect(inlineImage(FIREBASE_URL, { fetchImpl, timeoutMs: 5, ownerId: 'user-1' })).rejects.toThrow(
      'fetch timed out after 5ms'
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('applies the same deadline while a response body is stalled', async () => {
    const cancel = jest.fn(async () => undefined);
    const releaseLock = jest.fn();
    const body = {
      getReader: () => ({
        read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
        cancel,
        releaseLock,
      }),
      cancel: jest.fn(async () => undefined),
    } as unknown as ReadableStream<Uint8Array>;
    const response: FetchResponseLike = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png' }),
      body,
    };

    await expect(
      inlineImage(FIREBASE_URL, {
        fetchImpl: jest.fn(async () => response),
        timeoutMs: 5,
        ownerId: 'user-1',
      })
    ).rejects.toThrow('fetch timed out after 5ms');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('rejects a valid PNG whose declared MIME type says JPEG', async () => {
    const png = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#235789' },
    })
      .png()
      .toBuffer();

    await expect(
      inlineImage(FIREBASE_URL, {
        fetchImpl: fetchWith(png, { contentType: 'image/jpeg' }),
        ownerId: 'user-1',
      })
    ).rejects.toThrow('declared MIME type does not match');
  });

  it('rejects malformed bytes even when the declared MIME type is allowed', async () => {
    await expect(
      inlineImage(FIREBASE_URL, {
        fetchImpl: fetchWith(Buffer.from('not-a-png'), { contentType: 'image/png' }),
        ownerId: 'user-1',
      })
    ).rejects.toThrow('declared MIME type does not match');
  });

  it('rejects when even max compression stays over budget', async () => {
    // A deterministic high-entropy raster compresses poorly.
    const noise = Buffer.alloc(1400 * 900 * 3);
    let value = 0x12345678;
    for (let i = 0; i < noise.length; i += 1) {
      value ^= value << 13;
      value ^= value >>> 17;
      value ^= value << 5;
      noise[i] = value & 0xff;
    }
    const noisyPng = await sharp(noise, { raw: { width: 1400, height: 900, channels: 3 } })
      .png()
      .toBuffer();

    await expect(
      inlineImage(GCS_URL, {
        fetchImpl: fetchWith(noisyPng),
        maxBytes: 5_000,
        ownerId: 'user-1',
      })
    ).rejects.toThrow('after max compression');
  });
});
